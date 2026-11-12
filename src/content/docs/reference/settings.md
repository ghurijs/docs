---
title: Settings reference
description: Every setting read by Ghuri's packages, with types, defaults and meaning.
---

Settings are defined with `defineSettings((env) => ({ … }))` in `src/settings.ts`. See
[Settings](/docs/topics/settings/) for how they are resolved. Keys are `UPPER_SNAKE_CASE`, like
Django; option objects passed to adapters and classes are `camelCase`.

Each package adds its keys to the `GhuriSettings` interface through declaration merging, so
your editor knows about a key as soon as the package that reads it is installed.
`npx ghuri diffsettings` prints the settings that differ from the defaults.

:::tip[If you know Django]
Where a setting exists in Django or DRF, it has the same name and meaning. The main
differences: values that Django takes as dotted import strings (`ROOT_URLCONF`,
`INSTALLED_APPS`, `MIDDLEWARE`, backend and validator classes) are imported values here, and
backends are configured with factory functions like `d1('DB')` rather than `{'ENGINE': …}`
dicts.
:::

## Core (`@ghuri/core`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `SECRET_KEY` | `string` | required | Signs sessions, CSRF tokens, password reset tokens and signed cookies. Required unless `DEBUG` is true. Set with `wrangler secret put` or the environment. |
| `DEBUG` | `boolean` | `false` | Detailed error pages with stack traces, startup system checks. Never true in production. |
| `ALLOWED_HOSTS` | `string[]` | `['*']` | Host header values the site will serve. A leading dot matches subdomains (`.example.com`). Enforced by the app on every request (400). With `DEBUG` and `[]`, `localhost`, `127.0.0.1` and `[::1]` are allowed. |
| `INSTALLED_APPS` | `Array<AppConfigClass \| AppConfig>` | required | Apps in the project, in order. Order matters for `ready()` calls and command overrides. |
| `MIDDLEWARE` | `Array<MiddlewareClass \| Middleware \| MiddlewareHandler>` | `[]` | Middleware classes, configured instances or plain Hono middleware, outermost first. |
| `ROOT_URLCONF` | `UrlPatterns` | required | The root URL pattern array (imported, not a dotted path). |
| `APPEND_SLASH` | `boolean` | `true` | Redirect `GET`/`HEAD /x` to `/x/` with a 301 when `/x` does not match but `/x/` does. |
| `PREPEND_WWW` | `boolean` | `false` | `CommonMiddleware` redirects `example.com` to `www.example.com`. |
| `TIME_ZONE` | `string` | `'UTC'` | Time zone used to display and edit datetimes (the admin). |
| `USE_TZ` | `boolean` | `true` | Accepted for Django parity; no Ghuri package reads it currently. |
| `CACHES` | `Record<string, CacheConfig>` | `{ default: memoryCache() }` | Cache backends by alias: `memoryCache()`, `kvCache(binding)`, `cfCache()`. See [Caching](/docs/topics/caching/). |
| `CORS` | `CorsOptions \| false` | `false` | Configuration for `CorsMiddleware`: `{ allowOrigins: string[] \| '*', allowCredentials?, allowMethods?, allowHeaders?, exposeHeaders?, maxAge? }`. |
| `API_PATH_PREFIXES` | `string[]` | `['/api']` | Errors for paths under these prefixes are always rendered as JSON. |
| `SILENCED_SYSTEM_CHECKS` | `string[]` | `[]` | System check ids to ignore, e.g. `['security.W004']`. |

### Security

Read by `SecurityMiddleware`, `XFrameOptionsMiddleware` and host handling. Names and defaults
follow Django.

| Setting | Type | Default | Description |
|---|---|---|---|
| `SECURE_SSL_REDIRECT` | `boolean` | `false` | Redirect HTTP requests to HTTPS. |
| `SECURE_SSL_HOST` | `string` | none | Host to redirect to instead of the request's. |
| `SECURE_REDIRECT_EXEMPT` | `string[]` | `[]` | Regexes (matched against the path without the leading `/`) exempt from the redirect. |
| `SECURE_HSTS_SECONDS` | `number` | `0` | `Strict-Transport-Security` max-age on HTTPS responses; `0` sends no header. |
| `SECURE_HSTS_INCLUDE_SUBDOMAINS` | `boolean` | `false` | Add `includeSubDomains` to HSTS. |
| `SECURE_HSTS_PRELOAD` | `boolean` | `false` | Add `preload` to HSTS. |
| `SECURE_CONTENT_TYPE_NOSNIFF` | `boolean` | `true` | Send `X-Content-Type-Options: nosniff`. |
| `SECURE_REFERRER_POLICY` | `string \| string[] \| false` | `'same-origin'` | `Referrer-Policy` header. |
| `SECURE_CROSS_ORIGIN_OPENER_POLICY` | `string \| false` | `'same-origin'` | `Cross-Origin-Opener-Policy` header. |
| `SECURE_PROXY_SSL_HEADER` | `[string, string]` | none | Header and value that mark a request as HTTPS behind a proxy, e.g. `['X-Forwarded-Proto', 'https']`. |
| `USE_X_FORWARDED_HOST` | `boolean` | `false` | Use `X-Forwarded-Host` as the request host. |
| `X_FRAME_OPTIONS` | `string \| false` | `'DENY'` | Value of `X-Frame-Options` set by `XFrameOptionsMiddleware`. |

### CSRF

| Setting | Type | Default | Description |
|---|---|---|---|
| `CSRF_TRUSTED_ORIGINS` | `string[]` | `[]` | Extra origins allowed to send unsafe requests (`'https://app.example.com'`, `'https://*.example.com'`). |
| `CSRF_COOKIE_NAME` | `string` | `'csrftoken'` | Name of the CSRF cookie. |
| `CSRF_HEADER_NAME` | `string` | `'X-CSRFToken'` | Header that carries the token. |
| `CSRF_COOKIE_AGE` | `number \| null` | `31449600` (one year) | Cookie lifetime in seconds; `null` for a session cookie. |
| `CSRF_COOKIE_DOMAIN` | `string` | none | Cookie domain, for cross-subdomain forms. |
| `CSRF_COOKIE_PATH` | `string` | `'/'` | Cookie path. |
| `CSRF_COOKIE_SECURE` | `boolean` | `false` | Send the cookie over HTTPS only. |
| `CSRF_COOKIE_HTTPONLY` | `boolean` | `false` | Hide the cookie from JavaScript (clients then read the token from the page). |
| `CSRF_COOKIE_SAMESITE` | `'Lax' \| 'Strict' \| 'None' \| false` | `'Lax'` | `SameSite` attribute. |

## Database (`@ghuri/orm`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `DATABASES` | `Record<string, DatabaseConfig>` | required by the ORM | Database connections by alias. `default` is used unless a query says otherwise (`.using('pg')`, `--database pg`). |

Database configs are created with:

| Factory | Import from | Runtime | Notes |
|---|---|---|---|
| `d1(binding)` | `@ghuri/orm` | Workers (and the CLI through wrangler) | Cloudflare D1 (SQLite dialect). No interactive transactions; use `connection.batch()` for all-or-nothing writes. |
| `postgres({ url?, hyperdrive?, max?, driverOptions? })` | `@ghuri/orm` | Workers, Node | postgres.js. `hyperdrive` names a Hyperdrive binding; `url` is a connection string; `max` is the pool size (default 5). |
| `sqlite({ filename, wal?, options? })` | `@ghuri/orm/sqlite` | Node | better-sqlite3 (`':memory:'` or a file; WAL on by default). Good for local development and small single-server sites. |
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
| `AUTHENTICATION_BACKENDS` | `Array<BackendClass \| BaseBackend>` | `[ModelBackend]` | Tried in order by `authenticate()`. |
| `PASSWORD_HASHERS` | `Array<HasherClass \| BasePasswordHasher>` | `[PBKDF2PasswordHasher, PBKDF2SHA1PasswordHasher, ScryptPasswordHasher]` | The first hashes new passwords; all are accepted when checking. Hashes are upgraded on login when the first hasher changes. Pass instances to configure them: `new PBKDF2PasswordHasher({ iterations: 600_000 })`. |
| `AUTH_PASSWORD_VALIDATORS` | `Array<{ NAME, OPTIONS? } \| ValidatorClass \| validator>` | `[]` | Run by `createsuperuser`, `changepassword` and `validatePassword()`. Built-ins: `MinimumLengthValidator`, `CommonPasswordValidator`, `NumericPasswordValidator`, `UserAttributeSimilarityValidator`. |
| `SECRET_KEY_FALLBACKS` | `string[]` | `[]` | Old secret keys still accepted for signatures, session hashes and reset tokens, for key rotation. |
| `LOGIN_URL` | `string` | `'/accounts/login/'` | Where `loginRequired` redirects anonymous users. |
| `LOGIN_REDIRECT_URL` | `string` | `'/accounts/profile/'` | Default redirect after login. |
| `LOGOUT_REDIRECT_URL` | `string \| null` | `null` | Redirect after logout. |
| `PASSWORD_RESET_TIMEOUT` | `number` (seconds) | `259200` (three days) | How long a password reset link stays valid. |
| `REMOTE_USER_HEADER` | `string` | `'Remote-User'` | Header read by `RemoteUserMiddleware`. |

`PBKDF2PasswordHasher` produces Django-compatible `pbkdf2_sha256$<iterations>$<salt>$<hash>`
strings, so users imported from a Django database can log in unchanged.

### Sessions

| Setting | Type | Default | Description |
|---|---|---|---|
| `SESSION_ENGINE` | `'db' \| 'kv' \| 'cache' \| 'signedCookie' \| SessionStoreClass` | `'db'` | Where `SessionMiddleware` stores sessions. |
| `SESSION_KV_BINDING` | `string` | `'SESSIONS'` | KV namespace binding used by the `kv` engine. |
| `SESSION_CACHE_ALIAS` | `string` | `'default'` | `CACHES` alias used by the `cache` engine. |
| `SESSION_COOKIE_NAME` | `string` | `'sessionid'` | Session cookie name. |
| `SESSION_COOKIE_AGE` | `number` (seconds) | `1209600` (two weeks) | Session lifetime. |
| `SESSION_COOKIE_DOMAIN` | `string \| null` | `null` | Cookie domain. |
| `SESSION_COOKIE_PATH` | `string` | `'/'` | Cookie path. |
| `SESSION_COOKIE_SECURE` | `boolean` | `false` | Send the session cookie over HTTPS only. Set it to `true` in production. |
| `SESSION_COOKIE_HTTPONLY` | `boolean` | `true` | Hide the cookie from JavaScript. |
| `SESSION_COOKIE_SAMESITE` | `'Lax' \| 'Strict' \| 'None' \| false` | `'Lax'` | `SameSite` attribute of the session cookie. |
| `SESSION_SAVE_EVERY_REQUEST` | `boolean` | `false` | Save (and extend) the session on every request. |
| `SESSION_EXPIRE_AT_BROWSER_CLOSE` | `boolean` | `false` | Use a browser-session cookie. |

### JWT

`JWT` (or its alias `SIMPLE_JWT`) configures `JWTAuthentication` and the token views, with
djangorestframework-simplejwt's names. Lifetimes are in seconds.

| Key | Default | Description |
|---|---|---|
| `ACCESS_TOKEN_LIFETIME` | `300` (5 minutes) | Access token lifetime. |
| `REFRESH_TOKEN_LIFETIME` | `86400` (1 day) | Refresh token lifetime. |
| `ROTATE_REFRESH_TOKENS` | `false` | Return a new refresh token on refresh. |
| `BLACKLIST_AFTER_ROTATION` | `false` | Blacklist the old refresh token (needs `TokenBlacklistConfig`). |
| `UPDATE_LAST_LOGIN` | `false` | Update `lastLogin` when a token pair is obtained. |
| `ALGORITHM` | `'HS256'` | Signing algorithm. |
| `SIGNING_KEY` / `VERIFYING_KEY` | `SECRET_KEY` / the signing key | Keys for signing and verifying. |
| `AUDIENCE` / `ISSUER` | none | `aud` / `iss` claims. |
| `LEEWAY` | `0` | Clock skew allowance in seconds. |
| `AUTH_HEADER_TYPES` | `['Bearer']` | Accepted `Authorization` prefixes. |
| `USER_ID_FIELD` / `USER_ID_CLAIM` | `'id'` / `'user_id'` | Which user field goes into which claim. |
| `TOKEN_TYPE_CLAIM` / `JTI_CLAIM` | `'token_type'` / `'jti'` | Claim names. |
| `CHECK_REVOKE_TOKEN` / `REVOKE_TOKEN_CLAIM` | `false` / `'hash_password'` | Invalidate tokens when the password changes. |

See [Authentication](/docs/topics/authentication/) and [API tokens](/docs/topics/auth-tokens/).

## Storage (`@ghuri/storage`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `STORAGES` | `Record<string, StorageConfig \| Storage>` | `{}` | Storage backends by alias. `FileField` uses `default` unless given `storage`. Using an alias that is not configured throws. |
| `MEDIA_URL` | `string` | `'/media/'` | Base URL of files for backends without a `publicUrl` / `baseUrl`. Mount `serveMedia()` / `mediaPatterns()` under it to serve files through the app. |
| `DELETE_FILES_ON_MODEL_DELETE` | `boolean` | `false` | Delete stored files when a model instance is deleted (Django keeps them). |

Storage configs:

| Factory | Import from | Notes |
|---|---|---|
| `r2(binding, { publicUrl?, cacheControl? })` | `@ghuri/storage` | Cloudflare R2 binding. |
| `s3({ bucket, accessKeyId, secretAccessKey, endpoint?, region?, publicUrl?, forcePathStyle?, cacheControl? })` | `@ghuri/storage` | Any S3 API: AWS, R2's S3 endpoint, MinIO. Uses signed `fetch`, works on Workers and Node. Supports `presignedUrl()`. |
| `memoryStorage({ baseUrl? })` | `@ghuri/storage` | In-memory; for tests and development. |
| `fileSystemStorage({ location, baseUrl? })` | `@ghuri/storage/fs` | Local disk, Node only. |

See [Storage backends](/docs/topics/storage-backends/).

## REST framework (`@ghuri/rest`)

All REST settings live in one object, as in DRF. Unset keys keep their defaults.

```ts
import { IsAuthenticatedOrReadOnly, PageNumberPagination } from '@ghuri/rest'
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'

REST_FRAMEWORK: {
  DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, TokenAuthentication],
  DEFAULT_PERMISSION_CLASSES: [IsAuthenticatedOrReadOnly],
  DEFAULT_PAGINATION_CLASS: PageNumberPagination,
  PAGE_SIZE: 20,
},
```

| Key | Default | Description |
|---|---|---|
| `DEFAULT_AUTHENTICATION_CLASSES` | `[MiddlewareAuthentication]` | Used by views that do not set `authenticationClasses`. The default trusts the user set by `AuthenticationMiddleware` and enforces CSRF like DRF's `SessionAuthentication`. |
| `DEFAULT_PERMISSION_CLASSES` | `[AllowAny]` | Used by views that do not set `permissionClasses`. |
| `DEFAULT_RENDERER_CLASSES` | `[JSONRenderer, BrowsableAPIRenderer]` | Response formats. |
| `DEFAULT_PARSER_CLASSES` | `[JSONParser, FormParser, MultiPartParser]` | Request body formats. |
| `DEFAULT_PAGINATION_CLASS` | `null` | Pagination for list views. |
| `PAGE_SIZE` | `null` | Page size for the default paginator. |
| `DEFAULT_FILTER_BACKENDS` | `[]` | Filter backends for generic views. |
| `DEFAULT_THROTTLE_CLASSES` | `[]` | Throttles applied to every API view. |
| `DEFAULT_THROTTLE_RATES` | `{ user: null, anon: null }` | Rates by scope, e.g. `{ anon: '100/day', user: '1000/day' }`. |
| `THROTTLE_CACHE` | `'default'` | `CACHES` alias that stores throttle history. |
| `NUM_PROXIES` | `null` | Proxies in front of the app, for client IP detection in throttles. |
| `DEFAULT_CONTENT_NEGOTIATION_CLASS` | `DefaultContentNegotiation` | Picks the renderer and parser. |
| `DEFAULT_METADATA_CLASS` | `SimpleMetadata` | Answers `OPTIONS` requests. |
| `DEFAULT_SCHEMA_CLASS` | `AutoSchema` | OpenAPI schema generation. |
| `EXCEPTION_HANDLER` | `exceptionHandler` | Turns exceptions into API responses. |
| `UNAUTHENTICATED_USER` / `UNAUTHENTICATED_TOKEN` | `() => new AnonymousUser()` / `null` | `request.user` / `request.auth` when nobody authenticated. |
| `SEARCH_PARAM` | `'search'` | Query parameter read by `SearchFilter`. |
| `ORDERING_PARAM` | `'ordering'` | Query parameter read by `OrderingFilter`. |
| `NON_FIELD_ERRORS_KEY` | `'nonFieldErrors'` | Key for errors not tied to a field (DRF uses `'non_field_errors'`; set that for DRF-compatible clients). |
| `URL_FORMAT_OVERRIDE` / `FORMAT_SUFFIX_KWARG` | `'format'` / `'format'` | `?format=json` and `.json` suffix handling. |
| `URL_FIELD_NAME` | `'url'` | Field name used by hyperlinked serializers. |
| `DATE_FORMAT`, `DATETIME_FORMAT`, `TIME_FORMAT` | `'iso-8601'` | Output formats. |
| `DATE_INPUT_FORMATS`, `DATETIME_INPUT_FORMATS`, `TIME_INPUT_FORMATS` | `['iso-8601']` | Accepted input formats. |
| `COERCE_DECIMAL_TO_STRING` | `true` | Render decimals as strings. |
| `UPLOADED_FILES_USE_URL` | `true` | Render file fields as URLs rather than names. |
| `COMPACT_JSON` / `STRICT_JSON` | `true` / `true` | JSON rendering options. |
| `HTML_SELECT_CUTOFF` / `HTML_SELECT_CUTOFF_TEXT` | `1000` / `'More than {count} items...'` | Browsable API select limits. |
| `TEST_REQUEST_DEFAULT_FORMAT` | `'multipart'` | Default body format of the REST test client. |

Authentication classes (`SessionAuthentication`, `TokenAuthentication`, `JWTAuthentication`,
`BasicAuthentication`, `RemoteUserAuthentication`) are imported from `@ghuri/auth/rest`. See
[REST framework](/docs/topics/rest/).

## Admin (`@ghuri/admin`)

| Setting | Type | Default | Description |
|---|---|---|---|
| `ADMIN_ASSETS` | `{ htmx?: string \| false \| null; css?: string[]; js?: string[] }` | htmx 2 from jsDelivr | Where the admin loads htmx from (a self-hosted copy for strict CSPs or offline intranets; `false` disables it), plus extra stylesheets and deferred scripts for every admin page. |

Site titles are set on the `AdminSite` (`admin.site.siteHeader = 'My blog'`), not in settings.
See [Admin reference](/docs/topics/admin-reference/).

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
| `DEFAULT_MODEL` | `string \| LanguageModel` | none | Model used by agents that do not set `model`, as `provider:model` or an AI SDK model object. |
| `AI_BINDING` | `string` | `'AI'` | Workers AI binding name for the `workers-ai` provider. |
| `PROVIDERS` | `Record<string, { apiKey?, baseURL?, … }>` | `{}` | Credentials and options per provider (`anthropic`, `openai`, `workers-ai`, …). |
| `MAX_STEPS` | `number` | `10` | Maximum tool-call steps per agent run. |
| `AUTHENTICATION_CLASSES` | `AuthenticationClass[]` | `REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES` | Authentication for the chat and MCP endpoints. |
| `PERMISSION_CLASSES` | `PermissionClass[]` | `[IsAuthenticated]` | Permissions for agents that do not set `permissionClasses`. |
| `QUEUE_BINDING` | `string` | `'AGENTS_QUEUE'` | Queue producer binding used by `agent.enqueue()`. See [Background tasks](/docs/topics/background-tasks/). |

See [AI agents and MCP](/docs/topics/agents/).

## GraphQL (`@ghuri/graphql`)

```ts
GRAPHQL: {
  SCHEMA: schema,
  AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication],
  MAX_DEPTH: 10,
  RELAY_CONNECTION_MAX_LIMIT: 50,
},
```

| Key | Type | Default | Description |
|---|---|---|---|
| `SCHEMA` | `Schema \| GraphQLSchema \| () => …` | none | Default schema of `GraphQLView` and `ghuri graphql_schema`. graphene-django's `GRAPHENE['SCHEMA']`, but the object itself, not a dotted path. |
| `GRAPHIQL` | `boolean` | `DEBUG` | Serve GraphiQL to browsers at the view's URL. |
| `MAX_DEPTH` | `number` | unlimited | Reject operations nested deeper than this. |
| `MAX_COMPLEXITY` | `number` | unlimited | Reject operations whose estimated cost is higher (`first` / `last` multiply nested costs). |
| `INTROSPECTION` | `boolean` | `true` | Allow introspection queries (`__schema`, `__type`). |
| `RELAY_CONNECTION_MAX_LIMIT` | `number` | `100` | Maximum `first` / `last` of connections, and the page size when neither is given. |
| `BATCH` | `boolean` | `false` | Accept arrays of operations in one request. |
| `AUTHENTICATION_CLASSES` | `AuthenticationClass[]` | none (the user from `AuthenticationMiddleware`) | Authentication for `GraphQLView`, e.g. the classes from `@ghuri/auth/rest`. Session-authenticated `POST`s must carry the CSRF token. |
| `OPTIMIZE` | `boolean` | `false` | Apply the query optimizer (`selectRelated` / `prefetchRelated`) to every root list and connection. |

`GraphQLView.asView({ … })` options override these per view. See [GraphQL](/docs/topics/graphql/).

## Realtime (`@ghuri/realtime`)

```ts
REALTIME: {
  LAYER: durableObjectLayer('REALTIME'),
  ALLOWED_ORIGINS: ['https://app.example.com'],
  TOKEN_KEYWORD: 'Bearer',
},
```

| Key | Type | Default | Description |
|---|---|---|---|
| `LAYER` | `LayerConfig` | `memoryLayer()` | Where rooms live: `durableObjectLayer(binding)` from `@ghuri/realtime/cloudflare` on Workers, `memoryLayer()` on Node (one process) and in tests. |
| `ALLOWED_ORIGINS` | `string[]` | `[]` | Browser origins allowed to open sockets besides the request host and `CSRF_TRUSTED_ORIGINS`. `'https://*.example.com'` wildcards and `'*'` work. |
| `TOKEN_SOURCES` | `('subprotocol' \| 'query')[]` | `['subprotocol']` | Where handshake tokens may come from: `Sec-WebSocket-Protocol: ghuri, bearer.<token>` and/or `?token=`. |
| `TOKEN_KEYWORD` | `string` | `'Bearer'` | Keyword used when the token is copied into `Authorization` for `authenticationClasses` (`'Token'` for `TokenAuthentication`). |
| `MAX_MESSAGE_BYTES` | `number` | `1048576` | Larger frames close the socket with 1009. |
| `REVALIDATE_SECONDS` | `number` | `0` | Reload the user before an event when this many seconds passed since the last check; `0` checks only on the handshake. |

See [WebSockets](/docs/topics/websockets/).

## Email (`@ghuri/mail`)

```ts
EMAIL_BACKEND: env.RESEND_API_KEY ? resendBackend({ apiKey: env.RESEND_API_KEY }) : cloudflareEmailBackend(),
DEFAULT_FROM_EMAIL: 'Blog <noreply@blog.example.com>',
ADMINS: ['Jane <jane@blog.example.com>'],
```

| Key | Type | Default | Description |
|---|---|---|---|
| `EMAIL_BACKEND` | `EmailBackendConfig` | `consoleBackend()` in `DEBUG`, otherwise none | `cloudflareEmailBackend()`, `resendBackend({ apiKey })`, `smtpBackend()` (from `@ghuri/mail/smtp`), `consoleBackend()`, `locmemBackend()` or `dummyBackend()`. Sending with none set raises `ImproperlyConfigured`. |
| `DEFAULT_FROM_EMAIL` | `string` | `'webmaster@localhost'` | Sender when `sendMail()` or `EmailMessage` gets none. |
| `SERVER_EMAIL` | `string` | `'root@localhost'` | Sender of `mailAdmins()` and `mailManagers()`. |
| `EMAIL_SUBJECT_PREFIX` | `string` | `'[Ghuri] '` | Prefix of `mailAdmins()` and `mailManagers()` subjects. |
| `ADMINS` | `string[]` | `[]` | Who gets `mailAdmins()`: address strings such as `'Jane <jane@example.com>'`. |
| `MANAGERS` | `string[]` | `[]` | Who gets `mailManagers()`. |
| `EMAIL_TIMEOUT` | `number \| null` | `null` | Seconds before a network backend (Resend, SMTP) gives up; `null` waits forever. |
| `EMAIL_HOST` | `string` | `'localhost'` | SMTP host for `smtpBackend()`. |
| `EMAIL_PORT` | `number` | `25` | SMTP port. |
| `EMAIL_HOST_USER` | `string` | `''` | SMTP username; empty skips AUTH. |
| `EMAIL_HOST_PASSWORD` | `string` | `''` | SMTP password. |
| `EMAIL_USE_TLS` | `boolean` | `false` | Upgrade with STARTTLS (usually port 587). |
| `EMAIL_USE_SSL` | `boolean` | `false` | Implicit TLS (usually port 465). Not together with `EMAIL_USE_TLS`. |

See [Sending email](/docs/topics/email/).

## Tenants (`@ghuri/tenants`)

```ts
TENANTS: {
  MODEL: 'stores.Store',
  RESOLVERS: [new SubdomainResolver({ domain: 'myshop.example' }), new HostResolver()],
},
```

| Key (`TENANTS.*`) | Type | Default | Description |
|---|---|---|---|
| `MODEL` | `string \| ModelClass` | none | The tenant model, as `'app_label.ModelName'` or the class. Target of `TenantModel` foreign keys and default model of the resolvers. |
| `RESOLVERS` | `TenantResolverEntry[]` | `[]` | What `TenantMiddleware` tries, in order: `HeaderResolver`, `SubdomainResolver`, `HostResolver` or `async (c) => tenant \| null`. |
| `REQUIRED` | `boolean` | `false` | Answer 404 when no resolver finds a tenant. Otherwise the request runs with no tenant. |

See [Multi-tenancy](/docs/topics/multi-tenancy/).

## Social login (`@ghuri/socialauth`)

| Key (`SOCIALACCOUNT.*`) | Type | Default | Description |
|---|---|---|---|
| `PROVIDERS` | `Record<string, { APP?, APPS?, SCOPE?, AUTH_PARAMS?, VERIFIED_EMAIL? }>` | `{}` | Provider credentials and options; `APPS` for several OpenID Connect apps. |
| `ADAPTER` | `class extends SocialAccountAdapter` | `SocialAccountAdapter` | Customize signup and linking. |
| `AUTO_SIGNUP` | `boolean` | `true` | Create users from the profile without a form when possible. |
| `EMAIL_AUTHENTICATION` | `boolean` | `false` | Link to an existing user with the same **verified** email. |
| `EMAIL_REQUIRED` | `boolean` | `false` | Ask for an email when the provider gives none. |
| `LOGIN_ON_GET` | `boolean` | `false` | Start logins on GET (otherwise GET shows a confirm page; POST starts). |
| `STORE_TOKENS` | `boolean` | `false` | Keep provider tokens, encrypted, in `SocialToken`. |
| `LOGIN_RESPONSE` | `'session' \| 'jwt'` | `'session'` | `'jwt'` hands SPAs a one-time code at `FRONTEND_URL`. |
| `FRONTEND_URL` | `string` | none | Where browser flows return in JWT mode (`#code=` / `#error=`). |
| `LOGIN_ERROR_URL` | `string` | `LOGIN_URL` | Where browser flows go on errors, with `?error=`. |

## Login strategies (`@ghuri/oauth`)

| Key (`OAUTH.*`) | Type | Default | Description |
|---|---|---|---|
| `STATE_COOKIE` | `string` | `'ghuri_oauth'` | Name of the encrypted round-trip cookie. |
| `STATE_MAX_AGE` | `number` (seconds) | `600` | How long a started login stays valid. |
| `HTTP_TIMEOUT` | `number` (ms) | `10000` | Timeout of requests to providers. |
| `CALLBACK_BASE_URL` | `string` | the request origin | Origin used for callback URLs (set it behind proxies that rewrite the host). |

## Reading settings in your code

```ts
import { getSettings, setting } from '@ghuri/core'

const debug = getSettings().DEBUG
const pageSize = setting('PAGE_SIZE', 20)   // with a fallback
```

Both need a Ghuri context: inside a request, a cron or queue handler, a command, or a test that
called `app.setup(env)`. With only a Hono context at hand, `settingsFor(c)` returns the request's
settings or `undefined`. Custom keys are allowed; declare them for type checking:

```ts title="src/settings.ts"
declare module '@ghuri/core' {
  interface GhuriSettings {
    BLOG_POSTS_PER_PAGE?: number
  }
}
```
