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
`@ghuri/tenants` is at `0.1.0-alpha.0` and needs `@ghuri/core` and `@ghuri/orm` `0.1.0-alpha.1` or
later. Database-per-tenant routing, `dumpdata --tenant`, Postgres row-level security and a
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

`TenantModel` is a ready-made factory with `field: 'tenant'` and the target taken from
`TENANTS.MODEL`.

Start every index and unique constraint with the tenant field
(`uniqueTogether: [['store', 'handle']]`): uniqueness is usually per tenant, and the index then
serves the tenant filter too.

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

When no resolver finds a tenant, the request runs without one, so platform routes such as signup
or a marketing page keep working. Set `TENANTS.REQUIRED: true`, or use
`new TenantMiddleware({ required: true })`, to answer 404 instead. A view reads the tenant with
`currentTenant()` or `c.get('tenant')`.

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
| Reverse relations, many-to-many managers, GraphQL | Scoped, because they read through `objects`. |
| `save()`, `create()` | Fill an empty tenant; refuse another tenant's object, and an explicit key that names another tenant's row. |
| Foreign keys to tenant-scoped models | Must point to the same tenant (checked on `save`, `create`, `bulkCreate`, `bulkUpdate` and `update`). |
| `update(values)` | Scoped; refuses changing the tenant or pointing foreign keys at another tenant. |
| `bulkCreate()` | Fills and checks the tenant and foreign keys. |
| `bulkUpdate()` | Refuses objects of another tenant and changes to the tenant field. |
| `delete()` | Scoped; cascades follow the same-tenant foreign keys. |
| Many-to-many `add()` | Both sides must belong to the current tenant. |

A refused write throws `CrossTenantError`. With **no** tenant (and outside `withoutTenant()`),
any query or write on a tenant-scoped model throws `TenantNotSet`, and a tenant QuerySet used as a
subquery matches nothing.

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

## GraphQL and REST

[`@ghuri/graphql`](/docs/topics/graphql/) reads through each model's default manager, so root
fields, connections, relations and `node(id:)` are scoped with no per-type code. Another tenant's
`node(id:)` resolves to `null`.

[REST](/docs/topics/rest/) generic views and viewsets evaluate `queryset.all()` on every request,
so they are scoped the same way. That path is not covered by the package's own tests yet, so add
a [leak test](#testing-for-leaks) for your API.

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
in `beforeEach` and the returned `restore()` in `afterEach`. See [Testing](/docs/topics/testing/).

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
