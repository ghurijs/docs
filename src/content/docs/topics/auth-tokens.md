---
title: API tokens and JWT
description: DRF-style API tokens (the authtoken app) and simplejwt-style JWT with refresh, verify and blacklist endpoints, from @ghuri/auth and @ghuri/auth/rest.
---

Browsers authenticate with the session cookie. Scripts, mobile apps and
[MCP clients](/docs/topics/agents-mcp/) need a credential they can send in a header. `@ghuri/auth`
ships two, ported from the Django REST framework ecosystem:

| | Ported from | App | Header |
|---|---|---|---|
| API tokens | DRF's `rest_framework.authtoken` | `AuthTokenConfig` (label `authtoken`) | `Authorization: Token <key>` |
| JWT | `djangorestframework-simplejwt` | none required; `TokenBlacklistConfig` (label `token_blacklist`) for revocation | `Authorization: Bearer <access token>` |

The authentication classes and token endpoints live in the `@ghuri/auth/rest` entry point. They
implement the REST contract structurally and do not import `@ghuri/rest`, so they also work in
plain views and in [`@ghuri/agents`](/docs/topics/agents/). How REST picks and orders
authentication classes is covered in [REST authentication](/docs/topics/rest/authentication/).

## API tokens

One 40-hex-character key per user, stored in the `Token` model (table `authtoken_token`). Tokens
do not expire; delete or reset one to revoke it.

### Wiring

```ts title="src/settings.ts"
import { AuthConfig, AuthTokenConfig, ContentTypesConfig, SessionsConfig } from '@ghuri/auth'
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'

export default defineSettings((env) => ({
  // ...
  INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, AuthTokenConfig /* , your apps */],
  REST_FRAMEWORK: {
    DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, TokenAuthentication],
  },
}))
```

```ts title="src/urls.ts"
import { path } from '@ghuri/core'
import { obtainAuthToken } from '@ghuri/auth/rest'

export const urlpatterns = [
  path('api/auth/token/', obtainAuthToken),   // POST {username, password} → {token}
]
```

Run `npx ghuri migrate` to create `authtoken_token` (the app ships its migration).

### Creating tokens

```sh
npx ghuri drf_create_token alice            # prints the key
npx ghuri drf_create_token alice --reset    # replaces it
```

From code:

```ts
import { Token } from '@ghuri/auth'

const [token] = await Token.objects.getOrCreate({ user })
token.key   // '9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b'
```

Or let clients exchange a username and password for a token:

```sh
curl -X POST https://example.com/api/auth/token/ \
  -H 'Content-Type: application/json' \
  -d '{"username": "alice", "password": "s3cret"}'
# {"token":"9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"}
```

Wrong credentials answer `400` with `{"non_field_errors": ["Unable to log in with provided credentials."]}`.

### Using a token

```sh
curl https://example.com/api/posts/ -H 'Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b'
```

`TokenAuthentication` has two overridable attributes: `keyword` (default `'Token'`) and `model`
(the token model). A client that can only send `Bearer` headers can use a subclass:

```ts
import { TokenAuthentication } from '@ghuri/auth/rest'

export class BearerTokenAuthentication extends TokenAuthentication {
  keyword = 'Bearer'
}
```

## JWT

Access and refresh tokens with simplejwt's semantics, signed with `hono/jwt`. By default they use
HS256 with your `SECRET_KEY`. Access tokens are stateless: they are never stored and stay valid
until they expire. Refresh tokens can be rotated and, with the `token_blacklist` app, revoked.

### Wiring

```ts title="src/settings.ts"
import { AuthConfig, ContentTypesConfig, SessionsConfig, TokenBlacklistConfig } from '@ghuri/auth'
import { JWTAuthentication, SessionAuthentication } from '@ghuri/auth/rest'

export default defineSettings((env) => ({
  // ...
  INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, TokenBlacklistConfig /* , ... */],
  REST_FRAMEWORK: {
    DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, JWTAuthentication],
  },
  JWT: {
    ACCESS_TOKEN_LIFETIME: 5 * 60,         // seconds
    REFRESH_TOKEN_LIFETIME: 24 * 60 * 60,
    ROTATE_REFRESH_TOKENS: true,
    BLACKLIST_AFTER_ROTATION: true,        // needs TokenBlacklistConfig
  },
}))
```

```ts title="src/urls.ts"
import { path } from '@ghuri/core'
import { TokenBlacklistView, TokenObtainPairView, TokenRefreshView, TokenVerifyView } from '@ghuri/auth/rest'

export const urlpatterns = [
  path('api/auth/jwt/', TokenObtainPairView.asView()),             // {username, password} → {refresh, access}
  path('api/auth/jwt/refresh/', TokenRefreshView.asView()),        // {refresh} → {access} (+ {refresh} when rotating)
  path('api/auth/jwt/verify/', TokenVerifyView.asView()),          // {token} → 200 {} or 401
  path('api/auth/jwt/blacklist/', TokenBlacklistView.asView()),    // {refresh} → revoked (needs token_blacklist)
]
```

All token endpoints are CSRF-exempt (the credentials travel in the body) and accept JSON or form
data. Missing fields answer `400` with per-field errors; bad credentials or invalid tokens answer
`401` with `{ detail, code }` and a `WWW-Authenticate` header.

| View | Body | Response |
|---|---|---|
| `TokenObtainPairView` | `{ username, password }` (or your `USERNAME_FIELD`) | `{ refresh, access }`. Updates `lastLogin` when `UPDATE_LAST_LOGIN` is on |
| `TokenRefreshView` | `{ refresh }` | `{ access }`, plus a new `refresh` when `ROTATE_REFRESH_TOKENS` is on. With `BLACKLIST_AFTER_ROTATION`, the old refresh token is blacklisted. Inactive or deleted users are refused |
| `TokenVerifyView` | `{ token }` (any token type) | `200 {}` when valid; blacklisted refresh tokens are invalid |
| `TokenBlacklistView` | `{ refresh }` | `200 {}`; the refresh token can no longer be used. This is "log out" for JWT clients |

```sh
curl -X POST https://example.com/api/auth/jwt/ -H 'Content-Type: application/json' \
  -d '{"username": "alice", "password": "s3cret"}'
# {"refresh":"eyJhbGciOi…","access":"eyJhbGciOi…"}

curl https://example.com/api/posts/ -H 'Authorization: Bearer eyJhbGciOi…'
```

### The `token_blacklist` app

`TokenBlacklistConfig` adds `OutstandingToken` (`token_blacklist_outstandingtoken`) and
`BlacklistedToken` (`token_blacklist_blacklistedtoken`). With it installed, every refresh token
issued is recorded as outstanding, and blacklisted refresh tokens are refused by the refresh and
verify endpoints.

:::note
Blacklisting applies to refresh tokens only. An access token stays valid until it expires
(`ACCESS_TOKEN_LIFETIME`, five minutes by default), so keep that lifetime short. Without the app,
`TokenBlacklistView` and `refresh.blacklist()` fail with "The 'token_blacklist' app
(TokenBlacklistConfig) is not installed".
:::

Expired outstanding tokens accumulate. Delete them from a cron job with
`npx ghuri flushexpiredtokens`.

### Tokens in code

```ts
import { AccessToken, RefreshToken, tokenPairForUser } from '@ghuri/auth'

const refresh = await RefreshToken.forUser(user)   // recorded as outstanding when the blacklist app is on
refresh.set('tenant', 't1')                        // custom claims are copied to access tokens
const access = refresh.accessToken
await access.encode(); await refresh.encode()

const { refresh: r, access: a } = await tokenPairForUser(user)

const t = await AccessToken.fromString(raw)        // throws TokenError: bad signature, expired, wrong type
await refresh.blacklist()
```

`UntypedToken.fromString(raw)` validates a token of any type. These classes and `jwtSettings()`
are also exported from `@ghuri/auth/rest`.

### `JWT` settings

`JWT` (alias `SIMPLE_JWT`) uses simplejwt's key names. Lifetimes are in seconds.

| Key | Default | |
|---|---|---|
| `ACCESS_TOKEN_LIFETIME` | `300` | Five minutes |
| `REFRESH_TOKEN_LIFETIME` | `86400` | One day |
| `ROTATE_REFRESH_TOKENS` | `false` | Return a new refresh token from the refresh endpoint |
| `BLACKLIST_AFTER_ROTATION` | `false` | Blacklist the old refresh token when rotating (needs `token_blacklist`) |
| `UPDATE_LAST_LOGIN` | `false` | Set `lastLogin` when obtaining a pair |
| `ALGORITHM` | `'HS256'` | `HS256/384/512`, `RS256/384/512`, `PS256/384/512`, `ES256/384/512` or `EdDSA` |
| `SIGNING_KEY` | `SECRET_KEY` | A PEM private key for asymmetric algorithms |
| `VERIFYING_KEY` | `SIGNING_KEY` | A PEM public key for asymmetric algorithms |
| `AUDIENCE`, `ISSUER` | unset | Added to and checked on tokens when set |
| `LEEWAY` | `0` | Clock skew allowed, in seconds |
| `AUTH_HEADER_TYPES` | `['Bearer']` | Accepted `Authorization` keywords |
| `USER_ID_FIELD` / `USER_ID_CLAIM` | `'id'` / `'user_id'` | The user field stored in tokens, and its claim |
| `TOKEN_TYPE_CLAIM` / `JTI_CLAIM` | `'token_type'` / `'jti'` | |
| `CHECK_REVOKE_TOKEN` / `REVOKE_TOKEN_CLAIM` | `false` / `'hash_password'` | Embed a hash of the password, so tokens die when the password changes |

:::note[Differences from simplejwt]
`CHECK_REVOKE_TOKEN` hashes the password with SHA-256, because simplejwt's MD5 is missing from
WebCrypto. Tokens issued by a Django simplejwt deployment with that option on are therefore not
accepted.
:::

## Authentication classes

All five classes are in `@ghuri/auth/rest`:

| Class | Credentials | OpenAPI scheme |
|---|---|---|
| `SessionAuthentication` | the session; **enforces CSRF** on unsafe methods for authenticated users | `cookieAuth` (apiKey in cookie `sessionid`) |
| `TokenAuthentication` | `Authorization: Token <key>` | `tokenAuth` (apiKey in header `Authorization`) |
| `JWTAuthentication` | `Authorization: Bearer <access token>` | `jwtAuth` (http bearer, `bearerFormat: 'JWT'`) |
| `BasicAuthentication` | `Authorization: Basic …` | `basicAuth` (http basic) |
| `RemoteUserAuthentication` | a trusted proxy header (`Remote-User`) | none |

Each implements `authenticate(c): Promise<[user, auth] | null>` and `authenticateHeader(c)`.
Failures throw `AuthenticationFailed` or `InvalidToken` (401 with `{ detail, code }` and
`WWW-Authenticate`). Each class's static `securityScheme` is what the
[OpenAPI generator](/docs/topics/rest/openapi/) puts in `components.securitySchemes`; a subclass
with a different keyword or cookie name can override it.

Order matters: the first class that returns a user wins. Put `SessionAuthentication` first for a
site whose own pages call the API, and the header-based classes after it.
