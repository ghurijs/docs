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

`?` is a bound parameter (`$1`, `$2`, ... on Postgres) and `col` is the column. Pattern lookups
escape their input (`%`, `_` and `\` for `LIKE`; `*`, `?` and `[` for `GLOB`), so user input is
always matched literally.

| Lookup | Example | SQLite / D1 | Postgres |
|---|---|---|---|
| `exact` | `{ slug: 'hello' }` | `col = ?` | `col = ?` |
| `exact` with `null` | `{ publishedAt: null }` | `col IS NULL` | `col IS NULL` |
| `iexact` | `{ username__iexact: 'Rifat' }` | `UPPER(col) = UPPER(?)` | `UPPER(col) = UPPER(?)` |
| `contains` | `{ title__contains: 'Hono' }` | `col GLOB '*Hono*'` | `col LIKE '%Hono%' ESCAPE '\'` |
| `icontains` | `{ title__icontains: 'hono' }` | `col LIKE '%hono%' ESCAPE '\'` | `col ILIKE '%hono%' ESCAPE '\'` |
| `startswith` | `{ title__startswith: 'How' }` | `col GLOB 'How*'` | `col LIKE 'How%' ESCAPE '\'` |
| `istartswith` | `{ title__istartswith: 'how' }` | `col LIKE 'how%' ESCAPE '\'` | `col ILIKE 'how%' ESCAPE '\'` |
| `endswith` | `{ email__endswith: '@example.com' }` | `col GLOB '*@example.com'` | `col LIKE '%@example.com' ESCAPE '\'` |
| `iendswith` | `{ email__iendswith: '@EXAMPLE.com' }` | `col LIKE '%@EXAMPLE.com' ESCAPE '\'` | `col ILIKE '%@EXAMPLE.com' ESCAPE '\'` |
| `in` | `{ id__in: [1, 2, 3] }` | `col IN (?, ?, ?)` | `col IN (?, ?, ?)` |
| `gt` | `{ views__gt: 100 }` | `col > ?` | `col > ?` |
| `gte` | `{ views__gte: 100 }` | `col >= ?` | `col >= ?` |
| `lt` | `{ createdAt__lt: cutoff }` | `col < ?` | `col < ?` |
| `lte` | `{ createdAt__lte: cutoff }` | `col <= ?` | `col <= ?` |
| `range` | `{ createdAt__range: [start, end] }` | `col BETWEEN ? AND ?` | `col BETWEEN ? AND ?` |
| `isnull` | `{ publishedAt__isnull: true }` | `col IS NULL` / `IS NOT NULL` | `col IS NULL` / `IS NOT NULL` |
| `regex` | `{ slug__regex: '^v[0-9]+' }` | `col REGEXP ?` (not on D1) | `col ~ ?` |
| `iregex` | `{ slug__iregex: '^V[0-9]+' }` | `col REGEXP '(?i)' + pattern` (not on D1) | `col ~* ?` |

The pattern in the `contains` family is passed as a parameter; the table shows its value
inline for readability. On Postgres, non-text columns are cast to `text` for text lookups.

Notes:

- **Case sensitivity is the same everywhere.** `contains`, `startswith` and `endswith` are
  case-sensitive on every backend (SQLite and D1 use `GLOB`, because SQLite's `LIKE` ignores
  ASCII case), and the `i...` variants are case-insensitive. SQLite's `LIKE` only folds ASCII
  letters, so `icontains` on non-ASCII text can still differ from Postgres.
- **`null` values:** `exact`/`iexact` with `null` compile to `IS NULL`; `contains` and
  friends with `null` match nothing.
- **`in` with an empty array** compiles to a condition that matches nothing (`1 = 0`).
- **`in` with many values on SQLite/D1:** above 50 values the list is sent as one JSON
  parameter (`col IN (SELECT value FROM json_each(?))`), which keeps queries under D1's limit of
  100 bound parameters per statement.
- **`in` with a QuerySet** compiles to a subquery:
  `filter({ author__in: User.objects.filter({ isStaff: true }) })`.
- **`range` is inclusive** on both ends, like SQL `BETWEEN`. For datetimes, `range: [start, end]`
  with `end` at midnight excludes the rest of that day.
- **Values can be expressions:** `{ updatedAt__gt: F('createdAt') }`, `{ title__icontains: F('slug') }`.

:::caution[`regex` on D1]
SQLite has no built-in `REGEXP` function. With `@ghuri/orm/sqlite` (better-sqlite3), Ghuri
registers one backed by JavaScript `RegExp`. **D1 does not allow custom functions**, so `regex`
and `iregex` raise `NotSupportedError` on D1. Use `contains`/`startswith`, or filter in code.
On Postgres, patterns use POSIX syntax, which differs from JavaScript regular expressions in
some details.
:::

## Transforms

Transforms go between the field and the lookup, and can be chained with any lookup:
`createdAt__year__gte: 2025`, `createdAt__date: '2026-11-12'`. Without a lookup, `exact` is
implied. `DateTimeField` values are compared in UTC on both dialects.

| Transform | Value | SQLite / D1 | Postgres |
|---|---|---|---|
| `date` | `'YYYY-MM-DD'` | `substr(col, 1, 10)` | `CAST((col AT TIME ZONE 'UTC') AS date)` |
| `time` | `'HH:MM:SS'` | `substr(col, 12, 8)` | `CAST((col AT TIME ZONE 'UTC') AS time)` |
| `year` | number | `CAST(strftime('%Y', col) AS integer)` | `CAST(EXTRACT(YEAR FROM (col AT TIME ZONE 'UTC')) AS integer)` |
| `month` | 1-12 | `strftime('%m', ...)` | `EXTRACT(MONTH ...)` |
| `day` | 1-31 | `strftime('%d', ...)` | `EXTRACT(DAY ...)` |
| `hour`, `minute`, `second` | number | `strftime('%H' / '%M' / '%S', ...)` | `EXTRACT(HOUR / MINUTE / SECOND ...)` |
| `week_day` | 1 (Sunday) to 7 (Saturday), as in Django | `strftime('%w', ...) + 1` | `EXTRACT(DOW ...) + 1` |
| `quarter` | 1-4 | computed from the month | `EXTRACT(QUARTER ...)` |

Transforms wrap the column in a function, so they cannot use a plain index on it. For
large tables, prefer a range on the column itself: `{ createdAt__gte: start, createdAt__lt: end }`.

## Spanning relations

Follow foreign keys, reverse foreign keys and many-to-many relations with `__`, then apply a
lookup on the final field:

```ts
// forward FK: posts whose author's username is 'rifat'
Post.objects.filter({ author__username: 'rifat' })

// reverse FK (uses relatedQueryName, or relatedName, or the lower-camel model name):
// users with a published post
User.objects.filter({ posts__published: true })

// many-to-many: posts tagged 'workers'
Post.objects.filter({ tags__name: 'workers' })

// several hops
Comment.objects.filter({ post__author__email__iendswith: '@example.com' })
```

Spanning a multi-valued relation (reverse FK or M2M) compiles to an `EXISTS (...)` subquery
rather than a join, so a post with two matching tags still appears once and `.distinct()` is
rarely needed. Forward foreign keys and one-to-ones are joined. Without `relatedName`, the
reverse lookup name is the lower-camel model name: `User.objects.filter({ post__title: 'Hi' })`.

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

`Q.and(a, b, ...)` and `Q.or(a, b, ...)` combine any number of conditions, and `q.not()`
negates an existing `Q`. `exclude({ … })` is `filter(Q.not({ … }))`.

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
| `F('a').mod(x)` | `a % x` |
| `F('a').asc()` / `.desc({ nullsLast: true })` | ordering, with NULL placement |

`F()` also spans relations: `F('author__id')`.

## Functions and other expressions

Exported from `@ghuri/orm` and usable in `annotate()`, `filter()` values, `orderBy()` and
`update()`:

| Expression | SQL |
|---|---|
| `Value(x)` | `?` (a bound value) |
| `Lower(e)`, `Upper(e)` | `LOWER(e)`, `UPPER(e)` |
| `Length(e)` | `LENGTH(e)` (a number) |
| `Coalesce(a, b, ...)` | `COALESCE(a, b, ...)` |
| `Concat(a, b, ...)` | `(COALESCE(a, '') \|\| COALESCE(b, '') ...)`: NULL parts become `''` |
| `Now()` | `CURRENT_TIMESTAMP` on Postgres, an ISO-8601 UTC timestamp on SQLite |
| `new Func('NAME', [args], outputField?)` | `NAME(args)` |
| `new RawSQL('sql with ?', [params], outputField?)` | the SQL as written (not portable) |

String arguments are field references (`Lower('title')`); wrap literals in `Value()`.

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
| `Count(field = '*', { distinct?, filter? })` | `COUNT(col)` | `number` | `0` |
| `Sum(field, { distinct?, filter? })` | `SUM(col)` | `number` (`string` for `DecimalField`) | `null` |
| `Avg(field, ...)` | `AVG(col)` | `number` (`string` for `DecimalField`) | `null` |
| `Min(field, ...)` | `MIN(col)` | field type | `null` |
| `Max(field, ...)` | `MAX(col)` | field type | `null` |

`filter` is a `Q` or a filter object, relative to the queried model:
`Count('comments', { filter: Q({ comments__approved: true }) })`. Annotations can be used in
later `filter()`, `exclude()` and `orderBy()` calls; filtering on an aggregate annotation
compiles to `HAVING`. Aggregates over reverse or many-to-many relations in `annotate()` compile
to correlated subqueries, so several of them can be combined without multiplying rows.

## Ordering

`orderBy('-createdAt', 'title')`: a leading `-` means descending. `'?'` orders randomly
(`RANDOM()` on both dialects). Related fields span with `__`: `orderBy('author__username')`.
Expressions work too: `orderBy(Lower('title'))`, `orderBy(F('rating').desc({ nullsLast: true }))`.
Without `orderBy()`, `Meta.ordering` applies. NULLs sort first in ascending order on every
backend, so results do not change order when you move between SQLite and Postgres.
