---
title: Migrating from D1 to Postgres
description: Move a live Ghuri project from Cloudflare D1 to Postgres with a second database alias, migrate --database and copydata, without changing application code.
---

This is the escape hatch Ghuri is designed around. Your project started on D1 because it was
free and fast to set up; now you need something D1 does not give you (more storage, heavier
writes, real transactions, Postgres features, an ops team that runs Postgres). The move
touches settings and data, not your models, views or serializers: migrations are
dialect-neutral, and values, lookups, case rules, NULL ordering and `onDelete` behave the same
on both databases.

The plan:

1. Provision Postgres.
2. Configure it as a second database alias next to D1.
3. Create the schema in Postgres with `ghuri migrate --database pg`.
4. Copy the data with `ghuri copydata --from default --to pg`.
5. Verify the counts.
6. Cut over: make Postgres the `default` alias, then move the runtime if you want to.

:::tip[If you know Django]
This is Django's multi-database workflow: a second `DATABASES` entry, `migrate --database`,
and `dumpdata` / `loaddata --database` with the same fixture format
(`[{ "model": "blog.post", "pk": 1, "fields": { … } }]`). `copydata` is a Ghuri convenience
that does the dump and the load in one process.
:::

## 1. Provision Postgres

Any Postgres 14+ works: a managed service (Neon, Supabase, RDS, Crunchy), or one you run
yourself. Create an empty database, note its URL, and install the driver Ghuri uses
(postgres.js, imported only when a `postgres()` database is used):

```sh
npm install postgres
```

```text
postgres://mysite:password@db.example.com:5432/mysite
```

Decide where the app will run afterwards:

- **Still on Workers**: connect through [Hyperdrive](/docs/deployment/cloudflare/#postgres-on-workers-with-hyperdrive).
- **On Node**: see [Node and Postgres on a VPS](/docs/deployment/node-postgres/) or
  [Docker](/docs/deployment/docker/).

## 2. Add Postgres as a second alias

Keep D1 as `default` and add Postgres under another alias. Only the commands you run from your
machine need the second alias, so add it only when its URL is set:

```ts title="src/settings.ts"
import { defineSettings } from '@ghuri/core'
import { d1, postgres } from '@ghuri/orm'

export default defineSettings((env) => ({
  // …
  DATABASES: {
    default: d1('DB'),
    ...(env.PG_URL ? { pg: postgres({ url: env.PG_URL }) } : {}),
  },
}))
```

Put the URL in `.dev.vars` (or `.env`, or export it in your shell) and keep that file out of
version control:

```sh title=".dev.vars"
PG_URL=postgres://mysite:password@db.example.com:5432/mysite
```

The CLI reads `process.env`, then `.dev.vars`, then `.env`, then Wrangler `vars`, in that
order of precedence. `postgres()` also accepts `max` (pool size, default 5) and
`driverOptions` (passed to postgres.js), for example
`driverOptions: { ssl: 'require' }`.

:::note
If your settings already switch `default` on a variable such as `DATABASE_URL` (the template
does), use a different variable for the second alias while you migrate, as above. Otherwise
setting it would turn `default` into Postgres too, and you would copy a database onto itself.
:::

## 3. Create the schema in Postgres

Ghuri migrations are dialect-neutral: the same `0001_initial.ts` produces SQLite SQL for D1
and Postgres SQL here. Make sure the production D1 database is fully migrated, then apply the
same migrations to Postgres:

```sh
npx ghuri migrate --remote                  # production D1 is up to date
npx ghuri migrate --database pg             # same files, Postgres DDL
npx ghuri showmigrations --database pg      # every migration [X]
npx ghuri showmigrations --remote           # compare with D1
```

Do not copy data into a database whose migrations are behind the D1 one.

`migrate` sends `postMigrate`, so apps like `@ghuri/auth` immediately create their own rows in
Postgres (content types and permissions). Their ids will not necessarily match the ones in
D1, which is why step 4 uses `--flush`.

## 4. Copy the data

### `copydata`

```sh
npx ghuri copydata --remote --from default --to pg --flush --no-input
```

- `--remote` makes the `default` alias the production D1 database rather than your local one
  (see [Reaching remote D1](#reaching-remote-d1) below). Leave it out to copy local data.
- `--from` (default `default`) and `--to` are aliases from `DATABASES`; they must differ, and
  the destination must already be migrated.
- `--flush` empties every table in the destination first (on Postgres:
  `TRUNCATE … RESTART IDENTITY CASCADE`), without re-sending `postMigrate`, so rows created by
  step 3 do not collide with the copied ones. Without `--no-input` it asks for confirmation.
- `app` or `app.Model` arguments restrict the copy, and `--exclude <label>` (repeatable)
  leaves an app or model out: `copydata --to pg blog auth.user --exclude blog.draft`.

`copydata` is `dumpdata` plus `loaddata` in one process. It reads every row of every installed
model from the source, ordered by primary key, then loads them into the destination:

- **Dependency order.** Models are loaded so that foreign-key targets come before the models
  that point at them (users before posts, posts before comments). Postgres foreign keys are
  created `DEFERRABLE INITIALLY DEFERRED`, so self-references and cycles are checked at
  commit.
- **Original primary keys.** Rows are upserted by primary key (`INSERT … ON CONFLICT (id) DO
  UPDATE`), so ids, and every foreign key pointing at them, are preserved. Running the copy
  again updates existing rows and adds new ones, but never deletes rows that disappeared from
  the source; use `--flush` for an exact copy.
- **Many-to-many rows** of auto-created join tables are replaced per object. Explicit
  `through` models are copied like any other model.
- **One transaction.** On Postgres the whole load runs in a single transaction: if any row is
  rejected, nothing is written.
- **Sequences are reset** afterwards on Postgres, so the next `INSERT` gets an id above the
  highest copied one. You do not need to run `setval` by hand.
- `preSave` / `postSave` receivers are called with `raw: true`, as in Django's `loaddata`.

It prints `Copied N object(s) of M model(s) from 'default' to 'pg'.`

### Alternative: `dumpdata` and `loaddata`

The same move in two steps leaves you a JSON file you can inspect and keep as a backup:

```sh
npx ghuri dumpdata --remote --database default --indent 2 -o data.json
npx ghuri loaddata data.json --database pg
```

The file is a Django-compatible fixture: one object per row, field names as in your models,
foreign keys as the related primary key, many-to-many fields as lists of keys, datetimes as
ISO strings and binary data as base64:

```json title="data.json (excerpt)"
[
  { "model": "blog.tag", "pk": 3, "fields": { "name": "workers" } },
  { "model": "blog.post", "pk": 12, "fields": { "title": "Hello", "slug": "hello", "author": 1, "tags": [3], "createdAt": "2026-10-01T09:30:00.000Z" } }
]
```

`ghuri dumpdata > data.json` works too, but `-o` keeps any warning printed by the tooling out
of the file. `loaddata` behaves exactly like the load half of `copydata` (dependency order,
upsert by primary key, one transaction, sequence reset), but it does not empty the
destination. If it fails with an `IntegrityError` on `django_content_type` or
`auth_permission`, the rows created by `migrate` in step 3 have different ids from the ones in
D1: use `copydata --flush` instead. (`ghuri flush --database pg` does not help here: it sends
`postMigrate` again, which re-creates those rows.)

### Reaching remote D1

The CLI runs on Node, so it reaches D1 through Wrangler. Every command loads your bindings
with Wrangler's `getPlatformProxy()`; without `--remote` that is the local D1 state in
`.wrangler/state` (or `--persist-to <dir>`), and with `--remote` Ghuri writes a temporary
Wrangler config that marks every D1, R2 and KV binding as remote. For that you need:

- `wrangler` installed in the project (`npm install -D wrangler`, version 4 for remote
  bindings) and a `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` whose `d1_databases`
  entry has the real `database_id`.
- Wrangler authenticated for the account: `npx wrangler login`, or `CLOUDFLARE_API_TOKEN`
  (and `CLOUDFLARE_ACCOUNT_ID`) in the environment, for example in CI.
- `--env <name>` if the binding lives in a Wrangler environment.

Every query then travels over the network to D1, and `copydata` holds all rows in memory
before loading them. That is fine for typical D1 databases. For a very large one, export it
with Wrangler, import the dump into an empty local D1 (for example after moving your
`.wrangler/state` directory aside), and copy from the local state without `--remote`:

```sh
npx wrangler d1 export mysite --remote --output d1-dump.sql
npx wrangler d1 execute mysite --local --file d1-dump.sql
npx ghuri copydata --from default --to pg --flush --no-input
```

You can also copy app by app (`copydata --to pg blog`, then `copydata --to pg shop`, in
dependency order, passing `--flush` only on the first run).

## 5. Verify

Compare row counts per model. `ghuri shell` has `apps` and every model in scope, and
`--remote` points `default` at production D1:

```sh
npx ghuri shell --remote -c "
for (const m of apps.getModels())
  console.log(m._meta.label, await m.objects.count(), await m.objects.using('pg').count())
"
```

Then spot-check behaviour against Postgres: log in to the admin with an existing account
(password hashes are copied verbatim), open a few objects, and create and delete one to
confirm sequences are correct.

Things that can differ between D1 and Postgres and are worth checking:

| Area | What to look for |
|---|---|
| Lengths | SQLite ignores the `n` in `varchar(n)`; Postgres enforces it. Rows written past a `maxLength` without validation (raw SQL, `update()`, `bulkCreate()`) make the load fail. Fix the data in D1 and copy again. |
| Types | Postgres checks `uuid`, `date`, `time`, `numeric(p, s)` and `jsonb` values strictly; SQLite stored whatever it was given. |
| Check constraints | `Positive*Field` and `Meta.constraints` checks are enforced on load. |
| `regex` lookups | Unavailable on D1, native on Postgres (POSIX syntax). Code that avoided them can now use them. |
| Transactions | `atomic()` now really rolls back. Code written around D1's lack of rollback keeps working. |

## 6. Cut over

The app keeps writing to D1 until you switch, and anything written after the copy would be
lost. Do a trial copy first to measure how long it takes, then pick one:

- **Maintenance window.** Put the site in maintenance mode (a middleware that returns `503`
  for everything except your IP is enough), run `copydata --flush` once more, verify, switch,
  lift maintenance. For most D1-sized projects the copy takes minutes.
- **Read-only window.** Block writes (return `503` for non-safe methods) but keep serving
  reads from D1 while you copy.

Then make Postgres the `default` alias. Keep D1 under another alias for as long as you want an
easy way back:

```ts title="src/settings.ts"
DATABASES: {
  default: env.DATABASE_URL
    ? postgres({ url: env.DATABASE_URL })      // Node, and the CLI
    : postgres({ hyperdrive: 'HYPERDRIVE' }),  // Workers, through Hyperdrive
  ...(env.DB ? { d1: d1('DB') } : {}),          // the old database, for rollback
},
```

- **Staying on Workers:** add the Hyperdrive binding (see
  [Postgres on Workers with Hyperdrive](/docs/deployment/cloudflare/#postgres-on-workers-with-hyperdrive))
  and deploy with `npx ghuri deploy`. The CLI talks to Postgres directly through
  `DATABASE_URL`, so `ghuri migrate` keeps working from your machine or CI.
- **Moving to Node:** follow [Node and Postgres on a VPS](/docs/deployment/node-postgres/)
  (or [Docker](/docs/deployment/docker/)): set `DATABASE_URL`, run `npx ghuri migrate` as a
  release step, start the server, then move DNS (or the Worker route) to it. A Node server has
  no D1 binding, so the `d1` alias above only exists where Wrangler provides `DB` (on Workers
  and in the CLI).

No application code changes: every query keeps going through `default`.

## Files stay where they are

Your uploads live in R2 and do not have to move. R2 has an S3-compatible API, so a Node
deployment can keep using the same bucket through `s3()`:

```ts title="src/settings.ts"
import { s3 } from '@ghuri/storage'

STORAGES: {
  default: s3({
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: 'mysite-media',
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    publicUrl: 'https://media.example.com',
  }),
},
```

Create an R2 API token with read and write access to the bucket in the Cloudflare dashboard.
File fields store only the object name in the database, so the copied names resolve to the
same objects. See [Storage backends](/docs/topics/storage-backends/).

## Rollback plan

Nothing in this guide writes to D1 (`copydata` only reads from `--from`), so keep it untouched
for as long as you might need it.

- **Before any writes land in Postgres:** switch `default` back to `d1('DB')` and redeploy.
- **After writes landed in Postgres:** copy in the other direction, with D1 still configured
  under the `d1` alias: `npx ghuri copydata --remote --from default --to d1 --flush --no-input`,
  then switch back. On D1 the load is sent in batches of 5,000 statements, each atomic on its
  own, so a failure part-way can leave a partial copy: fix the cause and run it again with
  `--flush`.

Decide in advance how long you will keep the rollback path open, then delete the D1 database
with `npx wrangler d1 delete mysite` once you are confident.

## See also

- [CLI reference: dumpdata and loaddata](/docs/reference/cli/#dumpdata)
- [Migrations](/docs/topics/migrations/)
- [Transactions](/docs/topics/transactions/)
- [Deploying to Cloudflare Workers](/docs/deployment/cloudflare/)
- [Node and Postgres on a VPS](/docs/deployment/node-postgres/)
