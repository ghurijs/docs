---
title: URLs and views
description: URL patterns with path() and include(), converters, reverse() and resolve(), function and class-based views, shortcuts and error handling.
---

Ghuri routes requests the way Django does: a root list of URL patterns (`ROOT_URLCONF`), built
with `path()` and `include()`, mapping routes to views. Under the hood the patterns compile to a
[Hono](https://hono.dev) router, and views receive Hono's `Context`.

## URL patterns

```ts title="src/urls.ts"
import { path, rePath, include } from '@ghuri/core'
import { admin } from '@ghuri/admin'
import * as blog from './blog/urls'
import { home, archive, feed, upload, page } from './views'
import { AboutView } from './views/about'
import { legacyApp } from './legacy'

export const urlpatterns = [
  path('', home, { name: 'home' }),
  path('about/', AboutView, { name: 'about' }),              // View classes are accepted directly
  path('blog/', include(blog)),
  path('archive/<int:year>/<int:month>/', archive, { name: 'archive' }),
  rePath('^feeds/(?P<format>rss|atom)/$', feed, { name: 'feed' }),
  path('upload/', upload, { methods: ['POST'] }),            // other methods → 405
  path('terms/', page, { kwargs: { template: 'terms' } }),   // extra kwargs for the view
  path('admin/', admin.site.urls),
  path('legacy/', legacyApp),                                // any Hono app
]
```

`path(route, target, options?)` takes:

- **`route`**: a string with optional converters. Routes are matched in order; the first match
  wins.
- **`target`**: a view function, a `View` class (`asView()` is called for you) or the result of
  `asView()`, the result of `include()`, another pattern array (for example `admin.site.urls`
  or `router.urls`), or a `Hono` instance to mount as-is.
- **`options`**: `{ name?, methods?, kwargs? }`. `name` is used by `reverse()`; `methods`
  restricts the pattern to some HTTP methods (others get a 405 with an `Allow` header);
  `kwargs` are extra values merged into `kwargs(c)`, like Django's `path(..., kwargs={...})`.

`rePath()` takes a regular expression with named groups when converters are not enough. Both
JavaScript's `(?<name>…)` and Python's `(?P<name>…)` group syntax work.

### Converters

| Converter | Matches | Value |
|---|---|---|
| `<str:x>` or `<x>` | any non-empty segment without `/` | string |
| `<int:x>` | `0` or a positive integer | number (via `kwargs(c)`) |
| `<slug:x>` | letters, digits, `-` and `_` | string |
| `<uuid:x>` | a lowercase UUID | string |
| `<path:x>` | any non-empty string, including `/` | string |

A pattern such as `'posts/<int:id>/'` compiles to the Hono route `/posts/:id{[0-9]+}/`, so
routing stays fast. Read raw string parameters with `c.req.param('id')`, or converted values
(plus any `kwargs` from `path()`) with `kwargs(c)`:

```ts
import { kwargs } from '@ghuri/core'

export async function archive(c: Context) {
  const { year, month } = kwargs<{ year: number; month: number }>(c)   // numbers, because of <int:...>
  // ...
}
```

Register your own converter with `registerConverter()`, Django's `register_converter`:

```ts
import { registerConverter } from '@ghuri/core'

registerConverter('year', { regex: '[0-9]{4}', toJs: Number, toUrl: (v) => String(v).padStart(4, '0') })
path('archive/<year:y>/', archive)
```

Register converters before the URL patterns that use them are built (at module top level of
`urls.ts` is fine).

:::note
Routes Hono cannot express, such as two parameters in one path segment or a `rePath()` regex
with character classes, alternations or quantifiers outside its named groups, fall back to regex matching
automatically. They work the same, but their parameters are only available through `kwargs(c)`,
not `c.req.param()`.
:::

### `include()` and namespaces

`include()` nests patterns under a prefix. It accepts an array, or a module that exports
`urlpatterns` (and optionally `appName`). The `urlpatterns(appName, list)` helper builds an
array that carries its `appName`, like Django's `app_name = 'blog'`:

```ts title="src/blog/urls.ts"
import { path, urlpatterns as patterns } from '@ghuri/core'
import * as views from './views'

export const urlpatterns = patterns('blog', [
  path('', views.index, { name: 'index' }),
  path('<slug:slug>/', views.detail, { name: 'detail' }),
])
```

```ts title="src/urls.ts"
path('blog/', include(blog)),                                    // namespace 'blog' from appName
path('news/', include(blog.urlpatterns, { namespace: 'news' })), // explicit namespace
```

Exporting a separate `export const appName = 'blog'` next to a plain `urlpatterns` array works
too.

### Trailing slashes

With `APPEND_SLASH` on (the default), a `GET` or `HEAD` for `/blog/hello` that matches nothing
is redirected with a 301 to `/blog/hello/` when that URL would match. The app does this itself,
with or without `CommonMiddleware`. Write routes with trailing slashes, as in Django. `POST`s are
never redirected, so post to the slashed URL.

## Reversing and resolving URLs

Never hard-code paths. `reverse(name, params?, { query? })` builds one from a pattern name and
parameters:

```ts
import { reverse, redirect } from '@ghuri/core'

reverse('home')                                   // '/'
reverse('blog:detail', { slug: 'hello-ghuri' })   // '/blog/hello-ghuri/'
reverse('archive', { year: 2026, month: 11 })     // '/archive/2026/11/'
reverse('archive', [2026, 11])                    // positional parameters
reverse('blog:index', {}, { query: { page: 2 } }) // '/blog/?page=2'

return redirect(c, 'blog:detail', { slug: post.slug })
```

`reverse()` throws `NoReverseMatch` if the name is unknown or the parameters do not fit the
converters.

The other direction is `resolve(path)`, which returns a `ResolverMatch` (`route`, `urlName`,
`namespace`, `viewName`, `kwargs`, `view`, …) or throws `Resolver404`. Inside a view,
`resolverMatch(c)` gives the current request's match, like Django's `request.resolver_match`:

```ts
import { resolve, resolverMatch } from '@ghuri/core'

resolve('/blog/hello-ghuri/').viewName   // 'blog:detail'
resolverMatch(c)?.urlName                // 'detail'
```

## Function views

A view is any function `(c: Context) => Response | Promise<Response>`. `c` is Hono's context: the
request is `c.req`, and helpers such as `c.json()`, `c.html()` and `c.text()` build responses. A
view may also `throw` a `Response`, which is returned as-is.

```ts title="src/blog/views.ts"
import type { Context } from 'hono'
import { json, getUser, kwargs, PermissionDenied } from '@ghuri/core'
import { getObjectOr404 } from '@ghuri/orm'
import { Post } from './models'

export async function detail(c: Context) {
  const post = await getObjectOr404(Post, { slug: kwargs(c).slug })
  if (!post.published && post.authorId !== getUser(c).pk) {
    throw new PermissionDenied()
  }
  return json(c, { title: post.title, body: post.body })
}
```

### Shortcuts

| Shortcut | From | Does |
|---|---|---|
| `json(c, data, status?, headers?)` | `@ghuri/core` | JSON response. Objects with `toJSON()` (dates, model instances) serialise as usual; `bigint`, `Map` and `Set` are handled too |
| `render(c, jsx, { status?, headers? })` | `@ghuri/core` | HTML response from Hono JSX or a string; adds `<!DOCTYPE html>` when the output starts with `<html` |
| `redirect(c, to, params?, { permanent? })` | `@ghuri/core` | 302 (or 301) to a URL, to `reverse(name, params)`, or to `obj.getAbsoluteUrl()` |
| `resolveUrl(to, params?)` | `@ghuri/core` | The URL `redirect()` would use, without redirecting (Django's `resolve_url`) |
| `getObjectOr404(source, lookup)` | `@ghuri/orm` | `get()` on a model, manager or queryset that throws `Http404` instead of `DoesNotExist` |
| `getUser(c)` | `@ghuri/core` | The request user, `AnonymousUser` if none |
| `getRemoteAddr(c)` | `@ghuri/core` | The client address (Django's `REMOTE_ADDR`): `CF-Connecting-IP` on Cloudflare, the socket address on Node, else `''`. Never reads `X-Forwarded-For` |

### Rendering HTML with JSX

Ghuri does not have a template language; it uses Hono's JSX. Name the file `.tsx` and set
`"jsxImportSource": "hono/jsx"` in `tsconfig.json` (the project template does):

```tsx title="src/blog/views.tsx"
import type { Context } from 'hono'
import { render, reverse } from '@ghuri/core'
import { Post } from './models'
import { Layout } from '../layout'

export async function index(c: Context) {
  const posts = await Post.objects.filter({ published: true }).slice(0, 20)
  return render(c,
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

JSX output is escaped. For trusted raw markup use `html` or `raw` from `hono/html`.

## Errors

Throw an error from anywhere in a view (or in code it calls), and Ghuri turns it into a
response, as Django does:

| Error (from `@ghuri/core` unless noted) | Response |
|---|---|
| `Http404`, `ObjectDoesNotExist` (and every model's `DoesNotExist`) | 404 |
| `PermissionDenied`, `CsrfFailure` | 403 |
| `BadRequest`, `SuspiciousOperation`, `DisallowedHost` | 400 |
| `ValidationError` | 400 with `{ detail, errors: { field: [messages] } }` |
| `MethodNotAllowed(method, allowed)` | 405 with an `Allow` header |
| Hono's `HTTPException` | its status, or its own response |
| anything else | 500 |

The error body is JSON (`{ "detail": "…" }`) when `wantsJson(c)` is true: the path is under
one of `API_PATH_PREFIXES` (default `['/api']`), the client accepts JSON but not HTML, the
request body is JSON, or it is an `XMLHttpRequest`. Otherwise it is an HTML page. With `DEBUG`
on, 500s show a debug page with the stack trace, request details and settings (with secrets
masked), and 404s list the URL patterns that were tried. Production pages never reveal details.

Map your own errors with `registerExceptionHandler(ErrorClassOrPredicate, handler)`. Handlers
registered later are tried first; return `undefined` to fall through to the default mapping.
`@ghuri/rest` uses this for its `APIException`.

```ts
import { registerExceptionHandler } from '@ghuri/core'

registerExceptionHandler(PaymentRequired, (err, c) => c.json({ code: err.code }, 402))
```

For a project-wide hook, pass `createApp(settings, { onError: (err, c) => … })`; it runs before
the registered handlers. `handleException(err, c)` applies the whole mapping yourself, for
example from a mounted Hono app's own `onError`.

## Class-based views

`View` dispatches to a method named after the HTTP verb. Mount the class directly, or call
`asView(initkwargs)` to override attributes:

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
instance is created per request, so storing request state on `this` is safe. Each instance has
`this.c` (the Hono context), `this.request` (`c.req`) and `this.kwargs` (converted URL
parameters).

- Missing methods answer **405** with an `Allow` header; `HEAD` falls back to `get()`;
  `OPTIONS` answers 200 with `Allow`.
- Override `setup(c)` or `dispatch(c)` for logic shared by every method, as in Django.
- Set `static csrfExempt = true` to exempt every view the class produces from CSRF checks, and
  `static xframeOptionsExempt = true` to exempt them from `XFrameOptionsMiddleware`.

Two generic views are built in:

- **`TemplateView`** renders its `template`, a Hono JSX component, with the props returned by
  `getContextData()` (URL kwargs plus `extraContext` by default):

  ```tsx
  import { TemplateView } from '@ghuri/core'

  export class AboutView extends TemplateView {
    template = (p: { title: string }) => (
      <html lang="en"><body><h1>{p.title}</h1></body></html>
    )
    async getContextData() {
      return { ...(await super.getContextData()), title: 'About us' }
    }
  }
  ```

  Override `getTemplate()` to pick the component at request time, and set `status` for a
  non-200 response.

- **`RedirectView`**: `RedirectView.asView({ patternName: 'home', permanent: true })` or
  `{ url: '/posts/{id}/', queryString: true }`. `{param}` placeholders are filled from the URL
  kwargs; with neither `url` nor `patternName` it answers 410 Gone.

For JSON APIs, use the views in [`@ghuri/rest`](/docs/topics/rest/views/) instead: they add
parsing, authentication, permissions and content negotiation.

:::tip[If you know Django]
`path`, `re_path` (`rePath`), `include`, `reverse`, `resolve`, `register_converter`
(`registerConverter`), `app_name` (`urlpatterns(appName, …)` or `appName`), namespaces,
`View.as_view()` (`asView`), `TemplateView` and `RedirectView` are all here. The request object
is Hono's `Context`: `request.GET['q']` is `c.req.query('q')`, `request.POST` is
`await c.req.parseBody()`, `request.body` is `await c.req.json()` or `await c.req.text()`,
`request.user` is `getUser(c)` and `request.resolver_match` is `resolverMatch(c)`. Decorators
such as `login_required` are plain wrapper functions: `loginRequired(view)`.
:::

## Mounting Hono apps

Any Hono app can be mounted as a pattern target. It sees paths relative to the mount point and
runs inside Ghuri's middleware and request context, so it can use the ORM and `getUser(c)`:

```ts title="src/webhooks.ts"
import { Hono } from 'hono'
import { csrfExempt } from '@ghuri/core'
import { Order } from './shop/models'

export const webhooks = csrfExempt(new Hono())
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
To customise the root Hono app itself, pass `createApp(settings, { hono: (app) => { ... } })`;
the callback runs after `MIDDLEWARE` is installed and before the URL patterns.
