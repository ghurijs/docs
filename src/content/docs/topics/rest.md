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

The `Token` header works once `TokenAuthentication` is listed in
`DEFAULT_AUTHENTICATION_CLASSES` ([below](#the-rest_framework-setting)); the default,
`MiddlewareAuthentication`, only sees session users.

## How a request flows

When a request reaches an API view, `@ghuri/rest` runs these steps in order, the same way DRF
does:

1. **Parse.** The body is parsed according to `Content-Type` (JSON, form or multipart) before
   your handler runs, so `this.request.data` is a plain synchronous property. A parse error
   (`ParseError` 400, `UnsupportedMediaType` 415) is raised when you first read it, as in DRF.
   Query parameters are on `this.request.query` (first value per key) and
   `this.request.queryParams` (a `URLSearchParams`).
2. **Negotiate content.** The renderer is chosen from `Accept` (JSON, or the browsable API for
   browsers).
3. **Authenticate.** Each class in `authenticationClasses` is tried in turn. The first one that
   returns a user sets `this.request.user`; if none does, the user is anonymous.
4. **Check permissions.** Every class in `permissionClasses` must allow the request.
   Object-level checks run later, when `getObject()` loads the instance.
5. **Throttle.** Each class in `throttleClasses` may reject the request with `429`.
6. **Dispatch** to the handler (`get`, `post`, …, or a viewset action such as `list`).
7. **Handle exceptions.** `APIException` subclasses, Ghuri's `Http404`/`PermissionDenied`/
   `ValidationError` and the ORM's `DoesNotExist` are turned into JSON responses with DRF's error
   shapes. Replace the handler with `REST_FRAMEWORK.EXCEPTION_HANDLER`.

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
`PermissionDenied`, `NotFound`, `MethodNotAllowed`, `NotAcceptable`, `UnsupportedMediaType` and
`Throttled`.

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
| `DEFAULT_AUTHENTICATION_CLASSES` | `[MiddlewareAuthentication]` | How `request.user` is determined |
| `DEFAULT_PERMISSION_CLASSES` | `[AllowAny]` | Who may call a view |
| `DEFAULT_RENDERER_CLASSES` | `[JSONRenderer, BrowsableAPIRenderer]` | Response formats |
| `DEFAULT_PARSER_CLASSES` | `[JSONParser, FormParser, MultiPartParser]` | Accepted request bodies |
| `DEFAULT_CONTENT_NEGOTIATION_CLASS` | `DefaultContentNegotiation` | Picks the renderer |
| `DEFAULT_METADATA_CLASS` | `SimpleMetadata` | Body of `OPTIONS` responses |
| `DEFAULT_PAGINATION_CLASS` | `null` (no pagination) | How list responses are paged |
| `PAGE_SIZE` | `null` | Page size for the default paginator |
| `DEFAULT_FILTER_BACKENDS` | `[]` | Backends applied in `filterQueryset()` |
| `DEFAULT_THROTTLE_CLASSES` | `[]` | Rate limits applied to every view |
| `DEFAULT_THROTTLE_RATES` | `{ user: null, anon: null }` | Rates per scope, e.g. `{ anon: '100/day' }` |
| `THROTTLE_CACHE` | `'default'` | Cache alias that stores throttle history |
| `NUM_PROXIES` | `null` | Trusted proxies in front of the app, for client IPs |
| `DEFAULT_SCHEMA_CLASS` | `AutoSchema` | OpenAPI schema per view |
| `SEARCH_PARAM` | `'search'` | Query parameter for `SearchFilter` |
| `ORDERING_PARAM` | `'ordering'` | Query parameter for `OrderingFilter` |
| `EXCEPTION_HANDLER` | `exceptionHandler` | Turns exceptions into responses |
| `NON_FIELD_ERRORS_KEY` | `'nonFieldErrors'` | Key for errors raised from `validate()` |
| `UNAUTHENTICATED_USER` | `() => new AnonymousUser()` | User used when nobody authenticated |
| `UNAUTHENTICATED_TOKEN` | `null` | `request.auth` when nobody authenticated |
| `URL_FORMAT_OVERRIDE` / `FORMAT_SUFFIX_KWARG` | `'format'` / `'format'` | `?format=json` and `.json` suffixes |
| `URL_FIELD_NAME` | `'url'` | Name of `HyperlinkedModelSerializer`'s URL field |
| `DATETIME_FORMAT` / `DATE_FORMAT` / `TIME_FORMAT` | `'iso-8601'` | Output formats |
| `COERCE_DECIMAL_TO_STRING` | `true` | Render decimals as strings |
| `UPLOADED_FILES_USE_URL` | `true` | Render file fields as URLs |
| `TEST_REQUEST_DEFAULT_FORMAT` | `'multipart'` | Body format of `APIClient` requests |

Class references are classes, not dotted strings. That is how the bundler sees them and why your
editor can jump to them. Settings are read at request time through `apiSettings` (DRF's
`api_settings`), so `apiSettings.PAGE_SIZE` works anywhere.

`MiddlewareAuthentication` uses the user that `AuthenticationMiddleware` already put on the
request and enforces CSRF on unsafe methods. For tokens or JWTs, list the classes from
[`@ghuri/auth/rest`](/docs/topics/rest/authentication/).

`status` holds DRF's constants and helpers: `status.HTTP_201_CREATED`, `status.isSuccess(code)`.

:::note[Not yet ported]
There are no API versioning classes and no `TemplateHTMLRenderer` yet.
:::

## Testing an API

`APIClient` from `@ghuri/rest/testing` is DRF's test client: it encodes bodies, can skip
authentication, and parses JSON responses into `res.data`.

```ts
import { APIClient } from '@ghuri/rest/testing'

const client = new APIClient(app, { env, defaultFormat: 'json' })
client.forceAuthenticate(user)                       // bypass the authentication classes
client.credentials({ Authorization: 'Token abc' })   // headers for every request
const res = await client.post('/api/posts/', { title: 'Hi', slug: 'hi' })
expect(res.status).toBe(201)
expect(res.data.title).toBe('Hi')
await client.get('/api/posts/', { search: 'hi' })    // second argument: query parameters
```

Use the same `env` object for `app.setup(env)`, `setupTestDatabase()` and the client so requests
see the test database. Formats are `'json'`, `'multipart'` (the default,
`TEST_REQUEST_DEFAULT_FORMAT`) and `'form'`. See [Testing](/docs/topics/testing/) for the rest of
the test setup.

## Where to go next

- [Serializers](/docs/topics/rest/serializers/): validation, nested data, custom fields.
- [Views and viewsets](/docs/topics/rest/views/): `APIView`, generics, mixins, `@action`.
- [Routers](/docs/topics/rest/routers/): URL generation and the API root.
- [Permissions](/docs/topics/rest/permissions/) and
  [authentication](/docs/topics/rest/authentication/).
- [Pagination](/docs/topics/rest/pagination/), [filtering](/docs/topics/rest/filtering/) and
  [throttling](/docs/topics/rest/throttling/).
- [OpenAPI](/docs/topics/rest/openapi/): schema generation, Swagger UI and Scalar.
