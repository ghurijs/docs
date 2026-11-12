---
title: Testing
description: Test Ghuri apps with Vitest, a fresh test database on SQLite, PGlite or D1, and a test client that runs requests through the full stack.
---

Ghuri tests are [Vitest](https://vitest.dev) tests. The framework adds three things: a way to
start your app without a server (`app.setup(env)`), a fresh database per test run
(`setupTestDatabase` from `@ghuri/orm/testing`), and a test client that sends requests through
your middleware, URLs and views (`createTestClient` from `@ghuri/core/testing`).

## Running tests

```sh
npx ghuri test                 # vitest run
npx ghuri test src/blog        # extra arguments go to vitest
npx ghuri test --watch         # watch mode
```

`ghuri test` runs the project's own Vitest (install it with `npm install -D vitest`) from the
project root, so test files are collected by Vitest's defaults or your `vitest.config.ts`
(`*.test.ts` and `*.spec.ts`; add `include: ['src/**/tests.ts']` if you prefer Django-style
`tests.ts` modules).

## A first test

```ts title="src/blog/blog.test.ts"
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createApp } from '@ghuri/core'
import { setupTestDatabase, type TestDatabase } from '@ghuri/orm/testing'
import { User } from '@ghuri/auth'
import settings from '../settings'
import { Post } from './models'

const app = createApp(settings)
let db: TestDatabase

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
- **`setupTestDatabase({ using })`** opens a new, empty in-memory database, installs it as
  `DATABASES.default` in the current context (or in a fresh context if there is none), runs the
  migrations of installed apps that have some and creates tables directly for every other model,
  then returns `{ connection, flush, teardown }`. `postMigrate` is sent, so default permissions
  and content types exist. Options: `alias`, `models` (limit the tables), `createTables: false`.
- **`flush()`** empties every table but keeps the schema, then sends `postMigrate` like
  `ghuri flush`, so post-migrate data (content types, default permissions) is recreated.
  Calling it in `afterEach` gives each test a clean database without re-running migrations.
  `flush({ inhibitPostMigrate: true })` leaves every table empty.
- **`teardown()`** closes the test database and restores the previous `DATABASES`.

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

A good habit is to run the suite on several dialects in CI, so moving from D1 to Postgres is
never a surprise. `testBackends()` returns the backends listed in `GHURI_TEST_BACKENDS` (all
three when unset), ready for `describe.each`:

```ts
import { setupTestDatabase, testBackends } from '@ghuri/orm/testing'

describe.each(testBackends())('posts on %s', (using) => {
  let db: TestDatabase
  beforeAll(async () => { db = await setupTestDatabase({ using }) })
  afterEach(() => db.flush())
  afterAll(() => db.teardown())
  // ...
})
```

```sh
GHURI_TEST_BACKENDS=sqlite,pglite npx ghuri test
```

PGlite needs no Postgres server, so this works on any CI runner. `captureQueries(fn)` from
`@ghuri/orm` runs `fn` and returns a `[result, queries]` tuple, where `queries` is the list of
`QueryEvent`s (`sql`, `params`, `alias`, `vendor`, `durationMs`) the block executed, for
asserting query counts: `const [posts, queries] = await captureQueries(() => Post.objects.all())`.

## The test client

`createTestClient(app, { env })` returns a client whose methods send a `Request` through
`app.fetch`, the same path a real request takes, including middleware and error handling. No
port is opened.

```ts
import { createTestClient } from '@ghuri/core/testing'

const client = createTestClient(app, { env: { SECRET_KEY: 'test', DEBUG: 'true' } })

const res = await client.get('/blog/api/posts/', { query: { search: 'ghuri' } })
expect(res.status).toBe(200)
expect((await res.json()).count).toBe(1)

await client.post('/blog/api/posts/', { json: { title: 'Via test', slug: 'via-test' } })
await client.post('/contact/', { form: { email: 'a@b.c', attachment: new File(['x'], 'x.txt') } })
await client.patch('/blog/api/posts/via-test/', {
  json: { published: true },
  headers: { Authorization: `Token ${token}` },
})
await client.delete('/blog/api/posts/via-test/')

const followed = await client.get('/old-url/', { follow: true })
followed.redirectChain   // [['/new-url/', 301]]
```

- `get`, `head`, `options`, `post`, `put`, `patch` and `delete` take a path and
  `{ json?, form?, body?, query?, headers?, follow?, csrf? }`. `json` sets
  `Content-Type: application/json`; `form` sends `application/x-www-form-urlencoded`, or
  `multipart/form-data` when it contains a `File`/`Blob` or is a `FormData`.
- Responses are standard `Response` objects, plus `redirectChain` and `request`.
- **Cookies persist** between requests on the same client (`client.getCookie()`,
  `setCookie()`, `clearCookies()`), so sessions work as in a browser.
- **CSRF is handled for you.** Unsafe requests send the `csrftoken` cookie's value as
  `X-CSRFToken`, creating a cookie first if there is none. Pass `csrf: false` (per client or per
  request) to test CSRF failures.
- `client.waitForBackgroundTasks()` awaits everything views passed to `waitUntil()`.
- `client.withContext(fn)` runs `fn` inside a context for the client's `env`, for creating
  fixtures with the app's settings.

Requests go to `http://testserver` (change it with `baseUrl`).

:::caution
Unlike Django, Ghuri does not add `testserver` to `ALLOWED_HOSTS` during tests. If your settings
restrict `ALLOWED_HOSTS`, include `'testserver'` when testing (or set `baseUrl` to an allowed
host), or every request answers 400.
:::

The client is fetch-based, so it also works inside `workerd` with
`@cloudflare/vitest-pool-workers`.

### Logging in

Logging in through a form is slow and couples tests to your login page. `forceLogin` attaches a
session for a user directly:

```ts
const editor = await User.objects.createUser({ username: 'editor', password: 'pw-123456' })
await client.forceLogin(editor)

const res = await client.get('/admin/blog/post/')
expect(res.status).toBe(403)   // logged in, but not staff

await client.login({ username: 'editor', password: 'pw-123456' })   // true / false
await client.logout()
```

`forceLogin`, `login` and `logout` are provided by `@ghuri/auth`: importing it registers them
as test client hooks. They need sessions to work, so install `SessionsConfig` (for the default
`db` session engine) and `SessionMiddleware`. Use a fast password hasher in tests:
`PASSWORD_HASHERS: [new PBKDF2PasswordHasher({ iterations: 1000 })]`.

Packages extend the client the same way. `registerTestClientHook(name, fn)` from
`@ghuri/core/testing` registers a hook, and `client.callHook(name, ...args)` calls it; the names
`forceLogin`, `login` and `logout` back the methods of the same name.

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

## Testing cron and queue handlers

The object `createApp()` returns has the Workers `scheduled` and `queue` handlers, so tests can
call them directly with a fake event:

```ts
await app.scheduled({ cron: '0 * * * *', scheduledTime: Date.now() }, env)

const msg = { id: '1', timestamp: new Date(), body: { postId: 1 }, ack: vi.fn(), retry: vi.fn() }
await app.queue({ queue: 'emails', messages: [msg], ackAll: vi.fn(), retryAll: vi.fn() }, env)
expect(msg.ack).toHaveBeenCalled()
```

See [Background tasks](/docs/topics/background-tasks/).

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
and pass its `env` to `app.setup` and `createTestClient`. Tests then run inside `workerd`.

:::note[Alpha]
There is no per-test transactional mode yet: isolation comes from `flush()`, which empties
every table (one `DELETE` per table on SQLite and D1, one `TRUNCATE` on Postgres). Group tests
that can share data in one `describe` with a single `flush()` if this gets slow.
:::
