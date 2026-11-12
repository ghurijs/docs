---
title: Deploying to Cloudflare Workers
description: Create D1, R2 and KV resources, set secrets, run migrations against remote D1, deploy with ghuri deploy, and use Hyperdrive for Postgres on Workers.
---

Cloudflare Workers is Ghuri's default home. A deployed project is a single Worker whose bindings
give it a D1 database (`DB`), an R2 bucket for uploaded files (`MEDIA`) and, optionally, a KV
namespace for the cache (`CACHE`). This page walks through creating those resources, applying migrations to
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

The generated `wrangler.jsonc` already declares `DB` (with a placeholder `database_id` that only
works locally), `MEDIA`, and a commented-out `CACHE`.

## 1. Create the resources

Each command prints an identifier or a snippet for `wrangler.jsonc`. Keep the binding names the
settings expect: `DB`, `MEDIA` and `CACHE`.

### D1 database

```sh
npx wrangler d1 create mysite-db
```

Replace the placeholder id in `wrangler.jsonc` with the one it prints:

```jsonc title="wrangler.jsonc"
"d1_databases": [
  { "binding": "DB", "database_name": "mysite-db", "database_id": "7c0e…" }
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

Without `publicUrl`, mount `mediaPatterns('media/')` (or `path('media/<path:name>', serveMedia())`)
from `@ghuri/storage` in `src/urls.ts` and the Worker streams files from R2. See
[File storage](/docs/topics/file-storage/) and [Storage backends](/docs/topics/storage-backends/).

### KV namespace (optional)

```sh
npx wrangler kv namespace create CACHE
```

Uncomment `kv_namespaces` and paste the id:

```jsonc title="wrangler.jsonc"
"kv_namespaces": [
  { "binding": "CACHE", "id": "e29b…" }
]
```

The generated settings use it automatically: `CACHES.default` is
`env.CACHE ? kvCache('CACHE') : memoryCache()`. KV is eventually consistent (writes can take up to a minute to appear in other locations).
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

Migrations are applied from your machine (or CI). The `--remote` flag tells the CLI to build
`env` from the remote bindings in `wrangler.jsonc` instead of the local simulator: it writes a
temporary copy of the config with every D1, R2 and KV binding marked `"remote": true` and calls
Wrangler's `getPlatformProxy({ remoteBindings: true })`. It needs `wrangler login` and the real
`database_id`:

```sh
npx ghuri migrate --remote
npx ghuri showmigrations --remote
```

Create the first admin user against the remote database the same way:

```sh
npx ghuri createsuperuser --remote
```

:::note[Alpha]
`--remote` is a global option, so every command supports it, but it runs through Wrangler's
remote bindings proxy, which can be slow for large migrations. If it does not work in your
setup, use the SQL-file workflow below.
:::

### Alternative: Wrangler's own D1 migrations

If you prefer Wrangler to own schema changes (for example, because your CI already runs
`wrangler d1 migrations apply`), export every Ghuri migration as SQLite SQL files:

```sh
npx ghuri sqlmigrate --all --dialect sqlite --out migrations-sql
```

Point Wrangler at that directory and apply:

```jsonc title="wrangler.jsonc"
"d1_databases": [
  { "binding": "DB", "database_name": "mysite-db", "database_id": "7c0e…", "migrations_dir": "migrations-sql" }
]
```

```sh
npx wrangler d1 migrations apply DB --remote
```

Each generated file also inserts its row into Ghuri's `ghuri_migrations` table, so
`ghuri showmigrations --remote` agrees with Wrangler, and re-running `sqlmigrate --all` only
adds files for new migrations. Still, pick one workflow per database and stick with it:
Wrangler records what it applied in its own `d1_migrations` table and does not know about
migrations applied with `ghuri migrate`.

## 4. Deploy

```sh
npx ghuri deploy
```

`ghuri deploy` first asks whether to apply migrations to the remote database
(`ghuri migrate --remote`), then runs `wrangler deploy` and prints the `*.workers.dev` URL. Extra
arguments are passed to Wrangler, and `--env <name>` selects a Wrangler environment for both
steps. `npm run deploy` is the same command.

| Option | Meaning |
|---|---|
| `--migrate` | Apply remote migrations first without asking; a failed migration aborts the deploy. |
| `--skip-migrations` | Deploy without migrating (and without asking). |
| `--dry-run` | `wrangler deploy --dry-run`; no migrations. |
| `--no-input` | Never prompt (CI); migrations run only with `--migrate`. |

A typical release is therefore:

```sh
npx ghuri test
npx ghuri deploy --migrate
```

Run `migrate` before `deploy` so new code never runs against an old schema. When you remove a
column, do it in two releases: first deploy code that no longer uses it, then migrate.

## 5. Custom domains and hosts

Attach a domain in `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
"routes": [{ "pattern": "blog.example.com", "custom_domain": true }]
```

Then tighten the host and CSRF settings, which default to permissive values. The generated
settings read `ALLOWED_HOSTS` from a comma-separated variable (`["*"]` when it is unset):

```jsonc title="wrangler.jsonc"
"vars": { "DEBUG": "false", "ALLOWED_HOSTS": "blog.example.com" }
```

```ts title="src/settings.ts"
CSRF_TRUSTED_ORIGINS: ['https://blog.example.com'],
```

`npx ghuri check --deploy` reports the usual production mistakes.

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

A project created with `--db postgres` already has this shape: settings use Hyperdrive when the
`HYPERDRIVE` binding exists and `DATABASE_URL` otherwise, and `wrangler.jsonc` contains the
`hyperdrive` block commented out (uncomment it and paste the id):

```ts title="src/settings.ts"
DATABASES: {
  default: env.HYPERDRIVE ? postgres({ hyperdrive: 'HYPERDRIVE' }) : postgres({ url: env.DATABASE_URL }),
},
```

Locally, either leave the binding out and keep `DATABASE_URL` in `.dev.vars`, or give Wrangler a
local connection string for it (`localConnectionString` on the binding, or
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`). To run migrations against the
production database, point `DATABASE_URL` at it:

```sh
DATABASE_URL=postgres://user:password@db.example.com:5432/mysite npx ghuri migrate
```

## Scheduled and queue handlers

`createApp()` returns a Workers module handler with `fetch`, `scheduled` and `queue`, so
`src/index.ts` (`export default createApp(settings)`) already receives
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and
[Queues](https://developers.cloudflare.com/queues/) batches. Register handlers with `onSchedule`
and `onQueue` from `@ghuri/core`, typically in an app's `ready()`. They run inside a Ghuri
context, so the ORM, cache and storage work exactly as they do in a view.

```ts title="src/blog/app.ts"
import { AppConfig, onQueue, onSchedule } from '@ghuri/core'

export class BlogConfig extends AppConfig {
  // ...name, path, models, migrations, admin
  ready() {
    // the exact cron expression from wrangler.jsonc, or '*' for every trigger
    onSchedule('0 3 * * *', async () => {
      await Post.objects.filter({ published: false, createdAt__lt: lastMonth() }).delete()
    })
    onQueue<{ postId: number }>('emails', async (batch) => {
      for (const msg of batch.messages) {
        await notifySubscribers(msg.body.postId)
        msg.ack()
      }
    })
  }
}
```

```jsonc title="wrangler.jsonc"
"triggers": { "crons": ["0 3 * * *"] },
"queues": {
  "producers": [{ "binding": "EMAILS", "queue": "emails" }],
  "consumers": [{ "queue": "emails" }]
}
```

A batch for a queue with no registered handler fails with `ImproperlyConfigured`. These hooks
only fire on Workers; on Node, call the same code from a
[management command](/docs/topics/management-commands/) run by cron. See
[Background tasks](/docs/topics/background-tasks/).

## WebSockets (Durable Objects)

With [`@ghuri/realtime`](/docs/topics/websockets/), each room is a Durable Object. Export the class
next to the app and bind it:

```ts title="src/index.ts"
import { createApp } from '@ghuri/core'
import { createRoomClass } from '@ghuri/realtime/cloudflare'
import settings from './settings'

const app = createApp(settings)
export default app
export const GhuriRoom = createRoomClass(app)
```

```jsonc title="wrangler.jsonc"
"durable_objects": {
  "bindings": [{ "name": "REALTIME", "class_name": "GhuriRoom" }]
},
"migrations": [{ "tag": "realtime-v1", "new_sqlite_classes": ["GhuriRoom"] }]
```

```ts title="src/settings.ts"
REALTIME: { LAYER: durableObjectLayer('REALTIME') },   // from '@ghuri/realtime/cloudflare'
```

`wrangler deploy` creates the Durable Object class from the migration; no resource needs to be
created by hand. Keep the migration entry once deployed, and add new tags rather than editing it.
Open sockets drop on every deploy, so clients should reconnect with a backoff.

## Limits worth knowing

| Concern | What to do |
|---|---|
| D1 has no interactive transactions | `atomic()` on D1 has **no rollback**; use `connection.batch([...])` for all-or-nothing writes. See [Transactions](/docs/topics/transactions/). |
| Worker CPU time limits | Keep heavy work (image processing, big exports) out of request handlers. |
| D1 database size limits | When you approach them, [move to Postgres](/docs/deployment/d1-to-postgres/). |
| No filesystem | Use `r2()` storage; `@ghuri/storage/fs` is Node only. |
| One room is one Durable Object | A few thousand WebSocket connections per room; use `broadcast` rather than `groupSend` in large rooms. See [WebSockets](/docs/topics/websockets/#running-on-cloudflare). |

## See also

- [Migrating from D1 to Postgres](/docs/deployment/d1-to-postgres/)
- [CLI reference](/docs/reference/cli/)
- [Settings reference](/docs/reference/settings/)
