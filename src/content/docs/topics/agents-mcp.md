---
title: MCP server
description: Expose your agents, models, viewsets and REST routers as Model Context Protocol tools, authenticate clients with API tokens or OAuth, and connect Claude Desktop and Claude Code.
---

`@ghuri/agents` includes a [Model Context Protocol](https://modelcontextprotocol.io) server, so
MCP clients such as Claude Desktop and Claude Code can call the same tools your
[agents](/docs/topics/agents/) use: tools generated from your models, viewsets and routers, your
own `tool()` functions, and the agents themselves. It is implemented in-house (no MCP SDK
dependency) and runs on Workers and Node.

Every tool call runs **as the authenticated user**, through your REST permission classes,
querysets and serializers. An MCP client can do nothing that user could not do with your API.

## Wiring

Mount `agents.mcp()` from an `AgentRouter`:

```ts title="src/urls.ts"
import { include, path } from '@ghuri/core'
import { AgentRouter, ModelTools, RouterTools } from '@ghuri/agents'
import { router } from './api'                   // your @ghuri/rest router
import { EditorAgent } from './blog/agents'
import { Order } from './shop/models'

export const agents = new AgentRouter()
agents.register('editor', EditorAgent)

export const urlpatterns = [
  path('agents/', include(agents.urls)),
  path('mcp/', agents.mcp({
    name: 'shop',
    version: '1.0.0',
    instructions: 'Tools for the Example shop.',
    tools: [
      new RouterTools(router, { readOnly: true }),
      new ModelTools(Order, { filter: (qs, user) => qs.filter({ customer: user.pk }) }),
    ],
    agents: true,   // registered agents as ask_<name> tools (or a list of names, or false)
  })),
]
```

Without an `AgentRouter`, build the server directly:

```ts
import { McpServer } from '@ghuri/agents'

const mcp = new McpServer({ name: 'shop', tools: [new RouterTools(router)], agents: { editor: () => new EditorAgent() } })
path('mcp/', mcp.urls)
```

### What is exposed

| Source | MCP tools |
|---|---|
| `tools: [...]` | Every tool of each toolkit (`ModelTools`, `ViewSetTools`, `RouterTools`), plus `tool({ name, description, execute })` objects. Names such as `posts_list`, `orders_retrieve` |
| `agents` | One `ask_<name>` tool per registered agent, taking `{ message, conversationId? }` and returning `{ text, conversationId }`. Its description is the agent's `static description` |

Tools carry JSON Schema `inputSchema`s generated from your serializers or Zod schemas, and MCP
annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`). Two tools with the same name
raise `ImproperlyConfigured`.

:::note
The tools listed in an agent's own `tools` are **not** exposed one by one; the agent is reachable
only through its `ask_<name>` tool, which runs the agent (and its permission checks) as the user.
To give MCP clients direct access to the same toolkits, pass them in `tools`.
:::

### Options

`agents.mcp(options)` and `new McpServer(options)` accept:

| Option | Default | |
|---|---|---|
| `name` | `'ghuri'` | Server name reported by `initialize` |
| `version` | `'0.1.0'` | Server version |
| `title` | unset | Display title |
| `instructions` | unset | Instructions for the client's model, returned by `initialize` |
| `tools` | none | Toolkits and tools to expose |
| `agents` | `true` (`mcp()`) | `true` for every registered agent, a list of names, or `false`. On `McpServer`, a map of factories `{ name: () => agent }` |
| `authenticationClasses` | `AGENTS.AUTHENTICATION_CLASSES`, then `REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES` | Who the caller is |
| `permissionClasses` | `AGENTS.PERMISSION_CLASSES`, i.e. `[IsAuthenticated]` | Access to the endpoint |
| `allowAnyOrigin` | `false` | Accept browser `Origin`s other than your host and `CSRF_TRUSTED_ORIGINS` |
| `oauth` | unset | OAuth mode: Bearer access tokens, Protected Resource Metadata and per-tool scopes. See [MCP server with OAuth](/docs/topics/mcp-oauth/) |
| `listTtlMs` | `300000` | How long 2026-07-28 clients may cache `tools/list` and `server/discover` |

Mount the endpoint with a trailing slash and give clients that exact URL. `APPEND_SLASH` only
redirects `GET` requests, and MCP uses `POST`.

## Transport and protocol

The endpoint speaks the **Streamable HTTP** transport in its simplest form: JSON-RPC 2.0 over
`POST`, answered with JSON. There is no server-initiated event stream, so `GET` (and `DELETE`)
answer `405`. Clients that only speak stdio, such as Claude Desktop's local servers, connect
through the `mcp-remote` bridge (below).

Supported MCP protocol versions, newest first:

| Version | |
|---|---|
| `2026-07-28` | Stateless: no `initialize` and no session |
| `2025-11-25` | Legacy, negotiated with `initialize` (the answer when a client asks `initialize` for an unknown or newer version) |
| `2025-06-18` | Legacy |
| `2025-03-26` | Legacy |
| `2024-11-05` | Legacy |

Both eras are served on the same endpoint, and the server picks the era from each request.

**2026-07-28 requests** carry `_meta` fields `io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities`, plus `MCP-Protocol-Version` and `Mcp-Method` headers
(`Mcp-Name` on `tools/call`). There is no handshake.

- **Validation.** Missing `_meta` fields get `400` with `-32602`. Missing or mismatched headers get `-32020`. An
  unsupported version gets `-32022` with `data.supported` and `data.requested`. Header values in the
  `=?base64?…?=` form are decoded.
- **Methods.** `server/discover`, `tools/list`, `tools/call`, and empty `resources/list`,
  `resources/templates/list` and `prompts/list`. Unknown and removed methods (`ping`, `logging/setLevel`) get
  `404` with `-32601`.
- **Results.** Every result has `resultType: "complete"` and `io.modelcontextprotocol/serverInfo` in its
  `_meta`. Lists carry `ttlMs` and `cacheScope` (`private` in OAuth mode, where the list depends on the token).
- **Batches** are refused. Notifications get `202`.

**Legacy requests** work as before. The methods are `initialize`, which echoes a supported legacy version, `ping`,
`notifications/*` (answered `202`), `tools/list`, `tools/call` (text content plus `structuredContent`; tool failures
are results with `isError: true`), and the empty lists. Batches are accepted. A legacy request whose
`MCP-Protocol-Version` header is not a supported version gets `400`.

Errors use the JSON-RPC codes `-32700`, `-32600`, `-32601`, `-32602`, `-32603`, and `-32001` for
authentication and permission failures. `Mcp-Session-Id` is never issued, and it is ignored when a client sends it.

## Authentication

:::tip[OAuth]
For clients that connect with OAuth (Claude.ai, ChatGPT, Claude Code and Codex without
configuring headers), turn on OAuth mode with `@ghuri/oauth-provider` as the authorization
server. See [MCP server with OAuth](/docs/topics/mcp-oauth/). This section covers static
credentials, which remain the simplest choice for scripts and internal clients.
:::

Requests are authenticated by `AGENTS.AUTHENTICATION_CLASSES` (falling back to
`REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES`) and must pass `AGENTS.PERMISSION_CLASSES`, which
defaults to `[IsAuthenticated]`. Requests without valid credentials get HTTP `401` with a
`WWW-Authenticate` header and a JSON-RPC error body.

The REST default authentication class only reads the session, and MCP clients do not carry
browser cookies, so configure a header-based class. A DRF-style
[API token](/docs/topics/auth-tokens/) is the practical choice:

```ts title="src/settings.ts"
import { AgentsConfig } from '@ghuri/agents'
import { AuthTokenConfig } from '@ghuri/auth'
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
import { IsAuthenticated } from '@ghuri/rest'

export default defineSettings((env) => ({
  // ...
  INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, AuthTokenConfig, /* ... */ AgentsConfig],
  AGENTS: {
    AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication],
    PERMISSION_CLASSES: [IsAuthenticated],   // the default
  },
}))
```

Create a token for the user the client acts as:

```sh
npx ghuri drf_create_token alice           # add --remote for the deployed D1 database
# Generated token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b for user alice
```

Create a dedicated user with only the permissions the client needs rather than handing out a
superuser token. Revoke access by deleting the token (`drf_create_token alice --reset` replaces
it).

Some clients can only send `Authorization: Bearer <token>`. Either use
[JWT](/docs/topics/auth-tokens/#jwt) (`JWTAuthentication`), or accept API tokens under the
`Bearer` keyword:

```ts
import { TokenAuthentication } from '@ghuri/auth/rest'

class BearerTokenAuthentication extends TokenAuthentication {
  keyword = 'Bearer'
}

AGENTS: { AUTHENTICATION_CLASSES: [TokenAuthentication, BearerTokenAuthentication] }
```

With `SessionAuthentication`, unsafe requests from a logged-in browser must pass CSRF
validation. Independently of authentication, requests whose `Origin` header is not your own host
or listed in `CSRF_TRUSTED_ORIGINS` are refused with `403`, to block DNS-rebinding attacks from
web pages. Native clients usually send no `Origin` and are unaffected.

## Connecting clients

The examples use `https://shop.example.com/mcp/`; locally, `http://localhost:8787/mcp/` with
`npx ghuri runserver` works the same.

### Claude Code

```sh
claude mcp add --transport http shop https://shop.example.com/mcp/ \
  --header "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"
```

Or commit a project-scoped `.mcp.json` and keep the token in an environment variable:

```json title=".mcp.json"
{
  "mcpServers": {
    "shop": {
      "type": "http",
      "url": "https://shop.example.com/mcp/",
      "headers": { "Authorization": "Token ${SHOP_TOKEN}" }
    }
  }
}
```

### Claude Desktop

Claude Desktop's `claude_desktop_config.json` launches local (stdio) servers, so connect through
the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge, which forwards to the HTTP
endpoint and adds the header:

```json title="claude_desktop_config.json"
{
  "mcpServers": {
    "shop": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://shop.example.com/mcp/", "--header", "Authorization:${SHOP_AUTH}"],
      "env": { "SHOP_AUTH": "Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b" }
    }
  }
}
```

Write the header as `Authorization:${SHOP_AUTH}` with no space after the colon and keep the full
value (`Token <key>`) in `env`; this avoids argument-splitting problems with spaces on some
platforms. Restart Claude Desktop after editing the file.

:::note
Claude Desktop's remote connector settings take a URL but no custom request headers, so they
cannot send a static token. Use the `mcp-remote` configuration above, or turn on
[OAuth mode](/docs/topics/mcp-oauth/) so the connector can log in.
:::

### Other clients

Any client that supports remote Streamable HTTP servers with custom headers works with a
configuration of the same shape as the `.mcp.json` above: a URL with the trailing slash and an
`Authorization` header.

### Testing with curl

```sh
curl -X POST https://shop.example.com/mcp/ \
  -H 'Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

In tests, mount the router in `ROOT_URLCONF` and post JSON-RPC bodies with the `@ghuri/rest`
test client (`client.forceAuthenticate(user)`) or a real `Authorization: Token ...` header.
