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
`performCreate`, `@action(detail=True)` → `@action({ detail: true })`. Handlers receive
`(request, kwargs)`: the DRF request and the URL keyword arguments. Both are also on the view as
`this.request` and `this.kwargs`, and the Hono context is `this.c`.
:::

## The request object

The handler's `request` argument (also `this.request`) is an `APIRequest` wrapping the incoming
request:

| Property | Contents |
|---|---|
| `request.data` | Parsed body (JSON, form or multipart). Files are `File` objects |
| `request.files` | Uploaded files by field name |
| `request.query` | Query parameters as `Record<string, string>` (first value per key) |
| `request.queryParams` | The full `URLSearchParams` (DRF's `query_params`), for repeated keys |
| `request.user` | The authenticated user, or `AnonymousUser` |
| `request.auth` | Whatever the authentication class returned as the token |
| `request.method` | `'GET'`, `'POST'`, … |
| `request.raw` | The underlying fetch `Request` |
| `request.c` | The Hono context |

`request.data` is parsed before the handler runs, so it is a plain property, not a promise. On
the view, `this.kwargs` holds the URL keyword arguments, `this.format` the requested format
suffix, and `this.c` the Hono context (`this.c.get('session')`, `this.c.env` …).

## APIView

Subclass `APIView` and add methods named after HTTP verbs. Return an `APIResponse` (DRF's
`Response`, rendered by content negotiation), any fetch `Response` (sent as is), or plain data,
which is wrapped in an `APIResponse` for you.

```ts title="src/blog/views.ts"
import { APIView, APIResponse, IsAuthenticated, type APIRequest } from '@ghuri/rest'
import { Post } from './models'

export class StatsView extends APIView {
  permissionClasses = [IsAuthenticated]

  async get(request: APIRequest) {
    const user = request.user
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

Methods you do not define return `405 Method Not Allowed` with an `Allow` header. `OPTIONS`
returns metadata (`SimpleMetadata`), including the fields a `POST` or `PUT` accepts. Policy
attributes you can set on any API view:

`authenticationClasses`, `permissionClasses`, `throttleClasses`, `throttleScope`,
`parserClasses`, `rendererClasses` (JSON plus the browsable API by default),
`contentNegotiationClass`, `metadataClass` and `schema`. Override `initial(request)`,
`handleException(exc)`, `finalizeResponse()`, `getPermissions()` or `checkObjectPermissions()`
as in DRF. API views are CSRF-exempt; session-based authentication enforces CSRF itself.

## GenericAPIView

`GenericAPIView` adds the plumbing that model-backed views need:

| Attribute / method | Purpose |
|---|---|
| `queryset` | Base QuerySet. Re-evaluated per request, so it is safe to set on the class |
| `serializerClass` | Serializer used for input and output |
| `lookupField` / `lookupUrlKwarg` | Default `'pk'` |
| `paginationClass`, `filterBackends` | Override the `REST_FRAMEWORK` defaults (`paginationClass = null` disables paging) |
| `getQueryset()` | Override to scope by user, add annotations, … |
| `getObject()` | Loads one object (404 if missing) and runs object permissions |
| `getSerializer(opts)` / `getSerializerClass()` | Build the serializer; `opts` are serializer options, `context` is added |
| `getSerializerContext()` | `{ request, view, format }` |
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
export class CommentList extends ListCreateAPIView {
  serializerClass = CommentSerializer

  getQueryset() {
    return Comment.objects.filter({ post: this.kwargs.postId }).selectRelated('author')
  }

  async performCreate(serializer: CommentSerializer) {
    await serializer.save({ author: this.request.user, postId: this.kwargs.postId })
  }
}

// urls.ts
path('api/posts/<int:postId>/comments/', CommentList.asView())
```

`this.kwargs` holds the URL keyword arguments for hooks that do not receive them as an argument.

## Mixins

The generic views are compositions of `GenericAPIView` and these mixins:

| Mixin | Method | Hooks |
|---|---|---|
| `ListModelMixin` | `list(request)` | — |
| `CreateModelMixin` | `create(request)` | `performCreate(serializer)` |
| `RetrieveModelMixin` | `retrieve(request)` | — |
| `UpdateModelMixin` | `update(request)`, `partialUpdate(request)` | `performUpdate(serializer)` |
| `DestroyModelMixin` | `destroy(request)` | `performDestroy(instance)` |

TypeScript has no multiple inheritance, so mixins are class factories: functions that take a
base class and return a subclass. DRF's
`class TagList(ListModelMixin, CreateModelMixin, GenericAPIView)` becomes:

```ts
import { GenericAPIView, GenericViewSet, ListModelMixin, CreateModelMixin, type APIRequest } from '@ghuri/rest'

export class TagList extends ListModelMixin(CreateModelMixin(GenericAPIView)) {
  queryset = Tag.objects.all()
  serializerClass = TagSerializer

  async get(request: APIRequest) { return this.list(request) }
  async post(request: APIRequest) { return this.create(request) }
}

// a viewset with only list and create
export class TagViewSet extends CreateModelMixin(ListModelMixin(GenericViewSet)) {}
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
import {
  ModelViewSet, IsAuthenticatedOrReadOnly, SearchFilter, OrderingFilter, FieldFilter,
  action, APIResponse, type APIRequest,
} from '@ghuri/rest'
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
  async publish(request: APIRequest) {
    const post = await this.getObject()
    post.published = true
    await post.save({ updateFields: ['published'] })
    return new APIResponse({ status: 'published' })
  }

  @action({ detail: false })
  async mine(request: APIRequest) {
    const qs = this.filterQueryset(this.getQueryset().filter({ author: request.user.pk }))
    const page = await this.paginateQueryset(qs)
    const data = await this.getSerializer({ instance: page ?? qs, many: true }).getData()
    return page ? this.getPaginatedResponse(data) : new APIResponse(data)
  }
}
```

`this.action` is the name of the action being run (`'list'`, `'publish'`, …). Use it to vary the
queryset, serializer or permissions per action. `this.detail` and `this.basename` are set too, and
`this.reverseAction('detail', { pk })` builds the absolute URL of another route of the viewset.

### Custom actions

`@action` is a standard TC39 (stage 3) decorator, which TypeScript 5, esbuild and wrangler compile
by default. It also works as a legacy `experimentalDecorators` decorator. Options:

| Option | Default | Meaning |
|---|---|---|
| `detail` | required | `true` → `/posts/<pk>/publish/`; `false` → `/posts/mine/` |
| `methods` | `['get']` | Allowed HTTP methods |
| `urlPath` | method name in kebab-case | URL segment (`setFeatured` → `set-featured/`) |
| `urlName` | method name in kebab-case | Route name suffix, e.g. `post-set-featured` |
| `permissionClasses`, `serializerClass`, `throttleScope`, `name`, … | inherited | Per-action overrides |

```ts
@action({ detail: true, methods: ['post'], permissionClasses: [IsAdminUser] })
async setFeatured(request: APIRequest) { ... }   // POST /posts/<pk>/set-featured/
```

Without decorators, list the actions in a static map:

```ts
class PostViewSet extends ModelViewSet<Post> {
  static actions = { publish: action({ detail: true, methods: ['post'] }) }
  async publish(request: APIRequest) { ... }
}
```

:::caution[Vitest]
Vite 8 transforms TypeScript with oxc, which does not lower TC39 decorators yet. Either
pre-transform test files with esbuild in `vitest.config.ts` or use `static actions`.
:::

## Function-based API views

For small endpoints, wrap a function with `apiView()`. You get the request wrapper, parsing,
authentication, permissions and exception handling, without a class.

```ts
import { apiView, IsAuthenticated } from '@ghuri/rest'

export const whoami = apiView(['GET'], { permissionClasses: [IsAuthenticated] })(
  async (request, kwargs) => ({ id: request.user.pk, username: request.user.username }),
)

// urls.ts
path('api/whoami/', whoami)
```

The function receives `(request, kwargs, view)`; plain data is wrapped in an `APIResponse`. The
options object takes the same policy attributes as `APIView` (`rendererClasses`,
`parserClasses`, `authenticationClasses`, `permissionClasses`, `throttleClasses`,
`throttleScope`, `schema` …).

## Plain Hono views still work

API views are just views. Anything in `urlpatterns` can be a plain `(c) => Response`, and you can
mix them freely with REST views. Reach for `@ghuri/rest` when you want its policies; use
`json(c, data)` from `@ghuri/core` when you do not.
