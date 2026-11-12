---
title: Models and fields
description: Defining models with Model(), fields and options, Meta, abstract models, custom managers, instance methods and validation.
---

A model is the single source of truth about a piece of data: its fields, their types and
validation, and its behaviour. Each model maps to one database table. Ghuri's models work like
Django's, with a syntax adapted so TypeScript can infer every field type.

```ts title="src/blog/models.ts"
import {
  Model, CharField, SlugField, TextField, BooleanField, DateTimeField, PositiveIntegerField,
  ForeignKey, ManyToManyField, CASCADE, Manager, MinLengthValidator,
} from '@ghuri/orm'
import { User } from '@ghuri/auth'

export class Post extends Model({
  title: new CharField({ maxLength: 200, validators: [new MinLengthValidator(3)] }),
  slug: new SlugField({ unique: true }),
  body: new TextField({ blank: true }),
  status: new CharField({
    maxLength: 10,
    choices: [['draft', 'Draft'], ['review', 'In review'], ['live', 'Published']],
    default: 'draft',
  }),
  views: new PositiveIntegerField({ default: 0 }),
  author: new ForeignKey(() => User, { onDelete: CASCADE, relatedName: 'posts' }),
  tags: new ManyToManyField(() => Tag, { blank: true, relatedName: 'posts' }), // Tag is defined elsewhere in this file
  createdAt: new DateTimeField({ autoNowAdd: true }),
  updatedAt: new DateTimeField({ autoNow: true }),
}) {
  static Meta = {
    ordering: ['-createdAt'],
    verboseNamePlural: 'posts',
    indexes: [{ fields: ['status', 'createdAt'] }],
  }

  declare static objects: Manager<Post>

  toString() {
    return this.title
  }

  get isLive() {
    return this.status === 'live'
  }
}
```

## How `Model()` works

`Model(fields)` returns a base class built from the field definitions. You extend it to add
`Meta`, methods, getters and custom managers. Because the fields are a value rather than a set
of class property declarations, TypeScript can infer the instance type:

| Field | Instance property type |
|---|---|
| `CharField`, `TextField`, `SlugField`, `EmailField`, `URLField`, `UUIDField` | `string` |
| `IntegerField` and friends, `FloatField`, `DurationField` (ms) | `number` |
| `DecimalField` | `string` (exact; never a float) |
| `BooleanField` | `boolean` |
| `DateTimeField` | `Date` |
| `DateField`, `TimeField` | `string` (`'YYYY-MM-DD'`, `'HH:MM:SS'`) |
| `JSONField` | `any` (or the type parameter: `new JSONField<Settings>()`) |
| any field with `null: true` | `T \| null` |
| `ForeignKey` named `author` | `authorId: number` plus `author` (`User \| PromiseLike<User>`: await it, or read it directly once loaded) |
| `ManyToManyField` | a related manager |

Every model gets an implicit `id: new BigAutoField({ primaryKey: true })` unless a field sets
`primaryKey: true`. `instance.pk` is an alias for whichever field is the primary key.

### Typing results and reverse relations

`declare static objects: Manager<Post>` is what makes `Post.objects.get()` return a `Post`
(with your methods and getters). Without it, results are typed from the fields only. Reverse
relations are created at runtime when the other model is registered, so declare them for
TypeScript too. Always use `declare` (not a class field with an initializer) for these extra
typings:

```ts
import { type Manager, type RelatedManager } from '@ghuri/orm'

export class Post extends Model({ /* ... */ }) {
  declare static objects: Manager<Post>
  declare comments: RelatedManager<Comment>   // from Comment.post's relatedName: 'comments'
}
```

`BaseModel` is the real root class. Use it for `instanceof` checks and in generic code:
`function describe(obj: BaseModel) { return obj._meta.label }`.

:::tip[If you know Django]
```python
class Post(models.Model):
    title = models.CharField(max_length=200)
    class Meta:
        ordering = ['-created_at']
```
becomes `class Post extends Model({ title: new CharField({ maxLength: 200 }) }) { static Meta = { ordering: ['-createdAt'] } }`.
Field options are camelCase; columns are still snake_case in the database (`createdAt` is
stored as `created_at`). `__str__` is `toString()`, and properties work as getters.
:::

## Field options

These options work on every field type. The full list per field is in the
[field reference](/docs/reference/fields/).

| Option | Meaning |
|---|---|
| `null` | Store empty values as `NULL`. Default `false`. |
| `blank` | Allow empty values in validation (forms, serializers, admin). Default `false`. |
| `default` | A value, or a function called for each new instance (`default: () => crypto.randomUUID()`). |
| `dbDefault` | A default computed by the database (`DEFAULT` clause). |
| `choices` | `[value, label][]`, or an enum-like object. Validated, and shown as a select in the admin. |
| `primaryKey` | Make this the primary key. |
| `unique` | Add a unique constraint. |
| `dbIndex` | Add an index. |
| `dbColumn` | Override the column name. |
| `editable` | `false` hides the field from the admin and from `ModelSerializer` writes. |
| `verboseName`, `helpText` | Labels and help text for the admin and OpenAPI schema. |
| `validators` | Extra validators run by `fullClean()`. |
| `errorMessages` | Override messages by code, e.g. `{ unique: 'That slug is taken.' }`. |

As in Django, `null` is about the database and `blank` is about validation. For text fields,
prefer `blank: true, default: ''` to `null: true`, so there is only one "empty" value.

## Meta options

| Option | Meaning |
|---|---|
| `dbTable` | Table name. Default `${appLabel}_${modelname}`, e.g. `blog_post`. |
| `ordering` | Default ordering for QuerySets: `['-createdAt', 'title']`. |
| `verboseName`, `verboseNamePlural` | Human-readable names. |
| `uniqueTogether` | `[['author', 'slug']]`. |
| `indexes` | `[{ fields: ['status', 'createdAt'], name?: 'post_status_idx' }]`. |
| `constraints` | Check and unique constraints. |
| `abstract` | Make an abstract base model (no table). |
| `permissions` | Extra permissions: `[['publish_post', 'Can publish posts']]`. |
| `defaultPermissions` | Default `['add', 'change', 'delete', 'view']`. |
| `getLatestBy` | Field used by `latest()` / `earliest()`. |
| `appLabel` | Override the app the model belongs to. |
| `managed` | `false` means Ghuri never creates, alters or flushes the table (migrations still track the model's state). Default `true`. |
| `defaultManagerName` | Manager used by related lookups and internals. Default `objects`. |

Indexes are `{ fields, name?, unique?, condition? }`, where `condition` is a raw SQL `WHERE`
clause for a partial index and a leading `-` in `fields` makes that column descending.
Constraints are `{ type: 'unique', fields, name, condition? }` or
`{ type: 'check', check: 'price >= 0', name }`:

```ts
static Meta = {
  indexes: [{ fields: ['-createdAt', 'status'], name: 'post_recent_idx' }],
  constraints: [
    { type: 'unique', fields: ['author', 'slug'], name: 'post_author_slug_uniq' },
    { type: 'check', check: 'views >= 0', name: 'post_views_gte_0' },
  ],
}
```

## Registering models

A model gets its app label (and so its table name, `blog_post`) from the app that lists it:

```ts title="src/blog/app.ts"
import { AppConfig } from '@ghuri/core'
import * as models from './models'

export class BlogConfig extends AppConfig {
  name = 'blog'
  models = models
}
```

Outside `INSTALLED_APPS` (scripts, tests), set `Meta.appLabel` or call
`registerModels('blog', models)`. Reverse relations only exist once the model declaring the
foreign key is registered. To build a model class at runtime, use
`createModelClass('Post', fields, { meta, registry })`; this is what migrations use for
historical models, with an isolated `new ModelRegistry({ isolated: true })`.

## Model metadata: `_meta`

`Post._meta` exposes the model's structure. It is a stable, public API that the admin, the REST
framework, the agents package and the CLI are built on, and you can use it for generic code:

```ts
Post._meta.label                 // 'blog.Post'
Post._meta.dbTable               // 'blog_post'
Post._meta.pk.name               // 'id'
Post._meta.getField('title').maxLength   // 200
Post._meta.fields.map((f) => f.name)
Post._meta.relatedObjects        // reverse relations, e.g. comments
```

## Abstract base models

Share fields between models with an abstract model:

```ts
export class Timestamped extends Model({
  createdAt: new DateTimeField({ autoNowAdd: true }),
  updatedAt: new DateTimeField({ autoNow: true }),
}) {
  static Meta = { abstract: true }
}

export class Page extends Model(
  { title: new CharField({ maxLength: 200 }), body: new TextField() },
  { extends: Timestamped },
) {}
```

`Page` gets `createdAt` and `updatedAt` and its own table; `Timestamped` has no table. You can
also spread fields: `Model({ ...Timestamped.fields, title: ... })`. Multi-table inheritance and
proxy models are not supported in 0.1.

## Managers

`Post.objects` is the default manager, the entry point for queries. Add your own for common
filters:

```ts
import { Manager } from '@ghuri/orm'

class LiveManager extends Manager<Post> {
  getQueryset() {
    return super.getQueryset().filter({ status: 'live' })
  }

  byTag(name: string) {
    return this.getQueryset().filter({ tags__name: name })
  }
}

export class Post extends Model({ /* ... */ }) {
  declare static objects: Manager<Post>
  static live = new LiveManager()
}

await Post.live.byTag('typescript').count()
```

`objects` always exists, and extra managers are static properties. To change the default
manager's behaviour, assign your own: `static objects = new PostManager()`. Unlike Django, the
default manager (used for related lookups) is always `objects` unless you set
`Meta.defaultManagerName`.

## Saving, deleting and validating

```ts
const post = new Post({ title: 'Hi', slug: 'hi', authorId: 1 })
await post.save()                                   // INSERT
post.title = 'Hello'
await post.save({ updateFields: ['title'] })        // UPDATE only that column
await post.refreshFromDb()                          // or refreshFromDb({ fields: ['title'] })
await post.delete()                                 // [total, { 'blog.Post': 1, 'blog.Comment': 3 }]
```

`save()` also accepts `{ forceInsert, forceUpdate, using }`. `delete()` runs the `onDelete`
rules of every foreign key pointing at the object, sends delete signals and returns the number
of deleted rows, in total and per model.

`save()` does not validate. Call `fullClean()` first when data comes from users (the admin and
`ModelSerializer` do this for you). It runs field validation, `choices`, your `clean()` method,
foreign-key existence checks and uniqueness checks (`unique`, `uniqueTogether`, unique
constraints) against the database, and throws `ValidationError` with a `messageDict`.
`fullClean({ exclude: ['slug'], validateUnique: false })` narrows it:

```ts
import { ValidationError } from '@ghuri/core'

export class Post extends Model({ /* ... */ }) {
  clean() {
    if (this.status === 'live' && !this.body) {
      throw new ValidationError({ body: ['A published post needs a body.'] })
    }
  }
}

try {
  await post.fullClean()
} catch (e) {
  if (e instanceof ValidationError) console.log(e.messageDict)
}
```

Override `save()` to add behaviour, and call `super.save()`:

```ts
async save(opts?: { updateFields?: string[] }) {
  if (!this.slug) this.slug = this.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  await super.save(opts)
}
```

When the database itself rejects a write, the error is normalised across backends:
`IntegrityError` (unique, foreign key, `NOT NULL` or check violations), `NotSupportedError`, or
the base `DatabaseError`, all exported from `@ghuri/orm`. Deletes refused by `onDelete` raise
`ProtectedError` or `RestrictedError`; an unknown field in a query raises `FieldError`.

For behaviour that should run for every save including `bulkCreate`, prefer
[signals](/docs/topics/signals/) or explicit service functions; like Django, bulk operations do
not call `save()`.

## Serialising instances

`instance.toJSON()` returns a plain object of concrete field values (foreign keys as their
`...Id`), so `JSON.stringify(post)` and `json(c, post)` work. For API output with control over
fields and relations, use a [serializer](/docs/topics/rest/serializers/).

## The escape hatch

QuerySets compile to SQL with the ORM's own builder (`qs.toSQL()` returns `{ sql, params }`),
but each model also has a generated Drizzle table, for queries the ORM cannot express:

```ts
import { getDrizzle } from '@ghuri/orm'
import { sql } from 'drizzle-orm'

const db = await getDrizzle()
const posts = Post.table()
const rows = await db.select({ day: sql`date(${posts.createdAt})`, n: sql`count(*)` })
  .from(posts).groupBy(sql`1`)
```

`Post.table()` uses the dialect of the default database; `getTable(Post, 'postgresql')` and
`getSchema([Post, Comment], dialect)` (keyed by class name, including auto-created
many-to-many tables) build tables for a given dialect, and `field.drizzleColumn(dialect)`
builds a single column. Drizzle columns are keyed by attribute name (`posts.createdAt`,
`posts.authorId`), and values are converted the same way the ORM converts them.

Code written this way is dialect-specific when it uses raw SQL, so keep it in one place.
