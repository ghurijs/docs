---
title: Settings
description: How Ghuri settings work, why they are a function of the environment, and how packages add their own keys.
---

A Ghuri project is configured by one file, `src/settings.ts`, whose default export is created
with `defineSettings()`. Keys keep Django's `UPPER_SNAKE` names, so `INSTALLED_APPS`,
`MIDDLEWARE`, `DATABASES` and friends mean what you expect.

```ts title="src/settings.ts"
import { defineSettings, SecurityMiddleware, CommonMiddleware, CsrfMiddleware, kvCache, memoryCache } from '@ghuri/core'
import { d1, postgres } from '@ghuri/orm'
import { r2 } from '@ghuri/storage'
import { AuthConfig, SessionMiddleware, AuthenticationMiddleware } from '@ghuri/auth'
import { AdminConfig } from '@ghuri/admin'
import { BlogConfig } from './blog/app'
import { urlpatterns } from './urls'

export default defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  DEBUG: env.DEBUG === 'true',
  ALLOWED_HOSTS: ['blog.example.com', 'localhost'],
  INSTALLED_APPS: [AuthConfig, AdminConfig, BlogConfig],
  MIDDLEWARE: [SecurityMiddleware, CommonMiddleware, SessionMiddleware, CsrfMiddleware, AuthenticationMiddleware],
  ROOT_URLCONF: urlpatterns,
  DATABASES: {
    default: env.DATABASE_URL ? postgres({ url: env.DATABASE_URL }) : d1('DB'),
  },
  STORAGES: { default: r2('MEDIA', { publicUrl: 'https://media.example.com' }) },
  CACHES: { default: env.CACHE ? kvCache('CACHE') : memoryCache() },
  TIME_ZONE: 'UTC',
}))
```

## Settings are a function of `env`

In Django, `settings.py` runs once at import time and reads `os.environ`. A Cloudflare Worker
has no process environment: secrets, variables and resource bindings (D1, R2, KV) arrive as an
`env` object passed to every request. So `defineSettings()` takes a function of `env` rather
than an object.

- **On Workers**, `env` is the Worker's environment: `vars` from `wrangler.jsonc`, secrets set
  with `wrangler secret put`, and bindings. Locally, `.dev.vars` fills in secrets.
- **On Node**, `env` is whatever you pass to `serve()`, normally `process.env`.
- **In the CLI**, `env` is built from `wrangler.jsonc` bindings (local, or remote with
  `--remote`) merged with `.dev.vars` and `process.env`.

The function runs once per distinct `env` object. The result is cached in a `WeakMap`, merged
over the defaults, and validated, so calling it is cheap and you can treat settings as constants
after startup. Because `env` values are always strings on Workers, convert explicitly:
`DEBUG: env.DEBUG === 'true'`, `PAGE_SIZE: Number(env.PAGE_SIZE ?? 20)`.

Adapters such as `d1('DB')`, `r2('MEDIA')` and `kvCache('CACHE')` take a **binding name**, not
a binding. They look the binding up on `env` when the first connection is made. That keeps
`settings.ts` free of runtime objects and is what lets the same file describe both a Worker and
a Node process.

:::tip[If you know Django]
`defineSettings((env) => ({...}))` is your `settings.py`, and `env` is `os.environ` plus the
Cloudflare resources. There is no `DJANGO_SETTINGS_MODULE`: the CLI finds the file through
`"ghuri": { "settings": "src/settings.ts" }` in `package.json`, and the Worker imports it
directly in `src/index.ts`. For different environments, branch on `env` inside the function
rather than keeping several settings modules.
:::

## Reading settings at runtime

Anywhere code runs inside a request (or a CLI command, or a test after `app.setup()`), read the
active settings with `getSettings()`:

```ts
import { getSettings, setting } from '@ghuri/core'

const debug = getSettings().DEBUG
const pageSize = setting('PAGE_SIZE', 20)   // with a default
```

Both read from the current [request context](#the-request-context). Calling them at module top
level, before any request, throws `ImproperlyConfigured`. That is deliberate: on Workers there
is no `env` until the first request arrives.

To reach a raw binding (for example a Workers AI binding that no Ghuri adapter wraps), use
`getEnv()`:

```ts
import { getEnv } from '@ghuri/core'

const answer = await getEnv().AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { prompt })
```

Prefer adapters where they exist. Code that touches `env.DB` directly will not survive a move
to Postgres.

## The request context

Settings, database connections, the current user and other per-request state live in a
`GhuriContext` carried by `AsyncLocalStorage` (which is why `nodejs_compat` is required).
`createApp()` wraps every request in `runWithContext()`. Outside requests, the CLI and test
helpers call `app.setup(env)`, which populates apps and installs a global fallback context.

```ts
interface GhuriContext {
  env: Env
  settings: GhuriSettings
  executionCtx?: { waitUntil(p: Promise<unknown>): void }
  request?: Request
  hono?: import('hono').Context
  state: Map<string | symbol, unknown>   // per-request cache
}
```

You rarely need it directly, but `getContext().executionCtx?.waitUntil(promise)` is the way to
run work after the response is sent on Workers.

## Package settings and type safety

`GhuriSettings` is an interface that each package extends with declaration merging. Installing
`@ghuri/orm` makes `DATABASES` a known, typed key; `@ghuri/rest` adds `REST_FRAMEWORK`, and so
on. You can do the same for your own settings:

```ts title="src/blog/settings.ts"
declare module '@ghuri/core' {
  interface GhuriSettings {
    BLOG_POSTS_PER_FEED?: number
  }
}
```

```ts
const perFeed = setting('BLOG_POSTS_PER_FEED', 20)
```

Unknown keys are allowed (the interface has an index signature), but declaring them gives you
autocompletion and catches typos.

## Validation and checks

When settings are first resolved, Ghuri checks the basics: `SECRET_KEY` must be set unless
`DEBUG` is on, and `INSTALLED_APPS` and `ROOT_URLCONF` must be arrays. Packages register
further system checks (for example, that `AUTH_USER_MODEL` names an installed model). Run them
with:

```sh
npx ghuri check
```

When `DEBUG` is on, checks also run at startup.

## Core settings

| Setting | Default | Meaning |
|---|---|---|
| `SECRET_KEY` | required | Signs sessions, CSRF tokens, password reset tokens. |
| `DEBUG` | `false` | Detailed error pages with stack traces; runs checks at startup. Never in production. |
| `ALLOWED_HOSTS` | `['*']` | Host header values the site will serve. Enforced by `CommonMiddleware`. |
| `INSTALLED_APPS` | required | `AppConfig` classes or instances, in order. |
| `MIDDLEWARE` | `[]` | Middleware classes or Hono middleware handlers, outermost first. |
| `ROOT_URLCONF` | required | The root URL pattern array. |
| `APPEND_SLASH` | `true` | Redirect `GET /x` to `/x/` when only the latter matches. |
| `TIME_ZONE` / `USE_TZ` | `'UTC'` / `true` | Time zone for date lookups and display. |
| `CACHES` | memory cache | Cache aliases. See [Caching](/docs/topics/caching/). |
| `CSRF_TRUSTED_ORIGINS` | `[]` | Extra origins allowed for unsafe requests. |
| `CORS` | `false` | `{ allowOrigins, allowCredentials }` for `CorsMiddleware`. |

Every setting from every package is listed in the [settings reference](/docs/reference/settings/).
