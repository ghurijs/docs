---
title: Migrations
description: How Ghuri migrations work, the operations, data migrations, applying them to D1 and Postgres, and squashing the workflow into a deploy.
---

Migrations propagate changes you make to your models (adding a field, deleting a model, adding
an index) into your database schema. They are generated from your models, stored as TypeScript
files in each app, committed to version control, and applied in order.

## The commands

| Command | Does |
|---|---|
| `ghuri makemigrations [app...]` | Compare models with the migration history and write new migration files. |
| `ghuri migrate [app] [name]` | Apply (or, with a target name, roll back to) migrations. |
| `ghuri showmigrations [app]` | List migrations and whether each is applied. |
| `ghuri sqlmigrate <app> <name>` | Print the SQL a migration would run. |

All of them accept `--remote` to work against your deployed Cloudflare resources instead of the
local simulation. See the [CLI reference](/docs/reference/cli/) for every flag.

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
└── index.ts            # generated: imports every migration in order
```

A migration is a `Migration` with dependencies and a list of operations:

```ts title="src/blog/migrations/0002_post_summary.ts"
import { Migration, operations as ops } from '@ghuri/orm/migrations'

export default new Migration({
  dependencies: [['blog', '0001_initial']],
  operations: [
    ops.AddField({
      modelName: 'Post',
      name: 'summary',
      field: { type: 'CharField', maxLength: 300, blank: true, default: '' },
    }),
  ],
})
```

Fields are written as plain data (`{ type, ...options }`), produced by each field's
`deconstruct()`. Migrations therefore do not import your models: they describe the state of the
schema at that point in history, which is what lets old migrations keep working after the models
have moved on.

The `index.ts` file exists because Workers have no filesystem. `makemigrations` regenerates it
every time, and `AppConfig.migrations` imports it, so migrations are part of your bundle.

## Operations

| Operation | Purpose |
|---|---|
| `CreateModel`, `DeleteModel`, `RenameModel` | Tables |
| `AlterModelTable`, `AlterModelOptions` | Table name, Meta options (ordering, verbose names, permissions) |
| `AddField`, `RemoveField`, `AlterField`, `RenameField` | Columns |
| `AddIndex`, `RemoveIndex` | Indexes |
| `AddConstraint`, `RemoveConstraint`, `AlterUniqueTogether` | Constraints |
| `RunSQL({ sqlite?, postgresql?, reverse? })` | Raw SQL, per dialect |
| `RunCode(forwards, backwards?)` | Data migrations in TypeScript |

When `makemigrations` sees a field disappear and a similar one appear, it asks whether you
renamed it, so you get `RenameField` instead of losing data. In non-interactive runs, pass the
answer with flags or edit the generated file.

## Data migrations

To change data rather than schema, create an empty migration and add a `RunCode` operation
(`--empty` is planned for 0.1; until it lands, copy the latest migration file, clear its
operations and add yours):

```sh
npx ghuri makemigrations blog --empty --name backfill_summaries
```

```ts title="src/blog/migrations/0003_backfill_summaries.ts"
import { Migration, operations as ops } from '@ghuri/orm/migrations'

export default new Migration({
  dependencies: [['blog', '0002_post_summary']],
  operations: [
    ops.RunCode(
      async (apps) => {
        const Post = apps.getModel('blog.Post')
        for await (const post of Post.objects.filter({ summary: '' })) {
          post.summary = String(post.body).slice(0, 280)
          await post.save({ updateFields: ['summary'] })
        }
      },
      async () => {}, // reversible as a no-op
    ),
  ],
})
```

Always use `apps.getModel()` inside `RunCode`. It returns a **historical model** that matches the
schema at this point in the migration history, not your current class, which may have fields
the database does not have yet. Custom methods are not available on historical models.

The second argument is a `Connection`, for raw SQL inside the same migration:
`async (apps, conn) => { await conn.execute('UPDATE ...') }`.

## Dialects: D1, SQLite and Postgres

Operations are dialect-neutral; a schema editor per dialect turns them into SQL.

- **Postgres** supports nearly every `ALTER TABLE` natively, and each migration runs in a
  transaction.
- **SQLite and D1** have limited `ALTER TABLE`. For changes SQLite cannot make in place (changing
  a column type, dropping a constraint), Ghuri rebuilds the table: create a new table, copy the
  rows, drop the old one, rename. This is the same strategy as Django's SQLite backend.

Check what will run before applying a migration to a big D1 table:

```sh
npx ghuri sqlmigrate blog 0004 --dialect sqlite
```

:::caution[D1 and transactions]
D1 has no interactive transactions. Ghuri sends each migration's statements to D1 as a single
batch, which D1 executes atomically, so a failing migration does not leave half its statements
applied. `RunCode` operations cannot be part of that batch: their writes are applied as they
happen. Keep data migrations idempotent so a retry is safe. See
[Transactions](/docs/topics/transactions/).
:::

## Applying migrations in production

On Cloudflare:

```sh
npx ghuri migrate --remote
```

If you would rather let Wrangler own migrations (for example in a CI pipeline that already runs
`wrangler d1 migrations apply`), export plain SQL files:

```sh
npx ghuri sqlmigrate --all --dialect sqlite --out migrations-sql/
```

and point `migrations_dir` in `wrangler.jsonc` at that directory. Do not mix both approaches on
the same database: Wrangler records applied files in its own table and does not know about
`ghuri_migrations`.

On Node with Postgres, run `npx ghuri migrate` as a release step before starting the new
version. See [Node and Postgres](/docs/deployment/node-postgres/).

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
- If two branches both add a migration to the same app, `migrate` reports conflicting leaf nodes.
  Resolve it with a merge migration that depends on both leaves, as in Django
  (`makemigrations --merge` is planned to generate it for you).
- Never edit a migration that has been applied somewhere you do not control. Write a new one.
