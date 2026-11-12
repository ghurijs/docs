---
title: CLI commands
description: Every ghuri command, its arguments and options.
---

The `ghuri` binary comes from `@ghuri/cli`, which new projects list as a dev dependency. Run it
from anywhere inside the project with `npx ghuri` (or `npm run ghuri -- <command>`).

```sh
npx ghuri <command> [arguments] [options]
npx ghuri help              # list every command, grouped by where it comes from
npx ghuri help <command>    # arguments and options for one command
npx ghuri <command> --help  # the same
npx ghuri --version         # the CLI version
```

:::tip[If you know Django]
`npx ghuri <command>` is `python manage.py <command>`. Command names are the same where the
command exists in Django. Options are spelled with dashes (`--no-input`, `--dry-run`); Django's
`--noinput` is accepted as an alias of `--no-input`.
:::

## How the CLI finds and loads your project

1. It walks up from the current directory to the nearest `package.json` with a `ghuri` key or a
   `src/settings.ts`. The settings module is `package.json#ghuri.settings` (default
   `src/settings.ts`), or `--settings <path>`.
2. It loads TypeScript with [jiti](https://github.com/unjs/jiti), so there is no build step.
3. It builds `env`, from highest to lowest precedence:
   - Worker **bindings** (D1, R2, KV, Hyperdrive, …) from `wrangler.jsonc` / `wrangler.json` /
     `wrangler.toml` through Wrangler's `getPlatformProxy()`: **local** by default (Miniflare,
     state in `.wrangler/state`, shared with `wrangler dev`), **remote** with `--remote`;
   - `process.env`;
   - `.dev.vars` (or `.dev.vars.<env>` with `--env`), then `.env`, `.env.local`, `.env.<env>`;
   - wrangler `vars`.

   Without a wrangler config (or without wrangler installed) `env` is `process.env` plus the
   files above.
4. It runs `createApp(settings).setup(env)`, which populates `INSTALLED_APPS` and registers app
   commands, runs the command, then closes database connections and the bindings proxy.

Commands come from three places, and `ghuri help` groups them that way: the CLI itself
(`[ghuri]`), `@ghuri/orm` (`[orm]`), and the `commands` of each installed app (for example
`createsuperuser` from `@ghuri/auth`). An app command can override a built-in one (except
`help`). See [Management commands](/docs/topics/management-commands/) to write your own.

### Global options

Every command accepts these.

| Option | Meaning |
|---|---|
| `--settings <path>` | Settings module (default `package.json#ghuri.settings` or `src/settings.ts`). |
| `--env <name>` | Wrangler environment (`env.<name>` in the wrangler config) for bindings and vars. |
| `--remote` | Use remote D1, R2 and KV bindings instead of the local simulator. |
| `--persist-to <dir>` | Local binding state directory (default `.wrangler/state`). |
| `--traceback` | Print full stack traces on errors. |
| `--no-color` | Plain output (`NO_COLOR` is honoured too). |
| `-h`, `--help` | Show help for the command. |

`--remote` uses Wrangler 4's per-binding remote mode: the CLI writes a temporary copy of your
wrangler config with every D1, R2 and KV binding marked `"remote": true`, calls
`getPlatformProxy({ remoteBindings: true })`, and deletes the copy afterwards. You need
`wrangler login` and real resource ids (such as `database_id`) in the config.

:::note[Alpha]
Remote bindings go through Wrangler's proxy, which can be slow for large migrations or
fixtures. For big D1 schema changes, `sqlmigrate --all` plus `wrangler d1 migrations apply` is
the fallback.
:::

---

## Built-in commands

### `startproject`

```sh
npx ghuri startproject <name> [directory] [--db d1|postgres|sqlite] [--pm npm|pnpm|bun|yarn] [--no-install]
```

Creates a new project. It works outside a project; `npm create ghuri@latest` runs it for you.
It generates a random `SECRET_KEY` into `.dev.vars`.

| Argument / option | Default | Meaning |
|---|---|---|
| `name` | required | Project name; used for the directory, `package.json` and Worker name. |
| `directory` | `./<name>` | Where to create it (must be empty or missing). |
| `--db` | `d1` | `d1`: Cloudflare D1 + R2. `postgres`: Hyperdrive on Workers, `DATABASE_URL` elsewhere. `sqlite`: a Node project with better-sqlite3 and file storage, no wrangler. |
| `--pm` | the one running the command, else `npm` | Package manager for install and the printed next steps. |
| `--no-install` | | Do not install dependencies. |

### `startapp`

```sh
npx ghuri startapp <name> [directory] [--no-register]
```

Creates `src/<name>/` with `app.ts`, `models.ts`, `views.ts`, `urls.ts`, `serializers.ts`,
`admin.ts`, `tests.ts` and `migrations/index.ts`, and adds the generated `AppConfig`
(`<Name>Config`) to `INSTALLED_APPS` in your settings (an import plus a list entry) when the
settings file has the usual shape. It prints the `path(...)` line to add to `src/urls.ts`.

| Argument / option | Meaning |
|---|---|
| `name` | Lowercase identifier (`blog`, `blog_posts`). Names of Ghuri packages (`auth`, `admin`, …) are reserved. |
| `directory` | Destination (default `src/<name>`). |
| `--no-register` | Do not edit `INSTALLED_APPS`. |

### `runserver`

```sh
npx ghuri runserver [addrport] [-p <port>] [--host <host>] [--node] [--remote] [-- wrangler args]
```

Starts the development server. In a project with a wrangler config it runs `wrangler dev`
(port 8787); extra arguments are passed to Wrangler. With `--node`, or when there is no wrangler
config, it serves the app in-process with `@ghuri/core/node` (port 8000), still using local
Wrangler bindings when they exist.

| Argument / option | Default | Meaning |
|---|---|---|
| `addrport` | | A port (`8000`) or `ipaddr:port`. |
| `-p`, `--port` | `8787` (wrangler) / `8000` (Node) | Port to listen on. |
| `--host` | `localhost` | Interface to bind. |
| `--node` | off | Serve with Node instead of `wrangler dev`. |
| `--remote` | off | `wrangler dev --remote`; with `--node`, use remote D1, R2 and KV. |

### `shell`

```sh
npx ghuri shell [-c <code>]
```

A Node REPL with the project loaded: `apps`, `settings`, `env`, `core`, `orm`, `getModel()` and
every installed model by class name (`Post`, `User`, …). Top-level `await` works.
`-c`, `--command <code>` (or code piped on stdin) evaluates it, prints the result and exits:

```sh
npx ghuri shell -c "await Post.objects.count()"
```

### `check`

```sh
npx ghuri check [--deploy] [-t <tag>] [--fail-level <level>] [--list-tags]
```

Runs system checks (`runChecks()` from `@ghuri/core`: settings validation and anything
registered with `checks.register()`). The same checks run at startup when `DEBUG` is on.

| Option | Meaning |
|---|---|
| `--deploy` | Also run checks relevant to a production deployment. |
| `-t`, `--tag <tag>` | Only checks with this tag. Repeatable. |
| `--fail-level <level>` | `CRITICAL`, `ERROR` (default), `WARNING`, `INFO` or `DEBUG`: the level that makes the command exit non-zero. |
| `--list-tags` | List the available tags. |

### `test`

```sh
npx ghuri test [--watch] [vitest arguments]
```

Runs `vitest run` in the project (`--watch` for watch mode). Other arguments go to vitest, for
example `npx ghuri test src/blog`. See [Testing](/docs/topics/testing/).

### `deploy`

```sh
npx ghuri deploy [--migrate] [--skip-migrations] [--dry-run] [--no-input] [-- wrangler args]
```

Optionally applies migrations to the remote database (`ghuri migrate --remote`), then runs
`wrangler deploy`. Without `--migrate` or `--skip-migrations` it asks; with `--no-input` (or
without a terminal) it skips migrations and says so. Extra arguments go to Wrangler. See
[Deploying to Cloudflare Workers](/docs/deployment/cloudflare/).

| Option | Meaning |
|---|---|
| `--migrate` | Apply remote migrations first without asking. A failed migration aborts the deploy. |
| `--skip-migrations` | Do not apply migrations (and do not ask). |
| `--dry-run` | `wrangler deploy --dry-run`; skips migrations. |
| `--no-input` | Never prompt; migrations run only with `--migrate`. |

### `routes`

```sh
npx ghuri routes [--format table|json]
```

Lists URL patterns with their names, methods and views (django-extensions' `show_urls`;
`show_urls` is an alias).

### `diffsettings`

```sh
npx ghuri diffsettings [--all] [--show-secrets]
```

Shows settings that differ from Ghuri's defaults. `--all` lists every setting, marking
non-defaults with `###`. Secret-looking values are masked unless `--show-secrets` is given.

### `version` and `help`

```sh
npx ghuri version [--short]
npx ghuri help [command]
```

`version` prints the CLI version plus the project's `@ghuri/*`, `hono`, `wrangler` and Node
versions (`--short` prints only the CLI version).

---

## Database commands

These come from `@ghuri/orm/commands` and are available when the project has `@ghuri/orm`
installed. Every command that touches a database takes `--database <alias>` (a key of
`DATABASES`, default `default`), and `--remote` to use remote D1.

### `makemigrations`

```sh
npx ghuri makemigrations [app_label ...] [-n <name>] [--empty] [--dry-run] [--check] [--merge] [--no-input]
```

Compares your models with the state recorded in existing migrations, writes new migration
files to `src/<app>/migrations/`, and regenerates `migrations/index.ts`. It asks whether a
model or field was renamed, and for a one-off default when you add a `NOT NULL` field without a
default.

| Argument / option | Meaning |
|---|---|
| `app_label` | Limit to these apps. Default: all installed apps with a `path`. |
| `-n`, `--name` | Name for the migration file (`0003_<name>.ts`). |
| `--empty` | Create an empty migration to fill with `RunSQL` / `RunCode`. |
| `--dry-run` | Show what would be written without writing. |
| `--check` | Exit non-zero if model changes are missing migrations (for CI). |
| `--merge` | Create a merge migration when two branches added migrations to the same app. |
| `--no-input` | Do not prompt: renames are treated as remove + add, and a missing one-off default is an error. |

### `migrate`

```sh
npx ghuri migrate [app_label] [migration_name] [--fake] [--fake-initial] [--plan] [--run-syncdb] [--no-input] [--database <alias>]
```

Applies (or unapplies) migrations and records them in the `ghuri_migrations` table. Each
migration runs atomically with its record: in a transaction on SQLite and Postgres, as one
`batch()` on D1.

| Argument / option | Meaning |
|---|---|
| `app_label` | Only migrate this app. |
| `migration_name` | Migrate the app to this migration, unapplying later ones. `zero` unapplies all. |
| `--fake` | Mark migrations as applied (or unapplied) without running them. |
| `--fake-initial` | Fake initial migrations whose tables already exist. |
| `--plan` | Show the operations that would run, without running them. |
| `--run-syncdb` | Create tables for apps without migrations. |
| `--no-input` | Do not prompt. |
| `--database <alias>` | Database to migrate. |

### `showmigrations`

```sh
npx ghuri showmigrations [app_label ...] [-p] [--database <alias>]
```

Lists migrations per app with `[X]` for applied and `[ ]` for pending. `-p`, `--plan` shows all
migrations in the order they would be applied.

### `sqlmigrate`

```sh
npx ghuri sqlmigrate <app_label> <migration_name> [--backwards] [--dialect sqlite|postgresql] [--database <alias>]
npx ghuri sqlmigrate --all [--dialect sqlite] [--out migrations-sql]
```

Prints the SQL a migration would run. Without `--dialect` it uses the dialect of the selected
database.

| Option | Meaning |
|---|---|
| `--backwards` | The SQL to unapply the migration. |
| `--dialect` | `sqlite` (SQLite and D1) or `postgresql`. |
| `--all` | Every migration of every app, as numbered SQL files in dependency order (for `wrangler d1 migrations apply`). Each file also inserts its `ghuri_migrations` row, so `showmigrations` agrees with Wrangler. Re-running only adds files for new migrations. |
| `--out <dir>` | With `--all`: directory to write the `.sql` files to. |

### `dumpdata`

```sh
npx ghuri dumpdata [app_label[.Model] ...] [-e <label>] [--indent <n>] [-o <file>] [--database <alias>]
```

Writes rows as JSON fixtures to stdout (or `--output`). The format matches Django's:

```json
[{ "model": "blog.post", "pk": 1, "fields": { "title": "Hello", "author": 1, "tags": [2, 3] } }]
```

| Argument / option | Meaning |
|---|---|
| `app_label[.Model]` | Only these apps or models (`blog`, `blog.Post`). Default: everything. |
| `-e`, `--exclude` | Skip an app or model. Repeatable. |
| `--indent` | Pretty-print with this many spaces. |
| `-o`, `--output` | Write to a file instead of stdout. |
| `--format` | Only `json`. |
| `--database <alias>` | Read from this database. |

### `loaddata`

```sh
npx ghuri loaddata <fixture ...> [-e <label>] [--database <alias>]
```

Loads fixtures produced by `dumpdata`: file paths, names found in `<app>/fixtures/`, or `-` for
stdin. Objects are upserted by primary key in dependency order inside one transaction (one batch
on D1), many-to-many rows are replaced, and Postgres sequences are reset afterwards.

| Argument / option | Meaning |
|---|---|
| `fixture` | One or more fixtures. |
| `-e`, `--exclude` | Skip an app or model. Repeatable. |
| `--database <alias>` | Write to this database. |

### `copydata`

```sh
npx ghuri copydata --from <alias> --to <alias> [app_label ...] [-e <label>] [--flush] [--no-input]
```

Copies every row from one database alias to another in one process (a `dumpdata` plus
`loaddata` without the intermediate file). Migrate the destination first.

| Argument / option | Meaning |
|---|---|
| `--from` | Source alias (default `default`). |
| `--to` | Destination alias. |
| `app_label` | Only these apps or models. |
| `-e`, `--exclude` | Skip an app or model. Repeatable. |
| `--flush` | Delete every row of the destination first (asks for confirmation). |
| `--no-input` | Do not prompt. |

```ts title="src/settings.ts"
DATABASES: {
  default: d1('DB'),
  pg: postgres({ url: env.DATABASE_URL }),
},
```

```sh
npx ghuri migrate --database pg
npx ghuri copydata --from default --to pg
# or, with a file in between:
npx ghuri dumpdata --database default -o data.json && npx ghuri loaddata data.json --database pg
```

See [Migrating from D1 to Postgres](/docs/deployment/d1-to-postgres/).

### `flush`

```sh
npx ghuri flush [--no-input] [--database <alias>]
```

Deletes every row from every table, keeping the schema and the migration history. Asks for
confirmation unless `--no-input` is given.

:::caution[Not implemented]
`squashmigrations` and `inspectdb` do not exist yet. Migration files can declare `replaces`
(squashed migrations are loaded correctly), but there is no command to generate them.
:::

---

## Auth commands

These come from the apps in `@ghuri/auth` and are available when the app is installed.

### `createsuperuser` (`AuthConfig`)

```sh
npx ghuri createsuperuser [--username <name>] [--email <email>] [--password <pw>] [--no-input] [--database <alias>]
```

Creates a user with `isStaff` and `isSuperuser` set, prompting for the username, the email and
the password (twice). There is one option per `USERNAME_FIELD` and `REQUIRED_FIELDS` entry of
your user model. With `--no-input`, values come from the options or from
`GHURI_SUPERUSER_<FIELD>` environment variables, and the password from `--password` or
(preferably) `GHURI_SUPERUSER_PASSWORD`.

### `changepassword` (`AuthConfig`)

```sh
npx ghuri changepassword [username] [--password <pw>] [--database <alias>]
```

Sets a user's password, prompting twice. Defaults to the user named after your OS login
(`$USER`).

### `clearsessions` (`SessionsConfig`)

```sh
npx ghuri clearsessions
```

Deletes expired sessions from the database. Run it by hand or from a scheduled task.

### `drf_create_token` (`AuthTokenConfig`)

```sh
npx ghuri drf_create_token <username> [-r]
```

Creates (or prints) the API token for a user. `-r`, `--reset` replaces an existing token.

### `flushexpiredtokens` (`TokenBlacklistConfig`)

```sh
npx ghuri flushexpiredtokens
```

Deletes expired JWT refresh tokens from the outstanding-token list.

---

## Exit codes

`0` on success, `1` on a `CommandError` or failed check (or the `CommandError`'s own return
code), `2` on a usage error (unknown option, missing argument), and whatever number a command's
`handle()` returns otherwise.
