---
title: WebSockets
description: Real-time features with @ghuri/realtime, in the style of Django Channels — consumers routed in urls.ts, rooms hosted by Durable Objects on Cloudflare, and a channel layer you can reach from any view.
---

`@ghuri/realtime` adds WebSockets in the style of
[Django Channels](https://channels.readthedocs.io/): a **consumer** class handles one socket, it is
routed in `urls.ts` like any view, and the handshake runs through your `MIDDLEWARE` and your REST
authentication and permission classes. Connections live in **rooms**, and any code (a view, a
signal receiver, a cron handler) can send to a room through the **channel layer**.

On Cloudflare Workers each room is a [Durable Object](https://developers.cloudflare.com/durable-objects/)
that uses the WebSocket Hibernation API, so idle sockets cost nothing. On Node, rooms live in the
process.

:::note[Alpha]
`@ghuri/realtime` is at `0.1.0-alpha.0` and needs `@ghuri/core` and `@ghuri/auth` `0.1.0-alpha.1`
or later. GraphQL subscriptions, a multi-process layer for Node and server-sent events are planned.
:::

:::tip[If you know Django]
`JsonWebSocketConsumer` is `AsyncJsonWebsocketConsumer`, `channelLayer.groupSend()` is
`channel_layer.group_send()`, `memoryLayer()` is `InMemoryChannelLayer`, and
`WebSocketCommunicator` is `WebsocketCommunicator`. The biggest difference: a socket belongs to
exactly **one room**, chosen on the handshake, instead of joining groups with `group_add`. The
[mapping table](#for-django-channels-users) at the end lists the rest.
:::

## Setup

```sh
npm install @ghuri/realtime@next
```

Then pick a layer, the place rooms live, in `src/settings.ts`. On Cloudflare that is a Durable
Object; on Node and in tests it is memory:

```ts title="src/settings.ts"
import { defineSettings } from '@ghuri/core'
import { durableObjectLayer } from '@ghuri/realtime/cloudflare'

export default defineSettings((env) => ({
  // ...
  REALTIME: { LAYER: durableObjectLayer('REALTIME') },
}))
```

Cloudflare also needs the Durable Object class exported from the Worker entry and a binding in
`wrangler.jsonc`; see [Running on Cloudflare](#running-on-cloudflare). Node needs one line in
`src/server.ts`; see [Running on Node](#running-on-node).

## Your first consumer

A chat room that stores messages and sends each one to everybody in the room:

```ts title="src/chat/consumers.ts"
import { JsonWebSocketConsumer, type Scope } from '@ghuri/realtime'
import { IsAuthenticated } from '@ghuri/rest'
import { Message } from './models'

export class ChatConsumer extends JsonWebSocketConsumer {
  static room = (scope: Scope) => `chat.${scope.params.room}`
  static permissionClasses = [IsAuthenticated]

  async connect() {
    this.accept()
    await this.room.groupSend({ type: 'chat.joined', user: this.user.username }, { exclude: this })
  }

  async receiveJson(data: { text: string }) {
    const msg = await Message.objects.create({
      room: this.scope.params.room,
      author: this.user.pk,
      text: data.text,
    })
    await this.room.groupSend({ type: 'chat.message', id: msg.pk, text: msg.text, user: this.user.username })
  }

  // 'chat.message' events call chatMessage()
  async chatMessage(event: { id: number; text: string; user: string }) {
    this.sendJson(event)
  }

  async chatJoined(event: { user: string }) {
    this.sendJson({ type: 'joined', user: event.user })
  }
}
```

Route it like a view:

```ts title="src/chat/urls.ts"
import { path } from '@ghuri/core'
import { ChatConsumer } from './consumers'

export const urlpatterns = [path('ws/chat/<slug:room>/', ChatConsumer.asView(), { name: 'chat-socket' })]
```

And connect from the browser:

```js
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat/lobby/`)
ws.onmessage = (e) => console.log(JSON.parse(e.data))
ws.onopen = () => ws.send(JSON.stringify({ text: 'hello' }))
```

A plain HTTP request to `/ws/chat/lobby/` gets `426 Upgrade Required`.

## Consumers

`WebSocketConsumer` handles raw frames; `JsonWebSocketConsumer` parses text frames as JSON.
Override the handlers you need:

| Method | Called when |
|---|---|
| `connect()` | The handshake arrived. The default accepts. Call `close()`, or return without calling `accept()`, to reject the handshake with 403. |
| `receive({ text?, bytes? })` | A frame arrived. `JsonWebSocketConsumer` turns text into `receiveJson(data)`. |
| `disconnect(code, reason)` | The socket closed, from either side. Runs once. |

And call these:

| Method | Does |
|---|---|
| `accept(subprotocol?)` | Accept the handshake (only in `connect()`). |
| `send(data)` / `sendJson(data)` | Send a text or binary frame. |
| `close(code = 1000, reason?)` | Close the socket. |
| `tag(...tags)` / `untag(...tags)` | Label the connection inside its room (at most 10 tags), for `{ tag }` filters. |
| `refreshUser()` | Reload the user from the database. Returns `false` and closes with `4401` if the user was deleted or deactivated. |

Inside a handler you have:

- `this.scope`: what the handshake established: `path`, `params` (URL parameters, as strings),
  `query`, `routeName`, `room`, `connectionId`, `headers` (`origin`, `userAgent`, `subprotocols`),
  `user`, `sessionKey` and `auth` (the token payload, when small).
- `this.user`: the handshake's user. `isAuthenticated`, `isStaff` and friends come from the
  handshake; `hasPerm()` loads the full user through `@ghuri/auth`. `getUser()` returns the same user.
- `this.room`: the connection's room (next section).
- `this.state`: your per-connection data.

### Group events

`groupSend()` delivers an **event**, an object with a `type`. Each consumer in the room runs the
method named after the type: `chat.message`, `chat-message` and `chat_message` all call
`chatMessage(event)`. The handler decides what, if anything, to send to its client, so you can
filter per user:

```ts
async postPublished(event: { postId: number; authorId: number }) {
  if (event.authorId !== this.user.pk) this.sendJson(event)
}
```

An event without a matching method is dropped (with a warning when `DEBUG` is on).

### Consumers are rebuilt for every event

A Durable Object that hibernates keeps no memory, so Ghuri builds a fresh consumer instance for
every message and every group event, from the connection's saved `scope` and `state`. **Fields you
set on `this` are gone by the next event.** Keep what you need in `this.state`; it is saved after
every handler:

```ts
async receiveJson(data: { text: string }) {
  this.state.sent = ((this.state.sent as number) ?? 0) + 1
  if ((this.state.sent as number) > 100) return this.close(4429, 'Slow down')
  // ...
}
```

`scope`, `state` and tags together must fit in **2 KB**, the Cloudflare limit for data kept with a
hibernated socket, and the same limit applies on Node so code behaves the same in development.
Bigger state throws `RealtimeStateTooLarge`. Keep larger data in `this.room.storage` or the database.

### Errors

| Situation | Result |
|---|---|
| A handler throws | Logged; the socket closes with `1011` (like Channels). |
| A frame is larger than `MAX_MESSAGE_BYTES` | Closes with `1009`. |
| Invalid JSON in a `JsonWebSocketConsumer` | Closes with `1007`. |
| `connect()` neither accepts nor closes | Handshake rejected with 403. |
| The handshake would not fit in 2 KB (a huge query string) | Handshake rejected with 431. |

### Options per route

`asView(initkwargs)` assigns values to every instance, like `View.asView()`:

```ts
path('ws/feed/news/', FeedConsumer.asView({ kind: 'news' })),
path('ws/feed/sport/', FeedConsumer.asView({ kind: 'sport' })),
```

## Rooms

Every connection belongs to exactly one room, picked on the handshake by `static room`:

```ts
static room = 'lobby'                                         // one fixed room
static room = (s: Scope) => `chat.${s.params.room}`           // one room per URL parameter
static room = (s: Scope) => (s.user.isAuthenticated ? `user.${s.user.pk}` : null)   // one per user
```

Without `static room`, the room is the request path. Returning `null` rejects the handshake with 403.

A room offers:

| | |
|---|---|
| `groupSend(event, { tag?, exclude? })` | Run the event's handler on every connection (or only those with `tag`; `exclude` takes a consumer or a connection id). Resolves when all handlers ran. |
| `broadcast(message, { tag?, exclude? })` | Send the same frame to every socket without running consumer code. Objects are JSON-encoded. Much cheaper for large rooms. |
| `send(connectionId, event)` | Run the handler on one connection. |
| `connections({ tag? })` / `count({ tag? })` | Who is here: `{ id, userPk, tags, connectedAt }`. |
| `storage` | Small durable data for the room: `get`, `put`, `delete`, `list({ prefix, limit })`. Durable Object storage on Cloudflare, memory on Node. |

A socket cannot join a second room. If a page needs two streams, open two sockets, or send
everything a user needs to their per-user room.

## Sending from anywhere

`channelLayer` reaches rooms from code that is not a consumer: views, signal receivers, cron and
queue handlers, other consumers.

```ts title="src/blog/signals.ts"
import { postSave } from '@ghuri/orm'
import { channelLayer } from '@ghuri/realtime'
import { Post } from './models'

postSave.connect(
  async ({ instance, created }) => {
    const post = instance as Post
    if (created && post.published) {
      await channelLayer.broadcast('feed', { type: 'post.created', id: post.pk, title: post.title })
    }
  },
  { sender: Post, uid: 'feed-new-posts' },
)
```

| | |
|---|---|
| `channelLayer.room(name)` | The `Room` called `name`. |
| `channelLayer.groupSend(room, event, opts?)` | `room(name).groupSend(...)`. |
| `channelLayer.broadcast(room, message, opts?)` | `room(name).broadcast(...)`. |
| `channelLayer.send(connectionId, event)` | One connection. Ids look like `<room>:<uuid>` (`this.scope.connectionId`). |

`groupSend` waits until the room ran every handler. A view that should answer without waiting can
hand the promise to `waitUntil`:

```ts
import { getContext } from '@ghuri/core'
import { channelLayer } from '@ghuri/realtime'

getContext().executionCtx?.waitUntil(channelLayer.groupSend(`user.${pk}`, { type: 'notify', text }))
```

Delivery is at-most-once and nothing is replayed: a client that reconnects should load what it
missed over HTTP.

## Authentication and permissions

The handshake is an ordinary GET that runs through `MIDDLEWARE`, so users logged in with sessions
(`SessionMiddleware` + `AuthenticationMiddleware`) arrive as `this.user` with nothing else to set up.
After the middleware, in order:

1. **Origin check.** Browsers send an `Origin` header. It must match the request host, an entry of
   `CSRF_TRUSTED_ORIGINS` or `REALTIME.ALLOWED_ORIGINS`, otherwise the handshake gets 403. This
   stops another site from opening sockets with your users' cookies (Cross-Site WebSocket
   Hijacking). Clients without an `Origin` (servers, mobile apps) pass.
2. **`static authenticationClasses`**: the same classes as the REST framework, e.g.
   `TokenAuthentication` or `JWTAuthentication` from `@ghuri/auth/rest`. Invalid credentials get 401.
3. **`static permissionClasses`**: REST permission classes such as `IsAuthenticated`; they see
   `request.user`, `request.auth` and `request.scope` (URL kwargs in `scope.params`; `scope.room`
   is not resolved yet). Denied: 401 for anonymous users, 403 otherwise.
4. **`static room`**: `null` gets 403.

### Tokens from browsers

Browsers can't set an `Authorization` header on a WebSocket. Send the token as a subprotocol
instead; Ghuri copies it into `Authorization: <TOKEN_KEYWORD> <token>` before running the
authentication classes, and answers with the `ghuri` subprotocol, which the browser requires:

```js
const ws = new WebSocket(url, ['ghuri', `bearer.${accessToken}`])
```

```ts
import { JWTAuthentication } from '@ghuri/auth/rest'
import { JsonWebSocketConsumer, type Scope } from '@ghuri/realtime'
import { IsAuthenticated } from '@ghuri/rest'

export class NotificationsConsumer extends JsonWebSocketConsumer {
  static authenticationClasses = [JWTAuthentication]
  static permissionClasses = [IsAuthenticated]
  static room = (s: Scope) => `user.${s.user.pk}`
}
```

For `TokenAuthentication` (keyword `Token`), set `REALTIME.TOKEN_KEYWORD: 'Token'`. A `?token=` query
parameter works too when `TOKEN_SOURCES` includes `'query'`, but tokens in URLs end up in proxy and
access logs.

### Users change

Users are checked on the handshake. A deactivated user keeps an open socket until you check again:
call `await this.refreshUser()` before sensitive actions, or set `REVALIDATE_SECONDS` to recheck
automatically before an event once that many seconds have passed. Logging out does not close open
sockets either; to do that, send to the user's room from a `userLoggedOut` receiver and close there.

## Running on Cloudflare

Export the Durable Object class that hosts rooms next to the app:

```ts title="src/index.ts"
import { createApp } from '@ghuri/core'
import { createRoomClass } from '@ghuri/realtime/cloudflare'
import settings from './settings'

const app = createApp(settings)
export default app
export const GhuriRoom = createRoomClass(app)
```

Bind it and declare it in a migration:

```jsonc title="wrangler.jsonc"
"durable_objects": {
  "bindings": [{ "name": "REALTIME", "class_name": "GhuriRoom" }]
},
"migrations": [{ "tag": "realtime-v1", "new_sqlite_classes": ["GhuriRoom"] }]
```

`wrangler dev` runs Durable Objects locally, so the same configuration works in development.
`memoryLayer()` does not work on Workers: the runtime forbids writing to a socket from another
request, so it refuses with an error pointing to `durableObjectLayer`.

What happens on a connection:

1. The Worker runs `MIDDLEWARE`, the Origin check and the consumer's authentication and permission
   classes, exactly as for an HTTP view.
2. It forwards the handshake to the room's Durable Object (one object per room name), where
   `connect()` runs.
3. The object accepts the socket with the Hibernation API and keeps the connection's `scope`,
   `state` and tags with the socket. When the room is idle, the object hibernates; the next message
   wakes it and the consumer is rebuilt from that data.
4. Consumers run with the Worker's bindings, so D1, R2 and KV work inside them. `ping` frames are
   answered with `pong` without waking the object.

A room is a single-threaded object: a few thousand connections per room is a practical ceiling.
Sockets drop when you deploy a new version of the Worker; reconnect from the client with a backoff.

## Running on Node

Attach WebSockets to the server that `serve()` returns:

```ts title="src/server.ts"
import { createApp } from '@ghuri/core'
import { serve } from '@ghuri/core/node'
import { attachRealtime } from '@ghuri/realtime/node'
import settings from './settings'

const app = createApp(settings)
const server = await serve(app, { port: Number(process.env.PORT ?? 8000), env: process.env })
attachRealtime(server, app, { env: process.env })
```

The handshake still goes through `app.fetch`, so middleware, routing and consumers behave as on
Workers. With `REALTIME.LAYER` unset (or `memoryLayer()`), rooms live in this process, which is
correct for **one** process. Several processes or machines need a shared layer; a Postgres
`LISTEN/NOTIFY` layer is planned. Your reverse proxy must pass WebSocket upgrades through; see
[Deploying on Node](/docs/deployment/node-postgres/#6-reverse-proxy).

## Settings

```ts
REALTIME: {
  LAYER: durableObjectLayer('REALTIME'),
  ALLOWED_ORIGINS: ['https://app.example.com'],
  TOKEN_SOURCES: ['subprotocol'],
  TOKEN_KEYWORD: 'Bearer',
  MAX_MESSAGE_BYTES: 1_048_576,
  REVALIDATE_SECONDS: 0,
},
```

See the [settings reference](/docs/reference/settings/#realtime-ghurirealtime) for each key.

## Testing

`WebSocketCommunicator` from `@ghuri/realtime/testing` drives a consumer through your app without
a network. Use `memoryLayer()` in test settings:

```ts title="src/chat/tests/consumers.test.ts"
import { WebSocketCommunicator } from '@ghuri/realtime/testing'
import { expect, it } from 'vitest'
// app: createApp(settings); env: the test env; annUser / bobUser: users created in beforeEach

it('broadcasts messages to the room', async () => {
  const ann = new WebSocketCommunicator(app, '/ws/chat/lobby/', { user: annUser, env })
  const bob = new WebSocketCommunicator(app, '/ws/chat/lobby/', { user: bobUser, env })
  expect((await ann.connect()).connected).toBe(true)
  await bob.connect()

  await ann.sendJson({ text: 'hi' })
  expect(await bob.receiveJson()).toMatchObject({ type: 'chat.message', text: 'hi', user: 'ann' })

  await ann.disconnect()
  await bob.disconnect()
})

it('rejects anonymous users', async () => {
  expect(await new WebSocketCommunicator(app, '/ws/chat/lobby/', { env }).connect()).toMatchObject({
    connected: false,
    status: 401,
  })
})
```

| | |
|---|---|
| `connect()` | `{ connected, status, subprotocol?, body? }` (`body` is the response text of a rejected handshake). |
| `sendText()` / `sendJson()` / `sendBytes()` | Resolve after the consumer handled the frame. |
| `receiveFrom()` / `receiveJson()` | The next frame; throws `CommunicatorClosed` if the server closed. |
| `receiveNothing({ timeout })` | `true` when nothing arrives (default 100 ms). |
| `receiveClose()` | `{ code, reason }` of a server-side close. |
| `disconnect(code?)` | Close from the client; resolves after `disconnect()` ran. |

Options: `user` (logged in with `forceLogin`), `headers` (for example `origin`), `subprotocols`,
`env`. To test code that sends from outside a consumer, call it (or `channelLayer.groupSend()`) in
the test and assert with `receiveJson()`.

## For Django Channels users

| Django Channels | Ghuri (`@ghuri/realtime`) |
|---|---|
| `AsyncWebsocketConsumer` / `AsyncJsonWebsocketConsumer` | `WebSocketConsumer` / `JsonWebSocketConsumer` |
| `websocket_urlpatterns` + `URLRouter` in `asgi.py` | `path('ws/…/', Consumer.asView())` in `urls.ts` |
| `AuthMiddlewareStack` | your `MIDDLEWARE` (runs on the handshake) and `authenticationClasses` |
| `AllowedHostsOriginValidator` | built in: host, `CSRF_TRUSTED_ORIGINS`, `REALTIME.ALLOWED_ORIGINS` |
| `self.scope['user']` | `this.user` |
| `self.scope['url_route']['kwargs']` | `this.scope.params` |
| `await self.channel_layer.group_add(group, self.channel_name)` | `static room` (one per socket) or `this.tag(name)` inside the room |
| `await self.channel_layer.group_send(group, {'type': 'chat.message', …})` | `await this.room.groupSend({ type: 'chat.message', … })` or `channelLayer.groupSend(room, …)` |
| `async def chat_message(self, event)` | `async chatMessage(event)` |
| `self.channel_name` / `channel_layer.send(name, event)` | `this.scope.connectionId` / `channelLayer.send(id, event)` |
| `await self.send_json(content)` | `this.sendJson(content)` |
| `InMemoryChannelLayer` / `RedisChannelLayer` | `memoryLayer()` / `durableObjectLayer()` |
| `WebsocketCommunicator` | `WebSocketCommunicator` |
| `database_sync_to_async` | not needed: the ORM is async |
