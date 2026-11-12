---
title: Node and Postgres on a VPS
description: Run a Ghuri project on Node with Postgres, S3 or filesystem storage, systemd and a reverse proxy.
---

The same project that runs on Workers runs on Node. You switch the entry file
(`src/server.ts` instead of `src/index.ts`) and the adapters in settings. Models, views,
serializers and admin classes do not change.

This page sets up a single Linux server (any VPS: Hetzner, DigitalOcean, EC2, a box under your
desk) with Postgres, Caddy in front and systemd keeping the process alive. For containers, see
[Docker](/docs/deployment/docker/).

:::tip[If you know Django]
This is the classic Django deployment with the names changed: `server.ts` is your
`wsgi.py`, `@ghuri/core/node` (built on `@hono/node-server`) is gunicorn, Caddy or nginx sits in
front, and systemd restarts the process. There is no `collectstatic`: the admin ships its CSS
inside the package and loads htmx from a CDN (override with `ADMIN_ASSETS`).
:::

## 1. Settings for Node

A project generated with `--db d1` already switches `DATABASES` to Postgres when `DATABASE_URL`
is set, and its cache falls back to `memoryCache()` without a `CACHE` binding. Storage is the one
thing you must change: `r2('MEDIA')` needs a Worker binding, which Node does not have. Make the
adapters depend on the environment so the same file works in both places:

```ts title="src/settings.ts"
import { defineSettings, kvCache, memoryCache } from '@ghuri/core'
import { d1, postgres } from '@ghuri/orm'
import { r2, s3 } from '@ghuri/storage'

export default defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  DEBUG: env.DEBUG === 'true',
  ALLOWED_HOSTS: env.ALLOWED_HOSTS ? String(env.ALLOWED_HOSTS).split(',') : ['*'],
  CSRF_TRUSTED_ORIGINS: env.CSRF_TRUSTED_ORIGINS ? env.CSRF_TRUSTED_ORIGINS.split(',') : [],
  // …INSTALLED_APPS, MIDDLEWARE, ROOT_URLCONF as before
  DATABASES: {
    default: env.DATABASE_URL ? postgres({ url: env.DATABASE_URL, max: 10 }) : d1('DB'),
  },
  STORAGES: {
    default: env.S3_BUCKET
      ? s3({
          endpoint: env.S3_ENDPOINT,
          bucket: env.S3_BUCKET,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          region: env.S3_REGION ?? 'auto',
          publicUrl: env.MEDIA_PUBLIC_URL,
        })
      : r2('MEDIA'),
  },
  CACHES: { default: env.CACHE ? kvCache('CACHE') : memoryCache() },
}))
```

Notes on each adapter:

- **`postgres({ url })`** uses [postgres.js](https://github.com/porsager/postgres) under the
  hood. `max` is the pool size per process; keep `processes × max` below Postgres'
  `max_connections`.
- **`s3()`** speaks the S3 API, so it works with AWS S3, MinIO, Backblaze B2, and with R2 itself
  through R2's S3-compatible endpoint. Keeping your files in R2 while the app moves to a VPS is
  a perfectly good setup.
- **Filesystem storage** is available from `@ghuri/storage/fs` if you would rather keep uploads
  on the server's disk:

  ```ts
  import { fileSystemStorage } from '@ghuri/storage/fs'

  STORAGES: { default: fileSystemStorage({ location: '/var/lib/mysite/media', baseUrl: '/media/' }) },
  ```

  Remember to back that directory up, and serve it from the reverse proxy.
- **`memoryCache()`** is per process. With several processes each has its own cache, which is
  fine for memoization but not for rate limiting or anything that needs to be shared. A Redis
  backend is on the roadmap.

:::caution
`@ghuri/orm/sqlite` imports `better-sqlite3`, a native Node addon that cannot be bundled for
Workers. Do not import it statically from a settings file that is also bundled for Workers; keep a
separate `settings.node.ts`, or load it with a dynamic `import()` whose specifier is not a string
literal, so the bundler leaves it out (`examples/blog` loads PGlite this way).

`@ghuri/storage/fs` only imports `node:fs`, `node:path` and `node:stream`, which Workers provide
under `nodejs_compat`, so a shared settings file can import it and choose the backend at runtime:
`env.MEDIA ? r2('MEDIA') : fileSystemStorage({ ... })`, as `examples/blog` does. Only use it off
Workers, whose filesystem is not persistent.

A project created with `--db sqlite` is Node-only and already uses both (`sqlite({ filename })`
and `fileSystemStorage({ location: 'media', baseUrl: '/media/' })`), with Postgres when
`DATABASE_URL` is set.
:::

## 2. The entry file

```ts title="src/server.ts"
import { createApp } from '@ghuri/core'
import { serve } from '@ghuri/core/node'
import settings from './settings'

serve(createApp(settings), {
  port: Number(process.env.PORT ?? 8000),
  env: process.env,
})
```

This is the generated `src/server.ts`. `serve()` from `@ghuri/core/node` runs the app on
`@hono/node-server`, binds `0.0.0.0` by default (`hostname: '127.0.0.1'` for local only), gives
`waitUntil()` a Node implementation, and closes gracefully on `SIGINT` / `SIGTERM`. It passes
`process.env` as `env`, so `env.DATABASE_URL` in settings is `process.env.DATABASE_URL`. Try it
locally:

```sh
DATABASE_URL=postgres://localhost/mysite SECRET_KEY=dev npm start
```

`npm start` is `node --import jiti/register src/server.ts`: it runs the TypeScript sources
directly with [jiti](https://github.com/unjs/jiti) (a dependency of the generated project), no
build step. During development, `npx ghuri runserver --node` serves the same app in-process on
port 8000 with the CLI's environment (`.dev.vars`, `.env` files, local Wrangler bindings).

If you use [WebSockets](/docs/topics/websockets/), attach them to the server `serve()` returns:

```ts title="src/server.ts"
import { attachRealtime } from '@ghuri/realtime/node'

const app = createApp(settings)
const server = await serve(app, { port: Number(process.env.PORT ?? 8000), env: process.env })
attachRealtime(server, app, { env: process.env })
```

Rooms then live in this process (`memoryLayer()`), so run **one** Node process per site until a
shared layer is available.

## 3. Build or run TypeScript directly?

`npm start` works in production as it is. If you prefer a compiled artefact, build a single ESM
bundle with tsup:

```sh
npm install -D tsup
```

```json title="package.json (excerpt)"
"scripts": {
  "build:node": "tsup src/server.ts --format esm --target node22 --out-dir dist --clean",
  "start": "node dist/server.js"
}
```

Why: the production process starts faster, does not need a TypeScript loader at runtime, and
fails at build time rather than at boot if an import is broken. esbuild (inside tsup) also lowers
the standard decorators that `@admin.register` and `@action` use.
Keep `pg`-family drivers and other native or Node-only packages external (tsup leaves
`dependencies` external by default), and keep `node_modules` installed with
`npm ci --omit=dev`.

The `ghuri` CLI is different: it loads your TypeScript sources with jiti every time, so
management commands such as `migrate` need the `src/` directory and `@ghuri/cli` (a dev
dependency in the generated `package.json`) on the machine that runs them. Either keep the
repository checkout and dev dependencies on the server (simplest) or run migrations from CI
against the production `DATABASE_URL`. Without a wrangler config, or without Wrangler
installed, the CLI builds `env` from `process.env` and `.env` files only.

## 4. Prepare the server

Install Node 22 LTS and Postgres, then create a database and a role:

```sh
sudo -u postgres createuser --pwprompt mysite
sudo -u postgres createdb --owner mysite mysite
```

Deploy the code (git clone, rsync, or your CI) to `/srv/mysite`, then:

```sh
cd /srv/mysite
npm ci
npm run build:node
```

Put the environment in a file readable only by the service user:

```ini title="/etc/mysite.env"
SECRET_KEY=…long random string…
DEBUG=false
DATABASE_URL=postgres://mysite:password@localhost:5432/mysite
ALLOWED_HOSTS=blog.example.com
CSRF_TRUSTED_ORIGINS=https://blog.example.com
PORT=8000
```

Apply migrations and create a superuser:

```sh
set -a; . /etc/mysite.env; set +a
npx ghuri migrate
npx ghuri createsuperuser
```

## 5. systemd

```ini title="/etc/systemd/system/mysite.service"
[Unit]
Description=mysite (Ghuri)
After=network.target postgresql.service

[Service]
Type=simple
User=mysite
WorkingDirectory=/srv/mysite
EnvironmentFile=/etc/mysite.env
ExecStart=/usr/bin/node dist/server.js
# without a build step: ExecStart=/usr/bin/node --import jiti/register src/server.ts
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now mysite
journalctl -u mysite -f
```

One Node process uses one CPU core. To use more, run several instances on different ports
(a templated `mysite@.service` with `PORT=800%i`) and let the proxy balance across them.

## 6. Reverse proxy

Caddy obtains and renews TLS certificates automatically, which makes it the shortest path:

```caddy title="/etc/caddy/Caddyfile"
blog.example.com {
    encode gzip
    # only if you use fileSystemStorage
    handle_path /media/* {
        root * /var/lib/mysite/media
        file_server
    }
    reverse_proxy localhost:8000
}
```

The nginx equivalent:

```nginx title="/etc/nginx/sites-available/mysite"
server {
    server_name blog.example.com;
    client_max_body_size 20m;

    location /media/ { alias /var/lib/mysite/media/; }

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSockets (@ghuri/realtime)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
    }
}

# in the http {} block (for example /etc/nginx/conf.d/upgrade.conf)
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Pass the original `Host` header through: `ALLOWED_HOSTS`, the CSRF origin check and the WebSocket
origin check compare against it. Caddy proxies WebSocket upgrades without extra configuration.

## Security checklist

| Setting | Production value |
|---|---|
| `DEBUG` | `false` |
| `SECRET_KEY` | long, random, only in the environment file |
| `ALLOWED_HOSTS` | your domain names, not `'*'` |
| `CSRF_TRUSTED_ORIGINS` | `https://` origins of every site that posts forms to you |
| `CORS` | `false` unless a browser app on another origin calls your API |

Run `npx ghuri check --deploy` after changing settings; it runs the checks the app runs at
startup in debug mode plus the production ones.

## See also

- [Docker](/docs/deployment/docker/)
- [Migrating from D1 to Postgres](/docs/deployment/d1-to-postgres/)
- [File storage](/docs/topics/file-storage/)
