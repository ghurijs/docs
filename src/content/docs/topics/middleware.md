---
title: Middleware
description: The MIDDLEWARE setting, writing middleware classes, Hono middleware, and the built-in security, CSRF, CORS, session and authentication middleware.
---

Middleware wraps every request. Each entry in `MIDDLEWARE` sees the request on the way in, can
short-circuit with its own response, and sees the response on the way out. The first entry is
the outermost layer.

```ts title="src/settings.ts"
import { SecurityMiddleware, CommonMiddleware, CorsMiddleware, CsrfMiddleware } from '@ghuri/core'
import { SessionMiddleware, AuthenticationMiddleware } from '@ghuri/auth'

MIDDLEWARE: [
  SecurityMiddleware,
  CorsMiddleware,
  CommonMiddleware,
  SessionMiddleware,
  CsrfMiddleware,
  AuthenticationMiddleware,
],
```

## Writing middleware

Subclass `Middleware` and implement `handle(c, next)`. Call `await next()` to run the rest of the
chain (other middleware, then the view). Afterwards, `c.res` holds the response.

```ts title="src/middleware.ts"
import type { Context } from 'hono'
import { Middleware } from '@ghuri/core'

export class TimingMiddleware extends Middleware {
  async handle(c: Context, next: () => Promise<void>) {
    const start = Date.now()
    await next()
    c.res.headers.set('Server-Timing', `app;dur=${Date.now() - start}`)
  }
}
```

To answer without calling the view, return a `Response` and do not call `next()`:

```ts
import { getSettings } from '@ghuri/core'

export class MaintenanceMiddleware extends Middleware {
  async handle(c: Context, next: () => Promise<void>) {
    if (getSettings().MAINTENANCE_MODE && !c.req.path.startsWith('/admin/')) {
      return c.text('Back soon.', 503)
    }
    await next()
  }
}
```

Middleware instances are created once per isolate, so keep per-request data on `c` (with
`c.set()`) or in the request context, never on `this`.

Plain [Hono middleware](https://hono.dev/docs/guides/middleware) also works in `MIDDLEWARE`,
which gives you the whole Hono ecosystem:

```ts
import { logger } from 'hono/logger'
import { timeout } from 'hono/timeout'

MIDDLEWARE: [logger(), SecurityMiddleware, timeout(10_000), /* ... */],
```

:::tip[If you know Django]
A Ghuri middleware is Django's "new-style" middleware with the callable turned inside out:
`handle(c, next)` corresponds to `__call__(self, request)`, and `await next()` is
`self.get_response(request)`. There are no separate `process_view` / `process_exception` hooks;
wrap `next()` in `try`/`catch` to handle exceptions.
:::

## Built-in middleware

### `SecurityMiddleware` (core)

Sets security headers on every response: `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`, and
`Strict-Transport-Security` when the request came over HTTPS. Put it first.

### `CommonMiddleware` (core)

Rejects requests whose `Host` is not in `ALLOWED_HOSTS` (400) and implements `APPEND_SLASH`.

### `CorsMiddleware` (core)

Answers preflight requests and adds CORS headers according to the `CORS` setting:

```ts
CORS: { allowOrigins: ['https://app.example.com'], allowCredentials: true },
```

Place it before any middleware that can return early, so that error responses carry CORS
headers too.

### `CsrfMiddleware` (core)

Protects unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) from cross-site request forgery, in
two layers:

1. **Origin check.** The `Origin` header (or `Referer` for HTTPS requests without one) must
   match the request host or an entry in `CSRF_TRUSTED_ORIGINS`.
2. **Double-submit token.** A random token is set in the `csrftoken` cookie; the request must
   echo it in the `X-CSRFToken` header or a `csrfmiddlewaretoken` form field.

Put the token in forms with `getCsrfToken(c)`:

```tsx
<form method="post">
  <input type="hidden" name="csrfmiddlewaretoken" value={getCsrfToken(c)} />
  ...
</form>
```

For JavaScript clients, read the `csrftoken` cookie and send it as `X-CSRFToken`. Exempt a view
(for example, a webhook verified by signature) with `csrfExempt(view)`. API views authenticated
by tokens or JWTs are not subject to CSRF; `SessionAuthentication` in the REST framework enforces
it for session-authenticated API requests, as DRF does.

### `GZipMiddleware` (core)

Compresses responses on Node. On Workers it does nothing, because Cloudflare compresses at the
edge.

### `SessionMiddleware` and `AuthenticationMiddleware` (auth)

`SessionMiddleware` loads the session from the `sessionid` cookie and saves it after the
response if it changed; the session is `c.get('session')`. `AuthenticationMiddleware` reads the
user id from the session and sets the request user, available as `getUser(c)` or
`c.get('user')`. `AuthenticationMiddleware` must come after `SessionMiddleware`. See
[Authentication](/docs/topics/authentication/).

## Ordering

A good default order, outermost first:

1. `SecurityMiddleware`
2. `CorsMiddleware` (if you use CORS)
3. `CommonMiddleware`
4. `SessionMiddleware`
5. `CsrfMiddleware`
6. `AuthenticationMiddleware`
7. Your own middleware

This is the same order Django recommends, for the same reasons: security headers should apply
to everything, sessions must exist before CSRF and authentication can use them.
