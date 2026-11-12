---
title: API authentication
description: Session, token, JWT and basic authentication for REST views, and how to write your own authentication class.
---

Authentication associates a request with a user. It runs before permissions and throttling, and
its result is available as `this.request.user` and `this.request.auth`. Authentication on its own
never rejects a request; it only identifies the caller. Rejecting is the job of
[permissions](/docs/topics/rest/permissions/).

The `BaseAuthentication` interface lives in `@ghuri/rest`. The concrete classes live in
`@ghuri/auth/rest`, because they need the `User`, `Session` and `Token` models. They implement
the interface structurally and do not import `@ghuri/rest`.

| Class | Credentials | Package |
|---|---|---|
| `MiddlewareAuthentication` | The user `AuthenticationMiddleware` already set; enforces CSRF (the default) | `@ghuri/rest` |
| `SessionAuthentication` | The session; enforces CSRF on unsafe methods | `@ghuri/auth/rest` |
| `TokenAuthentication` | `Authorization: Token <key>` | `@ghuri/auth/rest` |
| `JWTAuthentication` | `Authorization: Bearer <access token>` | `@ghuri/auth/rest` |
| `BasicAuthentication` | `Authorization: Basic …` | `@ghuri/auth/rest` |
| `RemoteUserAuthentication` | A trusted proxy header (`Remote-User`) | `@ghuri/auth/rest` |

:::tip[If you know Django]
These are DRF's `SessionAuthentication`, `TokenAuthentication` (from `rest_framework.authtoken`),
`BasicAuthentication`, and the `djangorestframework-simplejwt` views, collected in one module.
`obtain_auth_token` is `obtainAuthToken`. The `Token` model is migrated with `@ghuri/auth`
(its `authtoken` app), so there is no extra package to install.
:::

## Configuring

Set project defaults in settings and override per view:

```ts title="src/settings.ts"
import { SessionAuthentication, TokenAuthentication, JWTAuthentication } from '@ghuri/auth/rest'

REST_FRAMEWORK: {
  DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, JWTAuthentication],
}
```

```ts
export class ReportViewSet extends ReadOnlyModelViewSet<Report> {
  authenticationClasses = [TokenAuthentication]
}
```

Classes are tried in order. The first that returns a user wins; a class that finds credentials
but considers them invalid raises `AuthenticationFailed` (`401`, `{ detail, code }` with a
`WWW-Authenticate` header) and stops the chain.

Without any configuration, `DEFAULT_AUTHENTICATION_CLASSES` is `[MiddlewareAuthentication]`
from `@ghuri/rest`: it trusts the user that `AuthenticationMiddleware` put on the request and
enforces CSRF for unsafe methods, much like `SessionAuthentication`.

## SessionAuthentication

Uses the session established by `login()` from `@ghuri/auth`, the same session the admin uses.
It needs `SessionMiddleware` and `AuthenticationMiddleware` in `MIDDLEWARE`.

Because a browser sends the session cookie automatically, `SessionAuthentication` enforces CSRF
on unsafe methods for authenticated users, even on views that would otherwise be exempt. Send
the token from the `csrftoken` cookie in the `X-CSRFToken` header:

```ts
await fetch('/api/posts/', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCookie('csrftoken') },
  body: JSON.stringify({ title: 'From the browser' }),
})
```

Use it for a first-party frontend served from the same site. Use tokens or JWT for mobile apps,
scripts and third parties.

## TokenAuthentication

A simple opaque token per user, stored in the `Token` model. Clients send it in the
`Authorization` header with the `Token` keyword:

```
Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b
```

Expose the token endpoint, which accepts `username` and `password` and returns the user's token
(creating it on first use):

```ts title="src/urls.ts"
import { obtainAuthToken } from '@ghuri/auth/rest'

path('api/auth/token/', obtainAuthToken)
```

```sh
$ curl -X POST http://localhost:8787/api/auth/token/ \
    -H 'Content-Type: application/json' -d '{"username": "rifat", "password": "…"}'
{ "token": "9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" }
```

Create tokens yourself with `Token.objects.getOrCreate({ user })` (`Token` is exported from
`@ghuri/auth`), for example in a `postSave` receiver for new users, or from the command line with
`ghuri drf_create_token <username> [--reset]`. To revoke a token, delete the row. Subclass
`TokenAuthentication` to change its `keyword` or `model`.

## JWTAuthentication

Short-lived signed access tokens plus refresh tokens, a port of
`djangorestframework-simplejwt` built on `hono/jwt` (WebCrypto). Access tokens are not stored:
verifying one needs no token lookup, only the query that loads the user.

```ts title="src/urls.ts"
import { TokenBlacklistView, TokenObtainPairView, TokenRefreshView, TokenVerifyView } from '@ghuri/auth/rest'

path('api/auth/jwt/', TokenObtainPairView.asView(), { name: 'token-obtain' }),       // {username, password} → {refresh, access}
path('api/auth/jwt/refresh/', TokenRefreshView.asView(), { name: 'token-refresh' }), // {refresh} → {access, refresh?}
path('api/auth/jwt/verify/', TokenVerifyView.asView()),                               // {token} → 200 / 401
path('api/auth/jwt/blacklist/', TokenBlacklistView.asView()),                         // {refresh} → revoke
```

The token endpoints are CSRF-exempt (credentials travel in the body) and speak JSON.

```sh
$ curl -X POST http://localhost:8787/api/auth/jwt/ \
    -H 'Content-Type: application/json' -d '{"username": "rifat", "password": "…"}'
{ "access": "eyJhbGciOi…", "refresh": "eyJhbGciOi…" }

$ curl http://localhost:8787/api/posts/mine/ -H 'Authorization: Bearer eyJhbGciOi…'
```

Configure lifetimes and signing under the `JWT` settings key (`SIMPLE_JWT` is accepted too):

```ts title="src/settings.ts"
JWT: {
  ACCESS_TOKEN_LIFETIME: 5 * 60,          // seconds (default 5 minutes)
  REFRESH_TOKEN_LIFETIME: 7 * 24 * 60 * 60, // default 1 day
  ALGORITHM: 'HS256',
  SIGNING_KEY: env.JWT_SIGNING_KEY,       // defaults to SECRET_KEY
  ROTATE_REFRESH_TOKENS: true,            // default false
}
```

The access token carries the user's primary key (`user_id` claim). Deactivating a user rejects
their tokens on the next request, because `JWTAuthentication` loads the user. A password change
only invalidates tokens with `CHECK_REVOKE_TOKEN: true`; otherwise keep access lifetimes short.
Blacklisting, rotation and the remaining settings are covered in
[API tokens and JWT](/docs/topics/auth-tokens/).

## BasicAuthentication

HTTP Basic with username and password on every request. Useful for testing and for internal
tools behind TLS; avoid it for public clients, because every request carries the password and
runs a password-hash check.

## RemoteUserAuthentication

Trusts a username set by a proxy in front of the app (the `Remote-User` header by default; change
`header` in a subclass) and authenticates it through the `remoteUser` backend. Only use it when
clients cannot set that header themselves.

## OpenAPI security schemes

Each class in `@ghuri/auth/rest` has a static `securityScheme`, which the
[OpenAPI generator](/docs/topics/rest/openapi/) puts in `components.securitySchemes` and in each
operation's `security`:

| Class | Name | Scheme |
|---|---|---|
| `SessionAuthentication` | `cookieAuth` | `apiKey` in cookie `sessionid` |
| `TokenAuthentication` | `tokenAuth` | `apiKey` in header `Authorization` (prefix `Token`) |
| `JWTAuthentication` | `jwtAuth` | `http` bearer, `bearerFormat: 'JWT'` |
| `BasicAuthentication` | `basicAuth` | `http` basic |

A subclass with a different keyword can override it:
`static override securityScheme = { name: 'bearerAuth', scheme: { type: 'http', scheme: 'bearer' } }`.

## Writing an authentication class

Implement `authenticate(c)`, returning `[user, auth]` on success or `null` when the request does
not carry this kind of credentials. Return `null` rather than throwing when the header is simply
absent, so the next class gets a chance.

```ts title="src/accounts/authentication.ts"
import type { Context } from 'hono'
import type { RequestUser } from '@ghuri/core'
import { AuthenticationFailed, type BaseAuthentication } from '@ghuri/rest'
import { ApiKey } from './models'

export class ApiKeyAuthentication implements BaseAuthentication {
  static securityScheme = { name: 'apiKeyAuth', scheme: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } }

  async authenticate(c: Context): Promise<[RequestUser, unknown] | null> {
    const key = c.req.header('X-Api-Key')
    if (!key) return null

    const apiKey = await ApiKey.objects.selectRelated('user').filter({ key, revoked: false }).first()
    if (!apiKey) throw new AuthenticationFailed('Invalid API key.')

    const user = await apiKey.user
    if (!user.isActive) throw new AuthenticationFailed('User inactive or deleted.')
    return [user, apiKey]
  }

  authenticateHeader() {
    return 'Api-Key'
  }
}
```

`BaseAuthentication` is an interface, so you `implement` it rather than extend a base class.
`authenticateHeader()` is optional. When the view's first authentication class returns a value
from it, unauthenticated requests that fail a permission check get `401` with a
`WWW-Authenticate` header instead of `403`. The optional static `securityScheme` documents the
class in the OpenAPI schema.

The user you return must satisfy the core `RequestUser` contract (`pk`, `isAuthenticated`,
`hasPerm()` …). Instances of `@ghuri/auth`'s `User` model do. See
[Authentication](/docs/topics/authentication/) for users, passwords and sessions in general.
