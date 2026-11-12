---
title: Signals
description: Decouple code with signals, connect receivers to model and request events, and define your own signals.
---

Signals let one part of your project react to events in another without the two importing each
other. A sender says "a post was saved", and any number of receivers respond. Ghuri's signals
work like Django's with one important difference: **receivers are async and are awaited, one
after another**, before `send()` resolves.

## Built-in signals

| Signal | From | Sent | Arguments |
|---|---|---|---|
| `preSave` | `@ghuri/orm` | before `instance.save()` writes | `instance`, `raw`, `using`, `updateFields` |
| `postSave` | `@ghuri/orm` | after `instance.save()` writes | `instance`, `created`, `raw`, `using`, `updateFields` |
| `preDelete` | `@ghuri/orm` | before an instance is deleted (also for each object of a cascading delete) | `instance`, `using`, `origin` |
| `postDelete` | `@ghuri/orm` | after an instance is deleted | `instance`, `using`, `origin` |
| `m2mChanged` | `@ghuri/orm` | around `add`/`remove`/`set`/`clear` on a many-to-many (sender: the through model) | `instance`, `action`, `reverse`, `model`, `pkSet`, `using` |
| `preMigrate` / `postMigrate` | `@ghuri/orm` | for every installed app before / after `migrate` (`postMigrate` also after `flush` and `setupTestDatabase`; sender: the `AppConfig`) | `appConfig`, `using`, `plan` |
| `userLoggedIn` / `userLoggedOut` | `@ghuri/auth` | by `login()` / `logout()` (sender: the user model) | `c`, `user` |
| `userLoginFailed` | `@ghuri/auth` | when `authenticate()` finds no matching backend | `c`, `credentials` (secrets masked) |
| `requestStarted` | `@ghuri/core` | when a request enters the app | `request` |
| `requestFinished` | `@ghuri/core` | after the response is produced | `request`, `response` |

Every receiver also receives `sender`: the model class for ORM model signals, the app object
for request signals.

`raw` is `true` while `loaddata` is loading fixtures. Receivers that create related rows should
skip that case, because the fixture contains those rows already.

As in Django, `qs.update()` and `bulkCreate()` do not send `preSave`/`postSave`, because they
never load instances. `qs.delete()` does send `preDelete`/`postDelete` for each object, since the
ORM loads the objects anyway to emulate `ON DELETE`.

## Connecting a receiver

`connect(receiver, { sender?, uid? })` registers a function. Pass `sender` to listen to one model
only:

```ts title="src/blog/signals.ts"
import { postSave } from '@ghuri/orm'
import { Post } from './models'

export async function notifyOnPublish({ instance, created }: { instance: Post; created: boolean }) {
  if (!created && instance.published) {
    await sendNewsletterFor(instance)
  }
}

postSave.connect(notifyOnPublish, { sender: Post, uid: 'blog.notify-on-publish' })
```

`uid` makes connecting idempotent. A second `connect` with the same `uid` is ignored, which
matters because modules can be evaluated more than once in tests and during development.
Connecting the same function twice for the same sender is also ignored.

The `receiver()` helper does the same thing in a decorator-like style:

```ts
import { receiver } from '@ghuri/core'
import { preSave } from '@ghuri/orm'

export const slugify = receiver(preSave, { sender: Post })(async ({ instance }) => {
  if (!instance.slug) instance.slug = toSlug(instance.title)
})
```

To stop listening: `postSave.disconnect(notifyOnPublish)` or `postSave.disconnect('blog.notify-on-publish')`.
Both return `true` if something was removed. `signal.hasListeners(sender?)` tells you whether
anything would run.

## Where to connect

Connect receivers when the app loads, so they are in place before the first request. The usual
place is `AppConfig.ready()`, importing a `signals.ts` module:

```ts title="src/blog/app.ts"
import { AppConfig } from '@ghuri/core'
import * as models from './models'

export class BlogConfig extends AppConfig {
  name = 'blog'
  models = models

  async ready() {
    await import('./signals')   // module body calls connect()
  }
}
```

A static import assigned to the config's `modules` (`import * as signals from './signals'`,
then `modules = { signals }`) works too, and keeps the bundler aware of the module. `ready()`
makes it clear the receivers need the app registry to be populated.

:::tip[If you know Django]
This is the `ready()` + `signals.py` convention from Django's docs. `@receiver(post_save,
sender=Post)` becomes `receiver(postSave, { sender: Post })(fn)`, and `dispatch_uid` is `uid`.
The difference: Django calls receivers synchronously and ignores what they return. Ghuri awaits
each receiver in turn, so a `postSave` receiver can safely hit the database before `save()`
resolves. An exception in a receiver propagates to the caller and stops the remaining receivers
(there is no `send_robust`). The exception is `requestFinished`: a failing receiver there is
logged and does not affect the response.
:::

## Receivers and the request lifecycle on Workers

Because receivers are awaited, a slow receiver slows down the request that triggered it. On
Workers there is a better option for work the user does not need to wait for: hand the promise
to `waitUntil`, which keeps the isolate alive after the response is sent.

```ts title="src/blog/signals.ts"
import { getContext } from '@ghuri/core'
import { postSave } from '@ghuri/orm'
import { Post } from './models'

postSave.connect(({ instance }) => {
  const work = pingSearchIndex(instance as Post)
  const ctx = getContext().executionCtx
  if (ctx) ctx.waitUntil(work)     // Workers: finish after the response
  else return work                 // CLI, tests, Node without ctx: await normally
}, { sender: Post, uid: 'blog.search-index' })
```

Database work inside `waitUntil` still runs inside the request's context, so the ORM connection
is available. For anything long or retryable, send a message to a Cloudflare Queue instead and
consume it with an `onQueue()` handler; see [Background tasks](/docs/topics/background-tasks/).

## Defining your own signals

Create a `Signal` with a type for its arguments and a name for debugging:

```ts title="src/blog/signals.ts"
import { Signal } from '@ghuri/core'
import type { Post } from './models'

export const postPublished = new Signal<{ post: Post; by: unknown }>('postPublished')
```

Send it from wherever the event happens. `send(sender, args)` resolves once every receiver has
finished:

```ts title="src/blog/views.ts"
await postPublished.send(PostViewSet, { post, by: this.request.user })
```

Receivers get `{ post, by, sender }`, typed from the signal's type parameter.

## Testing

Because receivers are module-level state, disconnect anything you connect in a test:

```ts
const calls: unknown[] = []
const spy = ({ instance }: { instance: unknown }) => { calls.push(instance) }
postSave.connect(spy, { sender: Post })
try {
  await Post.objects.create({ title: 'T', slug: 't', author })
  expect(calls).toHaveLength(1)
} finally {
  postSave.disconnect(spy)
}
```
