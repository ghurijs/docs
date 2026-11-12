---
title: Contributing
description: How the Ghuri repositories are organised, how to set up the development workspace, and how changes are made.
---

Ghuri is developed in the open under the [ghurijs](https://github.com/ghurijs) organisation on
GitHub. Bug reports, documentation fixes and pull requests are welcome.

## Repository layout

Each package lives in its own repository and publishes to npm under the `@ghuri` scope:

| Repository | npm package | Contents |
|---|---|---|
| [`ghurijs/ghuri`](https://github.com/ghurijs/ghuri) | (private) | Meta repo: the architecture spec, roadmap, development workspace and bootstrap script |
| [`ghurijs/core`](https://github.com/ghurijs/core) | `@ghuri/core` | settings, apps, URLs, views, middleware, context, signals, cache, commands, testing client, Node adapter |
| [`ghurijs/orm`](https://github.com/ghurijs/orm) | `@ghuri/orm` | models, fields, QuerySets, relations, database adapters, migrations |
| [`ghurijs/auth`](https://github.com/ghurijs/auth) | `@ghuri/auth` | users, permissions, sessions, tokens, JWT |
| [`ghurijs/rest`](https://github.com/ghurijs/rest) | `@ghuri/rest` | the REST framework |
| [`ghurijs/storage`](https://github.com/ghurijs/storage) | `@ghuri/storage` | storage backends, `FileField` |
| [`ghurijs/admin`](https://github.com/ghurijs/admin) | `@ghuri/admin` | the admin site |
| [`ghurijs/agents`](https://github.com/ghurijs/agents) | `@ghuri/agents` | AI agents and the MCP server |
| [`ghurijs/cli`](https://github.com/ghurijs/cli) | `@ghuri/cli` | the `ghuri` command |
| [`ghurijs/create-ghuri`](https://github.com/ghurijs/create-ghuri) | `create-ghuri` | `npm create ghuri@latest` |
| [`ghurijs/examples`](https://github.com/ghurijs/examples) | (private) | example projects, used as end-to-end tests |
| [`ghurijs/docs`](https://github.com/ghurijs/docs) | (private) | this site |

## The architecture spec

`ARCHITECTURE.md` in the meta repo is the source of truth for every package's public API. Its
last section, "As-built notes", records where the implementation deliberately differs from the
earlier sections and wins over them. Packages
talk to each other only through the contracts written there: for example, the REST framework
reads `Model._meta` and `Field.jsonSchema()`, and the admin reads `Field.formHint()`, without
importing ORM internals.

If a change needs a contract that does not exist, **add it to the spec first** (in the same pull
request, or a linked one against `ghurijs/ghuri`), then implement it.

## Setting up the workspace

The meta repo is an npm workspace that holds every package side by side:

```sh
git clone https://github.com/ghurijs/ghuri
cd ghuri
npm run bootstrap
```

`npm run bootstrap` runs `scripts/bootstrap.sh`, which:

1. clones each package repository (`core`, `orm`, `auth`, `rest`, `storage`, `admin`, `agents`,
   `cli`, `create-ghuri`) into `packages/<repo>` (git-ignored by the meta repo),
2. clones `examples` into `examples/`,
3. runs `npm install` at the root, linking the packages to each other, and
4. builds every package.

Sibling dependencies use the range `^0.1.0-alpha.0`, which npm workspaces resolve to the local
clones, so a change in `packages/orm` is visible to `packages/rest` after rebuilding.

Useful commands from the workspace root:

```sh
npm run build        # build every package (tsup)
npm test             # run every package's tests (vitest)
npm run typecheck    # tsc --noEmit everywhere
```

Each package is still its own git repository. Commit and open pull requests from inside
`packages/<name>`.

The docs site is not part of the workspace. Clone [`ghurijs/docs`](https://github.com/ghurijs/docs)
separately (or into `docs/` inside the meta repo), then:

```sh
cd docs
npm install
npm run dev          # http://localhost:4321/docs/
```

Every page has an **Edit page** link at the bottom that opens the source file on GitHub.

## Conventions

- **ESM only**, TypeScript `~5.9` with `strict: true`, target ES2022, `moduleResolution: bundler`.
- **Builds** use `tsup` (ESM plus `.d.ts`) into `dist/`. Subpath exports are declared in
  `package.json#exports`.
- **Workers compatibility.** Every package must run on Workers with `nodejs_compat`. Never import
  Node-only modules (`fs`, `path`, `better-sqlite3`, `pg`) from a package's main entry; put them
  behind a subpath such as `@ghuri/orm/sqlite` or `@ghuri/core/node`, or a dynamic import.
- **Global state** (the app registry, the request context, the model registry) must survive the
  package being loaded twice, so packages list `@ghuri/*` siblings as `peerDependencies`.
- **Naming.** Classes are `PascalCase`; options and fields are `camelCase`; settings keys stay
  `UPPER_SNAKE`; database columns are `snake_case`.
- **Errors** extend `GhuriError` from `@ghuri/core`.
- **Public API** is what `src/index.ts` and declared subpaths export. Everything else is internal
  and may change without notice.
- **Tests** use Vitest on Node. Database tests run against SQLite (better-sqlite3), PGlite
  (Postgres dialect) and D1 (Miniflare) where relevant; `testBackends()` from
  `@ghuri/orm/testing` reads `GHURI_TEST_BACKENDS=sqlite,pglite` to narrow the set.
- **Decorators** are standard TC39 decorators. Vite 8 (oxc) does not lower them yet, so packages
  that use them in tests lower them in `vitest.config.ts` (an esbuild pre-transform, or oxc's
  legacy decorator mode).
- **Lint and format** with Biome (each package has its own `biome.json`).

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), scoped to
the package:

```
feat(orm): support __iregex lookup on Postgres
fix(admin): keep filters when paginating the change list
docs(rest): document CursorPagination ordering
```

A good pull request:

- links the issue it fixes, or explains the problem it solves;
- includes tests, on every database dialect the change touches;
- updates the package's `README.md` and `CHANGELOG.md` when behaviour changes;
- updates `ARCHITECTURE.md` (in the meta repo) when it changes a public contract;
- updates these docs when it changes anything a user would notice.

## Reporting bugs

Open an issue on the repository of the package involved. Include the Ghuri package versions
(`npx ghuri version`), the runtime (Workers or Node, and the version), the database, a minimal
reproduction, and what you expected to happen. If you are not sure which package is responsible,
open it on [`ghurijs/ghuri`](https://github.com/ghurijs/ghuri/issues).

## License

Ghuri is released under the MIT license.
