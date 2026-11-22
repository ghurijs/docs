---
title: AI agents
description: Define AI agents whose tools are your models, viewsets and permission classes, serve them over HTTP and expose them to MCP clients with @ghuri/agents.
---

`@ghuri/agents` lets you define AI agents the same way you define viewsets: as classes with a
model, instructions, tools and permission classes. The tools can be generated from your models,
viewsets and routers, so an agent reuses the serializers, querysets and permissions you already
wrote for your REST API. The same tools can be exposed over the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) so that external clients such as
Claude Desktop and Claude Code can call them; see [MCP server](/docs/topics/agents-mcp/).

:::note[Alpha]
`@ghuri/agents` is at `0.1.0-alpha.0`, like the rest of Ghuri, and its API is the most likely to
change: option names on `ModelTools`, `ViewSetTools` and `RouterTools`, the conversation
endpoints and the streaming format in particular. The security model described below (tools run
as the request user, through your permission classes) is fixed.
:::

:::tip[If you know Django]
Django has no built-in equivalent. Think of an `Agent` as a viewset whose client is a language
model: `ModelTools` is to an agent what `ModelViewSet` is to a router, `AgentRouter` plays the
role of `DefaultRouter`, and `permissionClasses` are the same DRF-style classes you use in
`@ghuri/rest`.
:::

## Setup

Install the package and the provider you want to use. The package is built on the
[Vercel AI SDK](https://ai-sdk.dev) (v7). Provider packages are imported lazily, the first time a
model of that provider is used, so you only install the ones you need.

```sh
npm install @ghuri/agents@next ai zod
npm install workers-ai-provider      # 'workers-ai:...' models (Cloudflare Workers AI)
npm install @ai-sdk/anthropic        # 'anthropic:...'
npm install @ai-sdk/openai           # 'openai:...'
```

Add `AgentsConfig` (app label `agents`) to `INSTALLED_APPS`, after your user model's app. It
brings the `Conversation` and `Message` models that store chat history through the ORM, so
memory works on D1 and Postgres alike. The app ships its initial migration (adapted to a custom
`AUTH_USER_MODEL`), so create its tables with `npx ghuri migrate`; there is no need to run
`makemigrations agents`.

```ts title="src/settings.ts"
import { AgentsConfig } from '@ghuri/agents'
import { AuthConfig, AuthTokenConfig, ContentTypesConfig, SessionsConfig } from '@ghuri/auth'
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'

export default defineSettings((env) => ({
  // ...
  INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, AuthTokenConfig, BlogConfig, AgentsConfig],
  AGENTS: {
    DEFAULT_MODEL: 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    PROVIDERS: {
      anthropic: { apiKey: env.ANTHROPIC_API_KEY },
      openai: { apiKey: env.OPENAI_API_KEY },
    },
    AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication],
  },
}))
```

For Workers AI, add the binding to `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
"ai": { "binding": "AI" }
```

### `AGENTS` settings

| Key | Default | |
|---|---|---|
| `DEFAULT_MODEL` | none | `'provider:model-id'` or an AI SDK `LanguageModel`, for agents without a `model` |
| `AI_BINDING` | `'AI'` | Workers AI binding name |
| `PROVIDERS` | `{}` | Per-provider options: `{ anthropic: { apiKey }, openai: { apiKey, baseURL }, 'workers-ai': { gateway } }`. Extra keys are passed to the provider factory |
| `MAX_STEPS` | `10` | Tool-call round trips per run |
| `AUTHENTICATION_CLASSES` | `REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES` | Authentication for the chat and MCP endpoints |
| `PERMISSION_CLASSES` | `[IsAuthenticated]` | Access to agents and the MCP endpoint when an agent sets no `permissionClasses` |
| `ENQUEUE` | `'tasks'` with `@ghuri/tasks`, else `'queue'` | How `enqueue()` runs agents in the background (see [Background runs](#background-runs)) |
| `TASK` | `{}` | `'tasks'` mode: the `agents.run` task's `backend`, `queueName` and `priority` |
| `QUEUE_BINDING` | `'AGENTS_QUEUE'` | `'queue'` mode: Queue producer binding used by `enqueue()`. Setting it selects `'queue'` mode |
| `TRACE_RUNS` | `false` | Save one `Run` row per agent run (see [Run traces](#run-traces)). `{ messages: true }` also stores prompts and answers |
| `STRICT_TOOL_INPUT` | `false` | Check tool arguments before tools run, for agents that don't set `strictToolInput` (see [Shaping tools](#shaping-tools-for-smaller-models)) |
| `CONVERSATION_MODEL` | `'agents.Conversation'` | The conversation model, `'app_label.ModelName'` (see [Your own conversation model](#your-own-conversation-model)) |
| `USAGE_LIMITS` | none (off) | Token budgets per UTC day / month: `{ user, tenant, anon }`, each `{ day?, month? }` or a function of the subject, or one function for every scope (see [Usage limits](#usage-limits)) |

Without `PROVIDERS` keys, `anthropic:` and `openai:` models fall back to the `ANTHROPIC_API_KEY`
and `OPENAI_API_KEY` environment variables. Add other providers with
`registerProvider(name, factory)`.

### Provider headers and gateways

`PROVIDERS[name].headers` adds HTTP headers to every call to that provider. It can be an object, or a
function called once per run with the provider context, whose `run` names the agent, the user and the
carried request context (`{ tenant: '42' }` with [`@ghuri/tenants`](/docs/topics/multi-tenancy/)):

```ts
PROVIDERS: {
  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: 'https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic',
    headers: ({ run }) => ({ 'cf-aig-metadata': JSON.stringify({ agent: run?.agent, tenant: run?.carried.tenant }) }),
  },
},
```

Custom factories registered with `registerProvider()` receive the same `run` (absent when
`resolveModel()` is called outside an agent run).

The built-in **`ghuri-ai:`** provider talks to a ghuri-ai model gateway. Set its URL and key with
`PROVIDERS['ghuri-ai']: { baseURL, apiKey }` or the `GHURI_AI_URL` and `GHURI_AI_API_KEY` environment
variables:

| Model | Sent to |
|---|---|
| `ghuri-ai:<alias>` (`ghuri-ai:fast`, `ghuri-ai:smart`) | `<baseURL>/v1/chat/completions` (OpenAI-compatible; needs `@ai-sdk/openai`) |
| `ghuri-ai:anthropic/<model>` | `<baseURL>/v1/anthropic/messages` with the Anthropic SDK (`@ai-sdk/anthropic`), so `providerOptions` such as prompt caching keep working |
| `ghuri-ai:openai/<model>` | `<baseURL>/v1/openai/…` with the OpenAI SDK |

Every call carries `x-ghuri-agent`, `x-ghuri-user` (signed-in users only) and one `x-ghuri-<name>` header
per carried context value (`x-ghuri-tenant`), for metering and budgets. Headers you configure win over
these.

When the provider or gateway refuses a call, the chat endpoint answers **429** (with `Retry-After`) for
rate limits and spending caps, and **503** for a bad API key or a billing problem (401, 402, 403 from the
provider). `modelCallError(err)` applies the same mapping in your own views. Streamed responses have
already started with 200, so these errors arrive as an `error` chunk in the stream instead.

## Defining an agent

```ts title="src/blog/agents.ts"
import { Agent, ModelTools, ToolError, ViewSetTools, tool } from '@ghuri/agents'
import { IsAuthenticated } from '@ghuri/rest'
import { z } from 'zod'
import { Post } from './models'
import { PostSerializer } from './serializers'
import { CommentViewSet } from './views'

export class EditorAgent extends Agent {
  static agentName = 'editor'
  static description = 'Manages the signed-in author\'s blog posts.'

  model = 'anthropic:claude-sonnet-4-5'
  instructions = `You help authors manage their blog. Only act on the signed-in user's posts.
Ask for confirmation before publishing.`

  permissionClasses = [IsAuthenticated]

  tools = [
    new ModelTools(Post, {
      actions: ['list', 'retrieve', 'create', 'update'],
      serializer: PostSerializer,
      filter: (qs, user) => qs.filter({ author: user.pk }),
      saveKwargs: (user) => ({ author: user.pk }),
    }),
    new ViewSetTools(CommentViewSet, { actions: ['list'] }),
  ]

  @tool({
    description: 'Publish one of the user\'s posts by slug.',
    input: z.object({ slug: z.string() }),
  })
  async publish({ slug }: { slug: string }, { user }) {
    const post = await Post.objects.filter({ slug, author: user.pk }).first()
    if (!post) throw new ToolError(`No post with slug ${slug}.`)
    post.published = true
    await post.save({ updateFields: ['published'] })
    return { published: post.slug }
  }
}
```

| Attribute | Meaning |
|---|---|
| `static agentName` | Name stored on conversations and used for MCP (`ask_<name>`). Default: the class name minus `Agent`, kebab-cased. Set it explicitly, because minifiers rename classes. `AgentRouter.register(name, ...)` overrides it |
| `static description` | Shown to MCP clients for the `ask_<name>` tool |
| `model` | `'provider:model-id'` (`workers-ai:`, `anthropic:`, `openai:`) or an AI SDK `LanguageModel` instance. Default: `AGENTS.DEFAULT_MODEL` |
| `instructions` | The system prompt: a string, or a function of the run context, `(ctx) => string` |
| `tools` | `ModelTools`, `ViewSetTools` and `RouterTools` instances and `tool()` objects, plus `@tool` methods and `static tools` |
| `permissionClasses` | Who may talk to the agent at all. Default: `AGENTS.PERMISSION_CLASSES` |
| `maxSteps` | Overrides `AGENTS.MAX_STEPS` |
| `temperature`, `maxOutputTokens`, `providerOptions` | Passed to the AI SDK |
| `memory` | `false` for stateless runs (default `true` when `AgentsConfig` is installed) |

There is no `this.user` on an agent: tools receive the user in their context argument, and
instructions functions and hooks receive the run context (`ctx.user`, `ctx.conversation`).

## Tools from your API

All generated tools run through the full REST pipeline without HTTP: authentication is forced to
the run's user, then **permission classes, throttles, `getQueryset()`, filters, pagination,
serializer validation and representation** apply exactly as for an HTTP request. A `4xx` answer
becomes a tool error the model can read, such as
`"You do not have permission to perform this action. (HTTP 403)"`.

### `ModelTools`

`new ModelTools(Model, options)` generates one tool per action, named after the model's plural
verbose name: `posts_list`, `posts_retrieve`, `posts_create`, `posts_update` (a partial update)
and `posts_delete`. Input schemas come from the serializer's JSON Schema, so read-only fields are
not offered, field `helpText` becomes the description the model reads and choices become `enum`s.
Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).

| Option | Meaning |
|---|---|
| `actions` | Subset of `'list' \| 'retrieve' \| 'create' \| 'update' \| 'delete'`. Default: `['list', 'retrieve']` |
| `serializer` | Serializer for input validation and output. Default: a `ModelSerializer` with all fields |
| `filter` | `(qs, user) => QuerySet`; scopes every action, including retrieve, update and delete |
| `saveKwargs` | `(user, action) => values` forced on create and update; `action` is `'create'` or `'update'`. May be async |
| `permissionClasses` | Default: `REST_FRAMEWORK.DEFAULT_PERMISSION_CLASSES` |
| `searchFields` | Adds a `search` argument to the list tool |
| `orderingFields`, `ordering` | Adds an `ordering` argument, and the default order |
| `filterFields` | Exact-match filter arguments on the list tool |
| `pageSize`, `maxPageSize` | Rows per page (default 20) and the most the model may request (default `Math.max(100, pageSize)`). Keep them small: every row costs tokens |
| `prefix`, `descriptions` | Tool name prefix, and per-action descriptions |

Default to read-only tools and add write actions deliberately. Anything the tool can do, a
prompt injection in a post body can ask the model to do.

### `ViewSetTools`

`new ViewSetTools(ViewSet, { actions })` wraps viewset actions, including custom `@action`
methods (detail actions take an `id`). The call goes through the viewset exactly as an HTTP
request would. If your API already enforces a rule, the agent cannot bypass it.

```ts
new ViewSetTools(PostViewSet, { actions: ['list', 'retrieve', 'publish'] })
// → posts_list, posts_retrieve, posts_publish
new ViewSetTools(router.registry[0])   // every routed action of one registration
```

`'delete'` is accepted as an alias of `destroy`. Options: `actions`, `prefix`, `basename`,
`descriptions`.

### `RouterTools`

`RouterTools` exposes a whole REST router at once:

```ts
new RouterTools(router)                                                   // the whole API
new RouterTools(router, { include: ['posts', 'comments'], readOnly: true })
new RouterTools(router, { exclude: ['users', 'posts_destroy'], actions: { posts: ['list', 'create'] } })
```

### Custom tools: `tool()`

Decorate a method with `@tool({ description, input })`. `input` is a Zod schema (or a plain JSON
Schema object); the parsed input is the method's first argument, and the second is the tool
context, whose `user` is the requesting user. Whatever you return is serialized to JSON for the
model. Without decorators, declare `static tools = { cancelJob: tool({...}) }` and implement a
method of the same name, or put a standalone `tool({ name, description, execute })` in `tools`.

Throw `ToolError` for failures the model should see. Permission, not-found and validation errors
raised by Ghuri are shown to the model too. Other exceptions are reported as "The tool failed
with an internal error." (the real message only with `DEBUG`) and logged.

## Shaping tools for smaller models

A small model such as Claude Haiku can do most of what a large one does with your tools, if the tools are
easy to choose from and easy to call. Every option below is off by default; measure each change with an
[eval](#evaluating-agents).

**Load tools on demand.** With many tools, every request carries every schema, and a small model has more to
choose from. `toolSearch` sends only the tools you name in `alwaysLoaded`, plus `find_tools`. The model calls
`find_tools` with what it needs to do (or exact names) and the matching tools are loaded from its next step on,
and for the rest of the conversation:

```ts
class StoreAgent extends Agent {
  tools = [productTools, orderTools, themeTools]            // 50 tools
  toolSearch = { alwaysLoaded: ['products_list', 'orders_list'], maxResults: 5 }
}
```

`find_tools`' description lists the names of every tool it can load, and a line is added to the instructions
telling the model to use it. Loading a tool changes the tool list for later requests, which restarts prompt
caching after that point, so put the tools nearly every conversation needs in `alwaysLoaded`.

**Check arguments before tools run.** `strictToolInput = true` (or `AGENTS.STRICT_TOOL_INPUT`) checks the
arguments against the tool's schema first. Unknown arguments, missing required ones, values outside an `enum`
and wrong types come back as one message the model can act on: `Invalid arguments for orders_list: unknown
argument 'colour' (allowed: status, page, pageSize); 'page' must be integer (got two).` Without it, unknown
arguments are ignored and bad values fail later, less clearly. Numeric strings count as numbers, and nested
objects are left to the tool's own validation.

**Return less.** `resultFields` keeps only the fields the model needs (per action, `'*'` for the rest), and
`compact` leaves out `null`, empty strings and empty lists. Shorter results cost fewer tokens on every later
step of the run:

```ts
new ModelTools(Product, {
  actions: ['list', 'retrieve', 'update'],
  resultFields: { list: ['id', 'title', 'status', 'price'] },
  compact: true,
})
new RouterTools(router, { resultFields: { orders: { list: ['id', 'number', 'status'] } }, compact: true })
```

**Show an example.** `examples` (on `tool()`, `@tool`, or per action on `ModelTools` / `ViewSetTools`) adds
`Example input: {...}` lines to the description, for agents and MCP clients alike:

```ts
@tool({
  description: 'Set the price of a product variant.',
  input: z.object({ variantId: z.string(), price: z.string().describe('Decimal string, e.g. "1250.00".') }),
  examples: [{ variantId: '018f…', price: '1250.00' }],
})
```

**Measure the tools.** `toolReport(agent)` from `@ghuri/agents/evals` lists each tool's description and schema
size, a rough token count, and the arguments that have no description; `formatToolReport()` prints it, largest
first, with the total every request pays.

## Exposing agents over HTTP

Register agents on an `AgentRouter` and include its URLs:

```ts title="src/urls.ts"
import { include, path } from '@ghuri/core'
import { AgentRouter } from '@ghuri/agents'
import { EditorAgent } from './blog/agents'

export const agents = new AgentRouter()
agents.register('editor', EditorAgent)

export const urlpatterns = [
  // ...
  path('agents/', include(agents.urls)),
  path('mcp/', agents.mcp({ name: 'blog' })),   // see the MCP server page
]
```

Endpoints for each registered agent:

| Method and path | Purpose |
|---|---|
| `POST /agents/editor/chat` | Send `{ message, conversationId? }` (or an AI SDK `useChat` body with `messages`). Answers JSON, or server-sent events with `Accept: text/event-stream` or `?stream=1` |
| `GET /agents/editor/conversations/` | The user's conversations, `{ count, results }` (`?limit=&offset=`) |
| `GET /agents/editor/conversations/<id>/` | One conversation with its messages (owner only) |
| `DELETE /agents/editor/conversations/<id>/` | Delete it (owner only) |

Requests are authenticated with `AGENTS.AUTHENTICATION_CLASSES` (default: your
`REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES`), so the same session cookie, token or JWT that
works for your API works here. Access is checked with the agent's `permissionClasses`. With
session authentication, unsafe requests need the CSRF token (`X-CSRFToken`) like any API view.

```sh
curl -X POST http://localhost:8787/agents/editor/chat \
  -H 'Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b' \
  -H 'Content-Type: application/json' \
  -d '{"message": "Which of my posts are still drafts?"}'
# {"conversationId":"7c0e…","text":"You have two drafts: …","toolCalls":[…],"usage":{…},"finishReason":"stop"}
```

Send the `conversationId` back with the next message to continue the conversation:

```json
{ "message": "Publish the one about Hyperdrive.", "conversationId": "7c0e…" }
```

The SSE response uses the AI SDK's UI message stream format: text deltas, tool calls and tool
results as they happen. Its `start` chunk carries `messageMetadata: { conversationId }` (also sent
in the `x-conversation-id` header), and the stream closes only after the conversation was saved.
On the client, the AI SDK's `useChat` hook (React, Vue, Svelte) consumes it with a
`DefaultChatTransport` pointed at `/agents/editor/chat?stream=1`.

## Running agents from code

`agent.run()` runs a turn without HTTP, which is how you use agents from cron handlers,
management commands and tests:

```ts
import { EditorAgent } from './blog/agents'

const result = await new EditorAgent().run('Summarize yesterday\'s comments on my posts.', {
  user,                       // the user the tools run as
  conversationId: undefined,  // pass an id to continue a conversation
})

result.text              // final answer
result.toolCalls         // [{ toolName, input, output } | { toolName, input, error }]
result.messages          // AI SDK messages added by this run
result.usage             // tokens
result.conversationId    // the stored conversation

await EditorAgent.run('…', { user, conversationId })   // static shortcut
const s = await new EditorAgent().stream('…', { user })  // s.toUIMessageStreamResponse(), s.textStream, await s.done
```

Run options: `user`, `conversationId`, `signal`, `memory`, `checkPermissions` (check the agent's
`permissionClasses`; the HTTP and MCP layers always do) and `context` (free-form values for
hooks). Hooks: `beforeRun(ctx)`, `onToolCall(call, ctx)` (throw a `ToolError` to refuse a call)
and `afterRun(result, ctx)`.

### Background runs

With [`@ghuri/tasks`](/docs/topics/tasks/) installed, `enqueue()` enqueues the `agents.run` task on
your `TASKS` backend: Cloudflare Queues on Workers, the database with `npx ghuri db_worker` on Node,
or in-process in development.

```ts
const { conversationId, taskResult } = await agents.create('editor').enqueue('Summarize my week', { user })

// later, e.g. in a status endpoint
await taskResult.refresh()
if (taskResult.status === 'SUCCESSFUL') console.log(taskResult.returnValue.text)
```

The task reloads the user, runs the agent and stores the result in the conversation, which is
created up front so that you can poll `GET …/conversations/<id>/`. A failing run is tried 3 times.
Messages are saved only when a run finishes, so a retry does not duplicate them, but tools that
ran before a model error run again. The worker finds the agent by the name it was registered with
on an `AgentRouter`; for an agent you enqueue without a router, call
`registerAgent('editor', EditorAgent)` in a module the worker loads. Route the task with
`AGENTS.TASK`:

```ts title="src/settings.ts"
AGENTS: { TASK: { queueName: 'agents' } },
TASKS: { default: cloudflareQueues({ queues: { default: 'TASKS_QUEUE', agents: 'AGENTS_TASKS_QUEUE' } }) },
```

Without `@ghuri/tasks`, or with `AGENTS.QUEUE_BINDING` set or `AGENTS.ENQUEUE: 'queue'`,
`enqueue()` sends a job to a Cloudflare Queue that a consumer you register runs:

```ts
// wrangler.jsonc: "queues": { "producers": [{ "binding": "AGENTS_QUEUE", "queue": "agents" }],
//                            "consumers": [{ "queue": "agents" }] }
agents.consumeQueue('agents')      // once, e.g. in an AppConfig.ready()
```

Either way, `enqueue()` takes the request context along (`captureContext()` from `@ghuri/core`):
with `@ghuri/tenants`, the queued run happens as the tenant that enqueued it, so its tools see that
tenant's rows. See also [Cron triggers and queues](/docs/topics/background-tasks/).

## Run traces

Every run (`run()`, `stream()` once the stream ends, queued runs) sends the `runFinished` signal, with
the agent, its run context, the model (`'provider:model-id'`), the result or the error, and the duration.
Receivers that throw are logged and never fail the run:

```ts
import { runFinished } from '@ghuri/agents'

runFinished.connect(async ({ model, result, context }) => {
  if (result) console.log(context.agentName, model, result.usage.inputTokens, result.usage.outputTokens)
})
```

With `AGENTS.TRACE_RUNS: true`, each run is also saved as a `Run` (table `agents_run`, migration
`agents.0002_run`): agent, model, conversation, user, status (`ok` / `error`), finish reason, steps, input,
output and cached input tokens, the provider's usage object, tool calls (names and inputs), the carried
context (`{ tenant }`), the error message and the duration. `TRACE_RUNS: { messages: true }` also stores the
run's messages, which contain prompts and answers: decide how long to keep them. A trace that can't be
saved (for example before `ghuri migrate`) logs one warning and never fails the run.

## Usage limits

Model calls cost money per token. `AGENTS.USAGE_LIMITS` gives each user, tenant and anonymous client a token
budget per UTC day and month, so one heavy user can't run up the bill for everyone. A run of a subject that has
used its budget is refused **before it starts**: no model call, no conversation, no trace.

```ts
// settings.ts
AGENTS: {
  USAGE_LIMITS: {
    user: { day: 200_000, month: 2_000_000 },     // input + output tokens
    anon: { day: 20_000 },                        // per client address
    tenant: async (subject) => {                  // a function: plans, exemptions
      const plan = await Plan.objects.get({ tenant: subject.key })
      return plan.unlimited ? null : { month: plan.agentTokens }
    },
  },
}
```

Run `ghuri migrate` after setting it: usage is counted in `agents.Usage` (table `agents_usage`, migration
`agents.0003_usage`), one row per subject and window, incremented by the database after every run.

**Subjects.** A run counts against the user (`user`, keyed by pk) or, for anonymous users, the client
(`anon`, keyed by the address [throttles](/docs/topics/rest/throttling/) use; `'*'` for runs without a request,
such as queued ones), plus the tenant (`tenant`) when one is active: agents read it from the context
`@ghuri/tenants` carries, so queued runs count against the tenant that enqueued them. Only the scopes you name are
counted; a function for the whole setting, `USAGE_LIMITS: (subject) => …`, covers every scope. The function
receives `{ scope, key, user }` and returns `{ day?, month? }`, or `null` for no limit (the subject is still
counted). It runs before every run, so keep it cheap or cache it.

**What counts.** The run's total tokens (`usage.totalTokens`, else input + output), all steps included. Cached input
reads are part of the input and also kept apart. Failed runs report no usage and count nothing.

**Where it is checked.**

| A run started by | Over the limit |
|---|---|
| `POST …/chat` (JSON or server-sent events) | `429` with `Retry-After` (seconds until the window resets), `{ detail: 'Token usage limit reached for this day. Expected available in 7200 seconds.' }`, code `usage_limit_exceeded` |
| MCP `ask_<agent>` | a tool result with `isError: true`, the reason and `retryAfter` |
| `agent.run()`, `agent.stream()` | `UsageLimitExceeded` (`subject`, `period`, `limit`, `used`, `resetsAt`, `wait`) |
| `agent.enqueue()` | `UsageLimitExceeded`; nothing is enqueued |
| the queued run, when it runs | with `@ghuri/tasks`, the attempt fails (the task ends `FAILED`); with a Cloudflare Queue, the message is acked and logged, not retried |

In your own views, `modelCallError(err)` (or `usageThrottled(err)`) turns `UsageLimitExceeded` into the same
`Throttled` response.

**Showing usage.** `getUsage({ user })` returns the current day and month of each subject, for a "you have used
X of Y tokens" UI; every `AgentRouter` also serves it at `GET /agents/usage/` for the requesting user:

```ts
import { getUsage } from '@ghuri/agents'

const usage = await getUsage({ user: request.user })
// [{ scope: 'user', key: '42', period: 'day', start: '2026-11-23', resetsAt, used: 1234,
//    limit: 200000, remaining: 198766, inputTokens, outputTokens, cachedInputTokens, runs }, …]
```

**Signals.** `usageLimitReached` is sent when a run (or `enqueue()`) is refused, with the error and the subjects:
send a notification or an upgrade offer. `usageRecorded` is sent after a run was counted, with the tokens; call
`getUsage()` there to warn at 80 %. Receivers that throw are logged and never fail the run.

**Admin.** `import '@ghuri/agents/admin'` in one of your admin modules registers read-only `Usage` and `Run`
admins. Deleting a `Usage` row resets that subject's count for the window.

:::caution[Soft limits]
The counters are read before a run and updated after it. Runs that start at the same time all pass the same
check, and the run that crosses the limit is finished rather than cut off, so a subject can go over its budget
by about (concurrent runs) × (tokens of one run). Keep `maxSteps` and `maxOutputTokens` low to bound it, and
combine limits with [throttling](/docs/topics/rest/throttling/) of the chat endpoint.
:::

## Conversation memory

With `AgentsConfig` installed, every run is stored as a `Conversation` (owner, agent name, title,
metadata, timestamps) with its `Message`s (role and AI SDK content parts: text, tool calls with
their inputs, tool results and errors). Passing `conversationId` loads the history first.
Conversations belong to their user: another user's id fails with `ConversationNotFound` (404 over
HTTP). `loadMessages()`, `saveMessages()` and `createConversation()` are exported for custom
flows.

### Your own conversation model

`Conversation` is swappable, like `auth.User`: point `AGENTS.CONVERSATION_MODEL` at your own model
built from `conversationFields` (or `extends: AbstractConversation`). The usual reason is
multi-tenancy, so that a user who belongs to two stores only sees the current store's
conversations:

```ts title="src/stores/models.ts"
import { conversationFields } from '@ghuri/agents'

export class Conversation extends StoreModel({ ...conversationFields }) {
  static Meta = { ordering: ['-updatedAt'] }
}
```

```ts title="src/settings.ts"
AGENTS: { CONVERSATION_MODEL: 'stores.Conversation' },
```

`getConversation()`, `createConversation()`, `saveMessages()`, the conversation list and detail
views, `Message.conversation` and `Run.conversation` all use the model the setting names
(`getConversationModel()` returns it). With a [tenant-scoped](/docs/topics/multi-tenancy/) model,
another store's conversation is a 404 and new conversations get the current store. Messages are
not scoped themselves: they are reached through their conversation. `agents.Conversation` then has
no table, and its manager throws.

Projects that don't set `CONVERSATION_MODEL` see no change.

:::caution[Swapping in a project that already has conversations]
Set `CONVERSATION_MODEL` before the first `migrate` when you can. On a database where
`agents_conversation` already exists (with rows, and `agents_message` / `agents_run` pointing at
it), let your model adopt that table instead of creating a new one:

1. Give the model `Meta.dbTable: 'agents_conversation'`, set `CONVERSATION_MODEL`, and run
   `ghuri makemigrations stores`.
2. Edit the generated migration: add `managed: false` to the `CreateModel` options and follow it
   with an `AlterModelOptions` (state only), then a `RunCode` that adds the store column to the
   existing table, or creates the table on a new database (tests, new environments):

```ts title="src/stores/migrations/0007_conversation.ts"
ops.CreateModel({
  name: 'Conversation',
  fields: { /* as generated */ },
  options: { dbTable: 'agents_conversation', ordering: ['-updatedAt'], managed: false },
}),
ops.AlterModelOptions({ name: 'Conversation', options: { ordering: ['-updatedAt'] } }),
ops.RunCode(async (apps, conn, { editor, using }) => {
  const Conversation = apps.getModel('stores', 'Conversation')
  if (!(await editor.tableNames()).includes('agents_conversation')) {
    await editor.createModel(Conversation) // a new database
    return
  }
  // existing conversations: every row needs a store
  const store = await apps.getModel('stores', 'Store').objects.using(using).orderBy('createdAt').first()
  await editor.addField(Conversation, Conversation._meta.getField('store'), { default: store?.pk })
  // optionally move rows to the right store here, e.g. from the user's store membership
}, ops.RunCode.noop),
```

3. Keep the migration free of dependencies on `agents`, and run `ghuri migrate` then
   `ghuri makemigrations --check`. Existing conversations keep their ids, messages and run traces.

Going back to `agents.Conversation` later needs the reverse by hand.
:::

## MCP

`agents.mcp()` serves an MCP endpoint (Streamable HTTP, JSON responses) that exposes each
registered agent as an `ask_<name>` tool, plus any toolkits you pass in `tools`. Authentication
uses your REST authentication classes (a token is the practical choice); there is no OAuth.
Endpoint options, supported protocol versions and client configuration for Claude Desktop and
Claude Code are on the [MCP server](/docs/topics/agents-mcp/) page.

## Evaluating agents

Tests check that the code works; evals check that the **model** does the job well enough. An eval suite is a
list of real tasks with checks, run against one or more models, so you can see whether a cheap model handles
your tools as well as an expensive one, and catch regressions when you change instructions or tools.

```ts title="src/blog/support.eval.ts"
import { answerMatches, calledTool, defineEval, formatEvalReport, judge, maxSteps, noToolErrors,
  notCalledTool, runEval } from '@ghuri/agents/evals'

export const supportEval = defineEval({
  name: 'support',
  agent: SupportAgent,
  models: ['anthropic:claude-haiku-5-5', 'anthropic:claude-opus-5-5'],
  judgeModel: 'anthropic:claude-opus-5-5',
  prices: {                                     // US dollars per million tokens, for the cost columns
    'anthropic:claude-haiku-5-5': { input: 0.1, output: 0.5 },
    'anthropic:claude-opus-5-5': { input: 4, output: 20, cachedInput: 0.2 },
  },
  async setup() {                               // runs before every attempt, after beforeEach
    const editor = await makeEditorWithPosts()
    return { user: editor }                     // run options: the user the tools act as
  },
  cases: [
    {
      name: 'finds a post',
      input: 'Which posts mention Workers?',
      checks: [
        calledTool('posts_list', { search: /workers/i }),
        notCalledTool('posts_destroy'),
        noToolErrors(),
        answerMatches('Agents on Workers'),
        maxSteps(4),
        judge('Lists the matching posts by title and does not invent posts.'),
      ],
    },
  ],
})

it('support agent eval', async () => {
  const report = await runEval(supportEval, { beforeEach: () => db.flush() })
  console.log(formatEvalReport(report))
  expect(report.byModel['anthropic:claude-haiku-5-5'].passRate).toBeGreaterThanOrEqual(0.9)
})
```

Set up the app and a test database in `beforeAll`, as in your tests, so tool calls never touch real data.
Run the suites with [`npx ghuri eval`](/docs/reference/cli/#eval). Example output (illustrative numbers):

```text
Eval: support
model                       pass  rate  in tok  out tok     cost  $/pass  avg s
anthropic:claude-haiku-5-5  18/20   90%   61234     4120  $0.0082  $0.0005    2.1
anthropic:claude-opus-5-5   20/20  100%   60877     3906  $0.3216  $0.0161    4.8
```

| Check | Passes when |
|---|---|
| `calledTool(name, input?, { times? })` | the tool was called without an error; `input` is matched partially (`RegExp` for strings, functions as predicates) |
| `notCalledTool(name)` | the tool was never called |
| `noToolErrors()` | no tool call failed (permission, validation, not found) |
| `answerMatches(text \| RegExp)` | the final answer contains the text (case-insensitive) or matches |
| `maxSteps(n)` | the run took at most `n` model steps |
| `check(name, fn)` | `fn(ctx)` doesn't return `false` or throw: query the database, inspect `ctx.result` |
| `judge(rubric, { model? })` | a judge model (the suite's `judgeModel`) says the run meets the rubric |

Each attempt runs without conversation memory, one at a time. A run that fails (provider error, missing
key) counts as a failed attempt and its error is reported. `runEval()` returns a report with a summary per
model (`passed`, `total`, `passRate`, tokens, `cost`, `costPerPass`, `avgDurationMs`) and every attempt with
its tool calls and failures. `--models`, `--repeat` and `--case` on `ghuri eval` override the suites
(`GHURI_EVAL_MODELS`, `GHURI_EVAL_REPEAT`, `GHURI_EVAL_CASE`), and `--report <dir>` saves the reports as
JSON.

Prefer checks in code; use `judge()` for what code can't check, with a strong model as the judge. Run each
case a few times (`repeat`) before trusting a pass rate: models don't answer the same way every time.

## Testing

Use the AI SDK mock model; no network is needed:

```ts
import { MockLanguageModelV4 } from 'ai/test'

const model = new MockLanguageModelV4({
  doGenerate: [
    { content: [{ type: 'tool-call', toolCallId: '1', toolName: 'posts_list', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [] },
    { content: [{ type: 'text', text: 'You have 2 posts.' }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] },
  ],
})
class TestAgent extends EditorAgent { model = model }
const result = await new TestAgent().run('posts?', { user })
expect(result.toolCalls[0].output.count).toBe(2)
```

## Safety checklist

- Give each agent the smallest set of tools that does the job, and prefer read-only actions
  (`ModelTools` is read-only by default; `RouterTools` has `readOnly: true`).
- Scope `ModelTools` with `filter` so that a confused model cannot reach other users' rows.
- Keep `AGENTS.PERMISSION_CLASSES` at its default `[IsAuthenticated]`. Set `[AllowAny]` only
  deliberately, for public agents.
- Treat everything a tool returns as untrusted input to the model. Content written by users (post
  bodies, comments) can contain instructions; gate destructive tools with `onToolCall`, keep
  `maxSteps` low and audit with `afterRun`.
- Throttle the chat endpoint ([throttling](/docs/topics/rest/throttling/)) and set token budgets
  ([usage limits](#usage-limits)); model calls cost money.

:::note
`Conversation` and `Message` are not registered in the admin automatically. Register them in one
of your own `admin.ts` modules if you want to review conversations there. `import '@ghuri/agents/admin'`
registers `Usage` and `Run`.
:::
