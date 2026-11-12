---
title: 'Part 5: Deploy to Cloudflare'
description: Create the D1 database and R2 bucket, set secrets, migrate the remote database and deploy the blog to Cloudflare Workers.
---

The blog works locally. In this last part you will put it on Cloudflare's network, with a real
D1 database and an R2 bucket for uploads (and, optionally, a KV namespace for the cache).

You need a Cloudflare account (the free plan is enough) and Wrangler logged in:

```sh
npx wrangler login
```

## Create the resources

The generated `wrangler.jsonc` declares two bindings, `DB` (D1) and `MEDIA` (R2), plus a
commented-out `CACHE` (KV). Locally, Wrangler simulated them; now create the real resources:

```sh
npx wrangler d1 create mysite-db
npx wrangler r2 bucket create mysite-media
npx wrangler kv namespace create CACHE      # optional
```

`wrangler d1 create` prints the new database's id. Replace the placeholder
`00000000-0000-0000-0000-000000000000` in `wrangler.jsonc` with it, and, if you created the KV
namespace, uncomment `kv_namespaces` and paste its `id`:

```jsonc title="wrangler.jsonc" {10,15}
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mysite",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "d1_databases": [
    { "binding": "DB", "database_name": "mysite-db",
      "database_id": "4f0c3e1a-…" }
  ],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "mysite-media" }],
  "kv_namespaces": [
    // only if you created it; settings use kvCache('CACHE') when the binding exists
    { "binding": "CACHE", "id": "b7d2…" }
  ],
  "vars": { "DEBUG": "false" }
}
```

Your settings do not change. `d1('DB')` means "the D1 database bound as `DB`", whichever
database that is in the current environment, and `CACHES` already switches to KV when a `CACHE`
binding exists.

## Set the secret key

Production needs its own `SECRET_KEY`, stored as an encrypted Worker secret rather than in
`wrangler.jsonc` (the one in `.dev.vars` is for local development only):

```sh
openssl rand -base64 48 | npx wrangler secret put SECRET_KEY
```

## Migrate the remote database

Run the same migrations you ran locally, against the remote D1 database:

```sh
npx ghuri migrate --remote
npx ghuri createsuperuser --remote
```

`--remote` is a global option: the CLI asks Wrangler for remote bindings (it writes a temporary
copy of `wrangler.jsonc` with every D1, R2 and KV binding marked `"remote": true`), so the
command reads and writes your real Cloudflare resources instead of the local simulation. Every
command accepts it, so you can also `npx ghuri shell --remote` to inspect production data. Use
that one carefully. Remote bindings need `wrangler login` and the real `database_id`.

:::note[Alpha]
Remote commands go through Wrangler's platform proxy. Large migrations on D1 can be slow over
that path; if one times out, generate plain SQL with
`npx ghuri sqlmigrate --all --out migrations-sql` and apply it with
`npx wrangler d1 migrations apply DB --remote` (set `"migrations_dir": "migrations-sql"` on the
D1 binding). See [Deploy to Cloudflare](/docs/deployment/cloudflare/).
:::

## Deploy

```sh
npx ghuri deploy
```

`ghuri deploy` first asks whether to apply migrations to the remote database
(`ghuri migrate --remote`); answer yes, or pass `--migrate` to skip the question
(`--skip-migrations` to skip them). Then it runs `wrangler deploy`, which bundles
`src/index.ts` and everything it imports (your apps, models, migrations index and admin) into a
single Worker and uploads it. When it finishes it prints your URL:

```
Deployed mysite triggers
  https://mysite.<your-subdomain>.workers.dev
```

Open `https://mysite.<your-subdomain>.workers.dev/admin/`, log in with the superuser you just
created, and write a post. Then fetch it from the API:

```sh
curl https://mysite.<your-subdomain>.workers.dev/api/posts/
```

## Tighten production settings

Before you share the URL, restrict hosts and trust your own origin for CSRF. The generated
settings already read `ALLOWED_HOSTS` from the environment as a comma-separated list, so set it
as a variable:

```jsonc title="wrangler.jsonc"
"vars": {
  "DEBUG": "false",
  "ALLOWED_HOSTS": "blog.example.com,mysite.example.workers.dev"
}
```

```ts title="src/settings.ts"
export default defineSettings((env) => ({
  // ...
  CSRF_TRUSTED_ORIGINS: ['https://blog.example.com'],
}))
```

To serve the site on your own domain, add a route or custom domain in `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
"routes": [{ "pattern": "blog.example.com", "custom_domain": true }]
```

Run `npx ghuri check --deploy` to catch the usual production mistakes.

## The deploy loop

From now on, shipping a change that touches models is:

```sh
npx ghuri makemigrations
npx ghuri migrate            # local
npx ghuri test
npx ghuri deploy --migrate   # remote migrations, then the new code
```

`--migrate` applies migrations before `wrangler deploy`, which is the right order when you add
tables or columns: the new code never sees an old schema. When you remove a column, deploy the
code that stops using it first (`npx ghuri deploy --skip-migrations`) and migrate afterwards
(`npx ghuri migrate --remote`).

:::tip[If you know Django]
The order of operations is the same as for any Django deployment: migrate, then switch traffic
to new code. What disappears is the server: there is no gunicorn to restart, no `collectstatic`
(the admin's CSS ships inside `@ghuri/admin`) and no process manager.
:::

## Where to go from here

You have built and deployed a Django-style application on Cloudflare. Some next steps:

- When the blog outgrows D1, follow [Migrating from D1 to Postgres](/docs/deployment/d1-to-postgres/).
  Your models, views and serializers will not change.
- To run on your own server, read [Node and Postgres on a VPS](/docs/deployment/node-postgres/)
  or [Docker](/docs/deployment/docker/).
- Run work on a schedule or from a queue with [background tasks](/docs/topics/background-tasks/).
- Let an AI assistant manage posts through your API with [AI agents and MCP](/docs/topics/agents-mcp/).
- Browse the topic guides, starting with [Making queries](/docs/topics/queries/).
