---
title: Middleware
description: The MIDDLEWARE setting, writing middleware classes, Hono middleware, and the built-in security, CSRF, CORS, session and authentication middleware.
---

Middleware wraps every request. Each entry in `MIDDLEWARE` sees the request on the way in, can
short-circuit with its own response, and sees the response on the way out. The first entry is
the outermost layer.

```ts title="src/settings.ts"
import {
  SecurityMiddleware, CorsMiddleware, CommonMiddleware, CsrfMiddleware, XFrameOptionsMiddleware,
} from '@ghuri/core'
import { SessionMiddleware, AuthenticationMiddleware } from '@ghuri/auth'

MIDDLEWARE: [
  SecurityMiddleware,
  CorsMiddleware,
  SessionMiddleware,
  CommonMiddleware,
  CsrfMiddleware,
  AuthenticationMiddleware,
  XFrameOptionsMiddleware,
],
```

Before any of them run, the app itself sets up the request context, sends the `requestStarted`
signal and validates the `Host` header against `ALLOWED_HOSTS`. After them come the URL patterns
and error handling.

## Writing middleware

Subclass `Middleware` and implement `handle(c, next)`. Call `await next()` to run the rest of the
chain (other middleware, then the view). Afterwards, `c.res` holds the response.

```ts title="src/middleware.ts"
import type { Context, Next } from 'hono'
import { Middleware } from '@ghuri/core'

export class TimingMiddleware extends Middleware {
  async handle(c: Context, next: Next) {
    const start = Date.now()
    await next()
    c.header('Server-Timing', `app;dur=${Date.now() - start}`)
  }
}
```

To answer without calling the view, return a `Response` and do not call `next()`. Returning a
`Response` after `next()` replaces the view's response.

```ts
import { getSettings } from '@ghuri/core'

export class MaintenanceMiddleware extends Middleware {
  async handle(c: Context, next: Next) {
    if (getSettings().MAINTENANCE_MODE && !c.req.path.startsWith('/admin/')) {
      return c.text('Back soon.', 503)
    }
    await next()
  }
}
```

Middleware classes are instantiated once, when the app is built for an isolate, so keep
per-request data on `c` (with `c.set()`) or in the request context, never on `this`. To pass
options, put a configured instance in `MIDDLEWARE` instead of the class:
`new CorsMiddleware({ allowOrigins: '*' })`.

Plain [Hono middleware](https://hono.dev/docs/guides/middleware) also works in `MIDDLEWARE`,
which gives you the whole Hono ecosystem:

```ts
import { logger } from 'hono/logger'
import { timeout } from 'hono/timeout'

MIDDLEWARE: [logger(), SecurityMiddleware, timeout(10_000), /* ... */],
```

The other direction works too: `toHonoMiddleware(entry)` turns a Ghuri middleware class or
instance into a Hono handler, for use in a Hono app outside Ghuri's `MIDDLEWARE` (for example
`legacyApp.use('*', toHonoMiddleware(TimingMiddleware))`).

:::tip[If you know Django]
A Ghuri middleware is Django's "new-style" middleware with the callable turned inside out:
`handle(c, next)` corresponds to `__call__(self, request)`, and `await next()` is
`self.get_response(request)`. There are no separate `process_view` / `process_exception` hooks;
wrap `next()` in `try`/`catch` to handle exceptions, or use
[`registerExceptionHandler()`](/docs/topics/urls-and-views/#errors).
:::

## Built-in middleware

### `SecurityMiddleware` (core)

Django's `SecurityMiddleware`. Adds `X-Content-Type-Options: nosniff`
(`SECURE_CONTENT_TYPE_NOSNIFF`), `Referrer-Policy: same-origin` (`SECURE_REFERRER_POLICY`) and
`Cross-Origin-Opener-Policy: same-origin` (`SECURE_CROSS_ORIGIN_OPENER_POLICY`) unless the
response already set them. It sends `Strict-Transport-Security` on HTTPS requests once
`SECURE_HSTS_SECONDS` is above 0 (it is 0 by default), with `SECURE_HSTS_INCLUDE_SUBDOMAINS` and
`SECURE_HSTS_PRELOAD`. `SECURE_SSL_REDIRECT` redirects HTTP to HTTPS (honouring
`SECURE_SSL_HOST` and `SECURE_REDIRECT_EXEMPT`). Put it first.

Behind a proxy that terminates TLS (common on Node), set
`SECURE_PROXY_SSL_HEADER: ['X-Forwarded-Proto', 'https']` so Ghuri knows the request was
secure. On Workers the request URL already says `https`.

### `CommonMiddleware` (core)

Rejects requests whose `Host` is not in `ALLOWED_HOSTS` (400), implements `PREPEND_WWW`, and
redirects to the slashed URL for `APPEND_SLASH`.

:::note
`ALLOWED_HOSTS` and `APPEND_SLASH` are also enforced by the app itself, so they apply even
without `CommonMiddleware`. What the middleware adds on top is `PREPEND_WWW`.
:::

### `CorsMiddleware` (core)

Answers preflight requests and adds CORS headers according to the `CORS` setting:

```ts
CORS: {
  allowOrigins: ['https://app.example.com'],   // or '*'
  allowCredentials: true,
  // allowMethods, allowHeaders, exposeHeaders, maxAge (seconds, default 86400)
},
```

With `CORS: false` (the default) it does nothing. Place it before any middleware that can return
early, so that error responses carry CORS headers too.

### `CsrfMiddleware` (core)

Django's `CsrfViewMiddleware`. It protects unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`)
from cross-site request forgery, in two layers:

1. **Origin check.** The `Origin` header must match the request host or an entry in
   `CSRF_TRUSTED_ORIGINS` (which accepts wildcards: `'https://*.example.com'`). HTTPS requests
   without an `Origin` must send a matching `Referer`.
2. **Token check.** A random secret lives in the `csrftoken` cookie; the request must send a
   token derived from it in the `X-CSRFToken` header or a `csrfmiddlewaretoken` form field.
   Tokens use Django's masked format, so each rendered form gets a different value.

Put the token in forms with `getCsrfToken(c)`. Calling it creates the secret if needed, and the
middleware sends the cookie on the way out:

```tsx
<form method="post">
  <input type="hidden" name="csrfmiddlewaretoken" value={getCsrfToken(c)} />
  ...
</form>
```

For JavaScript clients, read the `csrftoken` cookie and send it as `X-CSRFToken`. The helpers,
all from `@ghuri/core`:

```ts
path('webhooks/stripe/', csrfExempt(stripeWebhook))   // skip the check (also works on a mounted Hono app)
path('spa/', ensureCsrfCookie(spaShell))              // always set the cookie (Django's ensure_csrf_cookie)
rotateCsrfToken(c)                                    // new secret, e.g. after login
await enforceCsrf(c)                                  // throw CsrfFailure unless the request passes
const reason = await checkCsrf(c)                     // the failure reason, or null
```

A failed check raises `CsrfFailure`, a 403 whose `reason` says what was wrong. Class-based views
can set `static csrfExempt = true`. The cookie and header follow Django's settings:
`CSRF_COOKIE_NAME`, `CSRF_HEADER_NAME`, `CSRF_COOKIE_AGE`, `CSRF_COOKIE_DOMAIN`,
`CSRF_COOKIE_PATH`, `CSRF_COOKIE_SECURE`, `CSRF_COOKIE_HTTPONLY`, `CSRF_COOKIE_SAMESITE`.

API views authenticated by tokens or JWTs are not subject to CSRF. Session-based REST
authentication (the default `MiddlewareAuthentication`, and `SessionAuthentication` from
`@ghuri/auth/rest`) calls `enforceCsrf()` itself, as DRF does.

### `XFrameOptionsMiddleware` (core)

Sets `X-Frame-Options: DENY` (or the value of `X_FRAME_OPTIONS`; `false` disables it) on
responses that do not set it themselves, to prevent clickjacking.

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
3. `SessionMiddleware`
4. `CommonMiddleware`
5. `CsrfMiddleware`
6. `AuthenticationMiddleware`
7. `XFrameOptionsMiddleware`
8. Your own middleware

This is the order Django recommends, for the same reasons: security headers should apply to
everything, CORS headers should reach early responses, and sessions must exist before CSRF and
authentication can use them. `ghuri check --deploy` warns when `SecurityMiddleware` or
`CsrfMiddleware` is missing.
