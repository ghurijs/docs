---
title: Deploying to Cloudflare Workers
description: Create D1, R2 and KV resources, set secrets, run migrations against remote D1, deploy with ghuri deploy, and use Hyperdrive for Postgres on Workers.
---

Cloudflare Workers is Ghuri's default home. A deployed project is a single Worker whose bindings
give it a D1 database (`DB`), an R2 bucket for uploaded files (`MEDIA`) and a KV namespace for
the cache (`CACHE`). This page walks through creating those resources, applying migrations to
the remote database and shipping the Worker.

The examples use the tutorial project `mysite` with its `blog` app.

:::tip[If you know Django]
There is no WSGI server, process manager or reverse proxy to configure. `wrangler.jsonc` plays
the part of your server config, `wrangler secret put` replaces the environment file on the
server, and `ghuri deploy` replaces "push, collectstatic, restart gunicorn".
:::

## Before you start

- A Cloudflare account, and Wrangler logged in to it:

  ```sh
  npx wrangler login
  npx wrangler whoami
  ```

- A project whose `wrangler.jsonc` has `"compatibility_flags": ["nodejs_compat"]` (the
  `create-ghuri` template does). Ghuri needs it for `AsyncLocalStorage`.

## 1. Create the resources

Each command prints a snippet to paste into `wrangler.jsonc`. Keep the binding names the
settings expect: `DB`, `MEDIA` and `CACHE`.

### D1 database

```sh
npx wrangler d1 create mysite
```

```jsonc title="wrangler.jsonc"
"d1_databases": [
  { "binding": "DB", "database_name": "mysite", "database_id": "7c0e…" }
]
```

### R2 bucket

```sh
npx wrangler r2 bucket create mysite-media
```

```jsonc title="wrangler.jsonc"
"r2_buckets": [
  { "binding": "MEDIA", "bucket_name": "mysite-media" }
]
```

If uploaded files should be publicly readable, connect a custom domain to the bucket (or enable
the `r2.dev` URL for testing) in the dashboard and pass it to the storage config so
`FieldFile.url` produces direct links:

```ts title="src/settings.ts"
STORAGES: { default: r2('MEDIA', { publicUrl: 'https://media.example.com' }) },
```

Without `publicUrl`, mount `serveMedia()` at `MEDIA_URL` and the Worker streams files from R2.
See [File storage](/docs/topics/file-storage/).

### KV namespace

```sh
npx wrangler kv namespace create CACHE
```

```jsonc title="wrangler.jsonc"
"kv_namespaces": [
  { "binding": "CACHE", "id": "e29b…" }
]
```

KV is eventually consistent (writes can take up to a minute to appear in other locations).
That is fine for a cache. If you use `SESSION_ENGINE: 'kv'`, be aware that a session written
in one region may briefly be missing in another; the default `db` engine does not have this
problem.

## 2. Set secrets and variables

Non-secret configuration goes in `vars`:

```jsonc title="wrangler.jsonc"
"vars": { "DEBUG": "false" }
```

Secrets are set once per Worker and never stored in the repository:

```sh
npx wrangler secret put SECRET_KEY
```

Generate a key with something like `openssl rand -base64 48`. Add any other secrets your
settings read from `env` (API keys for agents, S3 credentials and so on) the same way.

:::caution
Never deploy with `DEBUG` set to `"true"`. Debug error pages include stack traces and settings.
:::

## 3. Apply migrations to the remote database

Migrations are applied from your machine. The `--remote` flag tells the CLI to build `env` from
the remote bindings in `wrangler.jsonc` (through Wrangler's `getPlatformProxy`) instead of the
local simulator:

```sh
npx ghuri migrate --remote
npx ghuri showmigrations --remote
```

Create the first admin user against the remote database the same way:

```sh
npx ghuri createsuperuser --remote
```

:::note[Alpha]
`--remote` runs through Wrangler's remote bindings proxy. Its exact behaviour (and which
commands support it) may change before 0.1.0 final. If it does not work in your setup, use the
SQL-file workflow below.
:::

### Alternative: Wrangler's own D1 migrations

If you prefer Wrangler to own schema changes (for example, because your CI already runs
`wrangler d1 migrations apply`), export every Ghuri migration as SQLite SQL files:

```sh
npx ghuri sqlmigrate --all --dialect sqlite --out migrations-sql/
```

Point Wrangler at that directory and apply:

```jsonc title="wrangler.jsonc"
"d1_databases": [
  { "binding": "DB", "database_name": "mysite", "database_id": "7c0e…", "migrations_dir": "migrations-sql" }
]
```

```sh
npx wrangler d1 migrations apply mysite --remote
```

Pick one workflow per database and stick with it. Ghuri records applied migrations in its own
`ghuri_migrations` table and Wrangler records them in `d1_migrations`; neither knows about the
other.

## 4. Deploy

```sh
npx ghuri deploy
```

`ghuri deploy` runs `wrangler deploy` (arguments after `--` are passed through) and prints the
`*.workers.dev` URL. `npm run deploy` is the same command.

A typical release is therefore:

```sh
npx ghuri test
npx ghuri migrate --remote
npx ghuri deploy
```

Run `migrate` before `deploy` so new code never runs against an old schema. When you remove a
column, do it in two releases: first deploy code that no longer uses it, then migrate.

## 5. Custom domains and hosts

Attach a domain in `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
"routes": [{ "pattern": "blog.example.com", "custom_domain": true }]
```

Then tighten the host and CSRF settings, which default to permissive values:

```ts title="src/settings.ts"
ALLOWED_HOSTS: ['blog.example.com'],
CSRF_TRUSTED_ORIGINS: ['https://blog.example.com'],
```

## Postgres on Workers with Hyperdrive

You do not have to leave Workers to use Postgres. [Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
pools connections to an existing Postgres database close to it, so a Worker can talk to Postgres
without paying for a new TCP and TLS handshake on every request.

```sh
npx wrangler hyperdrive create mysite-pg \
  --connection-string="postgres://user:password@db.example.com:5432/mysite"
```

```jsonc title="wrangler.jsonc"
"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "a76a…" }]
```

```ts title="src/settings.ts"
import { postgres } from '@ghuri/orm'

DATABASES: { default: postgres({ hyperdrive: 'HYPERDRIVE' }) },
```

For local development, give Wrangler a local connection string through
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in `.dev.vars` or set
`localConnectionString` on the binding.

The CLI connects to Postgres directly, not through Hyperdrive, so set `DATABASE_URL` when you
run migrations:

```ts title="src/settings.ts"
DATABASES: {
  default: env.HYPERDRIVE ? postgres({ hyperdrive: 'HYPERDRIVE' }) : postgres({ url: env.DATABASE_URL }),
},
```

```sh
DATABASE_URL=postgres://user:password@db.example.com:5432/mysite npx ghuri migrate
```

## Scheduled and queue handlers

`createApp()` returns an object with `fetch`, and also `scheduled` and `queue` handlers that
Workers call for [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
and [Queues](https://developers.cloudflare.com/queues/). Both run inside a Ghuri context, so the
ORM, cache and storage work exactly as they do in a view.

```jsonc title="wrangler.jsonc"
"triggers": { "crons": ["0 3 * * *"] }
```

:::note[Alpha]
The API for registering cron and queue handlers is not final in 0.1. A dedicated
`@ghuri/tasks` package (Cloudflare Queues plus a Node worker) is on the roadmap. Until then,
keep scheduled work small and call it from a [management command](/docs/topics/management-commands/)
as well, so you can run it by hand.
:::

## Limits worth knowing

| Concern | What to do |
|---|---|
| D1 has no interactive transactions | `atomic()` batches writes where it can; see [Transactions](/docs/topics/transactions/). |
| Worker CPU time limits | Keep heavy work (image processing, big exports) out of request handlers. |
| D1 database size limits | When you approach them, [move to Postgres](/docs/deployment/d1-to-postgres/). |
| No filesystem | Use `r2()` storage; `@ghuri/storage/fs` is Node only. |

## See also

- [Migrating from D1 to Postgres](/docs/deployment/d1-to-postgres/)
- [CLI reference](/docs/reference/cli/)
- [Settings reference](/docs/reference/settings/)
