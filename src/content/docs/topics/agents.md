---
title: AI agents and MCP
description: Build AI agents whose tools come from your models and viewsets, and expose them to any MCP client.
---

`@ghuri/agents` lets you define AI agents the same way you define viewsets: as classes with a
model, instructions, tools and permission classes. The tools can be generated from your models
and viewsets, so an agent reuses the serializers, querysets and permissions you already wrote for
your REST API. The same tools can be exposed over the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) so that external clients such as
desktop assistants and IDEs can call them.

:::note[Alpha]
`@ghuri/agents` is the newest package and its API is the most likely to change before 0.1:
option names on `ModelTools` and `ViewSetTools`, the conversation endpoints and the streaming
format in particular. The security model described below (tools run as the request user, through
your permission classes) is fixed.
:::

:::tip[If you know Django]
Django has no built-in equivalent. Think of an `Agent` as a viewset whose client is a language
model: `ModelTools` is to an agent what `ModelViewSet` is to a router, `AgentRouter` plays the
role of `DefaultRouter`, and `permissionClasses` are the same DRF-style classes you use in
`@ghuri/rest`.
:::

## Setup

Install the package and the provider you want to use. The package is built on the
[Vercel AI SDK](https://ai-sdk.dev), so any AI SDK provider works.

```sh
npm install @ghuri/agents@next ai zod
npm install workers-ai-provider      # Cloudflare Workers AI
# or: npm install @ai-sdk/anthropic / @ai-sdk/openai
```

Add `AgentsConfig` to `INSTALLED_APPS`. It brings the `Conversation` and `Message` models that
store chat history through the ORM, so memory works on D1 and Postgres alike. Run
`npx ghuri migrate` afterwards.

```ts title="src/settings.ts"
import { AgentsConfig } from '@ghuri/agents'

export default defineSettings((env) => ({
  // ...
  INSTALLED_APPS: [AuthConfig, AdminConfig, AgentsConfig, BlogConfig],
  AGENTS: {
    DEFAULT_MODEL: 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    AI_BINDING: 'AI',                       // Workers AI binding name (default 'AI')
    PROVIDERS: {
      anthropic: { apiKey: env.ANTHROPIC_API_KEY },
      openai: { apiKey: env.OPENAI_API_KEY },
    },
    MAX_STEPS: 8,                           // tool-call round trips per turn
  },
}))
```

For Workers AI, add the binding to `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
"ai": { "binding": "AI" }
```

## Defining an agent

```ts title="src/blog/agents.ts"
import { Agent, ModelTools, ViewSetTools, tool } from '@ghuri/agents'
import { IsAuthenticated } from '@ghuri/rest'
import { z } from 'zod'
import { Post, Comment } from './models'
import { PostSerializer, CommentSerializer } from './serializers'
import { CommentViewSet } from './views'

export class EditorAgent extends Agent {
  model = 'anthropic:claude-sonnet-4-5'
  instructions = `You help authors manage their blog. Only act on the signed-in user's posts.
Ask for confirmation before publishing.`

  permissionClasses = [IsAuthenticated]

  tools = [
    new ModelTools(Post, {
      actions: ['list', 'retrieve', 'create', 'update'],
      serializer: PostSerializer,
      filter: (qs, user) => qs.filter({ author: user.pk }),
    }),
    new ViewSetTools(CommentViewSet, { actions: ['list'] }),
  ]

  @tool({
    description: 'Publish one of the user\'s posts by slug.',
    input: z.object({ slug: z.string() }),
  })
  async publish({ slug }: { slug: string }) {
    const post = await Post.objects.get({ slug, author: this.user.pk })
    post.published = true
    await post.save({ updateFields: ['published'] })
    return { published: post.slug }
  }
}
```

| Attribute | Meaning |
|---|---|
| `model` | `'provider:model-id'` (`workers-ai:`, `anthropic:`, `openai:`) or an AI SDK `LanguageModel` instance. Defaults to `AGENTS.DEFAULT_MODEL` |
| `instructions` | The system prompt. Override `getInstructions()` to build it per request |
| `tools` | `ModelTools`, `ViewSetTools` instances and `@tool` methods |
| `permissionClasses` | Who may talk to the agent at all |
| `maxSteps` | Overrides `AGENTS.MAX_STEPS` |

Inside the agent, `this.user` is the request user and `this.conversation` the current
`Conversation` instance.

## Tools from models: `ModelTools`

`ModelTools(Model, options)` generates one tool per action, named after the model
(`post_list`, `post_retrieve`, `post_create`, `post_update`, `post_delete`). Input schemas come
from the serializer's `jsonSchema()`, so field `helpText` and `choices` become the descriptions the
model reads.

| Option | Meaning |
|---|---|
| `actions` | Subset of `'list' \| 'retrieve' \| 'create' \| 'update' \| 'delete'`. Default: `['list', 'retrieve']` |
| `serializer` | Serializer for input validation and output. Default: a `ModelSerializer` with all editable fields |
| `filter` | `(qs, user) => QuerySet`; scopes every action, including retrieve, update and delete |
| `permissionClasses` | Checked per call, with object permissions on detail actions |
| `searchFields`, `filtersetFields` | Expose search and field filters as arguments of the list tool |
| `pageSize` | Max rows returned by the list tool (default 20). Keep it small; every row costs tokens |

Default to read-only tools and add write actions deliberately. Anything the tool can do, a
prompt injection in a post body can ask the model to do.

## Tools from viewsets: `ViewSetTools`

`ViewSetTools(ViewSet, { actions })` wraps viewset actions, including custom `@action` methods.
The call goes through the viewset exactly as an HTTP request would: authentication is already
done, then permissions, throttles, `getQueryset()`, serializer validation and your `perform*`
hooks. If your API already enforces a rule, the agent cannot bypass it.

```ts
new ViewSetTools(PostViewSet, { actions: ['list', 'retrieve', 'publish'] })
// → tools post_list, post_retrieve, post_publish
```

## Custom tools: `@tool`

Decorate a method with `@tool({ description, input })`. `input` is a Zod schema; the parsed
input is the method's argument and whatever you return is serialized to JSON for the model.
Throw `PermissionDenied` or `ValidationError` to report a refusal; the model sees the message.

## Exposing agents over HTTP

Register agents on an `AgentRouter` and include its URLs:

```ts title="src/urls.ts"
import { path, include } from '@ghuri/core'
import { AgentRouter } from '@ghuri/agents'
import { EditorAgent } from './blog/agents'

const agents = new AgentRouter()
agents.register('editor', EditorAgent)

export const urlpatterns = [
  // ...
  path('agents/', include(agents.urls)),
  path('mcp/', agents.mcp()),
]
```

Endpoints for each registered agent:

| Method and path | Purpose |
|---|---|
| `POST /agents/editor/chat` | Send a message; the reply streams as server-sent events |
| `GET /agents/editor/conversations/` | The user's conversations |
| `GET /agents/editor/conversations/<id>/` | One conversation with its messages |

Requests are authenticated with your `REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES`, so the same
session cookie, token or JWT that works for your API works here.

```sh
curl -N -X POST http://localhost:8787/agents/editor/chat \
  -H 'Authorization: Bearer eyJhbGciOi…' \
  -H 'Content-Type: application/json' \
  -d '{"message": "Which of my posts are still drafts?"}'
```

The response is a `text/event-stream` in the AI SDK's UI message stream format: text deltas,
tool calls and tool results as they happen, then a final event carrying the `conversationId`.
Send that id back with the next message to continue the conversation:

```json
{ "message": "Publish the one about Hyperdrive.", "conversationId": "c2f1…" }
```

On the client, the AI SDK's `useChat` hook (React, Vue, Svelte) consumes this stream directly.

## MCP

`agents.mcp()` returns a view that speaks MCP over the Streamable HTTP transport (JSON-RPC 2.0
with `initialize`, `tools/list` and `tools/call`). It exposes the tools of every registered agent,
prefixed with the agent name (`editor_post_list`, `editor_publish`), and checks both the agent's
`permissionClasses` and each tool's own permissions on every call.

MCP requests are authenticated with your REST authentication classes. Token or JWT
authentication is the practical choice, since MCP clients do not carry browser cookies:

```sh
# create a token for the account the MCP client acts as
npx ghuri shell
> const { Token, User } = await import('@ghuri/auth')
> const [token] = await Token.objects.getOrCreate({ user: await User.objects.get({ username: 'rifat' }) })
> token.key
```

Then point any MCP client that supports remote HTTP servers at the endpoint. Most clients accept
a configuration of this shape:

```json
{
  "mcpServers": {
    "my-blog": {
      "type": "http",
      "url": "https://blog.example.com/mcp/",
      "headers": { "Authorization": "Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" }
    }
  }
}
```

Every tool call then runs as that user, with that user's permissions. Create a dedicated user
with only the permissions the client needs rather than handing out a superuser token.

## Running agents from code

`agent.run()` runs a turn without HTTP, which is how you use agents from queues, cron handlers
and management commands:

```ts
import { EditorAgent } from './blog/agents'

const agent = new EditorAgent()
const result = await agent.run('Summarize yesterday\'s comments on my posts.', {
  user,                       // the RequestUser the tools run as
  conversationId: undefined,  // pass an id to continue a conversation
})

result.text              // final answer
result.toolCalls         // what the model called, with inputs and outputs
result.conversationId    // the stored conversation
```

## Safety checklist

- Give each agent the smallest set of tools that does the job, and prefer read-only actions.
- Scope `ModelTools` with `filter` so that a confused model cannot reach other users' rows.
- Treat everything a tool returns as untrusted input to the model. Content written by users
  (post bodies, comments) can contain instructions; do not give an agent that reads it a tool
  that deletes or publishes without a confirmation step.
- Throttle the chat endpoint ([throttling](/docs/topics/rest/throttling/)); model calls cost
  money.
- Review stored conversations in the admin: `Conversation` and `Message` are registered there
  automatically.
