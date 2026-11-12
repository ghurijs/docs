---
title: Throttling
description: Rate-limit API clients with AnonRateThrottle, UserRateThrottle and ScopedRateThrottle.
---

Throttles limit how often a client may call your API. They run after authentication and
permissions, and a throttled request gets `429 Too Many Requests` with a `Retry-After` header:

```json
{ "detail": "Request was throttled. Expected available in 37 seconds." }
```

Throttle state is kept in Ghuri's [cache](/docs/topics/caching/), so it works on every runtime
without extra infrastructure: KV on Cloudflare, memory on a single Node process.

:::tip[If you know Django]
DRF's throttles, unchanged: same classes, same `'100/day'` rate strings, same `scope` and
`throttle_scope` (here `throttleScope`). Like DRF, they are meant for fair-use limits, not as a
security boundary against a determined attacker.
:::

## Configuring

```ts title="src/settings.ts"
import { AnonRateThrottle, UserRateThrottle } from '@ghuri/rest'

REST_FRAMEWORK: {
  DEFAULT_THROTTLE_CLASSES: [AnonRateThrottle, UserRateThrottle],
  DEFAULT_THROTTLE_RATES: {
    anon: '60/hour',
    user: '2000/day',
    uploads: '20/hour',
  },
}
```

Rates are `<number>/<period>` where the period is `second`, `minute`, `hour` or `day` (only the
first letter matters, so `'10/s'` works too). A multiplier is allowed: `'10/5m'` is ten requests
per five minutes. A scope used by a throttle must have an entry in `DEFAULT_THROTTLE_RATES`
(`null` disables it), or the request fails with `ImproperlyConfigured`.

Per view:

```ts
export class SearchView extends APIView {
  throttleClasses = [UserRateThrottle]
}
```

## Built-in classes

| Class | Identifies clients by | Scope |
|---|---|---|
| `AnonRateThrottle` | IP address, only for anonymous requests | `anon` |
| `UserRateThrottle` | User primary key; IP for anonymous requests | `user` |
| `ScopedRateThrottle` | User or IP, per view scope | the view's `throttleScope` |

### Scoped throttles

Give expensive endpoints their own budget:

```ts
export class UploadView extends APIView {
  throttleClasses = [ScopedRateThrottle]
  throttleScope = 'uploads'
}
```

Every view with the same `throttleScope` shares one counter per client. Views without a
`throttleScope` are not throttled by `ScopedRateThrottle`. A viewset can set a scope for one
action only: `@action({ detail: true, methods: ['post'], throttleScope: 'uploads' })`.

## Client IP addresses

On Cloudflare the client IP comes from the `CF-Connecting-IP` header, which Cloudflare sets and
clients cannot forge. On Node behind a reverse proxy, tell Ghuri how many proxies to trust so it
reads the right entry from `X-Forwarded-For`:

```ts
REST_FRAMEWORK: {
  NUM_PROXIES: 1,   // e.g. one nginx or load balancer in front of the app
}
```

Without `NUM_PROXIES`, the whole `X-Forwarded-For` value is used as the identity when the header
is present (as in DRF), which a client can vary at will; when it is absent, `CF-Connecting-IP` or
the socket address is used. Behind a proxy, set `NUM_PROXIES` so all users do not share the
proxy's bucket and clients cannot pick their own.

## Accuracy on Workers

The KV cache is eventually consistent across Cloudflare locations, and a single counter can be
updated by many isolates at once. Expect limits to be approximate: a client might get a few more
requests than the rate allows during bursts. That is fine for fair-use limits.

If you need exact limits, use Cloudflare's own rate limiting in front of the Worker, or write a
throttle backed by a Durable Object or by your database. For a login endpoint, prefer
Cloudflare's rate limiting rules; they act before your Worker is billed.

## Custom throttles

Subclass `SimpleRateThrottle` and implement `getCacheKey()`; return `null` to skip throttling a
request.

```ts title="src/api/throttles.ts"
import { SimpleRateThrottle, type APIRequest } from '@ghuri/rest'

export class ApiKeyRateThrottle extends SimpleRateThrottle {
  scope = 'apikey'

  getCacheKey(request: APIRequest) {
    const key = request.header('X-Api-Key')
    return key ? `throttle_${this.scope}_${key}` : null
  }
}
```

Or set `rate = '5/minute'` on the subclass instead of a `scope`. For a completely different
algorithm, extend `BaseThrottle` and implement `allowRequest(request, view)` (may be async) and
`wait()`.

Throttle counters use the cache alias in `THROTTLE_CACHE` (default `'default'`). Point it at a
separate alias to keep them apart from application data:

```ts
REST_FRAMEWORK: { THROTTLE_CACHE: 'throttle' }   // an alias defined in CACHES
```
