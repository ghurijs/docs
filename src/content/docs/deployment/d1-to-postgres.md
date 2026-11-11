---
title: Migrating from D1 to Postgres
description: Move a live Ghuri project from Cloudflare D1 to Postgres with dumpdata and loaddata, without changing application code.
---

This is the escape hatch Ghuri is designed around. Your project started on D1 because it was
free and fast to set up; now you need something D1 does not give you (more storage, heavier
writes, Postgres features, an existing ops team that runs Postgres). The move touches settings
and data, not your models, views or serializers.

The plan:

1. Provision Postgres.
2. Make settings choose the database from the environment.
3. Create the schema in Postgres with `ghuri migrate`.
4. Export from D1 with `ghuri dumpdata`, import into Postgres with `ghuri loaddata`.
5. Verify, cut over, keep D1 around as the rollback.

:::tip[If you know Django]
This is the same `dumpdata` / `loaddata` dance you may have used to move a Django project
from SQLite to Postgres, and the fixture format is the same:
`[{ "model": "blog.post", "pk": 1, "fields": { … } }]`.
:::

## 1. Provision Postgres

Any Postgres 14+ works: a managed service (Neon, Supabase, RDS, Crunchy), or one you run
yourself. Create an empty database and note its URL:

```text
postgres://mysite:password@db.example.com:5432/mysite
```

Decide where the app will run afterwards:

- **Still on Workers**: connect through [Hyperdrive](/docs/deployment/cloudflare/#postgres-on-workers-with-hyperdrive).
- **On Node**: see [Node and Postgres on a VPS](/docs/deployment/node-postgres/) or
  [Docker](/docs/deployment/docker/).

## 2. Make the database a setting

If your settings came from the default template they already look like this. If not, change
`DATABASES` so the database depends on whether `DATABASE_URL` is set:

```ts title="src/settings.ts"
import { d1, postgres } from '@ghuri/orm'

DATABASES: {
  default: env.DATABASE_URL ? postgres({ url: env.DATABASE_URL }) : d1('DB'),
},
```

With `DATABASE_URL` unset, every `ghuri` command talks to D1. With it set, every command talks
to Postgres. That switch is all the migration needs.

## 3. Create the schema in Postgres

Ghuri migrations are dialect-neutral: the same `0001_initial.ts` produces SQLite SQL for D1
and Postgres SQL here.

```sh
export PG_URL=postgres://mysite:password@db.example.com:5432/mysite

DATABASE_URL=$PG_URL npx ghuri migrate
DATABASE_URL=$PG_URL npx ghuri showmigrations
```

Every migration should show as applied. Do not load data into a database whose migrations are
behind the D1 one: run `npx ghuri showmigrations --remote` and compare.

## 4. Copy the data

### Export from D1

Run `dumpdata` against the remote D1 database, with `DATABASE_URL` unset:

```sh
unset DATABASE_URL
npx ghuri dumpdata --remote --indent 2 > data.json
```

The output is a JSON array of objects, one per row:

```json title="data.json (excerpt)"
[
  { "model": "auth.user", "pk": 1, "fields": { "username": "rifat", "password": "pbkdf2_sha256$…", "isStaff": true } },
  { "model": "blog.tag", "pk": 3, "fields": { "name": "workers" } },
  { "model": "blog.post", "pk": 12, "fields": { "title": "Hello", "slug": "hello", "author": 1, "tags": [3], "createdAt": "2026-10-01T09:30:00.000Z" } }
]
```

Foreign keys are stored as the related primary key, many-to-many fields as a list of keys.

Some tables are derived and do not need copying. Excluding them makes the import faster and
avoids conflicts with rows that `migrate` already created:

```sh
npx ghuri dumpdata --remote --exclude auth.permission --exclude auth.contenttype > data.json
```

Sessions are optional: leave them out and everyone signs in again after the cut over.

### Import into Postgres

```sh
DATABASE_URL=$PG_URL npx ghuri loaddata data.json
```

`loaddata` inserts objects in dependency order (users before posts, posts before comments,
many-to-many rows last), keeps the original primary keys, and then resets Postgres sequences so
the next `INSERT` gets an id above the highest imported one. You do not need to run
`setval` by hand.

### Why not a pipe?

You may have seen `ghuri dumpdata | ghuri loaddata` used as shorthand. Both commands read the
same settings, so a plain pipe would export from and import into the same database. The
two-step version above, with `DATABASE_URL` switching the target, is the reliable form. It also
leaves you a `data.json` you can keep as a backup.

:::note[Alpha]
A `--database <alias>` option, which would let you declare both databases at once
(`DATABASES: { default: postgres(…), legacy: d1('DB') }`) and run
`ghuri dumpdata --database legacy`, is planned but not settled for 0.1. Prefer the
environment-switched workflow until it is documented as stable.
:::

## 5. Verify

Compare row counts per model. The shell makes this quick:

```sh
DATABASE_URL=$PG_URL npx ghuri shell
```

```ts
await Post.objects.count()
await Comment.objects.count()
await User.objects.count()
```

Compare with the same commands in `npx ghuri shell --remote` (D1). Then spot-check behaviour:
log in to the admin with an existing account (password hashes are copied verbatim), open a few
posts, create and delete one to confirm sequences are correct.

Things that can differ between SQLite and Postgres and are worth checking:

| Area | What to look for |
|---|---|
| Case sensitivity | `contains` and `startswith` are case-sensitive on Postgres. SQLite's `LIKE` is case-insensitive for ASCII, so `contains` may have matched more on D1. Use `icontains` where you meant it. |
| `regex` lookups | Native on Postgres; best-effort on SQLite. Results may now differ (usually for the better). |
| Unique constraints | Postgres enforces them strictly on text with different collations; duplicates that slipped in on SQLite will make `loaddata` fail. Fix the data in D1 and export again. |
| Decimals | `DecimalField` is text in SQLite and `numeric` in Postgres. Values stay strings in TypeScript either way. |

## 6. Cut over

The app keeps writing to D1 until you switch, so anything written after the export would be
lost. Pick one:

- **Maintenance window.** Put the site in maintenance mode (a middleware that returns `503`
  for everything except your IP is enough), export, import, switch, lift maintenance. For most
  projects that use D1 the whole export and import takes minutes.
- **Read-only window.** Block writes (return `503` for non-safe methods) but keep serving
  reads from D1 while you copy.

Then switch production to Postgres:

- **Workers + Hyperdrive:** add the Hyperdrive binding, change `DATABASES` to
  `postgres({ hyperdrive: 'HYPERDRIVE' })`, `npx ghuri deploy`.
- **Node:** start the Node deployment with `DATABASE_URL` set, then move DNS (or the Worker
  route) to it.

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
File fields store only the object name in the database, so the names copied by `loaddata`
resolve to the same objects.

## Rollback plan

Keep D1 untouched for as long as you might need it. Nothing in this guide writes to it.

- **Before any writes land in Postgres:** switch `DATABASES` back to `d1('DB')` (or unset
  `DATABASE_URL`) and redeploy.
- **After writes landed in Postgres:** run the same procedure in reverse:
  `DATABASE_URL=$PG_URL npx ghuri dumpdata > back.json`, then
  `npx ghuri flush --remote` and `npx ghuri loaddata back.json --remote` against D1.

Decide in advance how long you will keep the rollback path open, then delete the D1 database
with `npx wrangler d1 delete mysite` once you are confident.

## See also

- [CLI reference: dumpdata and loaddata](/docs/reference/cli/#dumpdata)
- [Migrations](/docs/topics/migrations/)
- [Deploying to Cloudflare Workers](/docs/deployment/cloudflare/)
