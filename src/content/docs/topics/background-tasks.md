---
title: Background tasks
description: Run code on a schedule with Cron Triggers and process messages from Cloudflare Queues with onSchedule() and onQueue(), on Workers and on Node.
---

Not every piece of work belongs in a request. Cloudflare gives a Worker two other entry points:
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), which
call it on a schedule, and [Queues](https://developers.cloudflare.com/queues/), which deliver
batches of messages sent by your own code. `@ghuri/core` connects both to your apps with two
functions, `onSchedule()` and `onQueue()`.

:::tip[If you know Django]
Django has no built-in scheduler or task queue; you reach for Celery beat, django-q or a system
crontab calling a management command. On Cloudflare the platform provides the scheduler and the
queue, so Ghuri only has to route them to your code. Handlers run with the same settings, ORM,
cache and storage as a view, much like a Celery task with Django loaded.
:::

## How the Worker entry exposes them

The object `createApp()` returns is a complete Workers module handler, with `fetch`, `scheduled`
and `queue` methods. Exporting it as the default export is all the wiring there is:

```ts title="src/index.ts"
import { createApp } from '@ghuri/core'
import settings from './settings'

export default createApp(settings)
```

When Cloudflare calls `scheduled` or `queue`, Ghuri resolves settings for the Worker's `env`,
populates `INSTALLED_APPS` (so every `ready()` has run and every handler is registered), and
runs the matching handlers inside a Ghuri context. `getSettings()`, the ORM, `cache`,
storage and `getContext().executionCtx.waitUntil()` all work. There is no request, so
`getUser()` returns `AnonymousUser`.

If you export your own object instead (for example to add a Durable Object class next to it),
forward all three methods:

```ts title="src/index.ts"
const app = createApp(settings)

export default {
  fetch: app.fetch,
  scheduled: app.scheduled,
  queue: app.queue,
}
export { ChatRoom } from './chat/room'
```

## Cron triggers

Declare the schedules in `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
"triggers": { "crons": ["0 * * * *", "30 3 * * *"] }
```

Then register a handler for each expression, usually from an `AppConfig.ready()`:

```ts title="src/blog/app.ts"
import { AppConfig, onSchedule } from '@ghuri/core'
import * as models from './models'
import { publishScheduledPosts, purgeOldDrafts } from './tasks'

export class BlogConfig extends AppConfig {
  name = 'blog'
  models = models

  ready() {
    onSchedule('0 * * * *', async (event) => {
      await publishScheduledPosts(new Date(event.scheduledTime))
    })
    onSchedule('30 3 * * *', () => purgeOldDrafts())
  }
}
```

`onSchedule(cron, handler)` matches the **exact string** from `wrangler.jsonc` (Cloudflare
passes it back as `event.cron`), so `'0 * * * *'` and `'0 */1 * * *'` are different triggers.
Use `'*'` to run a handler for every trigger. The handler receives the event
(`{ cron, scheduledTime }`) and the `GhuriContext`. `onSchedule()` returns a function that
unregisters the handler.

All handlers that match a trigger run in registration order. If one throws, the error is logged
and the others still run; the invocation then fails with that error (or an `AggregateError` if
several failed), so it shows as failed in the Cloudflare dashboard. A trigger with no matching
handler only logs a warning.

Keep scheduled work in a plain function that a [management command](/docs/topics/management-commands/)
can call too, so you can run it by hand (`npx ghuri publish_scheduled --remote`) when a trigger
was missed.

## Queues

A queue has producers, which send messages, and a consumer, which receives them in batches.
Bind both in `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
"queues": {
  "producers": [{ "binding": "EMAILS", "queue": "emails" }],
  "consumers": [{ "queue": "emails", "max_batch_size": 10, "max_retries": 3 }]
}
```

Send messages from anywhere with the producer binding:

```ts title="src/accounts/views.ts"
import { getEnv } from '@ghuri/core'

await getEnv().EMAILS.send({ userId: user.pk, template: 'welcome' })
```

Consume them with `onQueue(name, handler)`, where `name` is the queue name (not the binding):

```ts title="src/accounts/app.ts"
import { AppConfig, onQueue } from '@ghuri/core'
import { sendTemplatedEmail } from './email'

export class AccountsConfig extends AppConfig {
  name = 'accounts'

  ready() {
    onQueue<{ userId: number; template: string }>('emails', async (batch) => {
      for (const msg of batch.messages) {
        try {
          await sendTemplatedEmail(msg.body.userId, msg.body.template)
          msg.ack()
        } catch (err) {
          console.error(err)
          msg.retry({ delaySeconds: 60 })
        }
      }
    })
  }
}
```

The handler receives the batch (`queue`, `messages`, `ackAll()`, `retryAll()`) and the
`GhuriContext`. Each message has `id`, `timestamp`, `body`, `attempts`, `ack()` and
`retry({ delaySeconds? })`. `'*'` consumes every queue the Worker is bound to, and the type
parameter types `msg.body`. Like `onSchedule()`, it returns an unregister function.

Every handler registered for a queue runs, in registration order, on the same batch. A handler
that throws stops the ones after it and fails the batch, and Cloudflare redelivers every message
that was not acknowledged (up to `max_retries`, then to a dead-letter queue if you configured
one). Acknowledge or retry messages individually, as above, so one bad message does not hold up
the rest.

:::caution
A batch for a queue with no `onQueue()` handler throws `ImproperlyConfigured`, so its messages
are retried rather than silently dropped. If several apps share a queue, each handler should
skip messages that are not its own, as `@ghuri/agents` does.
:::

`@ghuri/agents` uses this to run agents in the background: `agents.consumeQueue('agents')` in a
`ready()` registers an `onQueue()` handler, and `agent.enqueue()` sends to the
`AGENTS.QUEUE_BINDING` producer. See [AI agents and MCP](/docs/topics/agents/).

## Running locally

`npx ghuri runserver` runs `wrangler dev` for Cloudflare projects, which simulates queues
locally: messages sent to a producer binding are delivered to the consumer in the same process.
To fire a cron trigger, start the dev server with wrangler's `--test-scheduled` flag (extra
flags are passed through) and request the special route:

```sh
npx ghuri runserver --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

## On Node

Node has no Cron Triggers or Queues, and Ghuri does not ship a scheduler or a queue worker. The
handlers are plain methods on the app, though, so anything that can run code on a schedule can
call them. A script that a system crontab (or a Kubernetes `CronJob`) runs:

```ts title="scripts/cron.ts"
import { createExecutionContext } from '@ghuri/core/node'
import app from '../src/index'

const ctx = createExecutionContext()
await app.scheduled({ cron: process.argv[2], scheduledTime: Date.now() }, process.env, ctx)
await ctx.drain()   // wait for waitUntil() work
```

```sh title="crontab"
0 * * * * cd /srv/mysite && npx tsx scripts/cron.ts "0 * * * *"
```

The same works in-process: call `app.scheduled({ cron, scheduledTime: Date.now() }, process.env)`
from any Node scheduling library, next to `serve()`. For queues, call
`app.queue({ queue: 'emails', messages, ackAll, retryAll }, env)` from your own consumer
(Redis, SQS, Postgres `LISTEN`), mapping `ack()` and `retry()` onto that system.

## Testing

Call `app.scheduled()` and `app.queue()` with a fake event; see
[Testing cron and queue handlers](/docs/topics/testing/#testing-cron-and-queue-handlers). To
inspect what is registered, `taskHandlers.schedulesFor(cron)` and `taskHandlers.queuesFor(name)`
return the matching handlers, and `taskHandlers.clear()` removes them all between tests.
