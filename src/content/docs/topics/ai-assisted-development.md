---
title: AI-assisted development
description: Connect Claude Code, Codex, Cursor and other coding agents to a Ghuri project with AGENTS.md, the Ghuri skill, the ghuri mcp server and llms.txt.
---

Ghuri is new, so the models behind coding agents have not seen it in training. Left alone they
fall back to what they know: Python Django, DRF, Prisma or raw Hono. Ghuri ships four things that
give an agent the real APIs instead. Use as many as your tool supports; they stack.

| Layer | What it gives the agent | Works with |
|---|---|---|
| [`AGENTS.md`](#agentsmd) | Project layout, commands and the core API cheat-sheet, in every new project | Every agent that reads `AGENTS.md` or `CLAUDE.md` |
| [Ghuri skill](#the-ghuri-skill) | Step-by-step workflows and per-area reference, loaded only when relevant | Claude Code (plugin), Codex, Cursor, Gemini CLI and others (`npx skills`) |
| [`ghuri mcp`](#the-ghuri-mcp-server) | Live access to *your* project: models, routes, settings, migrations, management commands, docs search | Any MCP client |
| [`llms.txt`](#llmstxt) | The whole documentation as one Markdown file | Anything that can fetch a URL |

:::note
This page is about using AI to **build** a Ghuri app. To let AI agents **use** your app's data at
runtime, see [AI agents](/docs/topics/agents/) and the [MCP server](/docs/topics/agents-mcp/) in
`@ghuri/agents`.
:::

## AGENTS.md

`ghuri startproject` (and `npm create ghuri`) writes three files for coding agents:

| File | Purpose |
|---|---|
| `AGENTS.md` | Project layout, the `ghuri` commands, a cheat-sheet of the core APIs (models, QuerySets, serializers, viewsets, admin, URLs and views) and the rules an agent should follow, such as running `makemigrations` after every model change and never touching D1 or R2 bindings from app code |
| `CLAUDE.md` | A one-line `@AGENTS.md` import, so Claude Code reads the same file |
| `.mcp.json` | Registers the [`ghuri mcp`](#the-ghuri-mcp-server) server for Claude Code, using your package manager (`npx`, `pnpm exec`, `bunx` or `yarn`) |

Codex, Cursor, GitHub Copilot, Gemini CLI and most other agents read `AGENTS.md` automatically.
Edit it as your project grows: add your apps, your domain vocabulary and your own conventions.

For a project created before these files existed, run `ghuri startproject` into a temporary
directory and copy them over.

## The Ghuri skill

The skill teaches an agent Ghuri in depth: a Django-to-Ghuri mapping, step-by-step workflows (add
an app, add a model and migration, expose a REST API, register it in the admin, add GraphQL or
WebSockets, deploy, move from D1 to Postgres), the mistakes a Django-trained model makes, and one
reference file per area. The agent loads it only when the task involves Ghuri, so it costs nothing
the rest of the time.

**Claude Code** — install the plugin, which bundles the skill and the `ghuri mcp` server:

```
/plugin marketplace add ghurijs/ghuri
/plugin install ghuri@ghuri
```

**Codex, Cursor, Gemini CLI, OpenCode and others** — install the skill with the
[`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
npx skills add ghurijs/ghuri
```

The skill lives in the [`ghurijs/ghuri`](https://github.com/ghurijs/ghuri) repository under
`plugins/ghuri/skills/ghuri/`.

## The ghuri mcp server

`ghuri mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio
that gives an agent live access to **your** project, so it checks your real models and routes
instead of guessing. See [`ghuri mcp`](/docs/reference/cli/#mcp) in the CLI reference for every
option.

| Tool | What it does |
|---|---|
| `project_info` | Project root, runtime, bindings, `DEBUG`, `INSTALLED_APPS`, `DATABASES` and `STORAGES` (engine and name only), `MIDDLEWARE` and `@ghuri/*` package versions. Secrets are hidden |
| `list_apps` | Each installed app: label, path, models, commands, migrations |
| `list_models` | Every `app.Model` with its table and fields |
| `describe_model` | Fields with their options, relations, reverse relations, `Meta` and managers |
| `list_routes` | Every URL pattern with its name and view, like `ghuri routes` |
| `list_commands` | Every management command, including those added by apps |
| `show_migrations` | Applied and unapplied migrations per app |
| `run_command` | Runs a management command (`makemigrations`, `migrate`, `test`, `check`, `startapp`, …) and returns its output |
| `search_docs`, `get_doc` | Search and read this documentation (from `llms-full.txt`) |

`run_command` will not run commands that are interactive, long-running or aimed at production:
`runserver`, `shell`, `dbshell`, `deploy`, `flush`, `startproject`, `createsuperuser` without
`--no-input`, `test --watch`, and anything with `--remote`. Project state is re-read whenever a
source file changes, so the agent sees models and routes it has just added.

:::caution
`run_command` runs against whatever database your settings point at. If `DATABASE_URL` or a
`--database` alias points at a shared Postgres server, the agent can migrate it. Keep agents on a
local database.
:::

New projects already register the server in `.mcp.json`. To add it elsewhere, run the command
from the project directory:

**Claude Code**

```bash
claude mcp add ghuri -- npx ghuri mcp
```

**Codex** (`~/.codex/config.toml`, or `.codex/config.toml` in the project)

```toml
[mcp_servers.ghuri]
command = "npx"
args = ["ghuri", "mcp"]
```

**Cursor** (`.cursor/mcp.json`)

```json
{ "mcpServers": { "ghuri": { "command": "npx", "args": ["ghuri", "mcp"] } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "ghuri": { "type": "stdio", "command": "npx", "args": ["ghuri", "mcp"] } } }
```

## llms.txt

The documentation is published as plain Markdown for tools that read URLs:

| URL | Contents |
|---|---|
| [`/docs/llms.txt`](https://ghurijs.github.io/docs/llms.txt) | Index of the sets below |
| [`/docs/llms-full.txt`](https://ghurijs.github.io/docs/llms-full.txt) | All of the documentation (about 175k tokens) |
| [`/docs/llms-small.txt`](https://ghurijs.github.io/docs/llms-small.txt) | Abridged version (about 140k tokens) |
| `/docs/_llms-txt/orm.txt`, `rest-framework.txt`, `admin.txt`, `auth.txt`, `agents.txt`, `deployment.txt` | One area each (7k–20k tokens) |

The focused sets fit easily in a context window. Paste one into a chat, or point a tool such as
Cursor's `@Docs` at it.
