---
title: Transactions
description: atomic(), savepoints, and what transactions mean on D1, SQLite and Postgres.
---

Ghuri runs in autocommit mode by default: each query is committed immediately. To make a group
of writes all-or-nothing, wrap them in `atomic()`.

```ts
import { atomic } from '@ghuri/orm'

await atomic(async () => {
  const order = await Order.objects.create({ customer: user, total: '49.00' })
  await OrderLine.objects.bulkCreate(lines.map((l) => new OrderLine({ ...l, order })))
  await Product.objects.filter({ id__in: lines.map((l) => l.productId) })
    .update({ stock: F('stock').sub(1) })
})
```

If the callback throws, everything inside it is rolled back and the error propagates. If it
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

Use a different database alias with `atomic(fn, { using: 'analytics' })`.

:::tip[If you know Django]
`atomic()` is `transaction.atomic`, used as a function wrapper instead of a `with` block or
decorator. The request context plays the role of Django's thread-local connection: queries made
anywhere inside the callback (in other functions, in signal receivers) join the transaction
automatically. There is no `ATOMIC_REQUESTS` setting; wrap the view body when you need it.
:::

## Behaviour by database

Transactions depend on what the database underneath supports. Each connection reports it as
`connection.supportsTransactions`.

| Database | `atomic()` | Savepoints |
|---|---|---|
| Postgres (`postgres()`, Hyperdrive) | real `BEGIN` / `COMMIT` / `ROLLBACK` | yes |
| SQLite (`@ghuri/orm/sqlite`), PGlite | real transactions | yes |
| D1 (`d1()`) | best effort, see below | no |

### D1

D1 does not support interactive transactions: a Worker cannot hold a transaction open across
several round trips. It does run a **batch** of statements atomically. Inside `atomic()` on D1,
Ghuri:

1. Executes reads immediately, as usual.
2. Collects writes whose results are not needed to continue (inserts without a returned id that
   is used later, updates, deletes) into a batch where it can.
3. Sends the batch at the end of the callback, so those writes commit or fail together.

Writes whose results the callback needs straight away (for example, `create()` followed by code
that uses the new primary key) are executed immediately and are **not** rolled back if a later
step fails.

This means `atomic()` on D1 is a useful optimisation and a partial safety net, not a guarantee.
Design write paths on D1 accordingly:

- Prefer single statements that do the whole job: `qs.update()` with `F()` expressions, or
  `bulkCreate()`.
- Make multi-step operations idempotent, so a retry after a failure converges.
- When you need strict multi-statement atomicity with reads in between, that is a strong signal
  to [move to Postgres](/docs/deployment/d1-to-postgres/), possibly through Hyperdrive while
  staying on Workers.

:::note[Alpha]
How much of a D1 `atomic()` block can be deferred into a batch is still being tuned. Do not
rely on a particular write being batched; rely only on the guarantees above.
:::

## Running code after commit

Sending an email or enqueueing a job should happen only if the transaction commits. Use
`onCommit()`:

```ts
import { atomic, onCommit } from '@ghuri/orm'

await atomic(async () => {
  const user = await User.objects.create({ ... })
  onCommit(() => sendWelcomeEmail(user))
})
```

Outside a transaction the callback runs immediately. On Workers, if the callback returns a
promise that should outlive the response, pass it to
`getContext().executionCtx?.waitUntil()`.
