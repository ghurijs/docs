---
title: Installation
description: Requirements, creating a project with npm create ghuri, and choosing a database.
---

## Requirements

- **Node.js 20 or later** (22 LTS recommended). The `ghuri` CLI and Wrangler run on Node even
  when your app runs on Workers.
- **npm**, pnpm, Bun or Yarn. The examples use npm.
- A **Cloudflare account** when you want to deploy to Workers. You do not need one to develop
  locally: `wrangler dev` simulates D1, R2 and KV on your machine.
- **Postgres 14+** only if you choose the Postgres template or deploy to a VPS.

## Create a project

```sh
npm create ghuri@latest mysite
```

`create-ghuri` asks for the project name, the database, the package manager, whether to install
dependencies and whether to initialise a git repository (with an initial commit). Then it runs
`ghuri startproject` for you and prints the next steps. You can answer the questions up front
with flags:

```sh
npm create ghuri@latest mysite -- --db d1        # Cloudflare D1 + R2 (default)
npm create ghuri@latest mysite -- --db postgres  # Postgres: Hyperdrive on Workers, DATABASE_URL elsewhere
npm create ghuri@latest mysite -- --db sqlite    # Node.js project: better-sqlite3 + local files, no Cloudflare
```

| Option | Default | Meaning |
|---|---|---|
| `[name]` | asked (`my-ghuri-app` with `--yes`) | Project name and directory. Letters, digits, `-` and `_`, starting with a letter. |
| `--db <d1\|postgres\|sqlite>` | `d1` | Database the generated `settings.ts`, `wrangler.jsonc` and `.dev.vars` use. |
| `--pm <npm\|pnpm\|bun\|yarn>` | the one you ran `create` with | Package manager for installing and for the printed commands. |
| `--install` / `--no-install` | yes | Install dependencies. |
| `--git` / `--no-git` | yes | `git init` plus an initial commit. |
| `-y`, `--yes` | | Never prompt; use defaults for anything not given. |

Prompts are skipped automatically when stdin is not a terminal (CI). You can also skip
`create-ghuri` and run the CLI directly: `npx @ghuri/cli@next startproject mysite --db d1`.

The `--db` choice only decides what goes into the generated files, and every template already
switches to Postgres when `DATABASE_URL` is set. You can change databases later by editing
settings, so do not agonise over it. If you are unsure, take the default.

## Run it

```sh
cd mysite
npx ghuri migrate            # create the tables for auth, sessions, tokens and the admin
npx ghuri createsuperuser    # an admin user
npm run dev
```

`npm run dev` runs `ghuri runserver`, which starts `wrangler dev` on `http://localhost:8787`
(for a `--db sqlite` project it runs `ghuri runserver --node` on `http://localhost:8000`).
The root URL answers with a small JSON document from the home view in `src/urls.ts`; the admin
is at `/admin/` and the REST API root at `/api/`.

Local development works with the placeholder `database_id` in `wrangler.jsonc`. You only need
to run `npx wrangler d1 create mysite-db` and paste the real id when you
[deploy](/docs/tutorial/part-5-deploy/).

:::tip[If you know Django]
`npm create ghuri@latest mysite` is `django-admin startproject mysite`, and `npm run dev` is
`python manage.py runserver`. Instead of `python manage.py <command>` you run
`npx ghuri <command>` from the project root (or `npm run ghuri -- <command>`).
:::

## The secret key

Ghuri signs sessions, CSRF tokens and password reset links with `SECRET_KEY`. `startproject`
generates a random one into `.dev.vars`, which Wrangler and the `ghuri` CLI both load:

```ini title=".dev.vars"
# Local development variables (read by wrangler and ghuri). Never commit this file.
SECRET_KEY=q3N…64 random characters…
DEBUG=true
```

`.dev.vars` is git-ignored; `.dev.vars.example` is the committed template for your teammates.
For production you set the secret with `npx wrangler secret put SECRET_KEY` (Workers) or an
environment variable (Node). Settings refuse to load without a `SECRET_KEY` unless `DEBUG` is
on.

## Adding Ghuri to an existing Workers project

The `create-ghuri` template is the supported path, but nothing in it is magic. To add Ghuri by
hand, install the packages under the `next` tag:

```sh
npm install @ghuri/core@next @ghuri/orm@next @ghuri/auth@next @ghuri/rest@next \
  @ghuri/storage@next @ghuri/admin@next hono drizzle-orm
npm install -D @ghuri/cli@next wrangler typescript vitest
```

Then:

1. Make sure `wrangler.jsonc` has `"compatibility_flags": ["nodejs_compat"]`. Ghuri uses
   `AsyncLocalStorage` from `node:async_hooks` to carry the request context.
2. Add `"ghuri": { "settings": "src/settings.ts" }` to `package.json` so the CLI can find your
   settings (without it the CLI looks for `src/settings.ts`).
3. Write a `settings.ts` (see [Settings](/docs/topics/settings/) and
   [Project layout](/docs/getting-started/project-layout/)) and export `createApp(settings)` as
   the Worker's default export.

The easiest way to get a correct starting point is to generate a throwaway project with
`npx @ghuri/cli@next startproject scratch --no-install` and copy what you need from it.

## Editor setup

Ghuri is written for `strict` TypeScript with `moduleResolution: "bundler"`, and the generated
`tsconfig.json` already has the right options:

```jsonc title="tsconfig.json"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["@cloudflare/workers-types", "node"],
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    // Hono JSX for server-rendered views
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
    // Ghuri uses standard (TC39) decorators: @admin.register, @action.
    // You do not need "experimentalDecorators".
  },
  "include": ["src", "vitest.config.ts"]
}
```

`npm run typecheck` runs `tsc --noEmit` over the project.

## Next steps

Take a look at [what `startproject` generated](/docs/getting-started/project-layout/), then
start the [tutorial](/docs/tutorial/part-1-models/).
