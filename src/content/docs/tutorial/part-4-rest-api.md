---
title: 'Part 4: A REST API'
description: Expose posts, tags and comments as a JSON API with serializers, viewsets, routers, permissions and token authentication.
---

The blog has an admin for writers. Readers, mobile apps and frontends need an API. In this part
you will build one with `@ghuri/rest`, which follows Django REST framework closely.

## Serializers

A serializer turns model instances into JSON-ready objects and validates incoming data before
it reaches your models. Open `src/blog/serializers.ts`:

```ts title="src/blog/serializers.ts"
import {
  CharField, ModelSerializer, SerializerMethodField, SlugRelatedField, ValidationError,
} from '@ghuri/rest'
import { Comment, Post, Tag } from './models'

export class TagSerializer extends ModelSerializer<Tag> {
  static Meta = { model: Tag, fields: ['id', 'name'] }
}

export class CommentSerializer extends ModelSerializer<Comment> {
  static Meta = { model: Comment, fields: ['id', 'post', 'authorName', 'body', 'createdAt'], readOnlyFields: ['post'] }
  authorName = new CharField({ source: 'author.username', readOnly: true })
}

export class PostSerializer extends ModelSerializer<Post> {
  static Meta = {
    model: Post,
    fields: ['id', 'title', 'slug', 'summary', 'body', 'published', 'authorName', 'tags', 'commentCount', 'createdAt'],
  }
  authorName = new CharField({ source: 'author.username', readOnly: true })
  tags = new SlugRelatedField({ slugField: 'name', many: true, queryset: Tag.objects.all(), required: false })
  commentCount = new SerializerMethodField()

  async getCommentCount(post: Post) {
    return post.comments.filter({ approved: true }).count()
  }

  validateTitle(value: string) {
    if (value.toLowerCase().includes('lorem ipsum')) {
      throw new ValidationError('Write a real title.')
    }
    return value
  }
}
```

`ModelSerializer` reads the model's fields and builds matching serializer fields, with the same
validation rules (`maxLength`, `unique`, choices). You override or add fields as class
properties: here `authorName` follows the `author` relation, `tags` uses tag names instead of
ids, and `commentCount` is computed by a method named `get<FieldName>`.

`validate<FieldName>` methods validate a single field, and `validate(attrs)` validates the
object as a whole.

Here is what using it looks like (the shell only preloads models, so try this in a test or a
view):

```ts
const s = new PostSerializer(await Post.objects.get({ slug: 'hello-ghuri' }))
await s.getData()
// { id: 1, title: 'Hello, Ghuri', slug: 'hello-ghuri', summary: '', body: '', published: true,
//   authorName: 'rifat', tags: ['typescript'], commentCount: 1, createdAt: '2026-11-12T08:14:03.201Z' }

const input = new PostSerializer({ data: { title: 'lorem ipsum', slug: 'hello-ghuri' } })
await input.isValid()   // false
input.errors
// { title: ['Write a real title.'], slug: ['post with this slug already exists.'] }

await input.isValid({ raiseException: true })   // throws ValidationError: a 400 response in a view
```

A model instance can be passed directly; the full form is
`new PostSerializer({ instance, data, partial, context, many })`.

Serializing is asynchronous (`await s.getData()`), because fields such as `authorName` and
`commentCount` may need the database. That is the main difference from DRF, where
`serializer.data` is a plain property.

## Viewsets

A viewset groups the views for one resource. `ModelViewSet` provides `list`, `create`,
`retrieve`, `update`, `partialUpdate` and `destroy`. Add these to `src/blog/views.ts` (the
function views from Part 1 can stay):

```ts title="src/blog/views.ts"
import {
  action, APIResponse, type APIRequest, FieldFilter, IsAdminUser, IsAuthenticatedOrReadOnly,
  ModelViewSet, OrderingFilter, ReadOnlyModelViewSet, SearchFilter,
} from '@ghuri/rest'
import { Post, Tag } from './models'
import { IsAuthorOrReadOnly } from './permissions'
import { CommentSerializer, PostSerializer, TagSerializer } from './serializers'

export class PostViewSet extends ModelViewSet<Post> {
  serializerClass = PostSerializer
  permissionClasses = [IsAuthenticatedOrReadOnly, IsAuthorOrReadOnly.or(IsAdminUser)]
  filterBackends = [SearchFilter, OrderingFilter, FieldFilter]
  searchFields = ['title', 'body']
  orderingFields = ['createdAt', 'title']
  filtersetFields = ['published', 'tags__name']
  lookupField = 'slug'

  getQueryset() {
    const qs = Post.objects.selectRelated('author').prefetchRelated('tags')
    // Anonymous readers only see published posts; signed-in users also see drafts.
    const user = this.request.user
    return user.isAuthenticated ? qs : qs.filter({ published: true })
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

  @action({ detail: true, methods: ['get', 'post'] })
  async comments(request: APIRequest) {
    const post = await this.getObject()
    if (request.method === 'POST') {
      const serializer = new CommentSerializer({ data: request.data })
      await serializer.isValid({ raiseException: true })
      await serializer.save({ post, author: request.user })
      return new APIResponse(await serializer.getData(), 201)
    }
    const comments = await post.comments.filter({ approved: true }).selectRelated('author')
    return new APIResponse(await new CommentSerializer({ instance: comments, many: true }).getData())
  }
}

export class TagViewSet extends ReadOnlyModelViewSet<Tag> {
  queryset = Tag.objects.all()
  serializerClass = TagSerializer
}
```

Handlers, including `@action` methods, receive the REST `request` (`request.data`,
`request.user`, `request.query`, and the Hono context as `request.c`); `this.request` is the same
object. `@action` is a standard TC39 decorator; without decorators, write
`static actions = { publish: action({ detail: true, methods: ['post'] }) }`.

A custom permission keeps people from editing each other's posts. Create
`src/blog/permissions.ts`:

```ts title="src/blog/permissions.ts"
import { type APIRequest, BasePermission, SAFE_METHODS } from '@ghuri/rest'
import type { Post } from './models'

export class IsAuthorOrReadOnly extends BasePermission {
  message = 'Only the author can change this post.'

  hasObjectPermission(request: APIRequest, _view: unknown, post: Post) {
    if (SAFE_METHODS.includes(request.method)) return true
    return post.authorId === request.user.pk
  }
}
```

Permission classes compose like DRF's `&`, `|` and `~` operators through static helpers:
`IsAuthorOrReadOnly.or(IsAdminUser)` lets staff edit any post, and `.and()` and `.not()` work the
same way. Each returns a new permission class.

## Routers

A router generates URL patterns for a viewset. The project already has one: `src/urls.ts`
exports a `DefaultRouter` mounted at `api/`. Register the viewsets there:

```ts title="src/urls.ts" ins={5,10-11}
import { admin } from '@ghuri/admin'
import { include, path } from '@ghuri/core'
import { DefaultRouter } from '@ghuri/rest'
import type { Context } from 'hono'
import { PostViewSet, TagViewSet } from './blog/views'
import { urlpatterns as blogUrls } from './blog/urls'

/** REST API router: register viewsets here, e.g. `router.register('posts', PostViewSet)`. */
export const router = new DefaultRouter()
router.register('posts', PostViewSet)
router.register('tags', TagViewSet)

function home(c: Context) {
  return c.json({ project: 'mysite', admin: '/admin/', api: '/api/' })
}

export const urlpatterns = [
  path('', home, { name: 'home' }),
  path('admin/', admin.site.urls),
  path('api/', include(router.urls)),
  path('blog/', include(blogUrls)),
]
```

You now have:

| URL | Name | Methods |
|---|---|---|
| `/api/` | `api-root` | `GET` (API root) |
| `/api/posts/` | `post-list` | `GET`, `POST` |
| `/api/posts/<slug>/` | `post-detail` | `GET`, `PUT`, `PATCH`, `DELETE` |
| `/api/posts/<slug>/publish/` | `post-publish` | `POST` |
| `/api/posts/<slug>/comments/` | `post-comments` | `GET`, `POST` |
| `/api/tags/`, `/api/tags/<pk>/` | `tag-list`, `tag-detail` | `GET` |

```sh
curl 'http://localhost:8787/api/posts/?search=ghuri&ordering=-createdAt'
curl 'http://localhost:8787/api/posts/?tags__name=typescript'
```

List responses are paginated by the project's `PageNumberPagination` setting:
`{ "count": …, "next": …, "previous": …, "results": [ … ] }`. Open `/api/posts/` in a browser
to get the browsable API.

:::tip[If you know Django]
This is DRF: `ModelSerializer` with `class Meta` as `static Meta`, `ModelViewSet`, `@action`,
`DefaultRouter().register()`, `perform_create` as `performCreate`, `get_queryset` as
`getQueryset`. Two things are async that are not in DRF: `isValid()` (unique validators query
the database) and reading output with `getData()`. `Response` is called `APIResponse` so it
does not shadow fetch's `Response`.
:::

## Authentication

The generated settings already configure the REST framework for you:

```ts title="src/settings.ts (excerpt)"
REST_FRAMEWORK: {
  DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, TokenAuthentication],
  DEFAULT_PERMISSION_CLASSES: [IsAuthenticatedOrReadOnly],
  DEFAULT_PAGINATION_CLASS: PageNumberPagination,
  PAGE_SIZE: 20,
},
```

Browsers that are logged into the admin already have a session, so `SessionAuthentication`
works for them (and enforces CSRF on unsafe methods). Other clients send a token, stored by the
`authtoken` app (`AuthTokenConfig`, already in `INSTALLED_APPS`). Add an endpoint that exchanges
a username and password for a token:

```ts title="src/urls.ts" ins={1,8}
import { obtainAuthToken } from '@ghuri/auth/rest'
// ...

export const urlpatterns = [
  path('', home, { name: 'home' }),
  path('admin/', admin.site.urls),
  path('api/', include(router.urls)),
  path('api-token-auth/', obtainAuthToken),
  path('blog/', include(blogUrls)),
]
```

`obtainAuthToken` is CSRF-exempt and expects JSON (or form data). Get a token and use it:

```sh
curl -X POST http://localhost:8787/api-token-auth/ \
  -H 'Content-Type: application/json' \
  -d '{"username": "rifat", "password": "correct horse"}'
# {"token":"9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"}

curl -X POST http://localhost:8787/api/posts/ \
  -H 'Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b' \
  -H 'Content-Type: application/json' \
  -d '{"title": "Written over the API", "slug": "over-the-api", "tags": ["typescript"]}'
```

The response is `201 Created` with the serialized post, and `authorName` is `rifat` because
`performCreate` set the author from the request. You can also create a token from the command
line with `npx ghuri drf_create_token rifat`. If you prefer JWTs, use `JWTAuthentication` with
`TokenObtainPairView` and `TokenRefreshView`; see
[REST authentication](/docs/topics/rest/authentication/) and
[Auth tokens](/docs/topics/auth-tokens/).

## OpenAPI docs

Add a schema and interactive docs in two lines:

```ts title="src/urls.ts"
import { DefaultRouter, ScalarView, SchemaView } from '@ghuri/rest'

// inside urlpatterns, before path('api/', include(router.urls)):
path('api/schema/', SchemaView.asView({ title: 'Blog API', version: '1.0.0' }), { name: 'openapi-schema' }),
path('api/docs/', ScalarView.asView({ urlName: 'openapi-schema' })),
```

Open `http://localhost:8787/api/docs/` to browse and try every endpoint (`SwaggerUIView` is
there too if you prefer Swagger UI). The schema is built
from your serializers, so it stays in sync with the code. See
[OpenAPI](/docs/topics/rest/openapi/).

## Testing the API

`startapp` created `src/blog/tests.ts`, whose test still expects the Part 1 `index` view. Replace
it with a test that exercises the API through the real middleware and URL stack:

```ts title="src/blog/tests.ts"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@ghuri/core'
import { createTestClient } from '@ghuri/core/testing'
import { setupTestDatabase } from '@ghuri/orm/testing'
import { User } from '@ghuri/auth'
import settings from '../settings'
import { Post } from './models'

// Use one env object everywhere: settings are resolved (and cached) per env object.
const env = { SECRET_KEY: 'test', DEBUG: 'true' }
const app = createApp(settings)
let db: Awaited<ReturnType<typeof setupTestDatabase>>

beforeAll(async () => {
  await app.setup(env)
  db = await setupTestDatabase({ using: 'sqlite' })   // in-memory, runs every migration
})
afterAll(() => db.teardown())

describe('posts API', () => {
  it('hides drafts from anonymous users', async () => {
    const author = await User.objects.createUser({ username: 'a', password: 'pw-123456' })
    await Post.objects.create({ title: 'Draft', slug: 'draft', author })
    await Post.objects.create({ title: 'Live', slug: 'live', author, published: true })

    const client = createTestClient(app, { env })
    const res = await client.get('/api/posts/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.map((p: { slug: string }) => p.slug)).toEqual(['live'])
  })
})
```

```sh
npx ghuri test
```

The generated `vitest.config.ts` picks up `src/**/tests.ts` and `*.test.ts` files, and turns on
oxc's legacy decorator mode so `@admin.register` and `@action` load under Vitest (Ghuri's
decorators work in both modes).

`setupTestDatabase()` swaps the `default` database for a fresh in-memory one (`'sqlite'`,
`'pglite'` for Postgres, or `'d1'` through Miniflare) and applies your migrations, so the test
never touches your development data. For DRF-style tests, `APIClient` from `@ghuri/rest/testing`
adds `forceAuthenticate(user)` and parsed `res.data`. More in [Testing](/docs/topics/testing/).

You have a complete backend. The last step is to put it on the internet:
[Part 5: Deploy to Cloudflare](/docs/tutorial/part-5-deploy/).
