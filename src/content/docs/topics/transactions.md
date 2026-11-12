---
title: Transactions
description: atomic(), savepoints, and what transactions mean on D1, SQLite and Postgres.
---

Ghuri runs in autocommit mode by default: each query is committed immediately. To make a group
of writes all-or-nothing on Postgres and SQLite, wrap them in `atomic()`. On D1, `atomic()`
cannot roll back; use [`connection.batch()`](#d1) instead.

```ts
import { atomic, F } from '@ghuri/orm'

await atomic(async () => {
  const order = await Order.objects.create({ customer: user, total: '49.00' })
  await OrderLine.objects.bulkCreate(lines.map((l) => new OrderLine({ ...l, order })))
  await Product.objects.filter({ id__in: lines.map((l) => l.productId) })
    .update({ stock: F('stock').sub(1) })
})
```

If the callback throws, everything inside it is rolled back (except on D1) and the error propagates. If it
returns, the transaction commits and `atomic()` resolves to the callback's return value.

Nested `atomic()` calls create savepoints, so an inner block can fail and roll back without
aborting the outer one:

```ts
await atomic(async () => {
  await post.save()
  try {
    await atomic(async () => {
      await notifySubscribers(post)   // may throw
    })
  } catch {
    // the post is still saved; only the inner block was rolled back
  }
})
```

Use a different database alias with `atomic(fn, { using: 'analytics' })`. Pass
`{ savepoint: false }` to make a nested block join the outer transaction without a savepoint.

:::tip[If you know Django]
`atomic()` is `transaction.atomic`, used as a function wrapper instead of a `with` block or
decorator. The request context plays the role of Django's thread-local connection: queries made
anywhere inside the callback (in other functions, in signal receivers) join the transaction
automatically. There is no `ATOMIC_REQUESTS` setting; wrap the view body when you need it.
:::

## Behaviour by database

Transactions depend on what the database underneath supports. Each connection reports it as
`connection.supportsTransactions` (and `connection.features.supportsSavepoints`).

| Database | `atomic()` | Savepoints |
|---|---|---|
| Postgres (`postgres()`, Hyperdrive) | real `BEGIN` / `COMMIT` / `ROLLBACK` | yes |
| SQLite (`@ghuri/orm/sqlite`), PGlite (`@ghuri/orm/pglite`) | real transactions | yes |
| D1 (`d1()`) | **no transaction, no rollback**, see below | no |

`connections.inAtomicBlock(alias)` tells you whether code is running inside `atomic()`.

### D1

:::caution[`atomic()` does not roll back on D1]
D1 has no interactive transactions: a Worker cannot hold a transaction open across several
round trips. On D1, `atomic()` simply runs the callback. Every statement is committed as soon
as it runs, and **nothing is rolled back if the callback throws**. The only thing `atomic()`
still does on D1 is defer `onCommit()` callbacks until the callback returns successfully.

This also applies to everything the ORM wraps in `atomic()` internally, such as cascading
deletes (`qs.delete()`), `updateOrCreate()` and `getOrCreate()`.
:::

What D1 does offer is a **batch**: a list of statements that D1 executes atomically, all or
nothing. Use `connection.batch()` when a group of writes must not be applied partially:

```ts
import { connections } from '@ghuri/orm'

const conn = await connections.get()
await conn.batch([
  { sql: 'UPDATE shop_product SET stock = stock - ? WHERE id = ? AND stock >= ?', params: [1, productId, 1] },
  { sql: 'INSERT INTO shop_orderline (order_id, product_id, quantity) VALUES (?, ?, ?)', params: [orderId, productId, 1] },
])
```

A batch cannot read in between statements (each statement's parameters are fixed when you
build it), and it takes raw SQL, so its statements are dialect-specific. On the other
backends `batch()` runs the statements in a transaction, so the same call is all-or-nothing
everywhere. Migrations (one batch per migration) and `loaddata` (one batch per 5,000
statements) use batches on D1 for the same reason.

Design write paths on D1 accordingly:

- Prefer single statements that do the whole job: `qs.update()` with `F()` expressions, or
  `bulkCreate()`.
- Group writes that must succeed together into one `connection.batch()`.
- Make multi-step operations idempotent, so a retry after a failure converges.
- When you need strict multi-statement atomicity with reads in between, that is a strong signal
  to [move to Postgres](/docs/deployment/d1-to-postgres/), possibly through Hyperdrive while
  staying on Workers.

## Running code after commit

Sending an email or enqueueing a job should happen only if the transaction commits. Use
`onCommit()`:

```ts
import { atomic, onCommit } from '@ghuri/orm'

await atomic(async () => {
  const user = await User.objects.create({ ... })
  await onCommit(() => sendWelcomeEmail(user))
})
```

Callbacks run in order after the outermost `atomic()` block commits, and are dropped if the
block (or the savepoint that registered them) rolls back. Outside a transaction the callback
runs immediately, which is why `onCommit()` returns a promise you should await. Pass
`{ using: 'analytics' }` for another alias. On Workers, if the callback returns a
promise that should outlive the response, pass it to
`getContext().executionCtx?.waitUntil()`.
