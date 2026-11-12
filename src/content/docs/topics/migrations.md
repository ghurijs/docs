---
title: Migrations
description: How Ghuri migrations work, the operations, data migrations, applying them to D1 and Postgres, and squashing the workflow into a deploy.
---

Migrations propagate changes you make to your models (adding a field, deleting a model, adding
an index) into your database schema. They are generated from your models, stored as TypeScript
files in each app, committed to version control, and applied in order. They are
**dialect-neutral**: the same files run on D1, SQLite and Postgres, which is what makes moving
between databases a settings change.

## The commands

| Command | Does |
|---|---|
| `ghuri makemigrations [app...]` | Compare models with the migration history and write new migration files. |
| `ghuri migrate [app] [name]` | Apply (or, with a target name, roll back to) migrations. |
| `ghuri showmigrations [app...]` | List migrations and whether each is applied (`[X]` / `[ ]`). |
| `ghuri sqlmigrate <app> <name>` | Print the SQL a migration would run. |

Their options:

| Command | Options |
|---|---|
| `makemigrations` | `--name <n>`, `--empty`, `--dry-run`, `--check` (exit non-zero if changes are missing migrations; writes nothing), `--merge`, `--no-input` |
| `migrate` | `--fake`, `--fake-initial`, `--plan`, `--run-syncdb`, `--no-input`, `--database <alias>` |
| `showmigrations` | `--plan`, `--database <alias>` |
| `sqlmigrate` | `--backwards`, `--dialect sqlite\|postgresql`, `--all [--out <dir>]`, `--database <alias>` |

`--database` picks a key of `DATABASES` (default `default`), with Django's semantics. Every
command also accepts the CLI's global `--remote` to work against your deployed Cloudflare
resources instead of the local simulation. See the [CLI reference](/docs/reference/cli/) for
details.

:::tip[If you know Django]
This is Django's migration system, re-implemented: the same autodetector approach, the same
operations, a dependency graph between apps, a table recording what ran (`ghuri_migrations`
instead of `django_migrations`), and data migrations with historical models.
`RunPython(forwards, backwards)` becomes `RunCode(forwards, backwards)` with async functions.
:::

## Migration files

```
src/blog/migrations/
├── 0001_initial.ts
├── 0002_post_summary.ts
└── index.ts            # generated: exports every migration in order
```

An app opts in to migrations with a `migrations` package (created by `ghuri startapp`) and a
`path`, which tells the CLI where to write files:

```ts title="src/blog/app.ts"
import { AppConfig } from '@ghuri/core'
import * as migrations from './migrations'
import * as models from './models'

export class BlogConfig extends AppConfig {
  name = 'blog'
  path = import.meta.dirname   // CLI only: where migrations/ lives
  models = models
  migrations = migrations      // the generated index: works on Workers (no file system)
}
```

A migration is a `Migration` with dependencies and a list of operations:

```ts title="src/blog/migrations/0002_post_summary.ts"
import { Migration, operations as ops } from '@ghuri/orm/migrations'

export default new Migration({
  dependencies: [['blog', '0001_initial'], ['auth', '0001_initial']],
  operations: [
    ops.AddField({
      modelName: 'Post',
      name: 'summary',
      field: { type: 'CharField', maxLength: 300, blank: true, default: '' },
    }),
    ops.AddField({
      modelName: 'Post',
      name: 'slug',
      field: { type: 'SlugField' },
      oneOffDefault: 'post',      // fills existing rows; not kept on the field
    }),
  ],
})
```

Fields are written as plain data (`{ type, ...options }`), produced by each field's
`deconstruct()`. Migrations therefore do not import your models: they describe the state of the
schema at that point in history, which is what lets old migrations keep working after the models
have moved on. Index and constraint names are always written out explicitly.

The `index.ts` file exists because Workers have no filesystem. `makemigrations` regenerates it
every time (it exports every migration plus an ordered `migrations` map), and
`AppConfig.migrations` imports it, so migrations are part of your bundle.

## What `makemigrations` detects

- Created, deleted and renamed models and fields; altered fields; many-to-many fields.
- `Meta.indexes`, `Meta.constraints`, `uniqueTogether`, `dbTable` and other Meta options.
- Dependencies between apps (`['auth', '0001_initial']`). Foreign-key cycles between apps are
  split into two migrations.

It is interactive by default. When a field or model disappears and a similar one appears, it
asks whether you renamed it, so you get `RenameField` / `RenameModel` instead of losing data.
When you add a `NOT NULL` field without a default (or make a field `NOT NULL`), it asks for a
one-off default to fill existing rows, stored as `oneOffDefault` on the operation. Callable
defaults (`default: () => ({})`) are evaluated once to fill existing rows, and
`autoNow`/`autoNowAdd` fields get the current time.

With `--no-input`, renames are treated as a removal plus an addition. A new `NOT NULL` field
without a default is an error; making an existing field `NOT NULL` only prints a warning,
and the migration will fail if NULL rows remain. Edit the generated file if you need a rename
in a non-interactive run, or call `makeMigrations({ questioner: new NonInteractiveQuestioner({ renames: true, defaults: { 'blog.Post.slug': 'post' } }) })`
from code.

Names follow Django: `0001_initial`, `0002_post_slug`, `0003_remove_post_body`, or
`auto_YYYYMMDD_HHMM` when no better name fits. `--name` overrides the part after the number.

:::note[Not yet supported]
`squashmigrations` and `inspectdb` do not exist yet. Swappable models (`AUTH_USER_MODEL`) are
written into dependencies as plain app labels rather than swappable-dependency markers, and the
autodetector does not handle changing a model's primary key or auto-field type. Write those
changes by hand (for example with `RunSQL`) if you need them.
:::

## Operations

| Operation | Purpose |
|---|---|
| `CreateModel`, `DeleteModel`, `RenameModel` | Tables |
| `AlterModelTable`, `AlterModelOptions` | Table name, Meta options (ordering, verbose names, permissions) |
| `AddField`, `RemoveField`, `AlterField`, `RenameField` | Columns |
| `AddIndex`, `RemoveIndex` | Indexes |
| `AddConstraint`, `RemoveConstraint`, `AlterUniqueTogether` | Constraints |
| `RunSQL({ sql?, sqlite?, postgresql?, reverse?, stateOperations? })` | Raw SQL, per dialect |
| `RunCode(forwards, backwards?)` | Data migrations in TypeScript |

`RunSQL` takes SQL for both dialects (`sql`) or per dialect; a dialect without SQL is skipped,
which keeps the migration portable. `reverse` makes it reversible (`ops.RunSQL.noop` for a
reversible no-op), and `stateOperations` tells the autodetector what schema change the SQL made:

```ts
ops.RunSQL({
  sqlite: "UPDATE blog_post SET slug = lower(title) WHERE slug = ''",
  postgresql: "UPDATE blog_post SET slug = lower(title) WHERE slug = ''",
  reverse: ops.RunSQL.noop,
})
```

## Data migrations

To change data rather than schema, create an empty migration and add a `RunCode` operation:

```sh
npx ghuri makemigrations blog --empty --name backfill_summaries
```

```ts title="src/blog/migrations/0003_backfill_summaries.ts"
import { Migration, operations as ops } from '@ghuri/orm/migrations'

export default new Migration({
  dependencies: [['blog', '0002_post_summary']],
  operations: [
    ops.RunCode(
      async (apps, conn, { using }) => {
        const Post = apps.getModel('blog', 'Post')    // or apps.getModel('blog.Post')
        for await (const post of Post.objects.using(using).filter({ summary: '' })) {
          post.summary = String(post.body).slice(0, 280)
          await post.save({ updateFields: ['summary'], using })
        }
      },
      ops.RunCode.noop, // reversible as a no-op
    ),
  ],
})
```

Always use `apps.getModel()` inside `RunCode`. It returns a **historical model** that matches the
schema at this point in the migration history, not your current class, which may have fields
the database does not have yet. Custom methods are not available on historical models.

The second argument is the `Connection`, for raw SQL inside the same migration
(`await conn.execute('UPDATE ...')`), and the third carries the database alias (`using`) being
migrated. Pass `using` on to queries so the migration works with `--database`.

## Dialects: D1, SQLite and Postgres

Operations are dialect-neutral; a schema editor per dialect turns them into SQL.

- **Postgres** uses plain `ALTER TABLE ... ALTER COLUMN TYPE / SET NOT NULL / SET DEFAULT`,
  named unique and check constraints, and `DEFERRABLE INITIALLY DEFERRED` foreign keys. Each
  migration runs in a transaction together with its `ghuri_migrations` record.
- **SQLite and D1** use `ALTER TABLE ... ADD / DROP / RENAME COLUMN` where SQLite allows it.
  Anything else (changing a column, unique / `NOT NULL` / foreign-key columns, check
  constraints) rebuilds the table like Django's SQLite backend, in a D1-safe way: D1 cannot
  disable foreign keys, so Ghuri sets `PRAGMA defer_foreign_keys = ON`, copies the rows through a
  temporary table, recreates the table and its indexes, and copies the rows back. Data is kept.

Check what will run before applying a migration to a big D1 table:

```sh
npx ghuri sqlmigrate blog 0004 --dialect sqlite
npx ghuri sqlmigrate blog 0004 --dialect postgresql --backwards
```

:::caution[D1 and transactions]
D1 has no interactive transactions. Ghuri sends each migration's statements, together with its
`ghuri_migrations` record, to D1 as a single batch, which D1 executes atomically, so a failing
migration does not leave half its statements applied. `RunCode` operations cannot be part of
that batch: the statements before a `RunCode` are sent as their own batch first, and the
callback's writes are applied as they happen. Keep data migrations idempotent so a retry is
safe. See [Transactions](/docs/topics/transactions/#d1).
:::

## Signals

`migrate` sends `preMigrate` before and `postMigrate` after applying migrations, once per
installed app, with the `AppConfig` as sender and `{ appConfig, using, plan }` as arguments.
`@ghuri/auth` uses `postMigrate` to create content types and permissions. `postMigrate` is
also sent after `flush` and by `setupTestDatabase()` in tests.

```ts
import { postMigrate } from '@ghuri/orm'

postMigrate.connect(async ({ appConfig, using }) => {
  if (appConfig.appLabel === 'blog') await ensureDefaultCategories(using)
})
```

## Applying migrations in production

On Cloudflare:

```sh
npx ghuri migrate --remote
```

If you would rather let Wrangler own migrations (for example in a CI pipeline that already runs
`wrangler d1 migrations apply`), export plain SQL files:

```sh
npx ghuri sqlmigrate --all --out migrations-sql
npx wrangler d1 migrations apply DB --remote
```

and point `migrations_dir` in `wrangler.jsonc` at that directory. `sqlmigrate --all` writes one
numbered file per migration in dependency order (`0001_blog_0001_initial.sql`, ...), using the
SQLite dialect unless you pass `--dialect`. Each file also inserts its own `ghuri_migrations`
row, so `ghuri showmigrations` agrees with what Wrangler applied. Re-running it only adds files
for new migrations; existing numbers never change. Still, pick one way of applying migrations
per database: Wrangler records applied files in its own table and does not read
`ghuri_migrations`.

On Node with Postgres, run `npx ghuri migrate` as a release step before starting the new
version. See [Node and Postgres](/docs/deployment/node-postgres/). With several databases
configured, migrate each one: `npx ghuri migrate --database pg`.

## Existing databases: `--fake` and `--fake-initial`

`migrate --fake` records migrations as applied without running them, for when the schema
already matches. `migrate --fake-initial` fakes only initial migrations whose tables already
exist, which is handy when adopting migrations on an existing database. `migrate --plan` shows
what would run without running it, and `--run-syncdb` creates tables for apps that have no
migrations.

## Rolling back

`migrate` with an app and a migration name migrates to that state, unapplying later migrations:

```sh
npx ghuri migrate blog 0002     # unapply 0003 and later
npx ghuri migrate blog zero     # unapply everything in blog
```

Operations generated by `makemigrations` are reversible. `RunSQL` needs a `reverse` and
`RunCode` needs a backwards function to be reversible; otherwise rolling back past them raises
`IrreversibleError`.

## Working in a team

- Commit migrations with the model changes that produced them.
- If two branches both add a migration to the same app, `migrate` and `makemigrations` report
  conflicting leaf nodes. Run `npx ghuri makemigrations --merge` to generate a merge migration
  that depends on both leaves, as in Django.
- Run `npx ghuri makemigrations --check` in CI to fail when someone changed models without
  generating a migration.
- Never edit a migration that has been applied somewhere you do not control. Write a new one.

## Programmatic API

`@ghuri/orm/migrations` is Workers-safe (no file system access), so you can migrate from code,
for example in a scheduled job or a test:

```ts
import { makeMigrations, migrate, showMigrations, sqlMigrate } from '@ghuri/orm/migrations'

await migrate({ using: 'default' })
await migrate({ appLabel: 'blog', target: 'zero' })
const statements = await sqlMigrate('blog', '0002', { dialect: 'postgresql' })   // string[]
const status = await showMigrations()   // [{ app, name, applied, dependencies }]
await makeMigrations({ dryRun: true })  // writing files needs @ghuri/orm/commands (Node)
```

The same entry point exports the building blocks: `Migration`, `operations`, `ProjectState` /
`StateApps`, `MigrationLoader`, `MigrationGraph`, `MigrationExecutor`, `MigrationRecorder`,
`MigrationAutodetector`, `MigrationWriter`, `sqlMigrateAll`, the schema editors, and the data
helpers `dumpData`, `loadData`, `flushDatabase` and `copyData`. `@ghuri/orm/commands` (Node
only) exports the command classes, `registerOrmCommands()`, which adds them to core's command
registry, and `setMigrationImporter()`, which replaces how migration files are imported from
disk.
