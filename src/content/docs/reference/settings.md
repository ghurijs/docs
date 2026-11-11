---
title: Settings reference
description: Every setting read by Ghuri's packages, with types, defaults and meaning.
---

Settings are defined with `defineSettings((env) => ({ … }))` in `src/settings.ts`. See
[Settings](/docs/topics/settings/) for how they are resolved. Keys are `UPPER_SNAKE_CASE`, like
Django; option objects passed to adapters and classes are `camelCase`.

Each package adds its keys to the `GhuriSettings` interface through declaration merging, so
your editor knows about a key as soon as the package that reads it is installed.

:::tip[If you know Django]
Where a setting exists in Django or DRF, it has the same name and meaning. The main
differences: values that Django takes as dotted import strings (`ROOT_URLCONF`,
`INSTALLED_APPS`, `MIDDLEWARE`, backend classes) are imported values here, and backends are
configured with factory functions like `d1('DB')` rather than `{'ENGINE': …}` dicts.
:::

## Core (`@ghuri/core`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `SECRET_KEY` | `string` | required | Signs sessions, CSRF tokens, password reset tokens and signed cookies. Required unless `DEBUG` is true. Set with `wrangler secret put` or the environment. |
| `DEBUG` | `boolean` | `false` | Detailed error pages with stack traces, startup checks. Never true in production. |
| `ALLOWED_HOSTS` | `string[]` | `['*']` | Host header values the site will serve. A leading dot matches subdomains (`.example.com`). Enforced by `CommonMiddleware`. |
| `INSTALLED_APPS` | `Array<AppConfigClass \| AppConfig>` | required | Apps in the project, in order. Order matters for `ready()` calls and command overrides. |
| `MIDDLEWARE` | `Array<MiddlewareClass \| MiddlewareHandler>` | `[]` | Middleware classes or plain Hono middleware, outermost first. |
| `ROOT_URLCONF` | `UrlPatterns` | required | The root URL pattern array (imported, not a dotted path). |
| `APPEND_SLASH` | `boolean` | `true` | Redirect `GET /x` to `/x/` with a 301 when `/x` does not match but `/x/` does. |
| `TIME_ZONE` | `string` | `'UTC'` | Default time zone for date handling and the admin. |
| `USE_TZ` | `boolean` | `true` | Store datetimes in UTC. |
| `CACHES` | `Record<string, CacheConfig>` | `{ default: memoryCache() }` | Cache backends by alias: `memoryCache()`, `kvCache(binding)`, `cfCache()`. |
| `CSRF_TRUSTED_ORIGINS` | `string[]` | `[]` | Extra origins (`https://app.example.com`) allowed to send unsafe requests. |
| `CORS` | `{ allowOrigins: string[] \| '*'; allowCredentials?: boolean } \| false` | `false` | Configuration for `CorsMiddleware`. `false` disables CORS headers. |

## Database (`@ghuri/orm`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `DATABASES` | `Record<string, DatabaseConfig>` | required | Database connections by alias. `default` is used unless a query says otherwise. |

Database configs are created with:

| Factory | Import from | Runtime | Notes |
|---|---|---|---|
| `d1(binding)` | `@ghuri/orm` | Workers | Cloudflare D1 (SQLite dialect). No interactive transactions. |
| `postgres({ url?, hyperdrive?, max? })` | `@ghuri/orm` | Workers, Node | postgres.js. `hyperdrive` names a Hyperdrive binding; `url` is a connection string; `max` is the pool size. |
| `sqlite({ filename })` | `@ghuri/orm/sqlite` | Node | better-sqlite3. Good for local development and small single-server sites. |
| `pglite({ dataDir? })` | `@ghuri/orm/pglite` | Node | Embedded Postgres (PGlite). Mainly for tests; in-memory without `dataDir`. |

```ts
DATABASES: {
  default: env.DATABASE_URL ? postgres({ url: env.DATABASE_URL }) : d1('DB'),
},
```

## Auth (`@ghuri/auth`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `AUTH_USER_MODEL` | `string` | `'auth.User'` | The user model, as `'app_label.Model'`. Set before the first migration. |
| `AUTHENTICATION_BACKENDS` | `AuthBackendClass[]` | `[ModelBackend]` | Tried in order by `authenticate()`. |
| `PASSWORD_HASHERS` | `PasswordHasherClass[]` | `[PBKDF2PasswordHasher]` | The first hashes new passwords; all are accepted when checking. Hashes are upgraded on login when the first hasher changes. |
| `AUTH_PASSWORD_VALIDATORS` | `Array<{ validator, options? }>` | `[]` | Run by `createsuperuser`, `changepassword` and `validatePassword()`. Built-ins: minimum length, common password, numeric, user attribute similarity. |
| `SESSION_ENGINE` | `'db' \| 'kv' \| 'signedCookie'` | `'db'` | Where `SessionMiddleware` stores sessions. `kv` uses the cache binding configured for sessions. |
| `SESSION_COOKIE_NAME` | `string` | `'sessionid'` | Session cookie name. |
| `SESSION_COOKIE_AGE` | `number` (seconds) | `1209600` (two weeks) | Session lifetime. |
| `SESSION_COOKIE_SECURE` | `boolean` | `!DEBUG` | Send the session cookie over HTTPS only. |
| `SESSION_COOKIE_SAMESITE` | `'Lax' \| 'Strict' \| 'None'` | `'Lax'` | `SameSite` attribute of the session cookie. |
| `LOGIN_URL` | `string` | `'/accounts/login/'` | Where `loginRequired` redirects anonymous users. |
| `LOGIN_REDIRECT_URL` | `string` | `'/'` | Default redirect after login. |

The session cookie settings and `LOGIN_URL` follow Django's names and defaults; check the
[Authentication](/docs/topics/authentication/) page for the current list while the package is in
alpha.

`PBKDF2PasswordHasher` produces Django-compatible `pbkdf2_sha256$<iterations>$<salt>$<hash>`
strings, so users imported from a Django database can log in unchanged.

## Storage (`@ghuri/storage`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `STORAGES` | `Record<string, StorageConfig>` | `{}` | Storage backends by alias. `FileField` uses `default` unless given `storage`. |
| `MEDIA_URL` | `string` | `'/media/'` | URL prefix for files served by `serveMedia()` when a storage has no public URL. |

Storage configs:

| Factory | Import from | Notes |
|---|---|---|
| `r2(binding, { publicUrl? })` | `@ghuri/storage` | Cloudflare R2 binding. |
| `s3({ endpoint, bucket, accessKeyId, secretAccessKey, region?, publicUrl? })` | `@ghuri/storage` | Any S3 API: AWS, R2's S3 endpoint, MinIO. Uses aws4fetch, works on Workers and Node. |
| `memoryStorage()` | `@ghuri/storage` | In-memory; for tests. |
| `fileSystemStorage({ location, baseUrl })` | `@ghuri/storage/fs` | Local disk, Node only. |

## REST framework (`@ghuri/rest`)

All REST settings live in one object, as in DRF:

```ts
REST_FRAMEWORK: {
  DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, TokenAuthentication],
  DEFAULT_PERMISSION_CLASSES: [IsAuthenticatedOrReadOnly],
  DEFAULT_PAGINATION_CLASS: PageNumberPagination,
  PAGE_SIZE: 20,
},
```

| Key | Type | Default | Description |
|---|---|---|---|
| `DEFAULT_AUTHENTICATION_CLASSES` | `AuthenticationClass[]` | `[SessionAuthentication]` when `@ghuri/auth` is installed, else `[]` | Used by views that do not set `authenticationClasses`. |
| `DEFAULT_PERMISSION_CLASSES` | `PermissionClass[]` | `[AllowAny]` | Used by views that do not set `permissionClasses`. |
| `DEFAULT_PAGINATION_CLASS` | `PaginationClass \| null` | `null` | Pagination for list views. |
| `PAGE_SIZE` | `number \| null` | `null` | Page size for the default paginator. |
| `DEFAULT_FILTER_BACKENDS` | `FilterBackendClass[]` | `[]` | Filter backends for generic views. |
| `DEFAULT_THROTTLE_CLASSES` | `ThrottleClass[]` | `[]` | Throttles applied to every API view. |
| `DEFAULT_THROTTLE_RATES` | `Record<string, string>` | `{}` | Rates by scope, e.g. `{ anon: '100/day', user: '1000/day' }`. |
| `SEARCH_PARAM` | `string` | `'search'` | Query parameter read by `SearchFilter`. |
| `ORDERING_PARAM` | `string` | `'ordering'` | Query parameter read by `OrderingFilter`. |
| `NON_FIELD_ERRORS_KEY` | `string` | `'non_field_errors'` | Key for errors not tied to a field (DRF-compatible). |

Authentication classes (`SessionAuthentication`, `TokenAuthentication`, `JWTAuthentication`,
`BasicAuthentication`) are imported from `@ghuri/auth/rest`. See
[REST framework](/docs/topics/rest/).

## Admin (`@ghuri/admin`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `ADMIN_ASSETS` | `{ htmx?: string }` | htmx from a public CDN | Override where the admin loads htmx from (for example, a self-hosted copy for strict CSPs or offline intranets). |

Site titles are set on the `AdminSite` (`admin.site.siteHeader = 'My blog'`), not in settings.

## Agents (`@ghuri/agents`)

```ts
AGENTS: {
  DEFAULT_MODEL: 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  AI_BINDING: 'AI',
  PROVIDERS: { anthropic: { apiKey: env.ANTHROPIC_API_KEY } },
  MAX_STEPS: 8,
},
```

| Key | Type | Default | Description |
|---|---|---|---|
| `DEFAULT_MODEL` | `string` | none | Model used by agents that do not set `model`, as `provider:model`. |
| `AI_BINDING` | `string` | `'AI'` | Workers AI binding name for the `workers-ai` provider. |
| `PROVIDERS` | `Record<string, { apiKey?: string; baseURL?: string }>` | `{}` | Credentials per provider (`anthropic`, `openai`, …). |
| `MAX_STEPS` | `number` | `5` | Maximum tool-call steps per agent turn. |

:::note[Alpha]
The `AGENTS` keys and their defaults may change while `@ghuri/agents` is in alpha. See
[AI agents and MCP](/docs/topics/agents/).
:::

## Reading settings in your code

```ts
import { getSettings, setting } from '@ghuri/core'

const debug = getSettings().DEBUG
const pageSize = setting('PAGE_SIZE', 20)   // with a fallback
```

Both need a Ghuri context: inside a request, a command, or a test that called `app.setup(env)`.
Custom keys are allowed; declare them for type checking:

```ts title="src/settings.ts"
declare module '@ghuri/core' {
  interface GhuriSettings {
    BLOG_POSTS_PER_PAGE?: number
  }
}
```
