---
title: What is Ghuri?
description: Why Ghuri exists, what it is built on, and how its packages fit together.
---

Ghuri is a web framework for TypeScript that copies Django's structure on purpose. A Ghuri
project has a `settings.ts`, a list of `INSTALLED_APPS`, models with `objects` managers,
migrations generated from those models, a `urls.ts` built from `path()` and `include()`, an
admin you get by registering models, and a REST framework that reads like Django REST
framework.

The name is Bengali for *kite* (ঘুড়ি): something light that flies high and stays on a string
you control.

## Why another framework?

TypeScript has excellent building blocks (routers, query builders, validation libraries) and
very few frameworks that decide how a whole application fits together. Django's answers to that
question have held up for twenty years. Ghuri takes those answers and fits them to a different
runtime: serverless JavaScript at the edge.

Three ideas drive the design:

**Cloudflare first.** A new project runs on Cloudflare Workers with D1 (SQLite) for data, R2
for files and KV for cache. `npm run dev` starts `wrangler dev`; `ghuri deploy` ships it. For a
small project that is free or close to it.

**Portability is a feature.** Your code never touches `env.DB` or `env.BUCKET`. Databases,
storage, caches and the runtime sit behind adapters chosen in settings. Moving to Postgres on a
VPS means changing `DATABASES`, running `ghuri migrate`, and copying your data with
`ghuri dumpdata` and `ghuri loaddata`. Your models, views and serializers stay as they are.

**Django muscle memory.** Names, file layout and behaviour follow Django and DRF wherever
TypeScript allows. Where TypeScript forces a change (options are `camelCase`, everything that
touches the database is `async`), the change is mechanical and documented in
[Ghuri for Django developers](/docs/django-developers/).

## What it is built on

| Layer | Library |
|---|---|
| HTTP routing, middleware, JSX rendering | [Hono](https://hono.dev) |
| SQL generation and dialects | [Drizzle ORM](https://orm.drizzle.team) |
| Local development and deploys | [Wrangler](https://developers.cloudflare.com/workers/wrangler/) |
| Node runtime | `@hono/node-server` |
| AI agents | [Vercel AI SDK](https://ai-sdk.dev) |

You can always reach the layer below. A view receives a Hono `Context`, any Hono app can be
mounted in `urlpatterns`, and `getDrizzle()` gives you the Drizzle database for a query the ORM
cannot express.

## The packages

Ghuri is split into packages under the `@ghuri` npm scope. A new project installs all of them;
you can drop the ones you do not use.

| Package | Contains |
|---|---|
| `@ghuri/core` | settings, app registry, URLs, views, middleware, request context, signals, cache, management command base, test client, Node adapter |
| `@ghuri/orm` | `Model`, fields, managers and QuerySets, relations, database adapters (D1, Postgres, SQLite, PGlite), migrations |
| `@ghuri/auth` | users, groups, permissions, password hashing, sessions, tokens, JWT |
| `@ghuri/rest` | serializers, API views, viewsets, routers, permissions, pagination, filters, throttling, OpenAPI |
| `@ghuri/storage` | storage API with R2, S3, filesystem and memory backends; `FileField`, `ImageField` |
| `@ghuri/admin` | the admin site, server-rendered with Hono JSX and htmx |
| `@ghuri/agents` | AI agents whose tools come from your models and viewsets; an MCP server |
| `@ghuri/cli` | the `ghuri` command |
| `create-ghuri` | `npm create ghuri@latest` |

:::caution[Alpha software]
Ghuri is at `0.1.0-alpha`. Packages publish under the `next` dist-tag, and APIs can still change
between alpha releases. Pages that describe APIs most likely to move carry an **Alpha** note.
:::

## Where to go next

- [Install Ghuri](/docs/getting-started/installation/) and create a project.
- Work through the [tutorial](/docs/tutorial/part-1-models/), which builds a blog with an admin
  and a REST API and deploys it to Cloudflare.
- If you already know Django, keep the [cheat sheet](/docs/django-developers/) open in a tab.
