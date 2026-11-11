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
  ModelSerializer, CharField, SlugRelatedField, SerializerMethodField, ValidationError,
} from '@ghuri/rest'
import { Post, Tag, Comment } from './models'

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

Try it in `npx ghuri shell`:

```ts
> const s = new PostSerializer(await Post.objects.get({ slug: 'hello-ghuri' }))
> await s.getData()
{ id: 1, title: 'Hello, Ghuri', slug: 'hello-ghuri', summary: '', body: '', published: true,
  authorName: 'rifat', tags: ['typescript'], commentCount: 1, createdAt: '2026-11-12T08:14:03.201Z' }

> const input = new PostSerializer({ data: { title: 'lorem ipsum', slug: 'hello-ghuri' } })
> await input.isValid()
false
> input.errors
{ title: ['Write a real title.'], slug: ['post with this slug already exists.'] }
```

Serializing is asynchronous (`await s.getData()`), because fields such as `authorName` and
`commentCount` may need the database. That is the main difference from DRF, where
`serializer.data` is a plain property.

## Viewsets

A viewset groups the views for one resource. `ModelViewSet` provides `list`, `create`,
`retrieve`, `update`, `partialUpdate` and `destroy`. Add these to `src/blog/views.ts` (the
function views from Part 1 can stay):

```ts title="src/blog/views.ts"
import {
  ModelViewSet, ReadOnlyModelViewSet, IsAuthenticatedOrReadOnly, SearchFilter, OrderingFilter,
  FieldFilter, action, APIResponse,
} from '@ghuri/rest'
import type { Context } from 'hono'
import { Post, Tag, Comment } from './models'
import { PostSerializer, TagSerializer, CommentSerializer } from './serializers'
import { IsAuthorOrReadOnly } from './permissions'

export class PostViewSet extends ModelViewSet<Post> {
  serializerClass = PostSerializer
  permissionClasses = [IsAuthenticatedOrReadOnly, IsAuthorOrReadOnly]
  filterBackends = [SearchFilter, OrderingFilter, FieldFilter]
  searchFields = ['title', 'body']
  orderingFields = ['createdAt', 'title']
  filtersetFields = ['published', 'tags__name']
  lookupField = 'slug'

  getQueryset() {
    const qs = Post.objects.selectRelated('author').prefetchRelated('tags')
    // Anonymous readers only see published posts; authors also see their drafts.
    const user = this.request.user
    return user.isAuthenticated ? qs : qs.filter({ published: true })
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

  @action({ detail: true, methods: ['get', 'post'] })
  async comments(c: Context) {
    const post = await this.getObject()
    if (this.request.method === 'POST') {
      const serializer = new CommentSerializer({ data: this.request.data })
      await serializer.isValid({ raiseException: true })
      await serializer.save({ post, author: this.request.user })
      return new APIResponse(await serializer.getData(), 201)
    }
    const comments = post.comments.filter({ approved: true }).selectRelated('author')
    return new APIResponse(await new CommentSerializer(comments, { many: true }).getData())
  }
}

export class TagViewSet extends ReadOnlyModelViewSet<Tag> {
  queryset = Tag.objects.all()
  serializerClass = TagSerializer
}
```

A custom permission keeps people from editing each other's posts. Create
`src/blog/permissions.ts`:

```ts title="src/blog/permissions.ts"
import { BasePermission, SAFE_METHODS, type APIRequest } from '@ghuri/rest'
import type { Post } from './models'

export class IsAuthorOrReadOnly extends BasePermission {
  hasObjectPermission(request: APIRequest, _view: unknown, post: Post) {
    if (SAFE_METHODS.includes(request.method)) return true
    return post.authorId === request.user.pk
  }
}
```

## Routers

A router generates URL patterns for a viewset. Update `src/blog/urls.ts`:

```ts title="src/blog/urls.ts"
import { path, include } from '@ghuri/core'
import { DefaultRouter } from '@ghuri/rest'
import * as views from './views'

const router = new DefaultRouter()
router.register('posts', views.PostViewSet)
router.register('tags', views.TagViewSet)

export const appName = 'blog'

export const urlpatterns = [
  path('', views.index, { name: 'index' }),
  path('api/', include(router.urls)),
  path('<slug:slug>/', views.detail, { name: 'detail' }),
]
```

You now have:

| URL | Methods |
|---|---|
| `/blog/api/` | `GET` (API root) |
| `/blog/api/posts/` | `GET`, `POST` |
| `/blog/api/posts/<slug>/` | `GET`, `PUT`, `PATCH`, `DELETE` |
| `/blog/api/posts/<slug>/publish/` | `POST` |
| `/blog/api/posts/<slug>/comments/` | `GET`, `POST` |
| `/blog/api/tags/`, `/blog/api/tags/<pk>/` | `GET` |

The `api/` pattern comes before `<slug:slug>/` so that a post called "api" does not shadow it.

```sh
curl 'http://localhost:8787/blog/api/posts/?search=ghuri&ordering=-createdAt'
curl 'http://localhost:8787/blog/api/posts/?tags__name=typescript'
```

:::tip[If you know Django]
This is DRF: `ModelSerializer` with `class Meta` as `static Meta`, `ModelViewSet`, `@action`,
`DefaultRouter().register()`, `perform_create` as `performCreate`, `get_queryset` as
`getQueryset`. Two things are async that are not in DRF: `isValid()` (unique validators query
the database) and reading output with `getData()`.
:::

## Authentication

Browsers that are logged into the admin already have a session, so `SessionAuthentication`
works for them. For other clients, turn on token authentication in settings:

```ts title="src/settings.ts"
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
import { IsAuthenticatedOrReadOnly, PageNumberPagination } from '@ghuri/rest'

export default defineSettings((env) => ({
  // ...
  REST_FRAMEWORK: {
    DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, TokenAuthentication],
    DEFAULT_PERMISSION_CLASSES: [IsAuthenticatedOrReadOnly],
    DEFAULT_PAGINATION_CLASS: PageNumberPagination,
    PAGE_SIZE: 20,
  },
}))
```

Add an endpoint that exchanges a username and password for a token:

```ts title="src/urls.ts" ins={2,8}
import { path, include, json } from '@ghuri/core'
import { obtainAuthToken } from '@ghuri/auth/rest'
// ...

export const urlpatterns = [
  path('', (c) => json(c, { hello: 'ghuri' }), { name: 'home' }),
  path('blog/', include(blog)),
  path('api/token/', obtainAuthToken),
  path('admin/', admin.site.urls),
]
```

`obtainAuthToken` is CSRF-exempt and expects JSON. Get a token and use it:

```sh
curl -X POST http://localhost:8787/api/token/ \
  -H 'Content-Type: application/json' \
  -d '{"username": "rifat", "password": "correct horse"}'
# {"token":"9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"}

curl -X POST http://localhost:8787/blog/api/posts/ \
  -H 'Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b' \
  -H 'Content-Type: application/json' \
  -d '{"title": "Written over the API", "slug": "over-the-api", "tags": ["typescript"]}'
```

The response is `201 Created` with the serialized post, and `authorName` is `rifat` because
`performCreate` set the author from the request. If you prefer JWTs, use `JWTAuthentication`
with `TokenObtainPairView` and `TokenRefreshView`; see
[REST authentication](/docs/topics/rest/authentication/).

## OpenAPI docs

Add a schema and interactive docs in two lines:

```ts title="src/urls.ts"
import { SchemaView, ScalarView } from '@ghuri/rest'

// inside urlpatterns:
path('api/schema/', SchemaView.asView(), { name: 'openapi-schema' }),
path('api/docs/', ScalarView.asView({ urlName: 'openapi-schema' })),
```

Open `http://localhost:8787/api/docs/` to browse and try every endpoint. The schema is built
from your serializers, so it stays in sync with the code. See
[OpenAPI](/docs/topics/rest/openapi/).

## Testing the API

`startapp` created `src/blog/tests.ts`. Add a test that exercises the API through the real
middleware and URL stack:

```ts title="src/blog/tests.ts"
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApp } from '@ghuri/core'
import { createTestClient } from '@ghuri/core/testing'
import { setupTestDatabase } from '@ghuri/orm/testing'
import { User } from '@ghuri/auth'
import settings from '../settings'
import { Post } from './models'

const app = createApp(settings)
let db: Awaited<ReturnType<typeof setupTestDatabase>>

beforeAll(async () => {
  await app.setup({ SECRET_KEY: 'test', DEBUG: 'true' })
  db = await setupTestDatabase({ using: 'sqlite' })
})
afterAll(() => db.teardown())

describe('posts API', () => {
  it('hides drafts from anonymous users', async () => {
    const author = await User.objects.createUser({ username: 'a', password: 'pw-123456' })
    await Post.objects.create({ title: 'Draft', slug: 'draft', author })
    await Post.objects.create({ title: 'Live', slug: 'live', author, published: true })

    const client = createTestClient(app, { env: { SECRET_KEY: 'test' } })
    const res = await client.get('/blog/api/posts/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.map((p: { slug: string }) => p.slug)).toEqual(['live'])
  })
})
```

```sh
npx ghuri test
```

More in [Testing](/docs/topics/testing/).

You have a complete backend. The last step is to put it on the internet:
[Part 5: Deploy to Cloudflare](/docs/tutorial/part-5-deploy/).
