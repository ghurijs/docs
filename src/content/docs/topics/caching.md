---
title: Caching
description: Configure cache backends (memory, Workers KV, the Cache API) and cache values, querysets and whole responses.
---

Ghuri's cache framework is a small key-value API with pluggable backends, like Django's. On
Cloudflare the default backend is Workers KV. On Node it is an in-process memory cache. Your
code calls `cache.get()` and `cache.set()` either way.

## Configuring caches

`CACHES` maps aliases to backend configs. `default` is what `cache` uses.

```ts title="src/settings.ts"
import { defineSettings, kvCache, cfCache, memoryCache } from '@ghuri/core'

export default defineSettings((env) => ({
  // ...
  CACHES: {
    default: env.CACHE ? kvCache('CACHE') : memoryCache(),
    pages: cfCache(),
  },
}))
```

| Backend | Storage | Scope | Good for |
|---|---|---|---|
| `memoryCache()` | a `Map` in the current process or isolate | one isolate / one Node process | tests, Node apps with one process, very hot small values |
| `kvCache(binding)` | Workers KV namespace | global, eventually consistent | values read far more than written: settings, rendered fragments, API results |
| `cfCache()` | the Workers Cache API | one Cloudflare data centre | whole responses, large values, anything that can be recomputed |

When `CACHES` is not set, `default` is `memoryCache()`.

A backend config has the shape `{ backend: string; create(env): CacheBackend }`, the same
pattern as database and storage configs, so you can write your own. A Redis backend is on the
roadmap.

:::tip[If you know Django]
`cache` is `django.core.cache.cache` and `caches.get('pages')` is `caches['pages']`. The method
names are the same in camelCase (`get_or_set` → `getOrSet`), and every method is async.
Timeouts are seconds, like Django's `timeout`.
:::

## The API

```ts
import { cache, caches } from '@ghuri/core'

await cache.set('greeting', { text: 'hello' }, 300)   // TTL in seconds
await cache.get<{ text: string }>('greeting')         // { text: 'hello' } or undefined
await cache.has('greeting')                           // true
await cache.delete('greeting')

// Compute on a miss, store, and return:
const count = await cache.getOrSet('posts:count', () => Post.objects.filter({ published: true }).count(), 60)

const pages = caches.get('pages')
await pages.set('home', html, 600)
await pages.clear?.()   // only some backends support clearing
```

Values must be JSON-serialisable. Model instances are not: cache the data you need
(`await qs.values('id', 'title')`, or a serializer's output) rather than instances.

Omit the TTL to keep a value until it is evicted. `set` with a TTL of `0` deletes the key.

## Caching a view's result

The most common pattern is to cache the expensive part of a view, keyed by whatever makes the
result different:

```ts title="src/blog/views.ts"
import type { Context } from 'hono'
import { cache, json } from '@ghuri/core'
import { Post } from './models'
import { PostSerializer } from './serializers'

export async function popular(c: Context) {
  const data = await cache.getOrSet('blog:popular:v1', async () => {
    const posts = await Post.objects.filter({ published: true }).orderBy('-createdAt').slice(0, 10)
    return new PostSerializer(posts, { many: true }).getData()
  }, 300)
  return json(c, data)
}
```

Invalidate when the data changes, for example from a `postSave`
[signal](/docs/topics/signals/):

```ts title="src/blog/app.ts"
import { cache } from '@ghuri/core'
import { postSave } from '@ghuri/orm'
import { Post } from './models'

// inside BlogConfig.ready():
postSave.connect(async () => { await cache.delete('blog:popular:v1') }, { sender: Post, uid: 'blog-popular-cache' })
```

Putting a version (`:v1`) in the key lets you invalidate everything at once after a deploy that
changes the cached shape.

## Caching whole responses

For anonymous pages that are identical for everyone, `cfCache()` can hold the `Response`
itself. Return a cached copy when there is one, and store a fresh one in the background with
`waitUntil` so the user does not wait for the write:

```ts
import { caches, getContext } from '@ghuri/core'

export async function home(c: Context) {
  const pages = caches.get('pages')
  const hit = await pages.get<string>('home')
  if (hit) return c.html(hit)

  const html = await renderHome()
  getContext().executionCtx?.waitUntil(pages.set('home', html, 600))
  return c.html(html)
}
```

Often it is simpler to send `Cache-Control: public, max-age=600` and let Cloudflare's CDN cache
the response before it reaches your Worker at all.

## Things to know about KV

- **It is eventually consistent.** A write is visible at once in the location that wrote it,
  but can take up to about 60 seconds to reach other locations. Do not use KV for counters,
  locks or anything that must be read back exactly after being written elsewhere.
- **The minimum TTL is 60 seconds.** `kvCache` rounds shorter TTLs up to 60 rather than
  failing.
- **Writes are limited.** Writing the same key more than about once per second is
  rate-limited, and KV's free plan has a daily write quota. Cache data that is read often and
  written rarely.
- **`clear()` is not supported** on KV. Namespaced or versioned keys work better.

## Who else uses the cache

- REST [throttling](/docs/topics/rest/throttling/) stores request counts in the default cache
  (or the alias in `REST_FRAMEWORK.THROTTLE_CACHE`). Because KV is eventually consistent,
  throttles on KV are approximate across locations. For strict limits, use a Durable Object or
  Cloudflare's rate limiting rules.
- The `kv` [session engine](/docs/topics/authentication/) uses its own KV binding, not `CACHES`.
