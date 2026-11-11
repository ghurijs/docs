---
title: 'Part 1: Your first app and models'
description: Create a project, add a blog app, write a view, and define your first models.
---

This tutorial builds a small blog: posts with tags and comments, an admin to write them, a
JSON API to read them, and a deployment to Cloudflare. It follows the same arc as Django's
"polls" tutorial, so if you have done that one, the steps will feel familiar.

By the end of this part you will have a project, a `blog` app with one view, and three models.

## Create the project

Make sure you have Node.js 20 or later (see [Installation](/docs/getting-started/installation/)),
then run:

```sh
npm create ghuri@latest mysite
cd mysite
cp .dev.vars.example .dev.vars
npm run dev
```

Visit `http://localhost:8787/`. You should see `{"hello":"ghuri"}`, which comes from the home
view in `src/urls.ts`. Leave the server running; it reloads when you save files.

:::tip[If you know Django]
This is `django-admin startproject mysite` followed by `python manage.py runserver`. The
development server is `wrangler dev`, which runs your code in the same `workerd` runtime
Cloudflare uses in production, with a local SQLite file standing in for D1.
:::

## Create the blog app

A project is a collection of apps. Each app is a directory under `src/` that owns some models,
views and URLs. Create one:

```sh
npx ghuri startapp blog
```

This writes `src/blog/` with `app.ts`, `models.ts`, `views.ts`, `urls.ts`, `serializers.ts`,
`admin.ts`, `tests.ts` and an empty `migrations/` package. Open `src/blog/app.ts`:

```ts title="src/blog/app.ts"
import { AppConfig } from '@ghuri/core'
import * as models from './models'
import * as migrations from './migrations'
import * as admin from './admin'

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

Install the app by adding it to `INSTALLED_APPS`:

```ts title="src/settings.ts" ins={6,13}
import { defineSettings, SecurityMiddleware, CommonMiddleware, CsrfMiddleware, kvCache } from '@ghuri/core'
import { d1, postgres } from '@ghuri/orm'
import { r2 } from '@ghuri/storage'
import { AuthConfig, SessionMiddleware, AuthenticationMiddleware } from '@ghuri/auth'
import { AdminConfig } from '@ghuri/admin'
import { BlogConfig } from './blog/app'
import { urlpatterns } from './urls'

export default defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  DEBUG: env.DEBUG === 'true',
  ALLOWED_HOSTS: ['*'],
  INSTALLED_APPS: [AuthConfig, AdminConfig, BlogConfig],
  // ...the rest is unchanged
}))
```

## Write your first view

Views are functions that receive a [Hono `Context`](https://hono.dev/docs/api/context) and
return a `Response`. Open `src/blog/views.ts`:

```ts title="src/blog/views.ts"
import type { Context } from 'hono'

export function index(c: Context) {
  return c.text("Hello, world. You're at the blog index.")
}
```

Wire it to a URL in the app's own URLconf:

```ts title="src/blog/urls.ts"
import { path } from '@ghuri/core'
import * as views from './views'

export const appName = 'blog'

export const urlpatterns = [
  path('', views.index, { name: 'index' }),
]
```

Then include the app's patterns from the root URLconf:

```ts title="src/urls.ts" ins={3,7}
import { path, include, json } from '@ghuri/core'
import { admin } from '@ghuri/admin'
import * as blog from './blog/urls'

export const urlpatterns = [
  path('', (c) => json(c, { hello: 'ghuri' }), { name: 'home' }),
  path('blog/', include(blog)),
  path('admin/', admin.site.urls),
]
```

Visit `http://localhost:8787/blog/` and you will see the greeting.

`include()` accepts a pattern array, or (as here) a module that exports `urlpatterns` and
optionally `appName`. Exporting `appName = 'blog'` puts the app's URL names in the `blog`
namespace, so elsewhere you can write `reverse('blog:index')`. Routes use Django's syntax:
`'posts/<int:id>/'` matches `/posts/42/` and gives you `id` as a number. Read more in
[URLs and views](/docs/topics/urls-and-views/).

:::tip[If you know Django]
`path()`, `include()`, `reverse()`, namespaces, `appName` (Django's `app_name`) and the
`<int:id>` converters all behave as in Django. The only change is that a view takes Hono's
`Context` (`c`) instead of an `HttpRequest`, and you reach the request through `c.req`.
:::

## Define models

Now the interesting part. A blog needs posts, tags and comments. Open `src/blog/models.ts`:

```ts title="src/blog/models.ts"
import {
  Model, CharField, SlugField, TextField, BooleanField, DateTimeField,
  ForeignKey, ManyToManyField, CASCADE, Manager,
} from '@ghuri/orm'
import { User } from '@ghuri/auth'

export class Tag extends Model({
  name: new CharField({ maxLength: 50, unique: true }),
}) {
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
- **`declare static objects: Manager<Post>`** is optional. Every model has an `objects`
  manager; the `declare` line only tells TypeScript that queries return `Post` instances with
  your custom methods, instead of the generic base type.

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
[Part 2](/docs/tutorial/part-2-migrations/). But you can already write the view that will list
published posts. Replace `src/blog/views.ts`:

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

```ts title="src/blog/urls.ts" ins={8}
import { path } from '@ghuri/core'
import * as views from './views'

export const appName = 'blog'

export const urlpatterns = [
  path('', views.index, { name: 'index' }),
  path('<slug:slug>/', views.detail, { name: 'detail' }),
]
```

Every database call is `async`: a QuerySet is lazy, and nothing touches the database until you
`await` it. `selectRelated('author')` fetches each post's author in the same query, so
`await p.author` does not hit the database again. `getObjectOr404` raises `Http404` when nothing
matches, which Ghuri turns into a 404 response.

If you reload `/blog/` now you will get an error about a missing `blog_post` table. That is
expected. Continue to [Part 2: Migrations](/docs/tutorial/part-2-migrations/).
