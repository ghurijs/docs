---
title: 'Part 1: Your first app and models'
description: Create a project, add a blog app, write a view, and define your first models.
---

This tutorial builds a small blog: posts with tags and comments, an admin to write them, a
JSON API to read them, and a deployment to Cloudflare. It follows the same arc as Django's
"polls" tutorial, so if you have done that one, the steps will feel familiar.

By the end of this part you will have a project, a `blog` app with two views, and three models.

## Create the project

Make sure you have Node.js 20 or later (see [Installation](/docs/getting-started/installation/)),
then run:

```sh
npm create ghuri@latest mysite -- --db d1 --yes
cd mysite
npx ghuri migrate
npm run dev
```

`--yes` accepts the defaults (npm, install dependencies, initialise git); leave it out to answer
the questions yourself. `startproject` already wrote a `.dev.vars` with a random `SECRET_KEY`,
and `migrate` created the tables for the built-in apps (content types, users, sessions, tokens
and the admin log) in a local D1 database.

Visit `http://localhost:8787/`. You should see
`{"project":"mysite","admin":"/admin/","api":"/api/","docs":"/api/docs/"}`, which comes from the home view in
`src/urls.ts`. Leave the server running; it reloads when you save files.

:::tip[If you know Django]
This is `django-admin startproject mysite` followed by `python manage.py migrate` and
`python manage.py runserver`. The development server is `wrangler dev`, which runs your code in
the same `workerd` runtime Cloudflare uses in production, with a local SQLite file standing in
for D1.
:::

## Create the blog app

A project is a collection of apps. Each app is a directory under `src/` that owns some models,
views and URLs. Create one (in a second terminal, from the project root):

```sh
npx ghuri startapp blog
```

This writes `src/blog/` with `app.ts`, `models.ts`, `views.ts`, `urls.ts`, `serializers.ts`,
`admin.ts`, `tests.ts` and a `migrations/index.ts`. Open `src/blog/app.ts`:

```ts title="src/blog/app.ts"
import { AppConfig } from '@ghuri/core'
import * as admin from './admin'
import * as migrations from './migrations'
import * as models from './models'

export class BlogConfig extends AppConfig {
  name = 'blog'
  verboseName = 'Blog'
  path = import.meta.dirname
  models = models
  migrations = migrations
  admin = admin
}
```

An `AppConfig` tells Ghuri what the app contains. Because a Worker is a bundle with no
filesystem, apps import their own modules instead of having Ghuri discover them by name:
whatever `models.ts` exports becomes the app's models, and importing `admin.ts` registers its
admin classes. `path` is only used by the CLI, to know where to write migration files.

`startapp` also installed the app for you: it added the import and the list entry to
`src/settings.ts`.

```ts title="src/settings.ts" ins={4,15}
// ...
import { r2 } from '@ghuri/storage'
import { urlpatterns } from './urls'
import { BlogConfig } from './blog/app'

export default defineSettings((env) => ({
  // ...
  INSTALLED_APPS: [
    ContentTypesConfig,
    AuthConfig,
    SessionsConfig,
    AuthTokenConfig,
    AdminConfig,
    RestFrameworkConfig,
    BlogConfig,
  ],
  // ...the rest is unchanged
}))
```

If your settings file does not have the usual shape, `startapp` prints the two lines to add
instead.

## Write your first view

Views are functions that receive a [Hono `Context`](https://hono.dev/docs/api/context) and
return a `Response`. `startapp` created one in `src/blog/views.ts`; change its body:

```ts title="src/blog/views.ts"
import type { Context } from 'hono'

export function index(c: Context) {
  return c.text("Hello, world. You're at the blog index.")
}
```

The app's own URLconf, `src/blog/urls.ts`, already maps it:

```ts title="src/blog/urls.ts"
import { path, urlpatterns as patterns } from '@ghuri/core'
import { index } from './views'

export const urlpatterns = patterns('blog', [
  path('', index, { name: 'index' }),
])
```

`urlpatterns('blog', [...])` (imported here as `patterns`) builds a pattern list with an
`appName`, Django's `app_name = 'blog'`. Include the app's patterns from the root URLconf:

```ts title="src/urls.ts" ins={5,18}
import { admin } from '@ghuri/admin'
import { include, path } from '@ghuri/core'
import { DefaultRouter } from '@ghuri/rest'
import type { Context } from 'hono'
import { urlpatterns as blogUrls } from './blog/urls'

/** REST API router: register viewsets here, e.g. `router.register('posts', PostViewSet)`. */
export const router = new DefaultRouter()

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

Visit `http://localhost:8787/blog/` and you will see the greeting.

`include()` accepts a pattern array or a module that exports `urlpatterns`. Because the blog
patterns carry `appName = 'blog'`, their URL names live in the `blog` namespace, so elsewhere
you can write `reverse('blog:index')`. Routes use Django's syntax: `'posts/<int:id>/'` matches
`/posts/42/` and gives you `id` as a number. Read more in
[URLs and views](/docs/topics/urls-and-views/).

:::tip[If you know Django]
`path()`, `include()`, `reverse()`, namespaces, `app_name` (here the first argument of
`urlpatterns()`) and the `<int:id>` converters all behave as in Django. The only change is that
a view takes Hono's `Context` (`c`) instead of an `HttpRequest`, and you reach the request
through `c.req`.
:::

## Define models

Now the interesting part. A blog needs posts, tags and comments. `src/blog/models.ts` contains a
commented-out example; replace it with:

```ts title="src/blog/models.ts"
import {
  BooleanField, CASCADE, CharField, DateTimeField, ForeignKey, Manager, ManyToManyField, Model,
  type RelatedManager, SlugField, TextField,
} from '@ghuri/orm'
import { User } from '@ghuri/auth'

export class Tag extends Model({
  name: new CharField({ maxLength: 50, unique: true }),
}) {
  declare static objects: Manager<Tag>

  toString() {
    return this.name
  }
}

export class Post extends Model({
  title: new CharField({ maxLength: 200 }),
  slug: new SlugField({ unique: true }),
  body: new TextField({ blank: true }),
  published: new BooleanField({ default: false }),
  author: new ForeignKey(() => User, { onDelete: CASCADE, relatedName: 'posts' }),
  tags: new ManyToManyField(() => Tag, { blank: true, relatedName: 'posts' }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
  updatedAt: new DateTimeField({ autoNow: true }),
}) {
  static Meta = { ordering: ['-createdAt'] }
  declare static objects: Manager<Post>
  declare comments: RelatedManager<Comment>

  toString() {
    return this.title
  }
}

export class Comment extends Model({
  post: new ForeignKey(() => Post, { onDelete: CASCADE, relatedName: 'comments' }),
  author: new ForeignKey(() => User, { onDelete: CASCADE, relatedName: 'comments' }),
  body: new TextField(),
  approved: new BooleanField({ default: true }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  static Meta = { ordering: ['createdAt'] }
  declare static objects: Manager<Comment>

  toString() {
    return `Comment by ${this.authorId} on ${this.postId}`
  }
}
```

A few things to notice:

- **`Model({...})` takes the fields and returns a base class.** You extend it to add methods
  and `Meta`. TypeScript infers instance properties from the fields, so `post.title` is a
  `string`, `post.published` a `boolean` and `post.createdAt` a `Date`.
- **Every model gets an `id` primary key** (`BigAutoField`) unless you mark a field
  `primaryKey: true`.
- **Options are camelCase.** Django's `max_length`, `auto_now_add` and `related_name` become
  `maxLength`, `autoNowAdd` and `relatedName`. Columns in the database are still snake_case:
  `createdAt` is stored as `created_at`.
- **Relations take a function** (`() => User`) so models can refer to each other regardless of
  declaration order. A string such as `'auth.User'` also works.
- **A foreign key has two properties on instances**: `post.authorId` is the raw id, and
  `await post.author` loads the related `User`.
- **Reverse relations** get the name in `relatedName` (`user.posts`, `post.comments`). Without
  one, the default is camelCase `<modelName>Set`, so it would be `user.postSet`.
- **`declare` lines are for TypeScript only.** Every model has an `objects` manager;
  `declare static objects: Manager<Post>` tells TypeScript that queries return `Post` instances
  with your methods, and `declare comments: RelatedManager<Comment>` types the reverse side of
  `Comment.post`. Use `declare`, never a class field with an initializer.

:::tip[If you know Django]
This is almost a transliteration of a Django `models.py`. `class Meta:` becomes
`static Meta = {...}`, `__str__` becomes `toString()`, and fields are passed to `Model()` rather
than declared as class attributes. That last change is what lets TypeScript infer types for
every field without a code generator.
:::

Because `models` in `BlogConfig` is `import * as models from './models'`, all three classes are
registered to the `blog` app automatically. Their database tables will be called `blog_tag`,
`blog_post` and `blog_comment`, and the many-to-many table `blog_post_tags`.

## Try the models in a view

Models do nothing until their tables exist, which is the subject of
[Part 2](/docs/tutorial/part-2-migrations/). But you can already write the views that will list
published posts and show one. Replace `src/blog/views.ts`:

```ts title="src/blog/views.ts"
import type { Context } from 'hono'
import { json } from '@ghuri/core'
import { getObjectOr404 } from '@ghuri/orm'
import { Post } from './models'

export async function index(c: Context) {
  const posts = await Post.objects
    .filter({ published: true })
    .selectRelated('author')
    .slice(0, 20)

  return json(c, {
    posts: await Promise.all(
      posts.map(async (p) => ({ title: p.title, slug: p.slug, author: (await p.author).username })),
    ),
  })
}

export async function detail(c: Context) {
  const post = await getObjectOr404(Post.objects.filter({ published: true }), { slug: c.req.param('slug') })
  return json(c, { title: post.title, body: post.body, createdAt: post.createdAt })
}
```

```ts title="src/blog/urls.ts" ins={6}
import { path, urlpatterns as patterns } from '@ghuri/core'
import { detail, index } from './views'

export const urlpatterns = patterns('blog', [
  path('', index, { name: 'index' }),
  path('<slug:slug>/', detail, { name: 'detail' }),
])
```

Every database call is `async`: a QuerySet is lazy, and nothing touches the database until you
`await` it. `selectRelated('author')` fetches each post's author in the same query, so
`await p.author` does not hit the database again. `getObjectOr404` raises `Http404` when nothing
matches, which Ghuri turns into a 404 response.

:::note
`src/blog/tests.ts`, which `startapp` generated, checks that `index` returns
`{ app: 'blog' }`. It no longer does; you will replace that test in
[Part 4](/docs/tutorial/part-4-rest-api/#testing-the-api).
:::

If you reload `/blog/` now you will get an error about a missing `blog_post` table. That is
expected. Continue to [Part 2: Migrations](/docs/tutorial/part-2-migrations/).
