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
for await (const post of qs) { /* ... */ }  // streams results
const n = await qs.count()                 // SELECT COUNT(*)
```

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
  { defaults: { title: 'Hello again' } },
)

await Tag.objects.bulkCreate([new Tag({ name: 'a' }), new Tag({ name: 'b' })])
```

## Retrieving objects

```ts
await Post.objects.all()
await Post.objects.filter({ published: true })
await Post.objects.exclude({ title__startswith: 'Draft' })
await Post.objects.get({ slug: 'hello' })      // exactly one, or throws
await Post.objects.filter({ published: true }).first()   // Post | null
await Post.objects.latest('createdAt')
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

In views, `getObjectOr404(Post.objects, { slug })` does that for you.

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
`iendswith`, `range`, `isnull`, `regex`, `date`, `year`, `month`, `day`), with the SQL each
produces on SQLite and Postgres, is in the [lookup reference](/docs/reference/lookups/).

### Lookups that span relations

Follow relations with `__`, as far as you need, forwards and backwards:

```ts
// Posts by a user whose username is 'rifat' (forward FK)
Post.objects.filter({ author__username: 'rifat' })

// Posts tagged 'cloudflare' (M2M)
Post.objects.filter({ tags__name: 'cloudflare' })

// Users who have written a published post (reverse FK, via relatedName 'posts')
User.objects.filter({ posts__published: true }).distinct()

// Posts with a comment by an author called 'sam'
Post.objects.filter({ comments__author__username: 'sam' })
```

When spanning a multi-valued relation, conditions inside one `filter()` call apply to the same
related object, while chained `filter()` calls may match different ones. This is the same subtle
rule as Django's.

### Ordering and slicing

```ts
Post.objects.orderBy('-createdAt', 'title')
Post.objects.orderBy('author__username')
Post.objects.all().slice(0, 10)       // LIMIT 10
Post.objects.all().slice(20, 30)      // OFFSET 20 LIMIT 10
```

Without `orderBy`, the model's `Meta.ordering` applies. `slice()` takes non-negative bounds;
negative indexing is not supported (use `orderBy` the other way).

### Values instead of instances

```ts
await Post.objects.values('id', 'title')                       // { id, title }[]
await Post.objects.values('author__username')                  // across relations
await Post.objects.valuesList('id', { flat: true })            // number[]
await Post.objects.inBulk([1, 2, 3])                           // Map<pk, Post>
```

`only('id', 'title')` and `defer('body')` load instances with fewer columns.

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

`Q.and()`, `Q.or()` and `Q.not()` combine any number of conditions. A `Q` and a plain object
can be passed together: `filter(Q(...).or(Q(...)), { published: true })`.

## Referring to fields with `F`

`F('field')` refers to a column's value inside the query, so the database does the work and
there is no race between reading and writing:

```ts
import { F } from '@ghuri/orm'

await Post.objects.filter({ slug }).update({ views: F('views').add(1) })
await Post.objects.filter({ updatedAt__gt: F('createdAt') })
```

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

## Updating and deleting in bulk

```ts
const updated = await Post.objects.filter({ published: false }).update({ published: true })   // number
const { count, perModel } = await Post.objects.filter({ createdAt__lt: cutoff }).delete()
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
- On D1, every query is a network round trip from the Worker to the database. Batching reads
  with `selectRelated`/`prefetchRelated` matters even more than on a local Postgres.

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

Use `?` placeholders; the adapter rewrites them to `$1`, `$2` for Postgres. Raw SQL is where
portability ends, so check `conn.dialect` (`'sqlite'` or `'postgresql'`) if you must support
both, or use Drizzle through [`getDrizzle()`](/docs/topics/models/#the-escape-hatch).
