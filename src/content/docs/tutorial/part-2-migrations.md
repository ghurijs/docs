---
title: 'Part 2: Migrations and the QuerySet API'
description: Create migrations from your models, apply them to D1, and explore the ORM in the shell.
---

In [Part 1](/docs/tutorial/part-1-models/) you defined `Tag`, `Post` and `Comment`. Now you will
turn them into tables and start querying them.

## Make migrations

```sh
npx ghuri makemigrations
```

```
Migrations for 'blog':
  src/blog/migrations/0001_initial.ts
    + Create model Tag
    + Create model Post
    + Create model Comment
```

`makemigrations` loads your project, replays every existing migration to build the *project
state*, compares that state with your current models, and writes the difference as a new
migration file. It also regenerates `src/blog/migrations/index.ts`, which imports every
migration so the bundle contains them.

Open the generated file:

```ts title="src/blog/migrations/0001_initial.ts"
import { Migration, operations as ops } from '@ghuri/orm/migrations'

export default new Migration({
  dependencies: [['auth', '0001_initial']],
  operations: [
    ops.CreateModel({
      name: 'Tag',
      fields: {
        id: { type: 'BigAutoField', primaryKey: true },
        name: { type: 'CharField', maxLength: 50, unique: true },
      },
    }),
    ops.CreateModel({
      name: 'Post',
      fields: {
        id: { type: 'BigAutoField', primaryKey: true },
        title: { type: 'CharField', maxLength: 200 },
        slug: { type: 'SlugField', maxLength: 50, unique: true },
        body: { type: 'TextField', blank: true },
        published: { type: 'BooleanField', default: false },
        author: { type: 'ForeignKey', to: 'auth.User', onDelete: 'CASCADE', relatedName: 'posts' },
        tags: { type: 'ManyToManyField', to: 'blog.Tag', blank: true, relatedName: 'posts' },
        createdAt: { type: 'DateTimeField', autoNowAdd: true },
        updatedAt: { type: 'DateTimeField', autoNow: true },
      },
      options: { ordering: ['-createdAt'] },
    }),
    // ...Comment
  ],
})
```

Migrations describe changes in terms of models and fields, not SQL. That is what makes them
portable: the same file produces SQLite DDL for D1 today and Postgres DDL after you move.
Commit migration files to git along with the models they describe.

To see the SQL a migration will run, use `sqlmigrate`:

```sh
npx ghuri sqlmigrate blog 0001
npx ghuri sqlmigrate blog 0001 --dialect postgresql
```

## Apply migrations

```sh
npx ghuri migrate
```

```
Operations to perform:
  Apply all migrations: admin, auth, blog
Running migrations:
  Applying auth.0001_initial... OK
  Applying admin.0001_initial... OK
  Applying blog.0001_initial... OK
```

`migrate` applies every migration that has not been applied yet and records it in the
`ghuri_migrations` table. By default the CLI talks to the **local** D1 database that
`wrangler dev` uses (a SQLite file under `.wrangler/state/`). When you deploy in
[Part 5](/docs/tutorial/part-5-deploy/) you will run the same command with `--remote`.

`showmigrations` lists what is applied:

```sh
npx ghuri showmigrations blog
```

```
blog
 [X] 0001_initial
```

:::tip[If you know Django]
The three-step workflow is identical: change `models.ts`, run `makemigrations`, run `migrate`.
Migration files have the same operations (`CreateModel`, `AddField`, `AlterField`,
`RunSQL`, ...), the same dependency graph and the same `showmigrations` / `sqlmigrate`
commands. Data migrations use `ops.RunCode(async (apps, conn) => {...})` instead of
`RunPython`.
:::

## Play with the API

`ghuri shell` opens a Node REPL with your settings loaded, apps populated and every model in
scope. Top-level `await` works.

```sh
npx ghuri shell
```

First create a user to be the author. The shell exposes `User` from `@ghuri/auth`:

```ts
> const rifat = await User.objects.createUser({ username: 'rifat', password: 'correct horse' })
> rifat.pk
1
```

Create some posts. `create()` builds an instance, saves it, and returns it:

```ts
> const hello = await Post.objects.create({ title: 'Hello, Ghuri', slug: 'hello-ghuri', author: rifat })
> hello.id
1
> hello.createdAt
2026-11-12T08:14:03.201Z
> hello.published
false
```

You can also build an instance and save it yourself:

```ts
> const draft = new Post({ title: 'Edge databases', slug: 'edge-databases', authorId: rifat.pk })
> await draft.save()
> draft.body = 'D1 is SQLite, replicated.'
> await draft.save({ updateFields: ['body'] })
```

Query them back. A QuerySet is lazy and chainable; `await` runs it and gives you an array:

```ts
> await Post.objects.all()
[ Post { title: 'Edge databases' }, Post { title: 'Hello, Ghuri' } ]
> await Post.objects.filter({ title__startswith: 'Hello' })
[ Post { title: 'Hello, Ghuri' } ]
> await Post.objects.filter({ author__username: 'rifat' }).count()
2
> await Post.objects.get({ slug: 'nope' })
Uncaught Post.DoesNotExist: Post matching query does not exist.
```

Notice `author__username`: the double underscore follows the `author` foreign key to `User` and
filters on its `username`, exactly like Django. Lookups such as `__startswith`, `__icontains`,
`__gte` and `__in` are listed in the [lookup reference](/docs/reference/lookups/).

Work with relations:

```ts
> const ts = await Tag.objects.create({ name: 'typescript' })
> const cf = await Tag.objects.create({ name: 'cloudflare' })
> await hello.tags.add(ts, cf)
> await hello.tags.all()
[ Tag { name: 'typescript' }, Tag { name: 'cloudflare' } ]
> await cf.posts.all()                 // reverse side, from relatedName: 'posts'
[ Post { title: 'Hello, Ghuri' } ]
> await rifat.posts.filter({ published: false }).count()
2
> await Comment.objects.create({ post: hello, author: rifat, body: 'First!' })
> await hello.comments.count()
1
```

Update and delete in bulk, straight from a QuerySet:

```ts
> await Post.objects.filter({ slug: 'hello-ghuri' }).update({ published: true })
1
> await Tag.objects.filter({ name: 'cloudflare' }).delete()
{ count: 2, perModel: { 'blog.Tag': 1, 'blog.Post_tags': 1 } }
```

Aggregation and annotation look like Django's too:

```ts
> import { Count } from '@ghuri/orm'
> await Post.objects.annotate({ numComments: Count('comments') }).values('title', 'numComments')
[ { title: 'Edge databases', numComments: 0 }, { title: 'Hello, Ghuri', numComments: 1 } ]
```

:::tip[If you know Django]
The two systematic differences from Django's ORM:

1. **Everything that touches the database is awaited.** `await qs`, `await qs.count()`,
   `await post.author`, `for await (const p of qs)`. Building a QuerySet (`filter`, `exclude`,
   `orderBy`) is synchronous and does no I/O.
2. **Keyword arguments become objects.** `filter(title__icontains='x')` is
   `filter({ title__icontains: 'x' })`. `order_by` is `orderBy`, `select_related` is
   `selectRelated`, and `qs[:10]` is `qs.slice(0, 10)`.
:::

## Check the views

Publish a post in the shell, then exit with `.exit` and reload `http://localhost:8787/blog/`.
The index view from Part 1 now returns the published post, and `/blog/hello-ghuri/` returns its
detail. An unknown slug returns a 404.

## Changing a model

Suppose you want a short summary on each post. Add a field:

```ts title="src/blog/models.ts" ins={4}
export class Post extends Model({
  title: new CharField({ maxLength: 200 }),
  slug: new SlugField({ unique: true }),
  summary: new CharField({ maxLength: 300, blank: true, default: '' }),
  // ...
```

and run the workflow again:

```sh
npx ghuri makemigrations
npx ghuri migrate
```

`makemigrations` writes `0002_post_summary.ts` containing a single `ops.AddField`. On SQLite
and D1, operations that SQLite cannot do with `ALTER TABLE` (changing a column type, for
example) are applied by rebuilding the table, the same strategy Django uses. You do not have to
think about it, but it is why large tables on D1 deserve a look at `sqlmigrate` output before
you run a migration in production. More in [Migrations](/docs/topics/migrations/).

Next, give yourself a way to edit posts without the shell:
[Part 3: The admin](/docs/tutorial/part-3-admin/).
