---
title: Serializers
description: Validate incoming data and render model instances with Serializer and ModelSerializer.
---

A serializer does two jobs. Going in, it turns untrusted request data into validated values you
can save. Going out, it turns model instances into plain JSON-ready objects. It is the API
equivalent of a Django form.

:::note[Alpha]
Serializer output is asynchronous because related objects may need a database query. The
documented API is `await serializer.getData()`. The method name may still change before 0.1
(alternatives under discussion are `resolve()` and `toRepresentationAsync()`); the behaviour will
not.
:::

:::tip[If you know Django]
Everything you know from DRF carries over, with three mechanical changes:

- `serializer.data` → `await serializer.getData()`
- `serializer.is_valid(raise_exception=True)` → `await serializer.isValid({ raiseException: true })`
- `validate_<field>` → `validate<Field>` (`validate_title` becomes `validateTitle`)
:::

## Declaring a serializer

Fields are declared as instance properties. Field classes come from `@ghuri/rest`. They share
names with the ORM's field classes (`CharField`, `IntegerField` …), so a `serializers.ts` file
should import fields only from `@ghuri/rest` and import models as classes.

```ts title="src/blog/serializers.ts"
import { Serializer, CharField, EmailField, DateTimeField } from '@ghuri/rest'

export class ContactSerializer extends Serializer {
  name = new CharField({ maxLength: 100 })
  email = new EmailField()
  message = new CharField({ style: { widget: 'textarea' } })
  sentAt = new DateTimeField({ readOnly: true })
}
```

### Deserializing and validating

Pass the incoming data as `data`, then validate. `isValid()` is async because some validators
(for example `UniqueValidator`) query the database.

```ts
const serializer = new ContactSerializer({ data: await c.req.json() })

if (await serializer.isValid()) {
  serializer.validatedData   // { name: 'Ada', email: 'ada@example.com', message: '…' }
} else {
  serializer.errors          // { email: ['Enter a valid email address.'] }
}
```

In views you usually let the error propagate. With `raiseException: true` a failed validation
throws a REST `ValidationError`, which the exception handler turns into a `400` with the errors as
the body:

```ts
await serializer.isValid({ raiseException: true })
```

### Serializing

Pass an instance (or an array with `many: true`) and await the output:

```ts
const post = await Post.objects.get({ slug: 'hello' })
const data = await new PostSerializer(post).getData()
// { id: 1, title: 'Hello', slug: 'hello', author: 'rifat', ... }

const posts = await Post.objects.filter({ published: true })
const list = await new PostSerializer(posts, { many: true }).getData()
```

## ModelSerializer

`ModelSerializer` builds its fields from the model's `_meta`: field types, `maxLength`,
`choices`, `null`/`blank` (which become `allowNull`/`required`), unique constraints and
relations. You list the fields you want in `static Meta`.

```ts title="src/blog/serializers.ts"
import { ModelSerializer, CharField, ValidationError } from '@ghuri/rest'
import { Post } from './models'

export class PostSerializer extends ModelSerializer<Post> {
  static Meta = {
    model: Post,
    fields: ['id', 'title', 'slug', 'body', 'published', 'author', 'authorName', 'tags', 'createdAt'],
    readOnlyFields: ['author', 'createdAt'],
    extraKwargs: { slug: { required: false } },
  }

  authorName = new CharField({ source: 'author.username', readOnly: true })

  validateTitle(value: string) {
    if (value.toLowerCase().includes('spam')) throw new ValidationError('No spam, please.')
    return value
  }

  validate(attrs: Record<string, unknown>) {
    if (attrs.published && !attrs.body) {
      throw new ValidationError({ body: ['A published post needs a body.'] })
    }
    return attrs
  }
}
```

`Meta` options:

| Option | Meaning |
|---|---|
| `model` | The model class |
| `fields` | Field names to include, or `'__all__'` |
| `exclude` | Field names to leave out (instead of `fields`) |
| `readOnlyFields` | Included in output, ignored on input |
| `extraKwargs` | Per-field option overrides, e.g. `{ password: { writeOnly: true } }` |
| `depth` | Render relations as nested objects this many levels deep (read only) |
| `validators` | Serializer-level validators such as `UniqueTogetherValidator` |

A field declared on the class always wins over the generated one with the same name.

### Relations

By default a `ForeignKey` renders as its primary key (`PrimaryKeyRelatedField`) and a
`ManyToManyField` as an array of primary keys. On input the serializer looks those keys up and
reports `Invalid pk "42" - object does not exist.` for missing ones.

Other relation fields:

```ts
author = new StringRelatedField()                                   // uses toString(), read only
tags = new SlugRelatedField({ slugField: 'name', many: true, queryset: Tag.objects.all() })
post = new PrimaryKeyRelatedField({ queryset: Post.objects.filter({ published: true }) })
```

Use `selectRelated` and `prefetchRelated` in the view's queryset so that rendering a list does not
issue one query per row.

### Nested serializers

Use another serializer as a field to embed related objects:

```ts
export class CommentSerializer extends ModelSerializer<Comment> {
  static Meta = { model: Comment, fields: ['id', 'author', 'body', 'createdAt'] }
  author = new StringRelatedField()
}

export class PostDetailSerializer extends ModelSerializer<Post> {
  static Meta = { model: Post, fields: ['id', 'title', 'body', 'comments'] }
  comments = new CommentSerializer({ many: true, readOnly: true })
}
```

Nested serializers are read only by default, as in DRF. To accept nested input, override
`create()` and `update()` and write the related objects yourself:

```ts
async create(validatedData: Record<string, any>) {
  const { tags = [], ...rest } = validatedData
  const post = await Post.objects.create(rest)
  await post.tags.set(tags)
  return post
}
```

### Computed values

`SerializerMethodField` calls `get<FieldName>` on the serializer. The method may be async.

```ts
commentCount = new SerializerMethodField()

async getCommentCount(post: Post) {
  return post.comments.count()
}
```

If you need the count on every row of a list, annotate the queryset instead
(`Post.objects.annotate({ commentCount: Count('comments') })`) and declare
`commentCount = new IntegerField({ readOnly: true })`. One query beats N.

## Saving

After validation, `save()` calls `create()` or `update()` depending on whether the serializer was
constructed with an instance. Keyword data passed to `save()` is merged into `validatedData`,
which is how views attach values that do not come from the client:

```ts
const serializer = new PostSerializer({ data: this.request.data })
await serializer.isValid({ raiseException: true })
const post = await serializer.save({ author: this.request.user })

// update
const edit = new PostSerializer(post, { data: { title: 'New title' }, partial: true })
await edit.isValid({ raiseException: true })
await edit.save()
```

`ModelSerializer.create()` handles many-to-many fields after the instance is saved, so `tags`
works without extra code.

## Fields

All fields accept `readOnly`, `writeOnly`, `required`, `default`, `allowNull`, `source`,
`validators`, `errorMessages`, `label` and `helpText`.

| Field | Notes |
|---|---|
| `CharField` | `maxLength`, `minLength`, `allowBlank`, `trimWhitespace` |
| `EmailField`, `URLField`, `UUIDField` | Validated strings |
| `IntegerField`, `FloatField` | `minValue`, `maxValue` |
| `DecimalField` | `maxDigits`, `decimalPlaces`; values are strings, as in the ORM |
| `BooleanField` | Accepts `true`/`false`, `"true"`, `"1"`, `"on"` … |
| `DateTimeField`, `DateField` | ISO 8601 in and out |
| `ChoiceField`, `MultipleChoiceField` | `choices` as `[value, label][]` |
| `ListField`, `DictField` | `child` field for elements |
| `JSONField` | Any JSON value |
| `FileField`, `ImageField` | Multipart uploads; see [File storage](/docs/topics/file-storage/) |
| `SerializerMethodField` | Read only, calls `get<Name>()` |
| `PrimaryKeyRelatedField`, `SlugRelatedField`, `StringRelatedField` | Relations |
| `HiddenField` | Not in input or output; value from `default`, e.g. `CurrentUserDefault` |
| `ReadOnlyField` | Renders the attribute as is |

`HiddenField` with `CurrentUserDefault` is the idiomatic way to set an owner without trusting the
client:

```ts
author = new HiddenField({ default: new CurrentUserDefault() })
```

## Validators

Field-level validation runs in this order: the field's own checks, its `validators`, then the
serializer's `validate<Field>()` method. Object-level validation (`Meta.validators`, then
`validate()`) runs once every field is valid.

```ts
import { UniqueValidator, UniqueTogetherValidator } from '@ghuri/rest'

slug = new CharField({ validators: [new UniqueValidator({ queryset: Post.objects.all() })] })

static Meta = {
  model: Comment,
  fields: ['post', 'author', 'body'],
  validators: [new UniqueTogetherValidator({ queryset: Comment.objects.all(), fields: ['post', 'author'] })],
}
```

`ModelSerializer` adds `UniqueValidator` automatically for model fields with `unique: true`.
Errors raised from `validate()` without a field key go under `non_field_errors`
(configurable with `NON_FIELD_ERRORS_KEY`).

## JSON Schema

Every serializer can describe itself:

```ts
new PostSerializer().jsonSchema()
// { type: 'object', properties: { title: { type: 'string', maxLength: 200 }, ... }, required: [...] }
```

The [OpenAPI generator](/docs/topics/rest/openapi/) and the
[agents package](/docs/topics/agents/) both use this to describe inputs and outputs, so a field's
`helpText` ends up in your API docs and in the tool descriptions an LLM sees.
