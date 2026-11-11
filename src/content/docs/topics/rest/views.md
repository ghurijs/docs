---
title: Views and viewsets
description: APIView, generic views, mixins, viewsets, custom actions and function-based API views.
---

`@ghuri/rest` offers the same ladder of abstractions as DRF. Start at the top rung that fits and
drop down when you need more control:

1. **`ModelViewSet`** and friends: a full CRUD API in a few lines, wired up by a router.
2. **Generic views** (`ListCreateAPIView`, `RetrieveUpdateDestroyAPIView`, …): one URL each.
3. **`GenericAPIView` plus mixins**: pick exactly the behaviours you want.
4. **`APIView`**: write the handlers yourself, keep parsing, auth, permissions and throttling.
5. **`apiView()`**: the same policies around a plain function.

:::tip[If you know Django]
These are DRF's classes with DRF's hook names in `camelCase`: `get_queryset` → `getQueryset`,
`get_object` → `getObject`, `get_serializer_class` → `getSerializerClass`, `perform_create` →
`performCreate`, `@action(detail=True)` → `@action({ detail: true })`. Handlers receive Hono's
`Context` (`c`), and the DRF `request` is available as `this.request`.
:::

## The request object

Inside any API view, `this.request` wraps the incoming request:

| Property | Contents |
|---|---|
| `this.request.data` | Parsed body (JSON, form or multipart). Files are `File` objects |
| `this.request.query` | Query parameters as `Record<string, string>`; `queryAll(name)` for repeats |
| `this.request.user` | The authenticated user, or `AnonymousUser` |
| `this.request.auth` | Whatever the authentication class returned as the token |
| `this.request.method` | `'GET'`, `'POST'`, … |
| `this.request.raw` | The underlying `Request` |

The handler's `c` argument is the Hono context, so `c.req.param('pk')`, `c.header()` and
`c.get('session')` are all available.

## APIView

Subclass `APIView` and add methods named after HTTP verbs. Return a `Response`, or use
`APIResponse` which serializes `data` to JSON and sets the status.

```ts title="src/blog/views.ts"
import type { Context } from 'hono'
import { APIView, APIResponse, IsAuthenticated } from '@ghuri/rest'
import { Post } from './models'

export class StatsView extends APIView {
  permissionClasses = [IsAuthenticated]

  async get(c: Context) {
    const user = this.request.user
    const [total, published] = await Promise.all([
      Post.objects.filter({ author: user.pk }).count(),
      Post.objects.filter({ author: user.pk, published: true }).count(),
    ])
    return new APIResponse({ total, published })
  }
}
```

```ts title="src/blog/urls.ts"
path('api/stats/', StatsView.asView(), { name: 'stats' })
```

Methods you do not define return `405 Method Not Allowed` with an `Allow` header. Policy
attributes you can set on any API view:

`authenticationClasses`, `permissionClasses`, `throttleClasses`, `parserClasses`,
`renderers` (JSON by default), plus `initial(c)` and `handleException(err)` hooks.

## GenericAPIView

`GenericAPIView` adds the plumbing that model-backed views need:

| Attribute / method | Purpose |
|---|---|
| `queryset` | Base QuerySet. Re-evaluated per request, so it is safe to set on the class |
| `serializerClass` | Serializer used for input and output |
| `lookupField` / `lookupUrlKwarg` | Default `'pk'` |
| `paginationClass`, `filterBackends` | Override the `REST_FRAMEWORK` defaults |
| `getQueryset()` | Override to scope by user, add annotations, … |
| `getObject()` | Loads one object (404 if missing) and runs object permissions |
| `getSerializer(...)` / `getSerializerClass()` | Build the serializer with context |
| `filterQueryset(qs)` | Applies the filter backends |
| `paginateQueryset(qs)` / `getPaginatedResponse(data)` | Pagination hooks |

Always go through `getQueryset()` rather than `this.queryset` in your own code, and always load
single objects with `getObject()` so that object permissions run.

## Concrete generic views

| Class | Methods |
|---|---|
| `CreateAPIView` | `post` |
| `ListAPIView` | `get` (list) |
| `RetrieveAPIView` | `get` (one) |
| `DestroyAPIView` | `delete` |
| `UpdateAPIView` | `put`, `patch` |
| `ListCreateAPIView` | `get`, `post` |
| `RetrieveUpdateAPIView` | `get`, `put`, `patch` |
| `RetrieveDestroyAPIView` | `get`, `delete` |
| `RetrieveUpdateDestroyAPIView` | `get`, `put`, `patch`, `delete` |

```ts
export class CommentList extends ListCreateAPIView<Comment> {
  serializerClass = CommentSerializer

  getQueryset() {
    return Comment.objects.filter({ post: Number(this.c.req.param('postId')) }).selectRelated('author')
  }

  async performCreate(serializer: CommentSerializer) {
    await serializer.save({ author: this.request.user, postId: Number(this.c.req.param('postId')) })
  }
}

// urls.ts
path('api/posts/<int:postId>/comments/', CommentList.asView())
```

`this.c` holds the current Hono context for hooks that do not receive it as an argument.

## Mixins

The generic views are compositions of `GenericAPIView` and these mixins:

| Mixin | Method | Hooks |
|---|---|---|
| `ListModelMixin` | `list(c)` | — |
| `CreateModelMixin` | `create(c)` | `performCreate(serializer)` |
| `RetrieveModelMixin` | `retrieve(c)` | — |
| `UpdateModelMixin` | `update(c)`, `partialUpdate(c)` | `performUpdate(serializer)` |
| `DestroyModelMixin` | `destroy(c)` | `performDestroy(instance)` |

TypeScript has no multiple inheritance, so mixins are functions that extend a base class:

```ts
import { GenericAPIView, ListModelMixin, CreateModelMixin } from '@ghuri/rest'

export class TagList extends ListModelMixin(CreateModelMixin(GenericAPIView<Tag>)) {
  queryset = Tag.objects.all()
  serializerClass = TagSerializer

  async get(c: Context) { return this.list(c) }
  async post(c: Context) { return this.create(c) }
}
```

## ViewSets

A viewset groups the actions for one resource in one class. It does not define `get` or `post`;
it defines actions (`list`, `create`, `retrieve`, `update`, `partialUpdate`, `destroy`) and a
[router](/docs/topics/rest/routers/) maps HTTP methods and URLs onto them.

| Class | Provides |
|---|---|
| `ViewSet` | Nothing; write your own actions |
| `GenericViewSet` | `GenericAPIView` machinery, no actions; combine with mixins |
| `ReadOnlyModelViewSet` | `list`, `retrieve` |
| `ModelViewSet` | all six actions |

```ts title="src/blog/views.ts"
import type { Context } from 'hono'
import { ModelViewSet, IsAuthenticatedOrReadOnly, SearchFilter, OrderingFilter, FieldFilter, action, APIResponse } from '@ghuri/rest'
import { Post } from './models'
import { PostSerializer, PostListSerializer } from './serializers'
import { IsAuthorOrReadOnly } from './permissions'

export class PostViewSet extends ModelViewSet<Post> {
  queryset = Post.objects.selectRelated('author').prefetchRelated('tags')
  serializerClass = PostSerializer
  permissionClasses = [IsAuthenticatedOrReadOnly, IsAuthorOrReadOnly]
  filterBackends = [SearchFilter, OrderingFilter, FieldFilter]
  searchFields = ['title', 'body']
  orderingFields = ['createdAt', 'title']
  filtersetFields = ['published', 'author']
  lookupField = 'slug'

  getQueryset() {
    const qs = super.getQueryset()
    // Anonymous users and other authors only see published posts.
    if (this.action === 'list' && !this.request.user.isStaff) return qs.filter({ published: true })
    return qs
  }

  getSerializerClass() {
    return this.action === 'list' ? PostListSerializer : PostSerializer
  }

  async performCreate(serializer: PostSerializer) {
    await serializer.save({ author: this.request.user })
  }

  @action({ detail: true, methods: ['post'] })
  async publish(c: Context) {
    const post = await this.getObject()
    post.published = true
    await post.save({ updateFields: ['published'] })
    return new APIResponse({ status: 'published' })
  }

  @action({ detail: false })
  async mine(c: Context) {
    const qs = this.filterQueryset(this.getQueryset().filter({ author: this.request.user.pk }))
    const page = await this.paginateQueryset(qs)
    const data = await this.getSerializer(page ?? qs, { many: true }).getData()
    return page ? this.getPaginatedResponse(data) : new APIResponse(data)
  }
}
```

`this.action` is the name of the action being run (`'list'`, `'publish'`, …). Use it to vary the
queryset, serializer or permissions per action.

### Custom actions

`@action` is a standard TC39 decorator; do not enable `experimentalDecorators`. Options:

| Option | Default | Meaning |
|---|---|---|
| `detail` | required | `true` → `/posts/<pk>/publish/`; `false` → `/posts/mine/` |
| `methods` | `['get']` | Allowed HTTP methods |
| `urlPath` | method name | URL segment |
| `urlName` | method name | Route name suffix, e.g. `post-publish` |
| `permissionClasses`, `serializerClass`, … | inherited | Per-action overrides |

```ts
@action({ detail: true, methods: ['post'], permissionClasses: [IsAdminUser], urlPath: 'set-featured' })
async setFeatured(c: Context) { ... }
```

## Function-based API views

For small endpoints, wrap a function with `apiView()`. You get the request wrapper, parsing,
authentication, permissions and exception handling, without a class.

```ts
import { apiView, APIResponse, IsAuthenticated } from '@ghuri/rest'

export const whoami = apiView(['GET'], { permissionClasses: [IsAuthenticated] })(
  async (request, c) => new APIResponse({ id: request.user.pk, username: request.user.username }),
)

// urls.ts
path('api/whoami/', whoami)
```

## Plain Hono views still work

API views are just views. Anything in `urlpatterns` can be a plain `(c) => Response`, and you can
mix them freely with REST views. Reach for `@ghuri/rest` when you want its policies; use
`json(c, data)` from `@ghuri/core` when you do not.
