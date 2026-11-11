---
title: Installation
description: Requirements, creating a project with npm create ghuri, and choosing a database.
---

## Requirements

- **Node.js 20 or later** (22 LTS recommended). The `ghuri` CLI and Wrangler run on Node even
  when your app runs on Workers.
- **npm**, pnpm or Bun. The examples use npm.
- A **Cloudflare account** when you want to deploy to Workers. You do not need one to develop
  locally: `wrangler dev` simulates D1, R2 and KV on your machine.
- **Postgres 14+** only if you choose the Postgres template or deploy to a VPS.

## Create a project

```sh
npm create ghuri@latest mysite
```

`create-ghuri` asks a couple of questions and then runs `ghuri startproject` for you. You can
answer them up front with flags:

```sh
npm create ghuri@latest mysite -- --db d1        # Cloudflare D1 (default)
npm create ghuri@latest mysite -- --db postgres  # Postgres, for Node or Hyperdrive
npm create ghuri@latest mysite -- --db sqlite    # local SQLite file, Node only
```

The `--db` flag only decides what goes into the generated `settings.ts`, `wrangler.jsonc` and
`.dev.vars.example`. You can change databases later by editing settings, so do not agonise over
it. If you are unsure, take the default.

Then install dependencies (if you skipped that step) and start the development server:

```sh
cd mysite
npm install
npm run dev
```

`npm run dev` runs `ghuri runserver`, which starts `wrangler dev` on
`http://localhost:8787`. The page you see is the default home view from `src/urls.ts`.

:::tip[If you know Django]
`npm create ghuri@latest mysite` is `django-admin startproject mysite`, and `npm run dev` is
`python manage.py runserver`. Instead of `python manage.py <command>` you run
`npx ghuri <command>` from the project root.
:::

## Set a secret key

Ghuri signs sessions, CSRF tokens and password reset links with `SECRET_KEY`. Locally it comes
from `.dev.vars`, which Wrangler loads as environment bindings:

```sh
cp .dev.vars.example .dev.vars
```

```ini title=".dev.vars"
SECRET_KEY="change-me-to-a-long-random-string"
DEBUG="true"
```

`.dev.vars` is git-ignored. For production you set the secret with
`npx wrangler secret put SECRET_KEY` (Workers) or an environment variable (Node). Settings refuse
to load without a `SECRET_KEY` unless `DEBUG` is on.

## Adding Ghuri to an existing Workers project

The `create-ghuri` template is the supported path, but nothing in it is magic. To add Ghuri by
hand, install the packages under the `next` tag:

```sh
npm install @ghuri/core@next @ghuri/orm@next @ghuri/auth@next @ghuri/rest@next \
  @ghuri/storage@next @ghuri/admin@next hono drizzle-orm
npm install -D @ghuri/cli@next wrangler typescript
```

Then:

1. Make sure `wrangler.jsonc` has `"compatibility_flags": ["nodejs_compat"]`. Ghuri uses
   `AsyncLocalStorage` from `node:async_hooks` to carry the request context.
2. Add `"ghuri": { "settings": "src/settings.ts" }` to `package.json` so the CLI can find your
   settings.
3. Write a `settings.ts` (see [Settings](/docs/topics/settings/)) and export
   `createApp(settings)` as the Worker's default export.

## Editor setup

Ghuri is written for `strict` TypeScript with `moduleResolution: "bundler"`, and the generated
`tsconfig.json` already has the right options. Two settings matter if you write your own:

```jsonc title="tsconfig.json"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    // Ghuri uses standard (TC39) decorators: @admin.register, @action, @tool.
    // Do not enable "experimentalDecorators".
    "types": ["@cloudflare/workers-types"]
  }
}
```

## Next steps

Take a look at [what `startproject` generated](/docs/getting-started/project-layout/), then
start the [tutorial](/docs/tutorial/part-1-models/).
