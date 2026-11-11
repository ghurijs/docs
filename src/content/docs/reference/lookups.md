---
title: Lookup reference
description: Every field lookup with the SQL it produces on SQLite/D1 and Postgres, plus relation spanning, Q, F and aggregates.
---

Lookups are written as `field__lookup` keys in `filter()`, `exclude()` and `get()`. A key with
no lookup means `exact`. See [Making queries](/docs/topics/queries/) for the QuerySet API.

```ts
await Post.objects.filter({
  title__icontains: 'workers',
  createdAt__year: 2026,
  author__username__in: ['rifat', 'ana'],
})
```

:::tip[If you know Django]
The lookup names and the double-underscore syntax are Django's. Values go in an object instead
of keyword arguments, so `filter(title__icontains='x')` becomes
`filter({ title__icontains: 'x' })`.
:::

## Field lookups

`?` is a bound parameter. `col` is the column. The SQL shown is representative; the compiler
escapes `%`, `_` and `\` in pattern lookups so user input is always matched literally.

| Lookup | Example | SQLite / D1 | Postgres |
|---|---|---|---|
| `exact` | `{ slug: 'hello' }` | `col = ?` | `col = ?` |
| `exact` with `null` | `{ publishedAt: null }` | `col IS NULL` | `col IS NULL` |
| `iexact` | `{ username__iexact: 'Rifat' }` | `col LIKE ? ESCAPE '\'` | `UPPER(col) = UPPER(?)` |
| `contains` | `{ title__contains: 'Hono' }` | `col LIKE '%' \|\| ? \|\| '%' ESCAPE '\'` | `col LIKE '%' \|\| ? \|\| '%'` |
| `icontains` | `{ title__icontains: 'hono' }` | `col LIKE '%' \|\| ? \|\| '%' ESCAPE '\'` | `UPPER(col) LIKE '%' \|\| UPPER(?) \|\| '%'` |
| `startswith` | `{ title__startswith: 'How' }` | `col LIKE ? \|\| '%' ESCAPE '\'` | `col LIKE ? \|\| '%'` |
| `istartswith` | `{ title__istartswith: 'how' }` | `col LIKE ? \|\| '%' ESCAPE '\'` | `UPPER(col) LIKE UPPER(?) \|\| '%'` |
| `endswith` | `{ email__endswith: '@example.com' }` | `col LIKE '%' \|\| ? ESCAPE '\'` | `col LIKE '%' \|\| ?` |
| `iendswith` | `{ email__iendswith: '@EXAMPLE.com' }` | `col LIKE '%' \|\| ? ESCAPE '\'` | `UPPER(col) LIKE '%' \|\| UPPER(?)` |
| `in` | `{ id__in: [1, 2, 3] }` | `col IN (?, ?, ?)` | `col IN (?, ?, ?)` |
| `gt` | `{ views__gt: 100 }` | `col > ?` | `col > ?` |
| `gte` | `{ views__gte: 100 }` | `col >= ?` | `col >= ?` |
| `lt` | `{ createdAt__lt: cutoff }` | `col < ?` | `col < ?` |
| `lte` | `{ createdAt__lte: cutoff }` | `col <= ?` | `col <= ?` |
| `range` | `{ createdAt__range: [start, end] }` | `col BETWEEN ? AND ?` | `col BETWEEN ? AND ?` |
| `isnull` | `{ publishedAt__isnull: true }` | `col IS NULL` / `IS NOT NULL` | `col IS NULL` / `IS NOT NULL` |
| `regex` | `{ slug__regex: '^v[0-9]+' }` | `col REGEXP ?` (best effort) | `col ~ ?` |
| `iregex` | `{ slug__iregex: '^V[0-9]+' }` | `col REGEXP '(?i)' \|\| ?` (best effort) | `col ~* ?` |
| `date` | `{ createdAt__date: '2026-11-12' }` | `date(col) = ?` | `(col AT TIME ZONE 'UTC')::date = ?` |
| `year` | `{ createdAt__year: 2026 }` | `col >= ? AND col < ?` (year bounds) | `col >= ? AND col < ?` (year bounds) |
| `month` | `{ createdAt__month: 11 }` | `CAST(strftime('%m', col) AS integer) = ?` | `EXTRACT(MONTH FROM col AT TIME ZONE 'UTC') = ?` |
| `day` | `{ createdAt__day: 12 }` | `CAST(strftime('%d', col) AS integer) = ?` | `EXTRACT(DAY FROM col AT TIME ZONE 'UTC') = ?` |

Notes:

- **Case sensitivity on SQLite.** SQLite's `LIKE` is case-insensitive for ASCII letters, so
  `contains`, `startswith` and `endswith` behave like their `i` versions on D1 and SQLite (the
  same limitation Django documents). They are case-sensitive on Postgres. If you need
  case-sensitive matching on both, use `regex` or compare in code.
- **`in` with an empty array** matches nothing and does not hit the database.
- **`in` with a QuerySet** compiles to a subquery:
  `filter({ author__in: User.objects.filter({ isStaff: true }) })`.
- **`year` uses a range** rather than a function call so an index on the column can be used.
- **`range` is inclusive** on both ends, like SQL `BETWEEN`. For datetimes, `range: [start, end]`
  with `end` at midnight excludes the rest of that day.

:::caution[`regex` on D1 and SQLite]
SQLite has no built-in `REGEXP` function. On Node with `@ghuri/orm/sqlite`, Ghuri registers one
backed by JavaScript `RegExp`. **D1 does not allow custom functions**, so `regex` and `iregex`
are not available on D1; the query raises `NotSupportedError`. Use `contains`/`startswith`, or
filter in code. On Postgres, patterns use POSIX syntax, which differs from JavaScript regular
expressions in some details.
:::

## Spanning relations

Follow foreign keys, reverse foreign keys and many-to-many relations with `__`, then apply a
lookup on the final field:

```ts
// forward FK: posts whose author's username is 'rifat'
Post.objects.filter({ author__username: 'rifat' })

// reverse FK (uses relatedQueryName, or relatedName, or the model name): users with a published post
User.objects.filter({ posts__published: true }).distinct()

// many-to-many: posts tagged 'workers'
Post.objects.filter({ tags__name: 'workers' })

// several hops
Comment.objects.filter({ post__author__email__iendswith: '@example.com' })
```

Spanning a multi-valued relation (reverse FK or M2M) joins one row per related object, so a
post with two matching tags appears twice. Add `.distinct()` when that matters.

As in Django, conditions in **one** `filter()` call apply to the **same** related object, while
chained `filter()` calls can match different related objects:

```ts
// posts with a single tag that is both named 'workers' and featured
Post.objects.filter({ tags__name: 'workers', tags__featured: true })

// posts with some tag named 'workers' and some (possibly other) featured tag
Post.objects.filter({ tags__name: 'workers' }).filter({ tags__featured: true })
```

Filtering on the relation itself compares primary keys. Both forms work:

```ts
Post.objects.filter({ author: user })      // a model instance
Post.objects.filter({ author: 1 })         // a primary key
Post.objects.filter({ authorId: 1 })       // the attname, no join
```

## `Q` objects

Combine conditions with `or`, `and` and `Q.not`:

```ts
import { Q } from '@ghuri/orm'

Post.objects.filter(
  Q({ title__icontains: 'd1' }).or(Q({ title__icontains: 'postgres' })).and(Q.not({ published: false })),
)
```

| Expression | SQL shape |
|---|---|
| `Q({ a: 1, b: 2 })` | `a = 1 AND b = 2` |
| `Q({ a: 1 }).or(Q({ b: 2 }))` | `(a = 1 OR b = 2)` |
| `Q({ a: 1 }).and(Q({ b: 2 }))` | `(a = 1 AND b = 2)` |
| `Q.not({ a: 1 })` | `NOT (a = 1)` |

`exclude({ … })` is `filter(Q.not({ … }))`.

## `F` expressions

`F('field')` refers to a column of the same row, so the database does the work:

```ts
import { F } from '@ghuri/orm'

// increment without a read-modify-write race
await Post.objects.filter({ id: 1 }).update({ views: F('views').add(1) })

// compare two columns
Post.objects.filter({ updatedAt__gt: F('createdAt') })
```

| Method | SQL |
|---|---|
| `F('a').add(x)` | `a + x` |
| `F('a').sub(x)` | `a - x` |
| `F('a').mul(x)` | `a * x` |
| `F('a').div(x)` | `a / x` |

`F()` also spans relations: `F('author__id')`.

## Aggregates

Use with `aggregate()` (one result for the whole QuerySet) or `annotate()` (one value per row):

```ts
import { Count, Sum, Avg, Min, Max } from '@ghuri/orm'

await Post.objects.aggregate({ total: Count('id'), avgViews: Avg('views') })
// → { total: 42, avgViews: 118.5 }

await User.objects.annotate({ numPosts: Count('posts') }).filter({ numPosts__gt: 2 })
```

| Aggregate | SQL | Result type | Empty set |
|---|---|---|---|
| `Count(field, { distinct? })` | `COUNT(col)` | `number` | `0` |
| `Sum(field)` | `SUM(col)` | `number` (`string` for `DecimalField`) | `null` |
| `Avg(field)` | `AVG(col)` | `number` | `null` |
| `Min(field)` | `MIN(col)` | field type | `null` |
| `Max(field)` | `MAX(col)` | field type | `null` |

Annotations can be used in later `filter()`, `exclude()` and `orderBy()` calls; filtering on an
aggregate annotation compiles to `HAVING`.

## Ordering

`orderBy('-createdAt', 'title')`: a leading `-` means descending. `'?'` orders randomly
(`RANDOM()` on both dialects). Related fields span with `__`: `orderBy('author__username')`.
Without `orderBy()`, `Meta.ordering` applies.
