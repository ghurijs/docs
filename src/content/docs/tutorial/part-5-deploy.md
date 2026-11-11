---
title: 'Part 5: Deploy to Cloudflare'
description: Create D1, R2 and KV resources, migrate the remote database, set secrets and deploy the blog to Cloudflare Workers.
---

The blog works locally. In this last part you will put it on Cloudflare's network, with a real
D1 database, an R2 bucket for uploads and a KV namespace for the cache.

You need a Cloudflare account (the free plan is enough) and Wrangler logged in:

```sh
npx wrangler login
```

## Create the resources

The generated `wrangler.jsonc` declares three bindings: `DB`, `MEDIA` and `CACHE`. Create the
resources behind them:

```sh
npx wrangler d1 create mysite
npx wrangler r2 bucket create mysite-media
npx wrangler kv namespace create CACHE
```

Each command prints the identifier of the new resource. Copy the D1 `database_id` and the KV
`id` into `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
{
  "name": "mysite",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    { "binding": "DB", "database_name": "mysite", "database_id": "4f0c3e1a-…" }
  ],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "mysite-media" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "b7d2…" }],
  "vars": { "DEBUG": "false" }
}
```

Your settings do not change. `d1('DB')` means "the D1 database bound as `DB`", whichever
database that is in the current environment.

## Set the secret key

Production needs its own `SECRET_KEY`, stored as an encrypted Worker secret rather than in
`wrangler.jsonc`:

```sh
node -e "console.log(crypto.randomUUID() + crypto.randomUUID())" | npx wrangler secret put SECRET_KEY
```

## Migrate the remote database

Run the same migrations you ran locally, against the remote D1 database:

```sh
npx ghuri migrate --remote
npx ghuri createsuperuser --remote
```

`--remote` makes the CLI build its environment from your real Cloudflare bindings (through
Wrangler's remote bindings) instead of the local simulation. Every command accepts it, so you
can also `ghuri shell --remote` to inspect production data. Use that one carefully.

:::note[Alpha]
Remote commands go through Wrangler's platform proxy. Large migrations on D1 can be slow over
that path; if one times out, generate plain SQL with
`npx ghuri sqlmigrate --all --dialect sqlite --out migrations-sql/` and apply it with
`wrangler d1 migrations apply`. See [Deploy to Cloudflare](/docs/deployment/cloudflare/).
:::

## Deploy

```sh
npx ghuri deploy
```

`ghuri deploy` runs `wrangler deploy`, which bundles `src/index.ts` and everything it imports
(your apps, models, migrations index and admin) into a single Worker and uploads it. When it
finishes it prints your URL:

```
Deployed mysite triggers
  https://mysite.<your-subdomain>.workers.dev
```

Open `https://mysite.<your-subdomain>.workers.dev/admin/`, log in with the superuser you just
created, and write a post. Then fetch it from the API:

```sh
curl https://mysite.<your-subdomain>.workers.dev/blog/api/posts/
```

## Tighten production settings

Before you share the URL, restrict hosts and trust your own origin for CSRF:

```ts title="src/settings.ts"
export default defineSettings((env) => ({
  // ...
  ALLOWED_HOSTS: env.DEBUG === 'true' ? ['*'] : ['blog.example.com', 'mysite.example.workers.dev'],
  CSRF_TRUSTED_ORIGINS: ['https://blog.example.com'],
}))
```

To serve the site on your own domain, add a route or custom domain in `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
"routes": [{ "pattern": "blog.example.com", "custom_domain": true }]
```

## The deploy loop

From now on, shipping a change that touches models is:

```sh
npx ghuri makemigrations
npx ghuri migrate            # local
npx ghuri test
npx ghuri migrate --remote   # production database
npx ghuri deploy             # production code
```

Run `migrate --remote` before `deploy` when you add tables or columns, so the new code never
sees an old schema. When you remove a column, deploy the code that stops using it first and
migrate afterwards.

:::tip[If you know Django]
The order of operations is the same as for any Django deployment: migrate, then switch traffic
to new code. What disappears is the server: there is no gunicorn to restart, no `collectstatic`
(the admin's CSS is embedded in the Worker) and no process manager.
:::

## Where to go from here

You have built and deployed a Django-style application on Cloudflare. Some next steps:

- When the blog outgrows D1, follow [Migrating from D1 to Postgres](/docs/deployment/d1-to-postgres/).
  Your models, views and serializers will not change.
- To run on your own server, read [Node and Postgres on a VPS](/docs/deployment/node-postgres/)
  or [Docker](/docs/deployment/docker/).
- Let an AI assistant manage posts through your API with [AI agents and MCP](/docs/topics/agents/).
- Browse the topic guides, starting with [Making queries](/docs/topics/queries/).
