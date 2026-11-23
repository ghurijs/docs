---
title: Multi-tenancy
description: Build SaaS apps with @ghuri/tenants — shared-schema multi-tenancy where tenant-scoped models, managers and QuerySets filter to the current tenant and fail closed when there is none.
---

`@ghuri/tenants` adds shared-schema multi-tenancy: all tenants live in one database, every
tenant-scoped row carries a foreign key to its tenant, and Ghuri scopes managers, QuerySets and
writes to the **current tenant**. A middleware finds the tenant of each request from a header, a
subdomain or a custom domain.

When no tenant is set, queries on tenant-scoped models **fail closed**: they throw
`TenantNotSet` instead of returning every tenant's rows. Forgetting the tenant becomes an error,
not a data leak.

It works the same on D1, SQLite and Postgres: one database, one migration run, and the same models
after a [D1 to Postgres move](/docs/deployment/d1-to-postgres/).

:::note[Alpha]
`@ghuri/tenants` is at `0.1.0-alpha.2` and needs `@ghuri/core` `0.1.0-alpha.1` and `@ghuri/orm`
`0.1.0-alpha.3` or later (plus `@ghuri/auth` `0.1.0-alpha.4` for
[per-tenant users](#per-tenant-users)). Database-per-tenant routing, `dumpdata --tenant`, Postgres row-level security and a
membership permission class for `@ghuri/rest` are planned. See [Limits](#limits).
:::

:::tip[If you know Django]
Django has no built-in multi-tenancy. `django-tenants` uses one Postgres schema per tenant, which
does not exist on D1 or SQLite. `@ghuri/tenants` follows the shared-schema approach of
`django-multitenant` and `django-scopes` instead: a tenant foreign key on every row plus a
manager that adds the filter. `runAsTenant()` is `django-scopes`' `scope()`, `withoutTenant()` is
`scopes_disabled()`, and `activateTenant()` is `django-tenants`' `connection.set_tenant()`.
:::

## Setup

```sh
npm install @ghuri/tenants@next
```

### The tenant model

The tenant is an ordinary model, for example a store, an organization or a workspace. It is not
tenant-scoped itself:

```ts title="src/stores/models.ts"
import { CharField, Model, SlugField } from '@ghuri/orm'
import { tenantModel } from '@ghuri/tenants'

export class Store extends Model({
  name: new CharField({ maxLength: 100 }),
  slug: new SlugField({ unique: true }),
  domain: new CharField({ maxLength: 200, null: true, blank: true }),
  storefrontToken: new CharField({ maxLength: 64, unique: true }),
}) {}

// One factory for the whole project: a `store` foreign key and UUIDv7 primary keys on every model.
export const StoreModel = tenantModel({ field: 'store', to: () => Store, uuidPk: true })
```

### Tenant-scoped models

Build tenant-scoped models with that factory instead of `Model()`:

```ts title="src/catalog/models.ts"
import { CharField, SlugField } from '@ghuri/orm'
import { StoreModel } from '../stores/models'

export class Product extends StoreModel({
  title: new CharField({ maxLength: 255 }),
  handle: new SlugField(),
}) {
  static Meta = { uniqueTogether: [['store', 'handle']] }
}
```

Run `npx ghuri makemigrations` as usual: the tenant foreign key is an ordinary column
(`store_id`) in the migration.

### Settings

Add `TenantMiddleware` and tell it where the tenant model is and how to find a request's tenant:

```ts title="src/settings.ts"
import { defineSettings } from '@ghuri/core'
import { HeaderResolver, HostResolver, SubdomainResolver, TenantMiddleware } from '@ghuri/tenants'

export default defineSettings((env) => ({
  // ...
  MIDDLEWARE: [SecurityMiddleware, CommonMiddleware, TenantMiddleware /* , … */],
  TENANTS: {
    MODEL: 'stores.Store',
    RESOLVERS: [
      new HeaderResolver({ header: 'X-Storefront-Token', field: 'storefrontToken' }),
      new SubdomainResolver({ domain: 'myshop.example', exclude: ['www', 'api', 'admin'] }),
      new HostResolver({ field: 'domain' }),
    ],
  },
}))
```

Every key is in the [settings reference](/docs/reference/settings/#tenants-ghuritenants). Now views
need no tenant code at all:

```ts
await Product.objects.all()                                       // this request's store only
await Product.objects.create({ title: 'Shirt', handle: 'shirt' }) // `store` is filled in
await Product.unscoped.count()                                    // every store (platform code only)
```

## `tenantModel()`

`tenantModel(options)` returns a `Model()`-like factory. Every model built with it gets:

| | |
|---|---|
| `<field>` | A `ForeignKey` to the tenant: NOT NULL, indexed, `onDelete: CASCADE`, column `<field>_id`. |
| `objects` | A `TenantManager`, whose QuerySets are filtered to the current tenant. |
| `unscoped` | A plain `Manager`: every tenant, no checks. |
| `save()` | Fills in and checks the tenant and foreign keys (see [What is checked](#what-is-checked)). |

| Option | Default | |
|---|---|---|
| `field` | `'tenant'` | Name of the tenant foreign key. |
| `to` | `TENANTS.MODEL` | The tenant model, or a thunk such as `() => Store`. |
| `relatedName` | Django's default (`productSet`) | Reverse accessor on the tenant model; `'+'` hides it. |
| `uuidPk` | `false` | Add `id: UUIDField({ primaryKey: true, default: uuid7 })`. |
| `extends` | none | An abstract model to inherit, such as `AbstractBaseUser`. Its `objects` manager class is kept and scoped. |

`TenantModel` is a ready-made factory with `field: 'tenant'` and the target taken from
`TENANTS.MODEL`.

Start every index and unique constraint with the tenant field
(`uniqueTogether: [['store', 'handle']]`): uniqueness is usually per tenant, and the index then
serves the tenant filter too.

### Per-tenant users

A shop's customers belong to one store, so they are a tenant-scoped model rather than
`AUTH_USER_MODEL` (which stays your platform's staff and merchants). Build them with
`extends: AbstractBaseUser` to get passwords, and give them their own JWT classes through
`@ghuri/auth`'s `userModel()` hook:

```ts title="src/customers/models.ts"
import { AbstractBaseUser, AccessToken, RefreshToken } from '@ghuri/auth'
import { JWTAuthentication } from '@ghuri/auth/rest'
import { BooleanField, EmailField } from '@ghuri/orm'
import { tenantModel } from '@ghuri/tenants'
import { Store } from '../stores/models'

const CustomerModel = tenantModel({ field: 'store', to: () => Store, uuidPk: true, extends: AbstractBaseUser })

export class Customer extends CustomerModel({
  email: new EmailField(),
  isActive: new BooleanField({ default: true }),
}) {
  static Meta = { uniqueTogether: [['store', 'email']] }
  static USERNAME_FIELD = 'email'
}

export class CustomerAccessToken extends AccessToken {
  static tokenType = 'customer_access'
  static userModel() { return Customer }
}

export class CustomerRefreshToken extends RefreshToken {
  static tokenType = 'customer_refresh'
  static accessTokenClass = CustomerAccessToken
  static userModel() { return Customer }
}

export class CustomerJWTAuthentication extends JWTAuthentication {
  tokenClasses = [CustomerAccessToken]
}
```

`Customer.objects` is a scoped `UserManager`, so looking up an email finds it in the request's
store only. Tokens are read back through the same scoped manager, so a customer token issued by
one store is rejected on another, and the separate `tokenType` means a customer token is never
accepted as a platform-user token, or the other way round.

`TokenObtainPairView` authenticates `AUTH_USER_MODEL`, so customers log in through a small view of
your own:

```ts title="src/customers/views.ts"
import type { Context } from 'hono'
import { Customer, CustomerRefreshToken } from './models'

export async function customerLogin(c: Context) {
  const { email, password } = await c.req.json()
  const customer = await Customer.objects.filter({ email }).first() // this store only
  if (!customer || !customer.isActive || !(await customer.checkPassword(password))) {
    return c.json({ detail: 'No active account found with the given credentials' }, 401)
  }
  const refresh = await CustomerRefreshToken.forUser(customer)
  return c.json({ refresh: await refresh.encode(), access: await refresh.accessToken.encode() })
}
```

For refresh and logout, use `TokenRefreshView` and `TokenBlacklistView` with
`tokenClass = CustomerRefreshToken`, and put `CustomerJWTAuthentication` in the
`authenticationClasses` of the customer-facing viewsets. See
[Tokens and JWT](/docs/topics/auth-tokens/).

## The current tenant

`TenantMiddleware` runs each request inside `runAsTenant()`. Outside a request (queue consumers,
cron handlers, management commands, tests) you set the tenant yourself:

| Function | |
|---|---|
| `currentTenant()` | The active tenant, or `null`. |
| `requireTenant()` | The active tenant; throws `TenantNotSet` when there is none. |
| `runAsTenant(tenant, fn)` | Run `fn` as `tenant`. |
| `withoutTenant(fn)` | Run `fn` with scoping off: tenant-scoped managers see every tenant and writes are not checked. |
| `activateTenant(tenant)` | Set a tenant outside any `runAsTenant()` (scripts, REPL, tests). Returns a `restore()` function. |
| `tenantMode()` | `'tenant'`, `'bypass'` (inside `withoutTenant()`) or `'none'`. |

They nest, and the innermost wins. A queue consumer that works for one store:

```ts title="src/catalog/app.ts"
import { AppConfig, onQueue } from '@ghuri/core'
import { runAsTenant } from '@ghuri/tenants'
import { Store } from '../stores/models'
import { Product } from './models'

export class CatalogConfig extends AppConfig {
  name = 'catalog'

  ready() {
    onQueue<{ storeId: string }>('inventory', async (batch) => {
      for (const msg of batch.messages) {
        const store = await Store.objects.get({ pk: msg.body.storeId })
        await runAsTenant(store, async () => {
          for await (const product of Product.objects.iterator()) {
            // only this store's products
          }
        })
        msg.ack()
      }
    })
  }
}
```

Keep `withoutTenant()` and `unscoped` for platform code, such as billing jobs, data migrations
and staff dashboards.

### Taking the tenant along

`@ghuri/tenants` registers a [context carrier](/docs/topics/background-tasks/#taking-request-context-along)
named `tenant`, so work that leaves the request can carry the tenant without passing store ids around:

```ts
import { captureContext, restoreContext } from '@ghuri/core'

await env.INVENTORY.send({ sku, context: captureContext() })   // { tenant: '<store pk>' }

// consumer
await restoreContext(msg.body.context, () => syncInventory(msg.body.sku))   // runs as that store
```

`restoreContext()` loads the tenant and runs the work inside `runAsTenant()`; it throws `TenantNotFound`
when the tenant was deleted. `withoutTenant()` is not carried: restored work runs with no tenant and fails
closed. Queued agent runs (`agent.enqueue()`) use this automatically.

## Finding the tenant of a request

`TenantMiddleware` tries `TENANTS.RESOLVERS` in order and stops at the first one that returns a
tenant. A resolver returns the tenant, returns `null` (this is not tenant traffic; try the next
resolver), or throws `TenantNotFound`, which answers 404.

| Resolver | Matches | Unknown value |
|---|---|---|
| `HeaderResolver({ header = 'X-Tenant', field = 'pk' })` | A request header, such as a storefront token. | 404 |
| `SubdomainResolver({ domain, field = 'slug', exclude })` | `amarshop.myshop.example` → `slug = 'amarshop'`. | 404; hosts outside `domain` give `null`. |
| `HostResolver({ field = 'domain' })` | The whole host, for custom domains. | `null` |
| `async (c) => tenant \| null` | Anything you like. | Your choice. |

Every resolver also takes `filter` (for example `{ isActive: true }`, so inactive tenants answer
404) and `model` (default `TENANTS.MODEL`).

`SubdomainResolver` and `HostResolver` read the host with `requestHost(c)`: the same host the
CSRF and `ALLOWED_HOSTS` checks use, lower-cased, without the port or a trailing dot. That is the
host of the request URL, which Workers and `@ghuri/core/node` take from the `Host` header.
`X-Forwarded-Host` is used only when `USE_X_FORWARDED_HOST` is `true`, as in Django. Set it only
behind a proxy that overwrites the header, or any client could choose its tenant.

:::note[Changed in 0.1.0-alpha.2]
Before `0.1.0-alpha.2` the host resolvers trusted `X-Forwarded-Host` unconditionally. If your proxy
sets it and you relied on that, set `USE_X_FORWARDED_HOST: true`.
:::

When no resolver finds a tenant, the request runs without one, so platform routes such as signup
or a marketing page keep working. Set `TENANTS.REQUIRED: true`, or use
`new TenantMiddleware({ required: true })`, to answer 404 instead. A view reads the tenant with
`currentTenant()` or `c.get('tenant')`.

With `REQUIRED`, mark the views that legitimately arrive without a tenant, such as a payment
provider's webhook or a health check, with `tenantNotRequired(view)`. It works like Django's
`login_not_required` for `LoginRequiredMiddleware`. A marked view runs with no tenant, so
tenant-scoped queries in it still fail closed. A tenant the resolvers do find is still activated,
and an unknown one is still a 404. [`@ghuri/billing`](/docs/topics/billing/)'s webhook view is
marked already.

```ts
import { tenantNotRequired } from '@ghuri/tenants'

export default [
  path('healthz/', tenantNotRequired(healthView)),
  path('hooks/github/', tenantNotRequired(githubWebhook)),
]
```

The marker is `Symbol.for('ghuri.tenantNotRequired')` (`TENANT_NOT_REQUIRED_MARKER`), so a package
can mark its own views without depending on `@ghuri/tenants`. `isTenantNotRequired(c)` checks the
current request. *New after 0.1.0-alpha.3.*

:::caution[Resolving is not authorizing]
A resolver only says which tenant a request is **for**. Whether the signed-in user may act for
that tenant is a permission check: compare `request.user` with your own membership model in a
[permission class](/docs/topics/rest/permissions/).
:::

## What is checked

With a tenant active:

| Operation | Behaviour |
|---|---|
| Reads (`fetch`, `get`, `count`, `exists`, `aggregate`, `values`, iteration) | `WHERE <tenant> = <current>` is added. |
| Subqueries (`filter({ pk__in: Product.objects.values('id') })`) | Scoped the same way. |
| Reverse relations, many-to-many managers, GraphQL, REST viewsets, agent tools | Scoped, because they read through `objects`. |
| `save()`, `create()` | Fill an empty tenant; refuse another tenant's object, and an explicit key that names another tenant's row. |
| Foreign keys to tenant-scoped models | Must point to the same tenant (checked on `save`, `create`, `bulkCreate`, `bulkUpdate` and `update`). |
| `update(values)` | Scoped; refuses changing the tenant or pointing foreign keys at another tenant. |
| `bulkCreate()` | Fills and checks the tenant and foreign keys. |
| `bulkUpdate()` | Refuses objects of another tenant and changes to the tenant field. |
| `delete()` | Scoped; cascades follow the same-tenant foreign keys. |
| Many-to-many `add()` | Both sides must belong to the current tenant. |

A refused write throws `CrossTenantError`, a `PermissionDenied`, so a client gets HTTP 403. With
**no** tenant (and outside `withoutTenant()`), any query or write on a tenant-scoped model throws
`TenantNotSet`, and a tenant QuerySet used as a subquery matches nothing. `TenantNotSet` reaches
clients as a 500, because it means code ran without a tenant where one was required.

The tenant filter is added when a QuerySet runs, not when it is built. So
`static queryset = Product.objects.all()` on a viewset is safe at import time and is scoped to
each request.

Each foreign key check costs one `COUNT` query per field per write. Values already checked are
remembered for the rest of the request or `runAsTenant()` block.

## Cache and primary keys

`tenantCache(alias = 'default')` wraps a configured [cache](/docs/topics/caching/) and prefixes
every key with `t:<tenant pk>:`. Its `clear()` deletes only the current tenant's keys on backends
that clear by prefix (memory and KV):

```ts
import { tenantCache } from '@ghuri/tenants'

const cache = tenantCache()
await cache.getOrSet('menu', () => buildMenu(), 300)
```

`uuid7()` returns a time-ordered UUID (RFC 9562) and `uuid7Time(id)` reads its timestamp back.
With `uuidPk: true`, primary keys are unique across databases, so a tenant can later move to a
database of its own without key clashes.

Ids made by one process (a Worker isolate or a Node process) are strictly increasing, even within
one millisecond, so `orderBy('id')` keeps insertion order for rows created together, such as the
lines of an order. Ids from different processes are ordered by time only. `uuid7Time()` can be
slightly ahead of the wall clock after the system clock steps back.

## GraphQL, REST and agents

GraphQL, REST and agents all read through each model's default manager, so they are scoped with
no per-type code:

- [`@ghuri/graphql`](/docs/topics/graphql/): root fields, connections, relations and `node(id:)`.
  Another tenant's `node(id:)` resolves to `null`.
- [`@ghuri/rest`](/docs/topics/rest/): viewsets, including `queryset = Product.objects.all()` set
  at import time. Another tenant's object is a 404, and a serializer foreign key that names another
  tenant's row fails validation with a 400, because related fields look rows up through the scoped
  `objects` too.
- [`@ghuri/agents`](/docs/topics/agents/): `ModelTools` run as the current tenant. The MCP endpoint
  runs them inside the request, after `TenantMiddleware`, and queued runs (`enqueue()`) run as the tenant
  that enqueued them. Conversations belong to their user; to scope them to the tenant as well, use
  a tenant-scoped conversation model (below).

### Agent conversations

A user who belongs to two stores would see both stores' agent conversations, because the built-in
`agents.Conversation` only knows its user. Swap it for a tenant-scoped model with
`AGENTS.CONVERSATION_MODEL`:

```ts
import { conversationFields } from '@ghuri/agents'

export class Conversation extends StoreModel({ ...conversationFields }) {
  static Meta = { ordering: ['-updatedAt'] }
}

// settings
AGENTS: { CONVERSATION_MODEL: 'stores.Conversation' },
```

The chat, conversation list and detail endpoints then read through the scoped `objects`: another
store's conversation is a 404, also for its owner, and new conversations get the current store.
Projects that already have conversations need a short migration; see
[Your own conversation model](/docs/topics/agents/#your-own-conversation-model).

## Testing for leaks

`assertTenantIsolation()` from `@ghuri/tenants/testing` runs `objects.all()` of every registered
tenant-scoped model (or the `models` you pass) as each tenant. It also runs your `run` function
as each tenant and searches what it returns: arrays, objects, `Map`s and `Set`s. It throws
`TenantLeakError` when another tenant's row comes back, or when a tenant's own rows are missing:

```ts title="src/orders/tests.ts"
import { assertTenantIsolation } from '@ghuri/tenants/testing'

it('never leaks between stores', async () => {
  const [a, b] = await makeTwoStoresWithData()

  await assertTenantIsolation({
    tenants: [a, b],
    run: () => listOrdersForDashboard(), // your own code, run once as each tenant
  })
})
```

To run ordinary test code as a tenant, wrap it in `runAsTenant()` or call `activateTenant(store)`
in `beforeEach` and the returned `restore()` in `afterEach`.

To send a request as a tenant through the [test client](/docs/topics/testing/#the-test-client),
put the host in the URL (`client.get('http://amarshop.myshop.example/products/')`) or in the
client's `baseUrl`, not in a `Host` header, and include it in `ALLOWED_HOSTS` if you restrict
them. Header resolvers work with an ordinary header.

## Limits

- `unscoped`, `_baseManager`, raw SQL and `getDrizzle()` are not scoped.
- A foreign key from a tenant-scoped model to the tenant model itself, other than the tenant
  field (for example `referrerStore`), is not checked.
- A reverse foreign key `add()` (`collection.productSet.add(p)`) updates rows by primary key. It
  only accepts saved instances, which came from scoped queries unless you loaded them through
  `unscoped`.
- `@ghuri/admin` has no tenant integration yet. It reads through the default manager, so on a
  request with no tenant its pages for tenant-scoped models fail with `TenantNotSet`. In your own
  platform views, use `withoutTenant()` or `unscoped`.
- Not yet: database routers to move one tenant to its own database, `dumpdata --tenant`, Postgres
  row-level security, and a tenant-membership permission class for `@ghuri/rest`.
