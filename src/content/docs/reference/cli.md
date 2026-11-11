---
title: CLI commands
description: Every built-in ghuri command, its arguments and options.
---

The `ghuri` binary comes from `@ghuri/cli`. Run it from the project root with `npx ghuri`
(or through an npm script).

```sh
npx ghuri <command> [arguments] [options]
npx ghuri help              # list every command, including ones from your apps
npx ghuri help <command>    # arguments and options for one command
```

Options marked *Planned* follow Django and are on the 0.1 roadmap but may not be in the
current alpha yet.

:::tip[If you know Django]
`npx ghuri <command>` is `python manage.py <command>`. Command names are the same where the
command exists in Django. Options are spelled with dashes (`--no-input`, `--dry-run`).
:::

## How the CLI finds and loads your project

1. It reads `package.json#ghuri.settings` (default `src/settings.ts`) and loads the file with
   [jiti](https://github.com/unjs/jiti), so TypeScript works without a build step.
2. It builds `env`:
   - from the bindings in `wrangler.jsonc` through Wrangler's `getPlatformProxy()`, using the
     **local** simulated D1, R2 and KV by default, or the **remote** resources with `--remote`;
   - merged with `.dev.vars` and `process.env` (`process.env` wins).
3. It calls `app.setup(env)`, which resolves settings and populates `INSTALLED_APPS`, then runs
   the command.

Commands come from three places: the CLI itself, `@ghuri/orm`, and the `commands` of each
installed app (which is how `createsuperuser` arrives from `@ghuri/auth`). See
[Management commands](/docs/topics/management-commands/) to write your own.

### Global options

| Option | Meaning |
|---|---|
| `--remote` | Use remote Cloudflare bindings (remote D1, R2, KV) instead of the local simulator. |
| `-h`, `--help` | Show help for the command. |

:::note[Alpha]
`--remote` goes through Wrangler's remote bindings proxy. Which commands support it, and how,
may still change in 0.1 alphas.
:::

---

## Project commands

### `startproject`

```sh
npx ghuri startproject <name> [directory] [--db d1|postgres|sqlite]
```

Creates a new project. `npm create ghuri@latest` runs this for you.

| Argument / option | Default | Meaning |
|---|---|---|
| `name` | required | Project name; used for the directory, `package.json` and Worker name. |
| `directory` | `./<name>` | Where to create it. |
| `--db` | `d1` | Database the generated settings and `wrangler.jsonc` use: `d1`, `postgres` or `sqlite`. |

### `startapp`

```sh
npx ghuri startapp <name>
```

Creates `src/<name>/` with `app.ts`, `models.ts`, `views.ts`, `urls.ts`, `serializers.ts`,
`admin.ts`, `tests.ts` and `migrations/index.ts`. Add the generated `AppConfig` to
`INSTALLED_APPS` yourself.

### `runserver`

```sh
npx ghuri runserver [--port 8787] [--node]
```

Starts the development server. By default it wraps `wrangler dev` (port 8787). With `--node`
it runs `src/server.ts` on Node instead (port 8000), which is what you want when developing
against Postgres or SQLite without Workers.

| Option | Default | Meaning |
|---|---|---|
| `--port` | `8787` (Workers) / `8000` (Node) | Port to listen on. |
| `--node` | off | Use the Node entry instead of `wrangler dev`. |
| `--remote` | off | `wrangler dev --remote`: run against remote resources. |

### `shell`

```sh
npx ghuri shell [--remote]
```

An interactive REPL with top-level `await` and every installed model preloaded by class name
(`Post`, `User`, …).

### `check`

```sh
npx ghuri check
```

Runs system checks (settings validation and anything registered with `checks.register()`).
Exits non-zero if any error is found. The same checks run at startup when `DEBUG` is on.

### `test`

```sh
npx ghuri test [pattern] [-- vitest options]
```

Runs your tests with vitest. Arguments after `--` go to vitest. See
[Testing](/docs/topics/testing/).

### `deploy`

```sh
npx ghuri deploy [-- wrangler options]
```

Runs `wrangler deploy`. See [Deploying to Cloudflare Workers](/docs/deployment/cloudflare/).

### `version` and `help`

```sh
npx ghuri version
npx ghuri help [command]
```

---

## Database commands

These come from `@ghuri/orm`.

### `makemigrations`

```sh
npx ghuri makemigrations [app_label ...] [--name <name>] [--no-input]
```

Compares your models with the state recorded in existing migrations and writes new migration
files to `src/<app>/migrations/`, then regenerates `migrations/index.ts`. When a field or model
looks renamed, it asks whether it was a rename.

| Argument / option | Meaning |
|---|---|
| `app_label` | Limit to these apps. Default: all installed apps with a `path`. |
| `--name` | Name suffix for the file (`0003_<name>.ts`). |
| `--empty` | Create an empty migration to fill with `RunSQL` / `RunCode`. Requires an app label. *Planned.* |
| `--dry-run` | Print what would be written without writing. *Planned.* |
| `--merge` | Create a merge migration when two branches added migrations to the same app. *Planned.* |
| `--no-input` | Do not prompt; rename questions are answered "no". |

### `migrate`

```sh
npx ghuri migrate [app_label] [migration_name] [--remote]
```

Applies (or unapplies) migrations and records them in the `ghuri_migrations` table.

| Argument / option | Meaning |
|---|---|
| `app_label` | Only migrate this app. |
| `migration_name` | Migrate the app to this migration, unapplying later ones. Use `zero` to unapply all. |
| `--remote` | Apply to the remote D1 database. |
| `--fake` | Mark as applied without running SQL. *Planned.* |
| `--database <alias>` | Database alias from `DATABASES`. Default: `default`. |

### `showmigrations`

```sh
npx ghuri showmigrations [app_label ...] [--remote]
```

Lists migrations per app with `[X]` for applied and `[ ]` for pending.

### `sqlmigrate`

```sh
npx ghuri sqlmigrate <app_label> <migration_name> [--dialect sqlite|postgresql]
npx ghuri sqlmigrate --all --dialect sqlite --out migrations-sql/
```

Prints the SQL a migration would run. Without `--dialect` it uses the dialect of the default
database.

| Option | Meaning |
|---|---|
| `--dialect` | `sqlite` or `postgresql`. |
| `--all` | Every migration of every app, in dependency order. |
| `--out <dir>` | With `--all`: write numbered `.sql` files compatible with `wrangler d1 migrations apply`. |

### `dumpdata`

```sh
npx ghuri dumpdata [app_label[.Model] ...] [--exclude <label>] [--indent <n>] [--output <file>] [--remote]
```

Writes rows as JSON fixtures to stdout (or `--output`). The format matches Django's:

```json
[{ "model": "blog.post", "pk": 1, "fields": { "title": "Hello", "author": 1, "tags": [2, 3] } }]
```

| Argument / option | Meaning |
|---|---|
| `app_label[.Model]` | Only these apps or models (`blog`, `blog.Post`). Default: everything. |
| `--exclude` | Skip an app or model. Repeatable. |
| `--indent` | Pretty-print with this many spaces. |
| `--output`, `-o` | Write to a file instead of stdout. |
| `--remote` | Read from remote D1. |
| `--database <alias>` | Read from this alias. **Alpha**: see below. |

### `loaddata`

```sh
npx ghuri loaddata <fixture ...> [--remote]
```

Loads fixture files produced by `dumpdata`. Objects are inserted in dependency order with their
original primary keys, many-to-many rows last, and Postgres sequences are reset afterwards.
Rows with an existing primary key are updated.

| Argument / option | Meaning |
|---|---|
| `fixture` | Path to a JSON fixture. Repeatable. |
| `--remote` | Write to remote D1. |
| `--database <alias>` | Write to this alias. **Alpha**: see below. |

:::note[Alpha]
`--database <alias>` on `dumpdata` and `loaddata` would let you copy between two configured
databases in one project. It is not final in 0.1. The supported way to copy between databases
is switching `DATABASE_URL` between the two commands; see
[Migrating from D1 to Postgres](/docs/deployment/d1-to-postgres/).
:::

### `flush`

```sh
npx ghuri flush [--no-input] [--remote]
```

Deletes every row from every table, keeping the schema and the migration history. Asks for
confirmation unless `--no-input` is given.

---

## Auth commands

These come from `@ghuri/auth` and are available when `AuthConfig` is installed.

### `createsuperuser`

```sh
npx ghuri createsuperuser [--username <name>] [--email <email>] [--no-input] [--remote]
```

Creates a user with `isStaff` and `isSuperuser` set. Prompts for the username, email and
password. With `--no-input`, the password is read from the `GHURI_SUPERUSER_PASSWORD`
environment variable (and the username and email from the options), which is useful in CI.

### `changepassword`

```sh
npx ghuri changepassword [username] [--remote]
```

Sets a user's password, prompting twice. Defaults to the user named after your OS login.

---

## Exit codes

`0` on success, `1` on a `CommandError` or failed check, and whatever number a command's
`handle()` returns otherwise.
