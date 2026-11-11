---
title: API authentication
description: Session, token, JWT and basic authentication for REST views, and how to write your own authentication class.
---

Authentication associates a request with a user. It runs before permissions and throttling, and
its result is available as `this.request.user` and `this.request.auth`. Authentication on its own
never rejects a request; it only identifies the caller. Rejecting is the job of
[permissions](/docs/topics/rest/permissions/).

The `BaseAuthentication` interface lives in `@ghuri/rest`. The concrete classes live in
`@ghuri/auth/rest`, because they need the `User`, `Session` and `Token` models.

:::tip[If you know Django]
These are DRF's `SessionAuthentication`, `TokenAuthentication` (from `rest_framework.authtoken`),
`BasicAuthentication`, and the `djangorestframework-simplejwt` views, collected in one module.
`obtain_auth_token` is `obtainAuthToken`. The `Token` model is migrated with `@ghuri/auth`, so
there is no extra app to install.
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
but considers them invalid raises `AuthenticationFailed` (`401`) and stops the chain.

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

Create tokens yourself with `Token.objects.getOrCreate({ user })`, for example in a `postSave`
receiver for new users. To revoke a token, delete the row.

## JWTAuthentication

Short-lived signed access tokens plus refresh tokens, built on `hono/jwt`. Nothing is stored per
request: verifying an access token needs no database query, which suits Workers well.

```ts title="src/urls.ts"
import { TokenObtainPairView, TokenRefreshView } from '@ghuri/auth/rest'

path('api/auth/jwt/', TokenObtainPairView.asView(), { name: 'token-obtain' }),
path('api/auth/jwt/refresh/', TokenRefreshView.asView(), { name: 'token-refresh' }),
```

```sh
$ curl -X POST http://localhost:8787/api/auth/jwt/ \
    -H 'Content-Type: application/json' -d '{"username": "rifat", "password": "…"}'
{ "access": "eyJhbGciOi…", "refresh": "eyJhbGciOi…" }

$ curl http://localhost:8787/api/posts/mine/ -H 'Authorization: Bearer eyJhbGciOi…'
```

Configure lifetimes and signing under the `JWT` settings key:

```ts title="src/settings.ts"
JWT: {
  ACCESS_TOKEN_LIFETIME: 5 * 60,          // seconds
  REFRESH_TOKEN_LIFETIME: 7 * 24 * 60 * 60,
  ALGORITHM: 'HS256',
  SIGNING_KEY: env.JWT_SIGNING_KEY,       // defaults to SECRET_KEY
  ROTATE_REFRESH_TOKENS: true,
}
```

The access token carries the user's primary key. Changing a user's password or deactivating them
does not invalidate access tokens already issued, so keep their lifetime short.

## BasicAuthentication

HTTP Basic with username and password on every request. Useful for testing and for internal
tools behind TLS; avoid it for public clients, because every request carries the password and
runs a PBKDF2 check.

## Writing an authentication class

Implement `authenticate(c)`, returning `[user, auth]` on success or `null` when the request does
not carry this kind of credentials. Return `null` rather than throwing when the header is simply
absent, so the next class gets a chance.

```ts title="src/accounts/authentication.ts"
import type { Context } from 'hono'
import { BaseAuthentication, AuthenticationFailed } from '@ghuri/rest'
import { ApiKey } from './models'

export class ApiKeyAuthentication extends BaseAuthentication {
  async authenticate(c: Context) {
    const key = c.req.header('X-Api-Key')
    if (!key) return null

    const apiKey = await ApiKey.objects.selectRelated('user').filter({ key, revoked: false }).first()
    if (!apiKey) throw new AuthenticationFailed('Invalid API key.')

    const user = await apiKey.user
    if (!user.isActive) throw new AuthenticationFailed('User inactive or deleted.')
    return [user, apiKey] as const
  }

  authenticateHeader() {
    return 'Api-Key'
  }
}
```

`authenticateHeader()` is optional. When it returns a value, unauthenticated requests that fail a
permission check get `401` with a `WWW-Authenticate` header instead of `403`.

The user you return must satisfy the core `RequestUser` contract (`pk`, `isAuthenticated`,
`hasPerm()` …). Instances of `@ghuri/auth`'s `User` model do. See
[Authentication](/docs/topics/authentication/) for users, passwords and sessions in general.
