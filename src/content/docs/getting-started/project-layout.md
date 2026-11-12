---
title: Project layout
description: What ghuri startproject and ghuri startapp generate, file by file.
---

`npm create ghuri@latest mysite` (which runs `ghuri startproject`) produces this tree:

```
mysite/
├── package.json         # scripts + "ghuri": { "settings": "src/settings.ts" }
├── wrangler.jsonc       # Worker config: nodejs_compat, D1 "DB", R2 "MEDIA" (not for --db sqlite)
├── tsconfig.json
├── vitest.config.ts     # `ghuri test` runs vitest (decorators enabled for tests)
├── .dev.vars            # local secrets: a random SECRET_KEY, DEBUG=true (git-ignored)
├── .dev.vars.example    # committed template of .dev.vars
├── .gitignore
├── README.md
└── src/
    ├── index.ts         # Worker entry: export default createApp(settings)
    ├── server.ts        # Node entry, for a VPS or Docker
    ├── settings.ts      # the project's settings
    └── urls.ts          # root URL patterns (ROOT_URLCONF) and the REST router
```

The examples on this page are the default `--db d1` template. The `postgres` and `sqlite`
variants differ only in `DATABASES`, `STORAGES` and the wrangler bindings.

## The project files

### `src/settings.ts`

Settings are a function of the environment. On Workers `env` holds your bindings and vars; on
Node it is `process.env`. Read [Settings](/docs/topics/settings/) for the full story.

```ts title="src/settings.ts"
import { AdminConfig } from '@ghuri/admin'
import {
  AuthConfig, AuthenticationMiddleware, AuthTokenConfig, ContentTypesConfig,
  SessionMiddleware, SessionsConfig,
} from '@ghuri/auth'
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
import {
  CommonMiddleware, CsrfMiddleware, defineSettings, kvCache, memoryCache,
  SecurityMiddleware, XFrameOptionsMiddleware,
} from '@ghuri/core'
import { d1, postgres } from '@ghuri/orm'
import { IsAuthenticatedOrReadOnly, PageNumberPagination } from '@ghuri/rest'
import { r2 } from '@ghuri/storage'
import { urlpatterns } from './urls'

export default defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  DEBUG: env.DEBUG === 'true',
  ALLOWED_HOSTS: env.ALLOWED_HOSTS ? String(env.ALLOWED_HOSTS).split(',') : ['*'],

  INSTALLED_APPS: [
    ContentTypesConfig,
    AuthConfig,
    SessionsConfig,
    AuthTokenConfig,
    AdminConfig,
  ],

  MIDDLEWARE: [
    SecurityMiddleware,
    CommonMiddleware,
    SessionMiddleware,
    CsrfMiddleware,
    AuthenticationMiddleware,
    XFrameOptionsMiddleware,
  ],

  ROOT_URLCONF: urlpatterns,

  DATABASES: {
    // D1 on Cloudflare; set DATABASE_URL to use Postgres instead (Node / a VPS).
    default: env.DATABASE_URL ? postgres({ url: env.DATABASE_URL }) : d1('DB'),
  },

  STORAGES: {
    default: r2('MEDIA'),
  },
  MEDIA_URL: '/media/',

  CACHES: {
    // Workers KV when the CACHE binding exists, otherwise an in-memory cache.
    default: env.CACHE ? kvCache('CACHE') : memoryCache(),
  },

  AUTH_USER_MODEL: 'auth.User',

  REST_FRAMEWORK: {
    DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, TokenAuthentication],
    DEFAULT_PERMISSION_CLASSES: [IsAuthenticatedOrReadOnly],
    DEFAULT_PAGINATION_CLASS: PageNumberPagination,
    PAGE_SIZE: 20,
  },

  TIME_ZONE: 'UTC',
  USE_TZ: true,
}))
```

The installed apps are Django's `contenttypes`, `auth`, `sessions`, DRF's `authtoken`, and
`admin`. Their tables use Django's names (`auth_user`, `django_session`, `authtoken_token`,
`django_admin_log`, …). `AuthConfig` refuses to start without `ContentTypesConfig` before it.

With `--db postgres`, `DATABASES` reads
`env.HYPERDRIVE ? postgres({ hyperdrive: 'HYPERDRIVE' }) : postgres({ url: env.DATABASE_URL })`.
With `--db sqlite`, it is `sqlite({ filename: env.DATABASE_PATH ?? 'db.sqlite3' })` from
`@ghuri/orm/sqlite` (or Postgres when `DATABASE_URL` is set), and `STORAGES` uses
`fileSystemStorage({ location: 'media', baseUrl: '/media/' })` from `@ghuri/storage/fs`.

### `src/urls.ts`

The root URLconf. Unlike Django, `ROOT_URLCONF` is the pattern array itself, not a dotted
module path, so the settings file imports it directly. The REST API router lives here too.

```ts title="src/urls.ts"
import { admin } from '@ghuri/admin'
import { include, path } from '@ghuri/core'
import { DefaultRouter } from '@ghuri/rest'
import type { Context } from 'hono'

/** REST API router: register viewsets here, e.g. `router.register('posts', PostViewSet)`. */
export const router = new DefaultRouter()

function home(c: Context) {
  return c.json({ project: 'mysite', admin: '/admin/', api: '/api/' })
}

export const urlpatterns = [
  path('', home, { name: 'home' }),
  path('admin/', admin.site.urls),
  path('api/', include(router.urls)),
]
```

### `src/index.ts` and `src/server.ts`

These are the equivalents of Django's `wsgi.py`/`asgi.py`: the place a runtime enters your app.

```ts title="src/index.ts"
import { createApp } from '@ghuri/core'
import settings from './settings'

export default createApp(settings)
```

```ts title="src/server.ts"
import { createApp } from '@ghuri/core'
import { serve } from '@ghuri/core/node'
import settings from './settings'

serve(createApp(settings), {
  port: Number(process.env.PORT ?? 8000),
  env: process.env,
})
```

`createApp()` returns a Workers module handler with `fetch`, `scheduled` and `queue`, so
`src/index.ts` also serves Cron Triggers and Queues. `npm start` runs `src/server.ts` on Node.
You only ever use one of them in a given deployment. Keeping both in the project costs nothing
and means the Node path is always one command away.

### `wrangler.jsonc`

Declares the Worker and the Cloudflare resources the default settings expect (comments
trimmed):

```jsonc title="wrangler.jsonc"
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mysite",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  // Placeholder id: fine locally. Before deploying: npx wrangler d1 create mysite-db
  "d1_databases": [
    { "binding": "DB", "database_name": "mysite-db", "database_id": "00000000-0000-0000-0000-000000000000" }
  ],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "mysite-media" }],
  // Optional KV cache: kvCache('CACHE') is used when the binding exists.
  // "kv_namespaces": [{ "binding": "CACHE", "id": "<namespace id>" }],
  "vars": { "DEBUG": "false" }
}
```

The binding names (`DB`, `MEDIA`, `CACHE`) are what settings refer to in `d1('DB')`,
`r2('MEDIA')` and `kvCache('CACHE')`. The `postgres` template replaces `d1_databases` with a
commented-out `hyperdrive` binding.

### `package.json`

```json title="package.json (excerpt)"
{
  "type": "module",
  "ghuri": { "settings": "src/settings.ts" },
  "scripts": {
    "dev": "ghuri runserver",
    "deploy": "ghuri deploy",
    "start": "node --import jiti/register src/server.ts",
    "migrate": "ghuri migrate",
    "makemigrations": "ghuri makemigrations",
    "check": "ghuri check",
    "test": "ghuri test",
    "typecheck": "tsc --noEmit",
    "ghuri": "ghuri"
  }
}
```

The `ghuri.settings` key is how the CLI finds your project. It plays the role of
`DJANGO_SETTINGS_MODULE`. In a `--db sqlite` project `dev` is `ghuri runserver --node` and there
is no `deploy` script. `@ghuri/cli`, `wrangler` and `vitest` are dev dependencies, so
`npx ghuri` uses the project's own copy.

## Apps

Functionality lives in apps. `npx ghuri startapp blog` creates:

```
src/blog/
├── app.ts            # BlogConfig (AppConfig subclass)
├── models.ts         # commented-out example model
├── views.ts          # an `index` view returning JSON
├── urls.ts           # urlpatterns('blog', [...])
├── serializers.ts    # REST serializers
├── admin.ts          # ModelAdmin registrations
├── tests.ts          # a vitest test for the index view
└── migrations/
    └── index.ts      # generated by makemigrations; do not edit by hand
```

and adds `BlogConfig` to `INSTALLED_APPS` in `src/settings.ts` (import plus list entry). Pass
`--no-register` to skip that. It does not touch `src/urls.ts`; it prints the line to add. See
[Applications](/docs/topics/applications/).

:::tip[If you know Django]
The mapping is one to one: `apps.py` → `app.ts`, `settings.py` → `settings.ts`, `urls.py` →
`urls.ts`, `wsgi.py` → `index.ts` / `server.ts`, `manage.py` → `npx ghuri`. The only new file is
`wrangler.jsonc`, which describes the Cloudflare resources your Worker can use.

One structural difference: Ghuri apps are wired with ES imports rather than discovered from
dotted strings. `AppConfig` imports its own `models`, `migrations` and `admin` modules, and
`INSTALLED_APPS` holds classes, not strings. This is what lets a bundler build a Worker without
any filesystem scanning at runtime.
:::

## Why there is no `manage.py`

Workers have no filesystem and no long-running process, so commands cannot run "inside" the
deployed app. The `ghuri` CLI runs on your machine, loads your settings with
[jiti](https://github.com/unjs/jiti), builds the `env` from `wrangler.jsonc` bindings (local
by default, remote with `--remote`) merged with `process.env`, `.dev.vars` and `.env` files,
and then runs the command against that environment. See the [CLI reference](/docs/reference/cli/).
