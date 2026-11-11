---
title: Testing
description: Test Ghuri apps with Vitest, a fresh test database on SQLite, PGlite or D1, and a test client that runs requests through the full stack.
---

Ghuri tests are [Vitest](https://vitest.dev) tests. The framework adds three things: a way to
start your app without a server (`app.setup(env)`), a fresh database per test run
(`setupTestDatabase`), and a test client that sends requests through your middleware, URLs and
views (`createTestClient`).

## Running tests

```sh
npx ghuri test                 # all tests
npx ghuri test src/blog        # one app
npx ghuri test -- --watch      # anything after -- goes to vitest
```

`ghuri test` runs Vitest with a config that understands your project. By default it collects
`src/**/tests.ts` and `src/**/*.test.ts`. If you need your own `vitest.config.ts`, it is picked up
automatically.

## A first test

```ts title="src/blog/tests.ts"
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createApp } from '@ghuri/core'
import { setupTestDatabase } from '@ghuri/orm/testing'
import { User } from '@ghuri/auth'
import settings from '../settings'
import { Post } from './models'

const app = createApp(settings)
let db: Awaited<ReturnType<typeof setupTestDatabase>>

beforeAll(async () => {
  await app.setup({ SECRET_KEY: 'test', DEBUG: 'true' })
  db = await setupTestDatabase({ using: 'sqlite' })
})
afterEach(() => db.flush())
afterAll(() => db.teardown())

describe('Post', () => {
  it('orders newest first', async () => {
    const author = await User.objects.createUser({ username: 'a', password: 'pw-123456' })
    await Post.objects.create({ title: 'Old', slug: 'old', author })
    await Post.objects.create({ title: 'New', slug: 'new', author })

    const titles = await Post.objects.valuesList('title', { flat: true })
    expect(titles).toEqual(['New', 'Old'])
  })
})
```

What each piece does:

- **`app.setup(env)`** resolves settings for that `env`, populates `INSTALLED_APPS` and sets a
  global context, so models and caches work outside a request. The `env` stands in for Worker
  bindings or `process.env`.
- **`setupTestDatabase({ using })`** replaces the `default` database with a new, empty one, runs
  every migration (or creates tables straight from the models when an app has no migrations
  yet) and returns `{ flush, teardown }`.
- **`flush()`** empties every table but keeps the schema. Calling it in `afterEach` gives each
  test a clean database without re-running migrations.
- **`teardown()`** closes and deletes the test database.

:::tip[If you know Django]
Django's `TestCase` wraps each test in a transaction and rolls it back. D1 has no interactive
transactions, so Ghuri isolates tests by flushing tables instead, which is Django's
`TransactionTestCase` behaviour. Use `flush()` in `afterEach`. There is no test class
hierarchy: you write plain Vitest `describe`/`it` blocks, and `setupTestDatabase` plays the role
of the test runner's database creation.
:::

## Choosing the test database

| `using` | Engine | Runs | Use when |
|---|---|---|---|
| `'sqlite'` | `better-sqlite3`, in memory | Node | Default. Fast, and the same SQL dialect as D1 |
| `'pglite'` | [PGlite](https://pglite.dev), Postgres compiled to WASM | Node | You deploy on Postgres, or want to make sure your queries work on both dialects |
| `'d1'` | D1 through Miniflare | Node | You rely on D1-specific behaviour such as `batch()` semantics or limits |

A good habit is to run the suite on both dialects in CI, so moving from D1 to Postgres is never
a surprise:

```ts
db = await setupTestDatabase({ using: (process.env.TEST_DB as 'sqlite' | 'pglite') ?? 'sqlite' })
```

```sh
TEST_DB=sqlite npx ghuri test && TEST_DB=pglite npx ghuri test
```

PGlite needs no Postgres server, so this works on any CI runner.

## The test client

`createTestClient(app, { env })` returns a client whose methods send a `Request` through
`app.fetch`, the same path a real request takes, including middleware and error handling. No
port is opened.

```ts
import { createTestClient } from '@ghuri/core/testing'

const client = createTestClient(app, { env: { SECRET_KEY: 'test', DEBUG: 'true' } })

const res = await client.get('/blog/api/posts/?search=ghuri')
expect(res.status).toBe(200)
expect((await res.json()).count).toBe(1)

await client.post('/blog/api/posts/', { json: { title: 'Via test', slug: 'via-test' } })
await client.post('/accounts/login/', { form: { username: 'a', password: 'pw-123456' } })
await client.patch('/blog/api/posts/via-test/', {
  json: { published: true },
  headers: { Authorization: `Token ${token}` },
})
await client.delete('/blog/api/posts/via-test/')
```

- `get`, `post`, `put`, `patch` and `delete` take a path and `{ json?, form?, headers? }`.
  `json` sets `Content-Type: application/json`; `form` sends
  `application/x-www-form-urlencoded`.
- Responses are standard `Response` objects.
- **Cookies persist** between requests on the same client, so sessions and CSRF work as in a
  browser. Form posts automatically include the `csrftoken` the client has received.

### Logging in

Logging in through a form is slow and couples tests to your login page. `forceLogin` attaches a
session for a user directly:

```ts
const editor = await User.objects.createUser({ username: 'editor', password: 'pw-123456' })
await client.forceLogin(editor)

const res = await client.get('/admin/blog/post/')
expect(res.status).toBe(403)   // logged in, but not staff
```

`forceLogin` is provided by `@ghuri/auth`. It only works when `AuthConfig` and
`SessionMiddleware` are installed.

## Testing management commands

Use `callCommand` with `bufferIO` to run a command and inspect its output:

```ts
import { callCommand, bufferIO } from '@ghuri/core'

it('publishes drafts', async () => {
  await Post.objects.create({ title: 'Draft', slug: 'draft', author })
  const io = bufferIO()
  await callCommand('publish_scheduled', { limit: '10' }, io)
  expect(io.out).toContain('Published "Draft"')
  expect(await Post.objects.filter({ published: true }).count()).toBe(1)
})
```

See [Management commands](/docs/topics/management-commands/).

## Other services in tests

Configure test-friendly backends through the `env` you pass to `app.setup`, the same way
production chooses its backends:

```ts title="src/settings.ts"
STORAGES: { default: env.MEDIA ? r2('MEDIA') : memoryStorage() },
CACHES: { default: env.CACHE ? kvCache('CACHE') : memoryCache() },
```

Test `env` objects have no `MEDIA` or `CACHE` binding, so tests get in-memory storage and cache
with no extra setup.

To test against real Workers bindings (KV, R2, Durable Objects), use Cloudflare's
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
and pass its `env` to `app.setup`. Tests then run inside `workerd`.

:::note[Alpha]
The test database helpers (`setupTestDatabase`, `flush`, `teardown`) and the `ghuri test`
defaults are still being settled. Expect a per-test transactional mode on SQLite and PGlite, and
possibly a `using: 'd1'` option tied to the Workers Vitest pool.
:::
