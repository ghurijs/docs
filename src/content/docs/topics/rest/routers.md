---
title: Routers
description: Generate URL patterns for viewsets with SimpleRouter and DefaultRouter.
---

A router turns registered viewsets into URL patterns. You register a prefix and a viewset class;
the router works out which actions the viewset supports and emits one route per URL shape.

```ts title="src/api/urls.ts"
import { include, path } from '@ghuri/core'
import { DefaultRouter } from '@ghuri/rest'
import { PostViewSet, TagViewSet, CommentViewSet } from '../blog/views'

export const router = new DefaultRouter()
router.register('posts', PostViewSet)
router.register('tags', TagViewSet)
router.register('comments', CommentViewSet, { basename: 'comment' })

export const urlpatterns = [path('api/', include(router.urls))]
```

:::tip[If you know Django]
This is DRF's router API: `router.register(prefix, viewset, basename=...)` becomes
`router.register(prefix, ViewSet, { basename })`, and `router.urls` is a `UrlPatterns` array you
pass to `include()`. Route names follow DRF (`post-list`, `post-detail`, `post-publish`), so
`reverse('post-detail', { pk: 1 })` works as you expect.
:::

## Generated routes

For `router.register('posts', PostViewSet)` with a `ModelViewSet` and the two custom actions from
the [views page](/docs/topics/rest/views/#viewsets):

| URL | Method → action | Name |
|---|---|---|
| `posts/` | `GET` → `list`, `POST` → `create` | `post-list` |
| `posts/<pk>/` | `GET` → `retrieve`, `PUT` → `update`, `PATCH` → `partialUpdate`, `DELETE` → `destroy` | `post-detail` |
| `posts/<pk>/publish/` | `POST` → `publish` | `post-publish` |
| `posts/mine/` | `GET` → `mine` | `post-mine` |

Only the actions the viewset implements are routed. A `ReadOnlyModelViewSet` produces `GET` on
both URLs and nothing else; other methods return `405`.

The `<pk>` segment uses the viewset's `lookupField` (and `lookupUrlKwarg` if set). Restrict what it
matches with `lookupValueRegex`:

```ts
export class PostViewSet extends ModelViewSet<Post> {
  lookupField = 'slug'
  lookupValueRegex = '[a-z0-9-]+'
}
// → posts/<slug>/ compiled to /posts/:slug{[a-z0-9-]+}/
```

## Basenames

The basename is the prefix of each route name. When the viewset has a `queryset` attribute, the
router derives it from the model (`Post` → `post`). If the viewset only defines `getQueryset()`,
pass `basename` explicitly; the router throws `ImproperlyConfigured` at startup if it cannot work
one out.

## SimpleRouter vs DefaultRouter

`SimpleRouter` emits exactly the routes above.

`DefaultRouter` adds an **API root** at the router's base URL: a `GET` endpoint that lists every
registered prefix with its absolute list URL.

```sh
$ curl http://localhost:8787/api/
{
  "posts": "http://localhost:8787/api/posts/",
  "tags": "http://localhost:8787/api/tags/",
  "comments": "http://localhost:8787/api/comments/"
}
```

`DefaultRouter` can also add `.json` format suffixes (`/api/posts.json`) with
`new DefaultRouter({ formatSuffixes: true })`. They are off by default because Ghuri only renders
JSON.

Both routers accept `{ trailingSlash: false }` if your API should not use trailing slashes. The
project-wide `APPEND_SLASH` redirect only applies to `GET`, so clients that `POST` to `/api/posts`
without the slash will get a `404` with the default router; pick one style and document it.

## Nesting and namespaces

Routers return ordinary patterns, so URL namespaces work the usual way:

```ts
path('api/v1/', include(router.urls, { namespace: 'v1' }))

reverse('v1:post-detail', { pk: 7 })   // → '/api/v1/posts/7/'
```

For nested resources such as `/posts/<postId>/comments/`, register a second router or write
the pattern by hand and read the parent id from the URL:

```ts
const commentRouter = new SimpleRouter()
commentRouter.register('comments', PostCommentViewSet, { basename: 'post-comment' })

export const urlpatterns = [
  path('api/', include(router.urls)),
  path('api/posts/<int:postId>/', include(commentRouter.urls)),
]
```

```ts
export class PostCommentViewSet extends ModelViewSet<Comment> {
  serializerClass = CommentSerializer
  getQueryset() {
    return Comment.objects.filter({ post: Number(this.c.req.param('postId')) })
  }
}
```

## Registering viewsets from several apps

A common layout is one `api` module that collects viewsets from all apps:

```ts title="src/urls.ts"
import { include, path } from '@ghuri/core'
import { admin } from '@ghuri/admin'
import { router } from './api/urls'

export const urlpatterns = [
  path('admin/', admin.site.urls),
  path('api/', include(router.urls)),
]
```

## Introspection

`router.registry` lists every registration. Each entry exposes `prefix`, `viewset`, `basename`
and the routed `actions` with their HTTP methods. The [OpenAPI generator](/docs/topics/rest/openapi/)
reads it to document your API, and [`ViewSetTools`](/docs/topics/agents/) reads it to turn
viewset actions into agent tools.

```ts
for (const entry of router.registry) {
  console.log(entry.prefix, entry.basename, entry.actions.map((a) => a.name))
}
// posts post [ 'list', 'create', 'retrieve', 'update', 'partialUpdate', 'destroy', 'publish', 'mine' ]
```
