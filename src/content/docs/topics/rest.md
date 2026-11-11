---
title: REST framework
description: An overview of @ghuri/rest, a Django REST framework clone for TypeScript, with a quick start and the REST_FRAMEWORK settings.
---

`@ghuri/rest` is a port of [Django REST framework](https://www.django-rest-framework.org/)
(DRF). It gives you serializers that validate input and render output, class-based API views
and viewsets, routers that generate URL patterns, and the policies around them: permissions,
authentication, pagination, filtering, throttling and an OpenAPI 3.1 schema.

Everything is built on the same pieces as the rest of Ghuri. Serializers read your model's
`_meta` to build their fields, viewsets run QuerySets through the ORM, and routers return plain
`UrlPatterns` that you `include()` in `urls.ts`.

:::tip[If you know Django]
The class names, attribute names and settings keys are DRF's, converted to `camelCase`:
`serializer_class` is `serializerClass`, `permission_classes` is `permissionClasses`,
`perform_create` is `performCreate`. Settings keep DRF's `UPPER_SNAKE` names inside
`REST_FRAMEWORK`. The biggest difference is that anything touching the database is `async`, so
you `await serializer.isValid()` and `await serializer.getData()` instead of reading
`serializer.data`.
:::

## Quick start

This builds a read-write API for the tutorial blog's `Post` model. It assumes the `blog` app
from the [tutorial](/docs/tutorial/part-1-models/) is installed.

**1. Write a serializer.** A `ModelSerializer` derives its fields from the model.

```ts title="src/blog/serializers.ts"
import { ModelSerializer, StringRelatedField } from '@ghuri/rest'
import { Post } from './models'

export class PostSerializer extends ModelSerializer<Post> {
  static Meta = {
    model: Post,
    fields: ['id', 'title', 'slug', 'body', 'published', 'author', 'tags', 'createdAt'],
    readOnlyFields: ['author', 'createdAt'],
  }
  author = new StringRelatedField()
}
```

**2. Write a viewset.** `ModelViewSet` provides list, create, retrieve, update, partial update
and destroy.

```ts title="src/blog/views.ts"
import { ModelViewSet, IsAuthenticatedOrReadOnly } from '@ghuri/rest'
import { Post } from './models'
import { PostSerializer } from './serializers'

export class PostViewSet extends ModelViewSet<Post> {
  queryset = Post.objects.selectRelated('author').prefetchRelated('tags')
  serializerClass = PostSerializer
  permissionClasses = [IsAuthenticatedOrReadOnly]

  async performCreate(serializer: PostSerializer) {
    await serializer.save({ author: this.request.user })
  }
}
```

**3. Register it with a router** and include the router's URLs.

```ts title="src/blog/urls.ts"
import { include, path } from '@ghuri/core'
import { DefaultRouter } from '@ghuri/rest'
import { PostViewSet } from './views'

const router = new DefaultRouter()
router.register('posts', PostViewSet)

export const urlpatterns = [path('api/', include(router.urls))]
```

That gives you:

| Method and path | Action |
|---|---|
| `GET /api/` | API root listing the registered endpoints |
| `GET /api/posts/` | `list` |
| `POST /api/posts/` | `create` |
| `GET /api/posts/<pk>/` | `retrieve` |
| `PUT /api/posts/<pk>/` | `update` |
| `PATCH /api/posts/<pk>/` | `partialUpdate` |
| `DELETE /api/posts/<pk>/` | `destroy` |

Try it:

```sh
curl http://localhost:8787/api/posts/
curl -X POST http://localhost:8787/api/posts/ \
  -H 'Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b' \
  -H 'Content-Type: application/json' \
  -d '{"title": "Hello", "slug": "hello", "body": "First post"}'
```

## How a request flows

When a request reaches an API view, `@ghuri/rest` runs these steps in order, the same way DRF
does:

1. **Parse.** The body is parsed according to `Content-Type` (JSON, form or multipart) and
   exposed lazily as `this.request.data`. Query parameters are on `this.request.query`.
2. **Authenticate.** Each class in `authenticationClasses` is tried in turn. The first one that
   returns a user sets `this.request.user`; if none does, the user is anonymous.
3. **Check permissions.** Every class in `permissionClasses` must allow the request.
   Object-level checks run later, when `getObject()` loads the instance.
4. **Throttle.** Each class in `throttleClasses` may reject the request with `429`.
5. **Dispatch** to the handler (`get`, `post`, …, or a viewset action such as `list`).
6. **Handle exceptions.** `APIException` subclasses, Ghuri's `Http404`/`PermissionDenied` and
   validation errors are turned into JSON responses with DRF's error shapes.

## Error responses

Errors use the shapes DRF clients already expect:

```json
// 400 from a serializer
{ "title": ["This field is required."], "slug": ["post with this slug already exists."] }

// 401, 403, 404, 405, 429
{ "detail": "Authentication credentials were not provided." }
```

Raise them yourself with the exception classes from `@ghuri/rest`: `APIException`,
`ValidationError`, `ParseError`, `NotAuthenticated`, `AuthenticationFailed`,
`PermissionDenied`, `NotFound`, `MethodNotAllowed` and `Throttled`.

```ts
import { APIException } from '@ghuri/rest'

export class ServiceUnavailable extends APIException {
  static statusCode = 503
  static defaultDetail = 'Service temporarily unavailable, try again later.'
  static defaultCode = 'service_unavailable'
}
```

## The `REST_FRAMEWORK` setting

Project-wide defaults live under one settings key. Any view can override them with its own
attributes.

```ts title="src/settings.ts"
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
import {
  IsAuthenticatedOrReadOnly, PageNumberPagination,
  FieldFilter, SearchFilter, OrderingFilter,
  AnonRateThrottle, UserRateThrottle,
} from '@ghuri/rest'

export default defineSettings((env) => ({
  // ...
  REST_FRAMEWORK: {
    DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, TokenAuthentication],
    DEFAULT_PERMISSION_CLASSES: [IsAuthenticatedOrReadOnly],
    DEFAULT_PAGINATION_CLASS: PageNumberPagination,
    PAGE_SIZE: 20,
    DEFAULT_FILTER_BACKENDS: [FieldFilter, SearchFilter, OrderingFilter],
    DEFAULT_THROTTLE_CLASSES: [AnonRateThrottle, UserRateThrottle],
    DEFAULT_THROTTLE_RATES: { anon: '100/hour', user: '1000/day' },
  },
}))
```

| Key | Default | Purpose |
|---|---|---|
| `DEFAULT_AUTHENTICATION_CLASSES` | `[SessionAuthentication, BasicAuthentication]` when `@ghuri/auth` is installed, else `[]` | How `request.user` is determined |
| `DEFAULT_PERMISSION_CLASSES` | `[AllowAny]` | Who may call a view |
| `DEFAULT_PAGINATION_CLASS` | `null` (no pagination) | How list responses are paged |
| `PAGE_SIZE` | `null` | Page size for the default paginator |
| `DEFAULT_FILTER_BACKENDS` | `[]` | Backends applied in `filterQueryset()` |
| `DEFAULT_THROTTLE_CLASSES` | `[]` | Rate limits applied to every view |
| `DEFAULT_THROTTLE_RATES` | `{}` | Rates per scope, e.g. `{ anon: '100/day' }` |
| `SEARCH_PARAM` | `'search'` | Query parameter for `SearchFilter` |
| `ORDERING_PARAM` | `'ordering'` | Query parameter for `OrderingFilter` |
| `NON_FIELD_ERRORS_KEY` | `'non_field_errors'` | Key for errors raised from `validate()` |
| `UNAUTHENTICATED_USER` | `AnonymousUser` | User used when nobody authenticated |

Class references are classes, not dotted strings. That is how the bundler sees them and why your
editor can jump to them.

## Where to go next

- [Serializers](/docs/topics/rest/serializers/): validation, nested data, custom fields.
- [Views and viewsets](/docs/topics/rest/views/): `APIView`, generics, mixins, `@action`.
- [Routers](/docs/topics/rest/routers/): URL generation and the API root.
- [Permissions](/docs/topics/rest/permissions/) and
  [authentication](/docs/topics/rest/authentication/).
- [Pagination](/docs/topics/rest/pagination/), [filtering](/docs/topics/rest/filtering/) and
  [throttling](/docs/topics/rest/throttling/).
- [OpenAPI](/docs/topics/rest/openapi/): schema generation, Swagger UI and Scalar.
