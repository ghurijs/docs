---
title: Making queries
description: The QuerySet API - filtering, lookups across relations, ordering, slicing, Q and F expressions, aggregation, updates, deletes and raw SQL.
---

Once you have models, Ghuri gives you a database API to create, read, update and delete objects.
It is Django's QuerySet API, made `async`. This page uses the blog models from the
[tutorial](/docs/tutorial/part-1-models/).

## QuerySets are lazy

A `QuerySet` describes a query. Building one does no I/O; the database is hit only when you
consume it:

```ts
const qs = Post.objects.filter({ published: true }).orderBy('-createdAt')   // no query yet

const posts = await qs                     // runs the query → Post[]
for await (const post of qs) { /* ... */ }  // runs the query, then iterates the results
const n = await qs.count()                 // SELECT COUNT(*)
```

For large tables, `qs.iterator(chunkSize = 2000)` fetches in pages of `chunkSize` rows (ordered
by primary key unless the QuerySet is already ordered) instead of loading everything at once:

```ts
for await (const post of Post.objects.filter({ published: true }).iterator(500)) { /* ... */ }
```

:::caution[Returning a QuerySet from an async function]
QuerySets are thenable, so `return qs` from an `async` function resolves it to an array. Return
it from a plain function, or wrap it in an object, when you want to keep the QuerySet.
:::

QuerySets are **immutable**. Each method returns a new QuerySet, so you can safely build a base
query and refine it:

```ts
const live = Post.objects.filter({ published: true })
const recent = live.filter({ createdAt__gte: lastWeek })
const byRifat = live.filter({ author__username: 'rifat' })
```

:::tip[If you know Django]
Everything is the same except the two TypeScript adaptations: keyword arguments become an object
(`filter(title__icontains='x')` → `filter({ title__icontains: 'x' })`), and evaluating a
QuerySet is `await qs` rather than iterating, slicing or calling `list()`. Methods are camelCase:
`order_by` → `orderBy`, `select_related` → `selectRelated`, `values_list` → `valuesList`,
`get_or_create` → `getOrCreate`.
:::

## Creating objects

```ts
const post = await Post.objects.create({ title: 'Hello', slug: 'hello', author: user })

const draft = new Post({ title: 'Draft', slug: 'draft', authorId: user.pk })
await draft.save()

const [tag, created] = await Tag.objects.getOrCreate({ name: 'typescript' })
const [post2, wasCreated] = await Post.objects.updateOrCreate(
  { slug: 'hello' },
  { defaults: { title: 'Hello again' } },   // also: createDefaults (used only when creating)
)

await Tag.objects.bulkCreate([new Tag({ name: 'a' }), new Tag({ name: 'b' })])
await Tag.objects.bulkCreate(tags, { batchSize: 500, ignoreConflicts: true })
await Post.objects.bulkUpdate(posts, ['title', 'status'])   // number of rows
```

`getOrCreate()` takes `{ defaults }` as its second argument and returns `[obj, created]`.
`bulkCreate()` uses multi-row `INSERT`s and sets primary keys on the instances (except with
`ignoreConflicts`); like `bulkUpdate()`, it does not call `save()` or send signals.

## Retrieving objects

```ts
await Post.objects.all()
await Post.objects.filter({ published: true })
await Post.objects.exclude({ title__startswith: 'Draft' })
await Post.objects.get({ slug: 'hello' })      // exactly one, or throws
await Post.objects.filter({ published: true }).first()   // Post | null (also last())
await Post.objects.latest('createdAt')                   // also earliest()
await Post.objects.filter({ slug: 'hello' }).exists()
```

`get()` throws `Post.DoesNotExist` when nothing matches and `Post.MultipleObjectsReturned` when
more than one does. Both also extend the generic `ObjectDoesNotExist` and
`MultipleObjectsReturned` from `@ghuri/core`, so you can catch them without knowing the model:

```ts
try {
  const post = await Post.objects.get({ slug })
} catch (e) {
  if (e instanceof Post.DoesNotExist) return c.notFound()
  throw e
}
```

In views, `getObjectOr404(Post, { slug })` does that for you, throwing `Http404` instead. It
accepts a model, a manager or a QuerySet; `getListOr404(source, filters)` does the same for a
list that must not be empty.

### Field lookups

A filter key is a field name, optionally followed by `__` and a lookup. Without a lookup,
`exact` is implied.

```ts
Post.objects.filter({ title__icontains: 'ghuri' })
Post.objects.filter({ createdAt__year: 2026, createdAt__month__gte: 6 })
Post.objects.filter({ id__in: [1, 2, 3] })
Post.objects.filter({ body__isnull: false })
Post.objects.filter({ views__range: [100, 1000] })
```

Several keys in one `filter()` are ANDed. The complete list (`exact`, `iexact`, `contains`,
`icontains`, `in`, `gt`, `gte`, `lt`, `lte`, `startswith`, `istartswith`, `endswith`,
`iendswith`, `range`, `isnull`, `regex`, `iregex`, and the transforms `date`, `year`, `month`,
`day`, `hour`, `minute`, `second`, `week_day`, `quarter`, `time`), with the SQL each produces on
SQLite and Postgres, is in the [lookup reference](/docs/reference/lookups/).

### Lookups that span relations

Follow relations with `__`, as far as you need, forwards and backwards:

```ts
// Posts by a user whose username is 'rifat' (forward FK)
Post.objects.filter({ author__username: 'rifat' })

// Posts tagged 'cloudflare' (M2M)
Post.objects.filter({ tags__name: 'cloudflare' })

// Users who have written a published post (reverse FK, via relatedName 'posts')
User.objects.filter({ posts__published: true })

// Posts with a comment by an author called 'sam'
Post.objects.filter({ comments__author__username: 'sam' })
```

When spanning a multi-valued relation, conditions inside one `filter()` call apply to the same
related object, while chained `filter()` calls may match different ones. This is the same subtle
rule as Django's. Unlike Django, multi-valued relations compile to `EXISTS (...)` subqueries,
so results are never duplicated and `distinct()` is rarely needed.

### Ordering and slicing

```ts
Post.objects.orderBy('-createdAt', 'title')
Post.objects.orderBy('author__username')
Post.objects.orderBy(F('rating').desc({ nullsLast: true }))
Post.objects.all().slice(0, 10)       // LIMIT 10 (also .limit(10))
Post.objects.all().slice(20, 30)      // OFFSET 20 LIMIT 10
```

Without `orderBy`, the model's `Meta.ordering` applies; `reverse()` flips the ordering. NULLs
sort first in ascending order on every backend (pass `nullsFirst`/`nullsLast` to change it).
`slice()` takes non-negative bounds; negative indexing is not supported (use `orderBy` the other
way).

### Values instead of instances

```ts
await Post.objects.values('id', 'title')                       // { id, title }[]
await Post.objects.values('author__username')                  // across relations
await Post.objects.valuesList('id', { flat: true })            // number[]
await Post.objects.inBulk([1, 2, 3])                           // Map<pk, Post>
await Post.objects.inBulk(['a', 'b'], { fieldName: 'slug' })   // Map<slug, Post>
```

`inBulk()` returns a `Map`, not a plain object. `only('id', 'title')` and `defer('body')` load
instances with fewer columns; deferred fields are `undefined` until
`refreshFromDb({ fields: ['body'] })`. `distinct()` takes no field names (`DISTINCT ON` is not
supported). `none()` returns an empty QuerySet without querying, and `using('replica')` runs
the query on another database alias.

## Complex lookups with `Q`

Use `Q` objects for `OR` and `NOT`:

```ts
import { Q } from '@ghuri/orm'

Post.objects.filter(
  Q({ title__icontains: 'edge' }).or(Q({ body__icontains: 'edge' })),
)

Post.objects.filter(
  Q({ published: true }).and(Q.not({ author__username: 'bot' })),
)
```

`Q.and()`, `Q.or()` and `Q.not()` combine any number of conditions; `q.not()` negates an
existing one. A `Q` and a plain object can be passed together:
`filter(Q(...).or(Q(...)), { published: true })`.

## Referring to fields with `F`

`F('field')` refers to a column's value inside the query, so the database does the work and
there is no race between reading and writing:

```ts
import { F } from '@ghuri/orm'

await Post.objects.filter({ slug }).update({ views: F('views').add(1) })
await Post.objects.filter({ updatedAt__gt: F('createdAt') })
await Post.objects.filter({ views__gt: F('likes').mul(2) })
```

`F` supports `add`, `sub`, `mul`, `div` and `mod`, and `asc()`/`desc()` for ordering.

## Aggregation and annotation

```ts
import { Count, Avg, Max, Sum } from '@ghuri/orm'

await Post.objects.aggregate({ total: Count('id'), avgViews: Avg('views') })
// { total: 42, avgViews: 118.5 }

const busy = await Post.objects
  .annotate({ numComments: Count('comments') })
  .filter({ numComments__gt: 2 })
  .orderBy('-numComments')

busy[0].numComments   // annotated values are available on instances
```

`values()` before `annotate()` groups by those fields, as in Django:

```ts
await Post.objects.values('author__username').annotate({ posts: Count('id') })
```

Aggregates take `{ distinct, filter }`. Aggregates over reverse or many-to-many relations in
`annotate()` compile to correlated subqueries, so combining several of them does not multiply
rows:

```ts
await Post.objects.annotate({
  approved: Count('comments', { filter: Q({ comments__approved: true }) }),
  tagCount: Count('tags', { distinct: true }),
})
```

### Database functions

`annotate()`, `filter()` values, `orderBy()` and `update()` also accept expressions:

| Expression | SQL |
|---|---|
| `Value(x)` | a bound literal |
| `Lower('title')`, `Upper('title')`, `Length('title')` | `LOWER(...)`, `UPPER(...)`, `LENGTH(...)` |
| `Coalesce('summary', 'title')` | `COALESCE(...)` |
| `Concat('firstName', Value(' '), 'lastName')` | `\|\|` concatenation; NULL parts count as `''` |
| `Now()` | the current timestamp |
| `new Func('ROUND', ['price'])` | any SQL function; string arguments are field references |
| `new RawSQL('LENGTH("title") > ?', [5])` | raw SQL with `?` parameters (not portable) |

```ts
import { Concat, Lower, Value } from '@ghuri/orm'

await User.objects.annotate({ fullName: Concat('firstName', Value(' '), 'lastName') })
await Tag.objects.orderBy(Lower('name'))
```

## Updating and deleting in bulk

```ts
const updated = await Post.objects.filter({ published: false }).update({ published: true })   // number
const [total, perModel] = await Post.objects.filter({ createdAt__lt: cutoff }).delete()
// total: 14, perModel: { 'blog.Post': 4, 'blog.Comment': 10 }
```

`update()` runs a single `UPDATE` and does not call `save()` or send `preSave`/`postSave`.
`delete()` collects related objects according to each foreign key's `onDelete` rule (cascades,
`SET_NULL`, `PROTECT`), sends delete signals and deletes everything in dependency order. See
[Relations](/docs/topics/relations/#on-delete).

## Performance

- **`selectRelated('author')`** joins forward foreign keys into the same query, so
  `await post.author` needs no extra round trip.
- **`prefetchRelated('tags', 'comments')`** fetches many-valued relations in one extra query per
  relation, instead of one per object.
- **`count()` and `exists()`** are cheaper than loading rows.
- **`new Prefetch('comments', { queryset: Comment.objects.filter({ approved: true }), toAttr: 'approvedComments' })`**
  customises a prefetch; with `toAttr` the results are stored as an array on that attribute.
- On D1, every query is a network round trip from the Worker to the database. Batching reads
  with `selectRelated`/`prefetchRelated` matters even more than on a local Postgres.
- **Count queries** in tests or while debugging: `const [result, queries] = await captureQueries(() => view())`
  returns every statement a block executed, and `onQuery((e) => console.log(e.sql, e.durationMs))`
  subscribes to all of them (it returns an unsubscribe function).

## Raw SQL

When you need SQL the ORM cannot express:

```ts
import { connections } from '@ghuri/orm'

const conn = await connections.get()      // 'default' alias
const { rows } = await conn.execute(
  'SELECT author_id, COUNT(*) AS n FROM blog_post WHERE created_at > ? GROUP BY author_id',
  [cutoff.toISOString()],
)
```

`conn.execute()` passes the SQL to the driver unchanged: use `?` placeholders on D1 and SQLite
and `$1`, `$2` on Postgres. For one statement that works on both, build it with the `sql` tag
from `@ghuri/orm/migrations` and render it for the connection's dialect:

```ts
import { sql } from '@ghuri/orm/migrations'

const q = sql`SELECT author_id, COUNT(*) AS n FROM blog_post WHERE created_at > ${cutoff} GROUP BY author_id`
const { sql: text, params } = q.render(conn.dialect)   // ? or $1, $2 as needed
const { rows } = await conn.execute(text, params)
```

Raw SQL is where portability ends, so check `conn.dialect` (`'sqlite'` or `'postgresql'`) if
you must support both, or use Drizzle through
[`getDrizzle()`](/docs/topics/models/#the-escape-hatch). `qs.toSQL()` shows the SQL a
QuerySet would run.
