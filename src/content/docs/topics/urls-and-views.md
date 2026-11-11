---
title: URLs and views
description: URL patterns with path() and include(), converters, reverse(), function and class-based views, shortcuts and error handling.
---

Ghuri routes requests the way Django does: a root list of URL patterns (`ROOT_URLCONF`), built
with `path()` and `include()`, mapping routes to views. Under the hood the patterns compile to a
[Hono](https://hono.dev) router, and views receive Hono's `Context`.

## URL patterns

```ts title="src/urls.ts"
import { path, rePath, include } from '@ghuri/core'
import { admin } from '@ghuri/admin'
import * as blog from './blog/urls'
import { home, about, archive, feed } from './views'
import { legacyApp } from './legacy'

export const urlpatterns = [
  path('', home, { name: 'home' }),
  path('about/', about, { name: 'about' }),
  path('blog/', include(blog)),
  path('archive/<int:year>/<int:month>/', archive, { name: 'archive' }),
  rePath('^feeds/(?<format>rss|atom)/$', feed, { name: 'feed' }),
  path('admin/', admin.site.urls),
  path('legacy/', legacyApp),                  // any Hono app
]
```

`path(route, target, options?)` takes:

- **`route`**: a string with optional converters. Routes are matched in order; the first match
  wins.
- **`target`**: a view function, the result of `include()`, another pattern array (for example
  `admin.site.urls` or `router.urls`), or a `Hono` instance to mount as-is.
- **`options`**: `{ name?: string; methods?: string[] }`. `name` is used by `reverse()`;
  `methods` restricts the pattern to some HTTP methods.

`rePath()` takes a regular expression with named groups when converters are not enough.

### Converters

| Converter | Matches | Value |
|---|---|---|
| `<str:x>` or `<x>` | any non-empty segment without `/` | string |
| `<int:x>` | `0` or a positive integer | number (via `kwargs(c)`) |
| `<slug:x>` | letters, digits, `-` and `_` | string |
| `<uuid:x>` | a lowercase UUID | string |
| `<path:x>` | any non-empty string, including `/` | string |

A pattern such as `'posts/<int:id>/'` compiles to the Hono route `/posts/:id{[0-9]+}/`. Read raw
string parameters with `c.req.param('id')`, or parsed values with `kwargs(c)`:

```ts
import { kwargs } from '@ghuri/core'

export async function archive(c: Context) {
  const { year, month } = kwargs(c)    // numbers, because of <int:...>
  // ...
}
```

### `include()` and namespaces

`include()` nests patterns under a prefix. It accepts an array, or a module that exports
`urlpatterns` (and optionally `appName`):

```ts title="src/blog/urls.ts"
export const appName = 'blog'
export const urlpatterns = [
  path('', views.index, { name: 'index' }),
  path('<slug:slug>/', views.detail, { name: 'detail' }),
]
```

```ts title="src/urls.ts"
path('blog/', include(blog)),                                  // namespace 'blog' from appName
path('news/', include(blog.urlpatterns, { namespace: 'news' })), // explicit namespace
```

### Trailing slashes

With `APPEND_SLASH` on (the default), a `GET` for `/blog/hello` that matches nothing is
redirected with a 301 to `/blog/hello/` when that URL would match. Write routes with trailing
slashes, as in Django.

## Reversing URLs

Never hard-code paths. `reverse()` builds one from a pattern name and parameters:

```ts
import { reverse, redirect } from '@ghuri/core'

reverse('home')                                   // '/'
reverse('blog:detail', { slug: 'hello-ghuri' })   // '/blog/hello-ghuri/'
reverse('archive', { year: 2026, month: 11 })     // '/archive/2026/11/'

return redirect(c, 'blog:detail', { slug: post.slug })
```

`reverse()` throws `NoReverseMatch` if the name is unknown or the parameters do not fit the
converters.

## Function views

A view is any function `(c: Context) => Response | Promise<Response>`. `c` is Hono's context: the
request is `c.req`, and helpers such as `c.json()`, `c.html()` and `c.text()` build responses.

```ts title="src/blog/views.ts"
import type { Context } from 'hono'
import { json, getUser, PermissionDenied } from '@ghuri/core'
import { getObjectOr404 } from '@ghuri/orm'
import { Post } from './models'

export async function detail(c: Context) {
  const post = await getObjectOr404(Post.objects, { slug: c.req.param('slug') })
  if (!post.published && post.authorId !== getUser(c).pk) {
    throw new PermissionDenied()
  }
  return json(c, { title: post.title, body: post.body })
}
```

Throw `Http404`, `PermissionDenied`, `BadRequest` or `SuspiciousOperation` from anywhere in a
view, and Ghuri returns the matching status code. The error page is JSON when the client sends
`Accept: application/json` or the path starts with `/api`, and HTML otherwise. With `DEBUG` on,
it includes the stack trace.

### Shortcuts

| Shortcut | From | Does |
|---|---|---|
| `json(c, data, status?)` | `@ghuri/core` | JSON response, serialising `Date` and model instances via `toJSON()` |
| `redirect(c, nameOrUrl, params?)` | `@ghuri/core` | 302 to a URL, or to `reverse(name, params)` |
| `getObjectOr404(qsOrManager, lookup)` | `@ghuri/orm` | `get()` that throws `Http404` instead of `DoesNotExist` |
| `getUser(c)` | `@ghuri/core` | The request user, `AnonymousUser` if none |

### Rendering HTML with JSX

Ghuri does not have a template language; it uses Hono's JSX. Name the file `.tsx` and set
`"jsxImportSource": "hono/jsx"` in `tsconfig.json` (the project template does):

```tsx title="src/blog/views.tsx"
import type { Context } from 'hono'
import { reverse } from '@ghuri/core'
import { Post } from './models'
import { Layout } from '../layout'

export async function index(c: Context) {
  const posts = await Post.objects.filter({ published: true }).slice(0, 20)
  return c.html(
    <Layout title="Blog">
      <ul>
        {posts.map((p) => (
          <li><a href={reverse('blog:detail', { slug: p.slug })}>{p.title}</a></li>
        ))}
      </ul>
    </Layout>,
  )
}
```

## Class-based views

`View` dispatches to a method named after the HTTP verb and answers 405 (with an `Allow`
header) for missing ones. Attach it with `asView()`:

```ts title="src/blog/views.ts"
import type { Context } from 'hono'
import { View, json, redirect, getUser } from '@ghuri/core'
import { loginRequired } from '@ghuri/auth'
import { Post } from './models'

export class PostDraftsView extends View {
  pageSize = 20

  async get(c: Context) {
    const drafts = await Post.objects.filter({ published: false, authorId: getUser(c).pk }).slice(0, this.pageSize)
    return json(c, drafts)
  }

  async post(c: Context) {
    const body = await c.req.parseBody()
    const post = await Post.objects.create({ title: String(body.title), slug: String(body.slug), author: getUser(c) })
    return redirect(c, 'blog:detail', { slug: post.slug })
  }
}
```

```ts title="src/blog/urls.ts"
path('drafts/', loginRequired(PostDraftsView.asView({ pageSize: 50 })), { name: 'drafts' }),
```

`asView(initkwargs)` sets the given properties on each new instance, like Django. A fresh
instance is created per request, so storing request state on `this` is safe.

Two generic views are built in:

- `TemplateView`: implement `render(c, context)` returning JSX; `getContextData(c)` supplies the
  data.
- `RedirectView`: `RedirectView.asView({ patternName: 'home', permanent: true })` or
  `{ url: '/elsewhere/' }`.

For JSON APIs, use the views in [`@ghuri/rest`](/docs/topics/rest/views/) instead: they add
parsing, authentication, permissions and content negotiation.

:::tip[If you know Django]
`path`, `re_path` (`rePath`), `include`, `reverse`, `app_name` (`appName`), namespaces,
`View.as_view()` (`asView`), `TemplateView` and `RedirectView` are all here. The request object
is Hono's `Context`: `request.GET['q']` is `c.req.query('q')`, `request.POST` is
`await c.req.parseBody()`, `request.body` is `await c.req.json()` or `await c.req.text()`, and
`request.user` is `getUser(c)`. Decorators such as `login_required` are plain wrapper functions:
`loginRequired(view)`.
:::

## Mounting Hono apps

Any Hono app can be mounted as a pattern target. It sees paths relative to the mount point and
runs inside Ghuri's middleware and request context, so it can use the ORM and `getUser(c)`:

```ts title="src/webhooks.ts"
import { Hono } from 'hono'
import { Order } from './shop/models'

export const webhooks = new Hono()
webhooks.post('/stripe', async (c) => {
  const event = await c.req.json()
  await Order.objects.filter({ stripeId: event.data.object.id }).update({ paid: true })
  return c.body(null, 204)
})
```

```ts
path('webhooks/', webhooks),
```

This is also the way to use Hono middleware or third-party Hono apps that Ghuri does not wrap.
To customise the root Hono app itself, pass `createApp(settings, { hono: (app) => { ... } })`.
