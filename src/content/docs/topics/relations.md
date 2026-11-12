---
title: Relations
description: ForeignKey, OneToOneField and ManyToManyField, related managers, loading related objects, through models and on-delete behaviour.
---

Ghuri supports Django's three relationship types: many-to-one (`ForeignKey`), one-to-one
(`OneToOneField`) and many-to-many (`ManyToManyField`). Examples use the blog models from the
[tutorial](/docs/tutorial/part-1-models/).

## Declaring relations

```ts
author: new ForeignKey(() => User, { onDelete: CASCADE, relatedName: 'posts' }),
profile: new OneToOneField(() => User, { onDelete: CASCADE, relatedName: 'profile' }),
tags: new ManyToManyField(() => Tag, { blank: true, relatedName: 'posts' }),
```

The target is a model class, a function returning one, or a string label:

- `() => Tag` works regardless of declaration order and avoids circular import problems,
  because it is resolved after every app is loaded.
- `'auth.User'` or `'blog.Tag'` works without importing the model at all. Use it to refer to
  models in apps that import yours, or to a swappable user model (`getUserModel()` returns it at
  runtime).
- `'Tag'` (no app label) refers to a model in the same app.
- `'self'` makes a recursive relation: `parent: new ForeignKey('self', { null: true, onDelete: CASCADE })`.

Options:

| Option | Meaning |
|---|---|
| `onDelete` | Required for `ForeignKey`/`OneToOneField`. See [below](#on-delete). |
| `relatedName` | Name of the reverse accessor on the target (`user.posts`). Default: the camelCase model name plus `Set`, e.g. `user.postSet` (for a one-to-one, just `user.profile`). `'+'` hides the reverse relation. |
| `relatedQueryName` | Name used in reverse lookups (`User.objects.filter({ post__title: ... })`). Defaults to `relatedName` when set, otherwise the lower-camel model name (`post`). |
| `toField` | Target field to point at, if not the primary key. |
| `limitChoicesTo` | A filter object (or a function returning one) that restricts choices in the admin and serializers. |
| `dbConstraint` | `false` skips the database foreign key constraint. Default `true`. |
| `through`, `throughFields` | (M2M) an explicit intermediate model, and which two of its foreign keys to use. |
| `null`, `blank`, `dbIndex`, ... | As for any field. Foreign keys are indexed by default. |

:::note[Django difference]
Without `relatedName`, the reverse accessor is camelCase `postSet` (Django: `post_set`) and the
lookup name is `post`. Reverse relations exist only once the model declaring the foreign key is
registered (through `INSTALLED_APPS` or `registerModels()`), and TypeScript only knows about
them if you declare them: `declare posts: RelatedManager<Post>` in the `User` subclass, or
`declare postSet: RelatedManager<Post>` when you kept the default name.
:::

## Forward access: foreign keys

A `ForeignKey` named `author` gives each instance two properties:

```ts
post.authorId          // the raw value of the author_id column; no query
await post.author      // the related User, loaded on first access and then cached
post.author = user     // assignment sets authorId
post.authorId = 7      // and so does setting the id
await post.save()
```

`post.author` is awaitable because loading it may need a query. If the object was fetched with
`selectRelated('author')`, or the relation was already loaded, `post.author` is the instance
itself (awaiting it still works and needs no I/O). A nullable foreign key is `null` when the id
is `null`; a missing non-null relation rejects with `User.DoesNotExist`. You cannot assign an
unawaited related object: `post.author = await other.author`.

```ts
const posts = await Post.objects.selectRelated('author').filter({ published: true })
for (const p of posts) {
  console.log((await p.author).username)    // no extra queries
}
```

:::tip[If you know Django]
`post.author_id` is `post.authorId`, and `post.author` is the same lazily-loaded descriptor,
except you `await` it. The classic N+1 problem and its fix (`select_related`) are exactly as in
Django. Because a forgotten `selectRelated` costs a round trip to D1 per row, count queries
early: `captureQueries()` and `onQuery()` from `@ghuri/orm` report every statement a block
runs (see [Making queries](/docs/topics/queries/#performance)).
:::

## Reverse access: related managers

The model on the other side of a `ForeignKey` gets a **related manager** named by
`relatedName`. It behaves like a manager whose QuerySet is pre-filtered:

```ts
await user.posts.all()
await user.posts.filter({ published: true }).count()
await user.posts.create({ title: 'New', slug: 'new' })    // sets author automatically
await post.comments.orderBy('-createdAt').first()
```

For a `OneToOneField`, the reverse side is a single object: `await user.profile` resolves to the
`Profile`, or throws `Profile.DoesNotExist`.

## Many-to-many

Both sides of a `ManyToManyField` get a related manager with extra methods:

```ts
await post.tags.add(ts, cf)          // instances or primary keys
await post.tags.remove(cf)
await post.tags.set([ts])            // replace the whole set
await post.tags.clear()
await post.tags.all()
await tag.posts.filter({ published: true })   // reverse side
```

The object must be saved (have a primary key) before you change its many-to-many relations.
Changes send the `m2mChanged` signal. Forward assignment (`post.tags = [...]`) is not allowed;
use `post.tags.set([...])`.

Ghuri creates the join table for you (`blog_post_tags` with an `id`, `post_id` and `tag_id`,
named like Django's). To store
data on the relationship itself, declare a `through` model:

```ts
export class Membership extends Model({
  person: new ForeignKey(() => Person, { onDelete: CASCADE }),
  group: new ForeignKey(() => Club, { onDelete: CASCADE }),
  role: new CharField({ maxLength: 20 }),
  joinedAt: new DateField(),
}) {
  static Meta = { uniqueTogether: [['person', 'group']] }
}

export class Club extends Model({
  name: new CharField({ maxLength: 100 }),
  members: new ManyToManyField(() => Person, { through: () => Membership, relatedName: 'clubs' }),
}) {}

await club.members.add(alice, { throughDefaults: { role: 'chair', joinedAt: '2026-11-01' } })
await Membership.objects.filter({ group: club, role: 'chair' })
```

## Loading related objects efficiently

| Method | Use for | Queries |
|---|---|---|
| `selectRelated('author', 'author__profile')` | forward FK and one-to-one | joined into the main query |
| `prefetchRelated('tags', 'comments')` | M2M and reverse FK | one extra query per relation |

```ts
const posts = await Post.objects
  .filter({ published: true })
  .selectRelated('author')
  .prefetchRelated('tags', 'comments')

for (const p of posts) {
  const tags = await p.tags.all()        // served from the prefetch cache
}
```

Calling `filter()` on a prefetched manager (`p.tags.filter(...)`) builds a new query, as in
Django, so filter in the prefetch rather than per object when you can, with a `Prefetch`
object:

```ts
import { Prefetch } from '@ghuri/orm'

const posts = await Post.objects.prefetchRelated(
  'tags__posts',                          // lookups can span relations
  new Prefetch('comments', {
    queryset: Comment.objects.filter({ approved: true }).orderBy('-createdAt'),
    toAttr: 'approvedComments',           // stored as an array on each post
  }),
)
```

`prefetchRelatedObjects(instances, ...lookups)` does the same for a list of instances you
already have.

## On delete

`onDelete` decides what happens to rows that point at an object being deleted:

| Constant | Behaviour |
|---|---|
| `CASCADE` | Delete the referring objects too. |
| `PROTECT` | Refuse, throwing `ProtectedError`. |
| `RESTRICT` | Refuse unless the referring objects are also being deleted by a cascade in the same operation. |
| `SET_NULL` | Set the foreign key to `NULL` (requires `null: true`). |
| `SET_DEFAULT` | Set it to the field's default. |
| `SET(value)` / `SET(() => value)` | Set it to a value, or the result of a function (an instance or a key). |
| `DO_NOTHING` | Do nothing; the database may reject the delete. |

These rules are **enforced by the ORM**, not by database `ON DELETE` clauses, exactly as Django
does it. Before deleting, Ghuri collects every affected object, sends `preDelete`/`postDelete`
signals for each, and applies updates and deletes in a safe order. That is why behaviour is
identical on D1, SQLite and Postgres, and why `qs.delete()` returns per-model counts:

```ts
const [total, perModel] = await User.objects.filter({ username: 'spam' }).delete()
// total: 14, perModel: { 'auth.User': 1, 'blog.Post': 3, 'blog.Comment': 10 }
```

`PROTECT` raises `ProtectedError` and `RESTRICT` raises `RestrictedError` (both exported from
`@ghuri/orm`) before anything is deleted. The flip side is the same as Django's: rows deleted
with raw SQL bypass these rules.

:::caution[Cascades on D1]
The collector runs inside `atomic()`, which has no rollback on D1. A failure part-way through a
large cascade on D1 can leave some rows deleted. See
[Transactions](/docs/topics/transactions/#d1).
:::
