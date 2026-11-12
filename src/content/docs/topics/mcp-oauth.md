---
title: MCP server with OAuth
description: Host a remote MCP server that Claude.ai, ChatGPT, Claude Code and Codex connect to with OAuth 2.1, using @ghuri/oauth-provider as the authorization server and @ghuri/agents as the protected resource.
---

Remote MCP clients such as Claude.ai, ChatGPT, Claude Code and Codex connect with **OAuth**. The user pastes your MCP URL,
logs in to your site, approves the client, and the client calls your tools with an access token. Two packages do this
in any Ghuri app:

- [`@ghuri/oauth-provider`](#the-authorization-server) is an OAuth 2.1 **authorization server**, in the style of
  django-oauth-toolkit. It provides the authorize page, the token, revocation and registration endpoints, and
  discovery metadata. Clients, grants and tokens live in your database, so it runs on D1, Postgres and SQLite, on
  Workers and on Node.
- [`@ghuri/agents`](/docs/topics/agents-mcp/) turns the MCP endpoint into an OAuth **protected resource**:
  - It serves Protected Resource Metadata.
  - It answers `401` / `403` with `WWW-Authenticate` challenges.
  - It accepts only access tokens issued for its own URL.
  - It filters tools by scope.

The implementation follows the MCP authorization spec of the **2026-07-28** revision. It also keeps working with
clients of earlier revisions.

:::note[Alpha]
`@ghuri/oauth-provider` is new (`0.1.0-alpha.0`). It needs `@ghuri/core`, `@ghuri/orm`, `@ghuri/auth` and
`@ghuri/oauth`, plus `@ghuri/rest` for the REST helpers and `@ghuri/admin` for the admin pages.
:::

## How a client connects

```
Client                                  Your Ghuri app
  │ POST /mcp/ (no token)          ──▶  401  WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"
  │ GET  resource metadata         ──▶  { resource: "https://shop.example.com/mcp", authorization_servers: ["https://shop.example.com"] }
  │ GET  /.well-known/oauth-authorization-server ──▶ endpoints, S256, CIMD supported, iss supported
  │ (client_id = its metadata URL, or POST /oauth/register/)
  │ browser → /oauth/authorize/?…&code_challenge=…&resource=https://shop.example.com/mcp
  │            user logs in, approves on the consent page
  │ ◀── redirect to the client's callback with ?code=…&state=…&iss=https://shop.example.com
  │ POST /oauth/token/ (code + code_verifier + resource) ──▶ access_token (aud = MCP URL), refresh_token
  │ POST /mcp/  Authorization: Bearer <access_token>     ──▶ tools run as the user
```

## Setup

```sh
npm install @ghuri/oauth-provider @ghuri/oauth
```

Install the app next to `auth`, add the session and CSRF middleware the consent page needs, and turn on OAuth mode on
the MCP server:

```ts title="src/settings.ts"
import { AgentsConfig } from '@ghuri/agents'
import { AuthConfig, AuthenticationMiddleware, ContentTypesConfig, SessionMiddleware, SessionsConfig } from '@ghuri/auth'
import { CsrfMiddleware, defineSettings } from '@ghuri/core'
import { OAuth2ProviderConfig } from '@ghuri/oauth-provider'

export default defineSettings((env) => ({
  // ...
  INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, AgentsConfig, OAuth2ProviderConfig /* , ... */],
  MIDDLEWARE: [SessionMiddleware, CsrfMiddleware, AuthenticationMiddleware /* , ... */],
  LOGIN_URL: '/accounts/login/',
  OAUTH2_PROVIDER: {
    SCOPES: {
      'theme:read': 'Read your store theme',
      'theme:write': 'Edit your store theme',
    },
  },
}))
```

```ts title="src/urls.ts"
import { McpServer, tool } from '@ghuri/agents'
import { authUrls } from '@ghuri/auth'
import { include, path } from '@ghuri/core'
import { oauth2ProviderUrls, oauth2WellKnownUrls, verifyAccessToken } from '@ghuri/oauth-provider'
import { z } from 'zod'

const mcp = new McpServer({
  name: 'shop',
  instructions: 'Tools for editing the store theme.',
  tools: [
    tool({
      name: 'theme_get',
      description: 'Read the current theme',
      scopes: ['theme:read'],
      execute: async (_input, ctx) => loadTheme(ctx.user),
    }),
    tool({
      name: 'theme_update',
      description: 'Change theme settings',
      input: z.object({ settings: z.record(z.string(), z.unknown()) }),
      scopes: ['theme:write'],
      execute: async ({ settings }, ctx) => saveTheme(ctx.user, settings),
    }),
  ],
  oauth: { verifyAccessToken },
})

export const urlpatterns = [
  path('accounts/', include(authUrls)),            // the login page the consent step redirects to
  path('oauth/', include(oauth2ProviderUrls)),     // authorize/, token/, revoke_token/, register/
  path('mcp/', mcp.urls),
  path('', include(oauth2WellKnownUrls)),          // /.well-known/oauth-authorization-server
  path('', include(mcp.wellKnownUrls)),            // /.well-known/oauth-protected-resource/mcp
]
```

Then run `npx ghuri migrate` to create the `oauth2_provider_*` tables, deploy, and give clients the URL
`https://shop.example.com/mcp/`.

The MCP URL is the token **audience**. Clients send it as the RFC 8707 `resource` parameter, the access token's `aud`
claim is set to it, and the MCP endpoint refuses tokens issued for anything else. Ghuri compares resource URLs in
canonical form: lowercase scheme and host, no default port and no trailing slash. So `https://shop.example.com/mcp/`
and `https://shop.example.com/mcp` are the same resource.

## Connecting clients

All four clients discover everything from the MCP URL. You don't configure client IDs or secrets.

| Client | How it registers | Callback |
|---|---|---|
| **Claude.ai** (custom connector) | Client ID Metadata Document: its `client_id` is a URL on Claude's domain. It falls back to dynamic registration if your server does not advertise `none` in `token_endpoint_auth_methods_supported` (Ghuri does). | `https://claude.ai/api/mcp/auth_callback` (and `https://claude.com/api/mcp/auth_callback`) |
| **ChatGPT** (connector / app) | Client ID Metadata Document, `client_id` `https://chatgpt.com/oauth/client.json` | `https://chatgpt.com/connector_platform_oauth_redirect` (used when the server supports RFC 9207 `iss`, as Ghuri does) |
| **Claude Code** | Dynamic registration, or a metadata document where supported | `http://localhost:<random port>/callback` |
| **Codex** | Dynamic registration, or a metadata document where supported | `http://127.0.0.1:<random port>/…` |

Claude Code and Codex listen on a random local port for each login. Ghuri matches loopback redirect URIs (`localhost`,
`127.0.0.1`, `[::1]`) on any port, as RFC 8252 asks, and compares every other redirect URI exactly.

### Claude.ai

Add a custom connector in Claude's connector settings and paste `https://shop.example.com/mcp/`. Claude opens your site
in a browser window. The user logs in and approves on the consent page, then Claude lists the tools that the granted
scopes allow.

### ChatGPT

Add a custom connector (app) with the MCP URL and choose OAuth authentication. ChatGPT reads the metadata, sends its
metadata-document client ID and redirects back to `connector_platform_oauth_redirect`.

### Claude Code

```sh
claude mcp add --transport http shop https://shop.example.com/mcp/
```

Inside Claude Code, run `/mcp`, pick `shop` and choose to authenticate. A browser opens on your consent page.

### Codex

```sh
codex mcp add shop --url https://shop.example.com/mcp/
codex mcp login shop
```

`codex mcp login` runs the OAuth flow in your browser and stores the tokens. Check `codex mcp --help` if your version
names the commands differently.

### Local development

Locally, `http://localhost:8787/mcp/` works with Claude Code and Codex. The MCP spec requires HTTPS for authorization
servers, so hosted clients (Claude.ai, ChatGPT) need a public HTTPS URL, such as a deployed preview or a tunnel. Behind
a proxy, set `SECURE_PROXY_SSL_HEADER` and `USE_X_FORWARDED_HOST` so the issuer and endpoint URLs come out as
`https://…`, or set `OAUTH2_PROVIDER.ISSUER`.

## Scopes

- **Declaring scopes.** List the scopes your server grants in `OAUTH2_PROVIDER.SCOPES`, with the text the consent page
  shows. If a request names no scope, it gets `DEFAULT_SCOPES` (default: every scope). An unknown scope gets
  `invalid_scope`.
- **Per-tool scopes.** `tool({ scopes })` and the toolkit option `scopes` set what a tool needs. The toolkit option is
  `ModelTools(Model, { scopes: { list: ['orders:read'], create: ['orders:write'] } })`, or one list for every action.
  `requireScopes(['orders:write'], new RouterTools(router))` adds scopes to anything after the fact.
- **Tool list and calls.** `tools/list` hides tools the token lacks a scope for (`hideUnauthorizedTools: false` lists
  them anyway). Calling one answers `403`:

  ```http
  HTTP/1.1 403 Forbidden
  WWW-Authenticate: Bearer error="insufficient_scope", scope="theme:read theme:write", resource_metadata="https://shop.example.com/.well-known/oauth-protected-resource/mcp", error_description="The tool 'theme_update' needs the scope theme:write."
  ```

  The client then asks the user to approve the larger set (step-up authorization).
- **`requiredScopes`.** Scopes every request needs. They are sent in the `401` challenge's `scope`.
- **`impliedScopes`.** A broader scope covers narrower ones: `{ 'theme:write': ['theme:read'] }`.
- **`scopes_supported`.** The Protected Resource Metadata advertises every scope the tools use, unless you set
  `scopesSupported`.

## The consent step

The default consent page shows:

- the client name and the requested scopes;
- the host the user will be sent back to;
- for loopback redirects, a warning that the app runs on the user's own computer.

It is never framed (`X-Frame-Options: DENY`) and posts back with a CSRF token. Users who are not logged in go to
`LOGIN_URL` and come back.

Replace it with your own page, for example to let a merchant pick which store the client may edit. The handler
receives the validated request, the client and the user. It approves with a subset of the requested scopes and
app-defined `props`, which are stored on the grant:

```tsx title="src/oauth.tsx"
import type { ConsentHandler } from '@ghuri/oauth-provider'
import { Store } from './stores/models'

export const chooseStore: ConsentHandler = async (ctx) => {
  const stores = await Store.objects.filter({ owner: ctx.user.pk })
  if (!ctx.form) {
    // GET: render your page. Post back `request` (ctx.pending) plus the CSRF token to ctx.action.
    return render(ctx.c, <ConsentPage client={ctx.client} scopes={ctx.scopes} stores={stores} pending={ctx.pending} action={ctx.action} />)
  }
  if (!('allow' in ctx.form)) return ctx.deny()
  const store = stores.find((s) => String(s.pk) === ctx.form!.store)
  if (!store) return ctx.deny('No such store.')
  return ctx.approve({ scope: ctx.request.scopes, props: { storeId: store.pk } })
}
```

```ts
OAUTH2_PROVIDER: { CONSENT_HANDLER: chooseStore, /* ... */ }
// or per URL: path('oauth/authorize/', authorizationView({ consent: chooseStore }))
```

Tools read the props through the token: `request.auth.props.storeId`, and `ctx.request.auth.props` inside a tool.
When the user has already approved the same scopes for the client and resource, the next authorization is approved
without asking and keeps the props (`REQUEST_APPROVAL_PROMPT: 'force'` always asks). Clients marked
`skipAuthorization` are never asked.

## The authorization server

### Endpoints

| URL | |
|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata. It advertises `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported` including `none`, `client_id_metadata_document_supported: true` and `authorization_response_iss_parameter_supported: true`. With an issuer path (`ISSUER: 'https://x.example/tenant1'`) the metadata is served at `/.well-known/oauth-authorization-server/tenant1`. |
| `oauth/authorize/` | Authorization code flow with PKCE. Only `S256` is accepted and there is no implicit flow. Every response, error responses included, carries `iss` (RFC 9207). Requests whose client or redirect URI cannot be verified get an error page and are never redirected. |
| `oauth/token/` | Form-encoded `authorization_code` and `refresh_token` grants. Client authentication is `none` (public clients), `client_secret_basic` or `client_secret_post`. Responses are `no-store` and allow CORS. |
| `oauth/revoke_token/` | RFC 7009. Revoking a refresh token or an access token revokes its whole grant. Always `200`. |
| `oauth/register/` | RFC 7591 dynamic client registration (`ALLOW_DYNAMIC_REGISTRATION`, rate-limited per IP by `REGISTRATION_RATE`). The MCP spec deprecates it in favour of metadata documents, but Claude Code and Codex still use it. |
| `/.well-known/jwks.json` | Public key, only with an asymmetric `ACCESS_TOKEN_SIGNING_KEY`. |

### Tokens

**Access tokens** are signed JWTs (RFC 9068, `typ: at+jwt`). Their claims are:

- `iss`, `sub` (the user's pk) and `aud` (the resource);
- `client_id` and `scope`;
- `jti`, `iat` and `exp`;
- `gid`, the grant.

By default they are signed with HS256 using a key derived from `SECRET_KEY`. `SECRET_KEY_FALLBACKS` still verifies
during key rotation. Set `ACCESS_TOKEN_SIGNING_KEY` (a private JWK) for ES256, RS256 or EdDSA if another service must
verify them through the JWKS.

`verifyAccessToken(token, { audience })` checks the signature, expiry and audience, and that the grant is still
active. That check costs one indexed query, and it is why revocation works immediately (`CHECK_GRANT_ON_ACCESS: false`
skips it). It returns `{ user, scopes, clientId, resource, grantId, props, expiresAt }`.

**Refresh tokens** are random, stored as SHA-256 hashes and rotated on every use. Presenting one that was already used
means someone holds a copy. The grant is then revoked with all of its tokens, and the request gets `invalid_grant`.
`REFRESH_TOKEN_GRACE_PERIOD_SECONDS` accepts a lost response's retry for a few seconds.

**Authorization codes** are hashed, live 60 seconds and work once. A replayed code revokes the grant it created.

Nothing in the database is a usable credential. Codes, refresh tokens and client secrets are stored only as hashes, and
access tokens are not stored at all.

### Client ID Metadata Documents

When a `client_id` is an `https://` URL with a path, the server fetches it as a Client ID Metadata Document. The
document's `client_id` must equal that URL exactly. Its `redirect_uris` must be `https` or loopback `http`, and its
auth method must be `none`. The fetch is guarded against SSRF:

- **Hosts.** Only `https` on the default port. IP literals, `localhost`, single-label names and internal suffixes
  (`.local`, `.internal`, …) are refused.
- **Requests.** Redirects are not followed, the document is capped at 5 KB, and the fetch times out after 5 s.
- **Caching.** Documents are cached as `Application` rows according to their `Cache-Control`, clamped to 5 minutes – 24
  hours.

Workers cannot resolve DNS before connecting, so a public name that resolves to a private address cannot be detected
there. Restrict hosts with `CLIENT_METADATA_ALLOWED_HOSTS` (`['claude.ai', 'claude.com', 'chatgpt.com']`) if you only
want known clients. `CLIENT_METADATA_POLICY` adds your own trust rules.

### Resources

By default tokens can be issued for any URL on the issuer's origin (your MCP endpoint, your API). `RESOURCES` widens or
narrows that (`['https://mcp.example.com/*']`, or a function), and anything else gets `invalid_target`. A request
without `resource` gets `DEFAULT_RESOURCE` (default: the issuer) as its audience, and `REQUIRE_RESOURCE: true` refuses
such requests.

### Admin and maintenance

```ts title="src/admin.ts"
import '@ghuri/oauth-provider/admin'
```

The admin pages cover applications, grants, refresh tokens and authorization codes; secrets and hashes are never shown.
The **Revoke selected grants** action signs a client out immediately. Register your own clients with
`createApplication({ name, redirectUris, clientType })`; the result includes the plain secret once.

`npx ghuri cleartokens` deletes expired codes, expired or revoked refresh tokens and revoked grants. Run it from a cron
trigger. It keeps rotated refresh tokens until they expire, so reuse is still detected.

### Protecting a REST API with the same tokens

```ts
import { OAuth2Authentication, TokenHasScope } from '@ghuri/oauth-provider/rest'

class ThemeAuthentication extends OAuth2Authentication {
  audience = 'https://shop.example.com/api'
}

class ThemeView extends APIView {
  authenticationClasses = [ThemeAuthentication]
  permissionClasses = [TokenHasScope]
  requiredScopes = ['theme:write']
}
```

## Settings

| Key (`OAUTH2_PROVIDER.*`) | Default | |
|---|---|---|
| `ISSUER` | request origin | Issuer identifier. Set it behind proxies or to use an issuer path. |
| `SCOPES` | unset (any scope) | `{ scope: description }`. |
| `DEFAULT_SCOPES` | every key of `SCOPES` | Scopes for requests that name none. |
| `ACCESS_TOKEN_EXPIRE_SECONDS` | `3600` | |
| `REFRESH_TOKEN_EXPIRE_SECONDS` | `2592000` (30 days) | Each rotation starts a new lifetime. |
| `AUTHORIZATION_CODE_EXPIRE_SECONDS` | `60` | |
| `REFRESH_TOKEN_GRACE_PERIOD_SECONDS` | `0` | Seconds a just-rotated refresh token may be retried. |
| `RESOURCES` | issuer origin | Allowed resource indicators: URLs, `prefix*`, or `(resource, c) => boolean`. |
| `DEFAULT_RESOURCE` | issuer | Audience when the request names no resource. |
| `REQUIRE_RESOURCE` | `false` | Refuse requests without `resource`. |
| `REQUEST_APPROVAL_PROMPT` | `'auto'` | `'force'` shows the consent page every time. |
| `CONSENT_HANDLER` | default page | Your consent step. |
| `ALLOW_DYNAMIC_REGISTRATION` | `true` | Serve `register/`. |
| `REGISTRATION_RATE` | `'20/hour'` | Registrations per IP (`null`: unlimited). |
| `ALLOW_CLIENT_ID_METADATA_DOCUMENTS` | `true` | Accept URL client IDs. |
| `CLIENT_METADATA_ALLOWED_HOSTS` | any public host | Hosts metadata documents may come from. |
| `CLIENT_METADATA_POLICY` | none | `(document, url) => boolean`. |
| `CLIENT_METADATA_CACHE_MIN_SECONDS` / `_DEFAULT_` / `_MAX_` | `300` / `3600` / `86400` | Cache bounds. |
| `CLIENT_METADATA_TIMEOUT` / `CLIENT_METADATA_MAX_BYTES` | `5000` ms / `5120` | Fetch limits. |
| `ALLOWED_REDIRECT_URI_SCHEMES` | `[]` | Extra schemes for native apps (`com.example.app`). `https` and loopback `http` are always allowed. |
| `ACCESS_TOKEN_ALGORITHM` | `'HS256'` (`'ES256'` with a key) | `HS256`, `ES256`, `RS256`, `EdDSA`. |
| `ACCESS_TOKEN_SIGNING_KEY` | none | Private JWK for asymmetric tokens. |
| `CHECK_GRANT_ON_ACCESS` | `true` | `verifyAccessToken` refuses tokens of revoked grants. |

`McpServer({ oauth })` options: `verifyAccessToken` (required), `authorizationServers` (default: your origin),
`resource` (default: the request's MCP URL), `scopesSupported`, `requiredScopes`, `impliedScopes`,
`hideUnauthorizedTools`, `resourceName` and `resourceDocumentation`.

## Testing

Run the flow with the test client. Start with `client.forceLogin(user)`, GET the authorize URL, post the consent form
back with its `request` field and `allow`, then exchange the code. To test tools without the browser step, create a
grant and its tokens directly:

```ts
import { Application, createApplication, createGrant, issueTokens } from '@ghuri/oauth-provider'

const { application } = await createApplication({ name: 'Test', redirectUris: ['https://client.example/cb'] })
const grant = await createGrant({ user, application, scopes: ['theme:read'], resource: 'http://testserver/mcp' })
const { access_token } = await issueTokens(grant, application, { issuer: 'http://testserver', scopes: ['theme:read'] })
```

Stub metadata-document fetches with `setProviderFetch()` from `@ghuri/oauth`.
