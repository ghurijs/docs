---
title: Tasks
description: Django 6.0 style background tasks with @ghuri/tasks — task(), enqueue(), results, retries and periodic tasks on Cloudflare Queues, the database or in-process.
---

`@ghuri/tasks` runs work outside the request: sending email, calling a slow API, generating a
report. It has the API of Django 6.0's built-in `django.tasks` (`task()`, `.enqueue()`,
`TaskResult`, the `TASKS` setting), and runs tasks on Cloudflare Queues, from the database with a
worker process, or in-process. Ghuri adds retries, periodic tasks, and request context (the
current tenant) that follows a task to its worker.

:::tip[If you know Django]
`@task` is `task(fn, options)`, `my_task.enqueue(...)` is `await myTask.enqueue(...)` (there is
no separate `aenqueue`), and `TASKS = {"default": {"BACKEND": ...}}` is
`TASKS: { default: cloudflareQueues(...) }`. Tasks are named `<app label>.<export name>` because
JavaScript has no module paths at runtime. Arguments are positional only.
:::

This page builds on [Cron triggers and queues](/docs/topics/background-tasks/), the low-level
`onSchedule()` and `onQueue()` hooks that `@ghuri/tasks` uses.

## Install

Projects created with `npm create ghuri` have it already: `TasksConfig` in `INSTALLED_APPS`, a
`TASKS` setting (Cloudflare Queues when the `TASKS_QUEUE` binding exists, otherwise the database), a
`<project>-tasks` queue in `wrangler.jsonc`, an `npm run worker` script, and a `tasks.ts` in every app made by
`ghuri startapp`. In an older project:

```sh
npm install @ghuri/tasks@next
```

Add `TasksConfig` to `INSTALLED_APPS` and run `npx ghuri migrate` for the `tasks_dbtaskresult`
table (needed by the database backend and for task results on Queues).

## Defining tasks

Put tasks in an app's `tasks.ts` and point the app config at it, as you do with `models`:

```ts title="src/blog/tasks.ts"
import { task } from '@ghuri/tasks'
import { sendMail } from '@ghuri/mail'
import { Post } from './models'

export const notifySubscribers = task(
  async (postId: number) => {
    const post = await Post.objects.get({ pk: postId })
    await sendMail({ subject: `New post: ${post.title}`, message: post.summary, recipientList: await post.subscriberEmails() })
    return { notified: true }
  },
  { queueName: 'emails', maxAttempts: 3 },
)
```

```ts title="src/blog/app.ts"
import { AppConfig } from '@ghuri/core'
import * as models from './models'
import * as tasks from './tasks'

export class BlogConfig extends AppConfig {
  name = 'blog'
  override models = models
  override tasks = tasks   // names them 'blog.notifySubscribers', …
}
```

Options: `priority` (-100 to 100, larger first), `queueName` (default `'default'`), `backend`
(a `TASKS` alias), `takesContext` (pass `{ taskResult, attempt }` as the first argument),
`maxAttempts` and `retryDelay` (see [Retries](#retries)), and `name` for a task that is not
exported from an app's `tasks` module.

## Enqueuing

```ts
const result = await notifySubscribers.enqueue(post.pk)

// with other options for this call
await notifySubscribers.using({ priority: 10, runAfter: 600 }).enqueue(post.pk)   // in 10 minutes
```

Arguments must survive a JSON round trip unchanged: a `Date`, a `Map` or a model instance raises
`InvalidTask`. Pass primary keys and ISO strings. Enqueue after the rows a task reads are
committed:

```ts
import { onCommit } from '@ghuri/orm'
await onCommit(() => notifySubscribers.enqueue(post.pk))
```

The request user is not carried to the task; pass `user.pk`. Request context registered with
[context carriers](/docs/topics/background-tasks/#taking-request-context-along), such as the
current tenant from `@ghuri/tenants`, is captured at enqueue and restored around every attempt.

## Results

`enqueue()` returns a `TaskResult`: `id`, `status` (`READY`, `RUNNING`, `SUCCESSFUL`, `FAILED`),
`args`, `enqueuedAt`, `startedAt`, `finishedAt`, `attempts`, `errors` and `returnValue` (which
throws `TaskResultNotReady` until the task succeeded). Load or reload one later:

```ts
const result = await notifySubscribers.getResult(id)
await result.refresh()
if (result.status === 'SUCCESSFUL') console.log(result.returnValue)
```

Return values must be JSON too. `getResult()` needs a backend that stores results (the database
backend, or Queues with the `tasks` app installed).

## Backends

| | `immediate()` | `dummy()` | `cloudflareQueues()` | `database()` |
|---|---|---|---|---|
| Runs tasks | inside `enqueue()` | never (tests) | in the Worker's `queue()` handler | `ghuri db_worker`, or a Cron Trigger |
| `runAfter` | no | yes | up to 24 hours | yes |
| `priority` | no effect | yes | no | yes |
| `getResult()` | no | no | with the `tasks` app | yes |
| Use for | development | tests | Workers | Node; Workers without Queues |

`immediate()` is used when `TASKS` is not set. Each factory takes `queues`, the queue names tasks
may use (default `['default']`; `[]` allows any). A typical portable setting:

```ts title="src/settings.ts"
import { cloudflareQueues, database } from '@ghuri/tasks'

TASKS: {
  default: env.TASKS_QUEUE
    ? cloudflareQueues({ queues: { default: 'TASKS_QUEUE', emails: 'EMAILS_QUEUE' } })
    : database({ queues: ['default', 'emails'] }),
},
```

### Cloudflare Queues

`cloudflareQueues({ queues })` maps each queue name to a producer binding. The app's `queue()`
handler (from `export default createApp(settings)`) runs task messages and leaves other messages to
your own `onQueue()` handlers.

```jsonc title="wrangler.jsonc"
"queues": {
  "producers": [
    { "binding": "TASKS_QUEUE", "queue": "mysite-tasks" },
    { "binding": "EMAILS_QUEUE", "queue": "mysite-emails" }
  ],
  "consumers": [
    { "queue": "mysite-tasks", "max_retries": 5 },
    { "queue": "mysite-emails", "max_retries": 5 }
  ]
}
```

A message is limited to 128 KB, and a consumer has 15 minutes per batch, so split long work into
tasks that enqueue the next one. With the `tasks` app installed each task also gets a row in
`tasks_dbtaskresult`; `cloudflareQueues({ queues, results: false })` skips those writes.

### The database

`database()` keeps the queue in `tasks_dbtaskresult` on any database: Postgres, SQLite or D1.
Workers claim a task with a single compare-and-set `UPDATE`, so two workers never run the same
task. On Node, run one or more workers next to the web server:

```sh
npx ghuri db_worker                          # all queues, until SIGTERM
npx ghuri db_worker --queue-name emails --interval 2
npx ghuri db_worker --batch                  # run what is ready, then exit
npx ghuri prune_db_task_results --min-age-days 14
```

On Workers without Queues, run the queue from a Cron Trigger for up to 25 seconds a minute:

```ts title="src/blog/app.ts"
import { onSchedule } from '@ghuri/core'
import { drainTasks } from '@ghuri/tasks'

ready() {
  onSchedule('* * * * *', drainTasks({ seconds: 25 }))
}
```

A task left `RUNNING` for longer than `staleAfter` seconds (default one hour) lost its worker; the
next worker counts that attempt as failed and retries or fails it.

## Retries

Django runs a task once. Ghuri retries it when you ask:

```ts
export const syncInvoice = task(async (id: string) => { … }, {
  maxAttempts: 5,
  retryDelay: (attempt) => 30 * attempt,   // seconds; default 2 ** attempt, at most an hour
})
```

Each failed attempt is recorded in `result.errors`, and the result goes back to `READY` until the
last attempt fails. `taskFinished` is sent once, when the task succeeds or fails for good. On
Queues, keep each consumer's `max_retries` at least `maxAttempts - 1`; `ghuri check` warns
(`tasks.W002`).

## Periodic tasks

```ts title="src/blog/app.ts"
import { periodicTask } from '@ghuri/tasks'
import { cleanUpDrafts, syncFeeds } from './tasks'

ready() {
  periodicTask('0 3 * * *', cleanUpDrafts)                   // enqueue at 03:00 UTC
  periodicTask('*/10 * * * *', syncFeeds, { inline: true })  // run inside the cron handler
}
```

Crons use Cloudflare's syntax and run in UTC. **Day of week is 1-7 with 1 = Sunday** (or
`SUN`-`SAT`), not Unix's 0 = Sunday; `L`, `W` and `#` work as on Cloudflare.

- **Workers:** add each cron to `"triggers": { "crons": [...] }` in `wrangler.jsonc`. `ghuri check`
  reports a missing one (`tasks.E003`).
- **Node:** start the scheduler in exactly one process, with `serve(app, { scheduler: true })` or
  `npx ghuri db_worker --beat`. It fires every cron registered with `onSchedule()`, so your own
  handlers run too.

## Agents

With `@ghuri/agents`, `agent.enqueue()` becomes the `agents.run` task (3 attempts) when
`@ghuri/tasks` is installed, and returns its `taskResult`. See
[Background runs](/docs/topics/agents/#background-runs).

## Signals and admin

`taskEnqueued`, `taskStarted` and `taskFinished` are sent with the backend class as sender and
`{ taskResult }`:

```ts
import { taskFinished } from '@ghuri/tasks'

taskFinished.connect(async ({ taskResult }) => {
  if (taskResult.status === 'FAILED') await alertOps(taskResult)
})
```

`import '@ghuri/tasks/admin'` in your admin module lists task results read-only, with "Run selected
tasks again" and "Mark selected tasks as failed" actions.

## Testing

Swap the backend for `dummy()` and inspect what was enqueued, or run it:

```ts
import { captureTasks, dummy, useTaskBackend } from '@ghuri/tasks/testing'

const { backend, restore } = useTaskBackend(dummy())
await client.post('/posts/', { title: 'Hi' })
expect(backend.results.map((r) => r.task.modulePath)).toEqual(['blog.notifySubscribers'])
await backend.runPending()   // runs them in-process, with retries and request context
restore()

const results = await captureTasks(() => client.post('/posts/', { title: 'Hi' }))
```

## Checks

| Id | Problem |
|---|---|
| `tasks.E001` | a `TASKS` entry is not a task backend |
| `tasks.E002` | a task uses a backend or queue that is not configured |
| `tasks.E003` | a periodic task's cron is not in `wrangler.jsonc` |
| `tasks.E004` | `database()` (or `cloudflareQueues({ results: true })`) without the `tasks` app |
| `tasks.E005` | a Queues producer binding is not in `wrangler.jsonc` |
| `tasks.W001` | `--deploy`: the default backend is `immediate()` |
| `tasks.W002` | a consumer's `max_retries` is lower than a task's `maxAttempts - 1` |
| `tasks.W004` | a task queue has no consumer in `wrangler.jsonc` |
