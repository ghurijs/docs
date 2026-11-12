---
title: GraphQL
description: Build a GraphQL API from your models with @ghuri/graphql, in the style of graphene-django — Relay connections and filters, mutations that reuse your REST serializers and permissions, GraphiQL.
---

`@ghuri/graphql` gives you a GraphQL API in the style of
[graphene-django](https://docs.graphene-python.org/projects/django/): object types generated from
your models, a `Query` and a `Mutation` class per app merged into one schema, Relay nodes and
connections with filters and ordering, and mutations that run through the **serializers and
permission classes you already wrote for your REST API**. Requests are authenticated with the same
authentication classes as `@ghuri/rest`, relations are batched with DataLoaders, and the view
speaks GraphQL over HTTP with GraphiQL in development. It runs on Cloudflare Workers (D1) and on
Node (SQLite, Postgres).

:::note[Alpha]
`@ghuri/graphql` is at `0.1.0-alpha.0` and is built on
[graphql-js](https://github.com/graphql/graphql-js) 17 (a peer dependency). Subscriptions are not
supported yet.
:::

:::tip[If you know Django]
`ModelType` is `DjangoObjectType`, `ConnectionField` is `DjangoFilterConnectionField`,
`SerializerMutation` is graphene-django's `SerializerMutation`, the `GRAPHQL` setting is
`GRAPHENE`, and `ghuri graphql_schema` is `./manage.py graphql_schema`. The
[mapping table](#for-graphene-django-users) at the end of this page lists the rest.
:::

## Setup

New projects can start with GraphQL:

```sh
npm create ghuri@latest mysite -- --graphql     # or: npx ghuri startproject mysite --graphql
```

That adds the dependencies, `GraphQLConfig` to `INSTALLED_APPS`, a `src/schema.ts` and the
`/graphql/` route. To add it to an existing project:

```sh
npm install @ghuri/graphql@next graphql
```

```ts title="src/settings.ts"
import { JWTAuthentication, SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
import { defineSettings } from '@ghuri/core'
import { GraphQLConfig } from '@ghuri/graphql'
import { BlogConfig } from './blog/app'
import { schema } from './schema'

export default defineSettings((env) => ({
  INSTALLED_APPS: [/* … */, GraphQLConfig, BlogConfig],   // GraphQLConfig: the graphql_schema command
  GRAPHQL: {
    SCHEMA: schema,
    AUTHENTICATION_CLASSES: [TokenAuthentication, JWTAuthentication, SessionAuthentication],
  },
  // …
}))
```

```ts title="src/urls.ts"
import { path } from '@ghuri/core'
import { GraphQLView } from '@ghuri/graphql'

export const urlpatterns = [
  // …
  path('graphql/', GraphQLView.asView(), { name: 'graphql' }),   // schema from GRAPHQL.SCHEMA
]
```

```ts title="src/schema.ts"
import { Schema } from '@ghuri/graphql'
import { BlogMutation, BlogQuery, CommentType } from './blog/schema'

export const schema = new Schema({
  query: [BlogQuery],          // every app's Query class, merged (name clashes are errors)
  mutation: [BlogMutation],
  types: [CommentType],        // types reachable only through relations
})
```

The schema is built on first use, so importing it from `settings.ts` is fine even though the
apps are not loaded yet. `schema.validate()` builds it eagerly and throws configuration errors
(useful in a test).

Each app created with `ghuri startapp` has a commented `schema.ts` to start from. The
[example blog](https://github.com/ghurijs/examples/tree/main/blog) has a complete one.

## Types from models

```ts title="src/blog/schema.ts"
import { Field, ModelType, Node, type ResolveInfo, String as GString } from '@ghuri/graphql'
import type { QuerySet } from '@ghuri/orm'
import { Comment, Post, Tag } from './models'

export class TagType extends ModelType {
  static Meta = { model: Tag, fields: ['id', 'name', 'slug'], interfaces: [Node] }
}

export class PostType extends ModelType {
  static Meta = {
    model: Post,
    fields: ['id', 'title', 'slug', 'body', 'author', 'tags', 'published', 'comments', 'createdAt'],
    interfaces: [Node],
    filterFields: { title: ['exact', 'icontains'], published: ['exact'], author__username: ['exact'] },
    orderBy: ['createdAt', 'title'],
  }

  // extra fields
  static fields = {
    excerpt: Field(GString, { resolve: (post: Post) => post.body.slice(0, 140) }),
  }

  // a resolver for an existing field: resolve<Field>(parent, args, info)
  static resolveTitle(post: Post) {
    return post.title.trim()
  }

  // row-level scoping, applied wherever PostType objects are fetched
  static getQueryset(qs: QuerySet<Post>, info: ResolveInfo) {
    const user = info.context.user
    if (user.isStaff) return qs
    return qs.filter({ published: true })
  }
}
```

`fields` (default `'__all__'`) or `exclude` choose the model fields. **List fields explicitly for
models with sensitive columns**: a `ModelType` for the user model should expose
`['id', 'username']`, never `password` or `email` by accident.

| Model field | GraphQL type |
|---|---|
| primary key | `ID!` (a global ID when the type implements `Node`) |
| `CharField`, `TextField`, `SlugField`, `EmailField`, `URLField`, `GenericIPAddressField` | `String` |
| `IntegerField`, `SmallIntegerField`, `Positive*IntegerField` | `Int` |
| `BigIntegerField`, `PositiveBigIntegerField` | `BigInt` (a number when safe, else a string) |
| `FloatField`, `DurationField` (milliseconds) | `Float` |
| `DecimalField` | `Decimal` (a string) |
| `BooleanField` | `Boolean` |
| `DateField`, `DateTimeField`, `TimeField` | `Date`, `DateTime`, `Time` |
| `UUIDField`, `JSONField`, `BinaryField` | `UUID`, `JSON`, `Base64` |
| `FileField`, `ImageField` | `String` (the file URL) |
| a field with `choices` | an enum `<Model><Field>` (`Meta.convertChoicesToEnum: false` to keep strings) |
| `ForeignKey`, `OneToOneField` | the related type |
| reverse FK, `ManyToManyField`, reverse M2M | `[Related!]!`, or a connection when the related type implements `Node` |

Fields are non-null unless the model field has `null: true`. Relations to models without a
`ModelType` are skipped (an error if you list them in `fields`). Custom model fields map with
`registerFieldConverter('MoneyField', () => Decimal)`.

Plain graphene-style types are there too: `ObjectType`, `InputObjectType`, `Interface`, `Union`,
`Enum` (`class Episode extends Enum { static values = { NEWHOPE: 4 } }` or `Enum.from(...)`), with
`Field`, `List`, `NonNull` and `Argument` wrappers and the scalars `String`, `Int`, `Float`,
`Boolean`, `ID`, `DateTime`, `DateScalar`, `Time`, `Decimal`, `JSONScalar`, `UUID`,
`BigIntScalar` and `Base64`.

## Queries

```ts title="src/blog/schema.ts (continued)"
import { ConnectionField, Field, List, NonNull, Node, Query, String as GString } from '@ghuri/graphql'
import { Post } from './models'
// PostType: defined above

export class BlogQuery extends Query {
  static fields = {
    posts: List(PostType),                       // root lists default to Model.objects.all()
    post: Field(PostType, {
      args: { slug: NonNull(GString) },
      resolve: (_root: unknown, { slug }: { slug: string }) => Post.objects.get({ slug }),
    }),
    allPosts: ConnectionField(PostType),         // Relay connection with filter / orderBy
    node: Node.Field(),                          // node(id: ID!): Node
  }
}
```

Resolvers receive `(parent, args, info)`. `info.context` holds `user` (the authenticated user),
`c` (the Hono context), `request`, `auth`, `loaders` and a `state` object. QuerySets returned for
`ModelType` lists go through the type's `getQueryset()`.

:::caution[Return QuerySets synchronously]
A QuerySet is thenable, so an `async` resolver (or an `async getQueryset`) that returns one runs
the query before Ghuri can apply `getQueryset()`, pagination or the optimizer. Return the
QuerySet from a plain function.
:::

`schema.execute(query, { user, variables })` runs an operation without HTTP (scripts, agents,
tests); `schema.printSchema()` returns the SDL.

## Relay connections and filters

```graphql
{
  allPosts(
    first: 10
    after: "YXJyYXljb25uZWN0aW9uOjk="
    filter: { title: { icontains: "workers" }, or: [{ published: { exact: true } }, { authorUsername: { exact: "ann" } }] }
    orderBy: ["-createdAt"]
  ) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { cursor node { id title author { username } } }
  }
}
```

- **Nodes.** Types with `interfaces: [Node]` get global IDs (`base64("PostType:42")`, see
  `toGlobalId` / `fromGlobalId`); `Node.Field()` and `Node.ListField()` fetch any node,
  `Node.Field(PostType)` a typed one. `getQueryset()` applies, so hidden rows return `null`.
- **Pagination.** `first` / `after` and `last` / `before` with offset cursors, compatible with
  graphene. Without `first` / `last` the page size is `RELAY_CONNECTION_MAX_LIMIT`; asking for
  more is an error. `ConnectionField(PostType, { maxLimit: 50 })` sets a per-field limit.
  `totalCount` only runs a `COUNT` when it is selected.
- **Filters.** One nested `filter` input per type, built from `Meta.filterFields`:
  `['title']` allows `exact`; `{ title: ['icontains', 'exact'] }` lists the lookups. Every ORM
  lookup is available (`iexact`, `contains`, `in`, `gt`, `gte`, `lt`, `lte`, `startswith`,
  `range`, `isnull`, `year`, …). Relations span with `__`: `author__username` becomes
  `authorUsername`. Combine with `and`, `or` and `not`. IDs accept raw primary keys and global
  IDs.
- **Ordering.** `orderBy: ["-createdAt", "title"]` over the fields in `Meta.orderBy` (or the
  field's `orderBy` option; `'__all__'` allows every concrete field). A primary key is always
  appended so pages are stable.
- Reverse foreign keys and many-to-many relations to `Node` types are connections too, with the
  related type's filters and ordering.

:::note[Why not `title_Icontains`?]
graphene-django with django-filter generates one flat argument per lookup
(`title_Icontains: "x"`). Ghuri uses a nested `filter:` input instead, which keeps the field list
short, composes with `and` / `or` / `not` and is easy to build from variables.
:::

## Mutations

### With a REST serializer

The recommended way: your `ModelSerializer` validates the input, runs `create()` / `update()`
and its field validators, and permission classes decide who may do it.

```ts title="src/blog/schema.ts (continued)"
import { ModelMutation, Mutation, type ResolveInfo, SerializerMutation } from '@ghuri/graphql'
import { IsAuthenticated } from '@ghuri/rest'
import { Post } from './models'
import { IsAuthorOrReadOnly } from './permissions'
import { PostSerializer } from './serializers'

export class CreatePost extends SerializerMutation {
  static Meta = {
    serializerClass: PostSerializer,
    modelOperations: ['create'] as const,
    permissionClasses: [IsAuthenticated],
  }
  // like PostViewSet.performCreate()
  static async performMutate(serializer: PostSerializer, info: ResolveInfo) {
    await serializer.save({ author: info.context.user })
    return { ...(await serializer.getData()), errors: [] }
  }
}

export class UpdatePost extends SerializerMutation {
  static Meta = {
    serializerClass: PostSerializer,
    modelOperations: ['update'] as const,
    permissionClasses: [IsAuthenticated, IsAuthorOrReadOnly],
  }
}

export class DeletePost extends ModelMutation {
  static Meta = { model: Post, operation: 'delete' as const, permissionClasses: [IsAuthenticated, IsAuthorOrReadOnly] }
}

export class BlogMutation extends Mutation {
  static fields = { createPost: CreatePost.field(), updatePost: UpdatePost.field(), deletePost: DeletePost.field() }
}
```

```graphql
mutation {
  createPost(input: { title: "Hello", slug: "hello", tags: ["news"], clientMutationId: "a1" }) {
    id slug errors { field messages } clientMutationId
  }
}
```

The input type (`CreatePostInput`) holds the serializer's writable fields; the payload has its
readable fields plus `errors` and `clientMutationId`. **Validation errors come back in `errors`**
(`[{ field: "slug", messages: ["Post with this Slug already exists."] }]`), not as GraphQL
errors, like graphene-django. An input with the lookup field (`id` by default, `Meta.lookupField`
to change it) updates with `partial: true`; the object is found through the type's
`getQueryset()`, so users cannot update rows they cannot see. The serializer context has
`request` (with `user`), so `CurrentUserDefault` works. Override `getSerializerKwargs()` or
`performMutate()` to customize. `@ghuri/rest` is an optional peer: the package never imports it.

### Model mutations

`ModelMutation` handles `create`, `update` and `delete` without a serializer (validation through
`fullClean()`), or with `serializerClass`. Payloads are `{ post, errors, clientMutationId }` for
create / update and `{ ok, deletedId, errors, clientMutationId }` for delete.

### Plain mutations

```ts
import { Boolean as GBoolean, Field, ID, loginRequired, Mutation, NonNull } from '@ghuri/graphql'
import { Post } from './models'
// PostType: defined above

class PublishPost extends Mutation {
  static Arguments = { id: NonNull(ID) }
  static fields = { post: Field(PostType), ok: GBoolean }
  static mutate = loginRequired(async (_root: unknown, { id }: { id: string }) => {
    const post = await Post.objects.get({ id })
    post.published = true
    await post.save()
    return { post, ok: true }
  })
}
```

`ClientIDMutation` (`static Input`, `static mutateAndGetPayload()`) is the Relay variant.

## Authentication and permissions

`info.context.user` is the request user. The view authenticates with `authenticationClasses` (or
`GRAPHQL.AUTHENTICATION_CLASSES`), the same classes as the REST framework; without them it uses
the user set by `AuthenticationMiddleware`.

- **CSRF.** The view is exempt from `CsrfMiddleware`, so token and JWT clients just send the
  `Authorization` header. CSRF is enforced for **session-authenticated `POST`s**; GraphiQL sends
  the token for you. Invalid credentials give 401 with `WWW-Authenticate`, CSRF failures 403.
- **Decorators** for resolvers: `loginRequired`, `staffMemberRequired`, `superuserRequired`,
  `permissionRequired('blog.change_post')`, `userPassesTest(fn)`. Anonymous users get
  `extensions.code: "UNAUTHENTICATED"`, others `"PERMISSION_DENIED"`.
- **Permission classes** from `@ghuri/rest`: on fields
  (`Field(T, { permissionClasses: [IsAuthenticated] })`, also `ConnectionField`), on mutations
  (`Meta.permissionClasses`: `hasPermission`, then `hasObjectPermission` for updates and
  deletes; `request.method` is `POST`, `PATCH` or `DELETE`, so `ModelPermissions` checks `add_`,
  `change_` and `delete_` permissions) and on types (`ModelType` `Meta.permissionClasses`: lists
  drop objects that fail `hasObjectPermission`, single fields raise `PERMISSION_DENIED`).
- **Row-level scoping** belongs in `getQueryset(qs, info)` on the type: it applies to root
  lists, connections, `node`, relations and mutation lookups.

## The view and GraphiQL

`GraphQLView` follows the
[GraphQL over HTTP](https://graphql.github.io/graphql-over-http/) specification:

- `GET` with `query`, `variables` and `operationName` parameters (queries only: a mutation over
  `GET` is **405**), `POST` with `application/json`, `application/graphql` or a form.
- With `Accept: application/graphql-response+json`, parse and validation errors are **400**;
  with `application/json` (or no `Accept`) every well-formed request is 200 with `errors` in the
  body. Malformed JSON or a missing query is 400, other content types 415.
- **GraphiQL** is served to browsers when `graphiql`, `GRAPHQL.GRAPHIQL` or `DEBUG` is on (pinned
  CDN assets). Add `?raw` to a browser URL to get JSON instead.
- Unexpected exceptions are masked as `"Internal server error"`; Ghuri errors (permission denied,
  validation, not found, REST `APIException`s) keep their message. Every error has
  `extensions.code`; with `DEBUG` the original exception and stack are in
  `extensions.exception`.
- Options of `asView()`: `schema`, `graphiql`, `authenticationClasses`, `batch`, `maxDepth`,
  `maxComplexity`, `introspection`, `validationRules`, `persistedQueries` (`documentId` or APQ
  hashes → query text) with `persistedQueriesOnly`, `getContext(c, ctx)` and `debug`.

## Performance

- **No N+1.** Foreign keys, reverse foreign keys, one-to-ones and many-to-many relations are
  loaded through per-request **DataLoaders**: one batched `__in` query per relation and nesting
  level (two for many-to-many), however many rows the page has. `selectRelated` /
  `prefetchRelated` results are reused when present. Add your own loaders with
  `info.context.loaders.get(key, batchFn)`.
- **Optimizer.** `optimize(qs, info)` in a resolver, or `new Schema({ …, optimize: true })` /
  `GRAPHQL.OPTIMIZE` for every root list and connection, turns the selection into
  `selectRelated` (forward foreign keys) and `prefetchRelated` (argument-less reverse and
  many-to-many lists of types with the default `getQueryset`); `{ only: true }` also limits
  columns.
- **Limits.** `MAX_DEPTH` rejects deeply nested queries and `MAX_COMPLEXITY` expensive ones
  (`first` / `last` multiply the cost of nested selections). Connections never return more than
  `RELAY_CONNECTION_MAX_LIMIT` rows. Consider `INTROSPECTION: false` and persisted queries for
  public production APIs.

## Settings

```ts title="src/settings.ts"
GRAPHQL: {
  SCHEMA: schema,
  GRAPHIQL: true,                     // default: DEBUG
  MAX_DEPTH: 10,
  MAX_COMPLEXITY: 5000,
  INTROSPECTION: true,
  RELAY_CONNECTION_MAX_LIMIT: 100,
  BATCH: false,
  AUTHENTICATION_CLASSES: [TokenAuthentication, SessionAuthentication],
  OPTIMIZE: false,
},
```

Every key is described in the [settings reference](/docs/reference/settings/#graphql-ghurigraphql).
View options override them per view.

## The `graphql_schema` command

With `GraphQLConfig` installed:

```sh
npx ghuri graphql_schema                          # SDL of GRAPHQL.SCHEMA to stdout
npx ghuri graphql_schema --out schema.graphql --sort
npx ghuri graphql_schema --json --out schema.json # introspection result, for client code generators
```

See the [CLI reference](/docs/reference/cli/#graphql_schema-graphqlconfig).

## Testing

```ts title="src/blog/tests.ts"
import { assertResponseHasErrors, assertResponseNoErrors, graphqlQuery, payloadErrors } from '@ghuri/graphql/testing'
import { expect, it } from 'vitest'
// client: a test client for the app (createTestClient); token: a Token key for a user

it('filters posts', async () => {
  const res = await graphqlQuery(client, '{ allPosts(filter: { title: { icontains: "d1" } }) { edges { node { slug } } } }')
  assertResponseNoErrors(res)
  expect(res.data.allPosts.edges).toHaveLength(1)
})

it('needs a login to create', async () => {
  const anon = await graphqlQuery(client, 'mutation { createPost(input: { title: "x", slug: "x" }) { id } }')
  assertResponseHasErrors(anon, { code: 'UNAUTHENTICATED' })

  const res = await graphqlQuery(client, 'mutation ($i: CreatePostInput!) { createPost(input: $i) { errors { field messages } } }', {
    variables: { i: { title: '', slug: 'taken' } },
    headers: { Authorization: `Token ${token}` },
  })
  expect(payloadErrors(res.data.createPost)).toHaveProperty('title')
})
```

`graphqlQuery(client, query, { variables, operationName, headers, method: 'GET', csrf, path })`
works with the core test client (and `APIClient.client`); `client.forceLogin(user)` gives session
authentication with the CSRF token sent automatically. Or skip HTTP with
`schema.execute(query, { user })`. See [Testing](/docs/topics/testing/).

## For graphene-django users

| graphene-django | @ghuri/graphql |
|---|---|
| `class PostType(DjangoObjectType): class Meta: model = Post` | `class PostType extends ModelType { static Meta = { model: Post } }` |
| `fields = (...)` / `exclude = (...)` | `Meta.fields` / `Meta.exclude` |
| `def resolve_title(self, info)` | `static resolveTitle(post, args, info)` |
| `title = graphene.String()` | `static fields = { title: String }` |
| `graphene.Field(T, id=graphene.ID(required=True))` | `Field(T, { args: { id: NonNull(ID) } })` |
| `graphene.List(T)`, `graphene.NonNull(T)`, `required=True` | `List(T)`, `NonNull(T)`, `{ required: true }` |
| `get_queryset(cls, queryset, info)` | `static getQueryset(qs, info)` (synchronous) |
| `info.context.user` | `info.context.user` (Hono context: `info.context.c`) |
| `class Query(blog.schema.Query, shop.schema.Query, graphene.ObjectType)` | `new Schema({ query: [BlogQuery, ShopQuery] })` |
| `graphene.Schema(query=Query, mutation=Mutation)` | `new Schema({ query, mutation, types })` |
| `relay.Node`, `relay.Node.Field()` | `Node`, `Node.Field()`, `Node.ListField()` |
| `DjangoFilterConnectionField(T)` + `filter_fields` | `ConnectionField(T)` + `Meta.filterFields` |
| `allPosts(title_Icontains: "x")` | `allPosts(filter: { title: { icontains: "x" } })` |
| `order_by` (django-filter `OrderingFilter`) | `orderBy: ["-createdAt"]` + `Meta.orderBy` |
| `RELAY_CONNECTION_MAX_LIMIT` | `GRAPHQL.RELAY_CONNECTION_MAX_LIMIT` |
| `graphene.Mutation` + `class Arguments` + `mutate()` | `Mutation` + `static Arguments` + `static mutate()` |
| `relay.ClientIDMutation` + `mutate_and_get_payload()` | `ClientIDMutation` + `static mutateAndGetPayload()` |
| `SerializerMutation` (`serializer_class`, `model_operations`, `lookup_field`) | `SerializerMutation` (`serializerClass`, `modelOperations`, `lookupField`) |
| `ErrorType` (`field`, `messages`) | `ErrorType` (`field`, `messages`) |
| `@login_required`, `@permission_required` (django-graphql-jwt) | `loginRequired`, `permissionRequired`, `staffMemberRequired`, `superuserRequired` |
| `GraphQLView.as_view(graphiql=True)` | `GraphQLView.asView({ graphiql: true })` |
| `GRAPHENE = {'SCHEMA': 'mysite.schema.schema'}` | `GRAPHQL: { SCHEMA: schema }` |
| `./manage.py graphql_schema` | `npx ghuri graphql_schema` |
| `GraphQLTestCase.query()` | `graphqlQuery(client, …)` |
| graphene-django-optimizer | built in: DataLoaders + `optimize` |

Differences worth knowing: generated mutation payloads are named `<Mutation>Payload`; connection
edges are `[XEdge!]!` with `totalCount` built in; types are not registered globally, so a
`ModelType` only reachable through relations must be listed in `Schema({ types })`.
