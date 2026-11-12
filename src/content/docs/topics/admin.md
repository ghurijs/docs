---
title: The admin
description: Register models with the Ghuri admin, customise change lists and forms, write actions, control permissions and build custom admin sites.
---

`@ghuri/admin` is a port of Django's admin: a staff-only interface, generated from your models,
for trusted users to create, read, update and delete data. Pages are rendered on the server with
Hono JSX and progressively enhanced with a little JavaScript and htmx. One embedded stylesheet
provides a Django-admin look with light and dark themes. Users run no build step, and the admin
works the same on Workers (D1, R2) and Node (Postgres, SQLite).

This page is a tour. Every option, filter class, action and inline setting is listed in the
[Admin reference](/docs/topics/admin-reference/).

## Setting it up

The project template already does all three steps:

1. `AdminConfig` (from `@ghuri/admin`, app label `admin`) is in `INSTALLED_APPS`, after
   `ContentTypesConfig`, `AuthConfig` and `SessionsConfig` from `@ghuri/auth`. The admin checks
   at startup that `contenttypes` and `auth` are installed. `SessionMiddleware` and
   `AuthenticationMiddleware` must be in `MIDDLEWARE`, because the admin logs users in with
   sessions and stores flash messages there.
2. `path('admin/', admin.site.urls)` is in the root `urls.ts`.
3. Each app's `AppConfig` imports its `admin.ts` module (`admin = admin`). Importing that module
   runs its registrations.

```ts title="src/settings.ts"
import { AdminConfig } from '@ghuri/admin'
import {
  AuthConfig, AuthenticationMiddleware, ContentTypesConfig, SessionMiddleware, SessionsConfig,
} from '@ghuri/auth'
import { CommonMiddleware, CsrfMiddleware, defineSettings, SecurityMiddleware } from '@ghuri/core'

export default defineSettings((env) => ({
  // ...
  INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, AdminConfig, BlogConfig],
  MIDDLEWARE: [SecurityMiddleware, SessionMiddleware, CommonMiddleware, CsrfMiddleware, AuthenticationMiddleware],
}))
```

```ts title="src/urls.ts"
import { path } from '@ghuri/core'
import { admin } from '@ghuri/admin'

export const urlpatterns = [
  path('admin/', admin.site.urls),
]
```

```ts title="src/blog/app.ts"
import { AppConfig } from '@ghuri/core'
import * as admin from './admin'
import * as models from './models'

export class BlogConfig extends AppConfig {
  name = 'blog'
  models = models
  admin = admin
}
```

Then run `npx ghuri migrate` (the admin ships the migration for its `LogEntry` model, table
`django_admin_log`) and create a user who can log in with `npx ghuri createsuperuser`.

:::tip[If you know Django]
Django finds `admin.py` through `autodiscover()`. Ghuri has no filesystem to scan, so each app
imports its admin module from `app.ts` instead. Everything after that is the same:
`admin.site.register()`, `@admin.register()`, `ModelAdmin`, inlines, actions and `AdminSite`.
The `admin` export mirrors `django.contrib.admin` (`admin.site`, `admin.register`,
`admin.ModelAdmin`, `admin.TabularInline`, `admin.display`, `admin.action`,
`admin.SimpleListFilter` and so on), and everything is also a named export.
:::

## Registering models

The shortest registration uses the defaults:

```ts title="src/blog/admin.ts"
import { admin } from '@ghuri/admin'
import { Tag } from './models'

admin.site.register(Tag)
```

To customise, pass a `ModelAdmin` subclass, either as the second argument or with the decorator:

```ts title="src/blog/admin.ts"
import { admin, ModelAdmin } from '@ghuri/admin'
import { Post, Tag } from './models'

class TagAdmin extends ModelAdmin<Tag> {
  searchFields = ['name']
}
admin.site.register(Tag, TagAdmin)

@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  listDisplay = ['title', 'author', 'published', 'createdAt']
}
```

`@admin.register()` works with standard (TC39) decorators and with `experimentalDecorators`.
Without decorators, call it: `admin.register(Post)(PostAdmin)`. `admin.site.register([A, B], SomeAdmin)`
registers several models with one class.

`admin.site.unregister(Model)` removes a registration and `admin.site.isRegistered(Model)` checks
for one. Registering a model twice throws `AlreadyRegistered`; unregistering an unknown model
throws `NotRegistered`. Use `unregister` to replace an admin registered by another app, such as
the built-in `UserAdmin`.

## Change list options

These options control the list of objects at `/admin/<app>/<model>/`. The most common ones:

| Option | Meaning |
|---|---|
| `listDisplay` | Columns: field names, `__`-paths such as `'author__username'`, names of methods on the `ModelAdmin` or the model, or functions. Default: `['__str__']` |
| `listDisplayLinks` | Which columns link to the change form. Default: the first; `null` for none |
| `listFilter` | Filters in the sidebar: field names, `SimpleListFilter` subclasses, or `['field', FilterClass]` |
| `searchFields` | Fields searched by the search box. `'title'` is `icontains`, `'^slug'` `istartswith`, `'=email'` `iexact`. Words are ANDed, fields ORed |
| `dateHierarchy` | A date or datetime field that gets year → month → day drill-down links above the list |
| `ordering` | Default ordering, e.g. `['-createdAt']`. Falls back to the model's `Meta.ordering` |
| `listPerPage` | Page size. Default `100` |
| `listSelectRelated` | `true`, a list of fields to `selectRelated()`, or `false` |
| `listEditable` | Fields edited in place on the change list |

A column can be a method that returns a computed value. It may be async. Use `display()` to set
its header, make it sortable or render it as a yes/no icon:

```ts title="src/blog/admin.ts"
import { admin, display, ModelAdmin } from '@ghuri/admin'

@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  listDisplay = ['title', 'author', 'published', 'commentCount', 'isRecent']
  listSelectRelated = ['author']

  @display({ description: 'Comments' })
  async commentCount(post: Post) {
    return post.comments.count()
  }

  @display({ description: 'Recent?', boolean: true, ordering: '-createdAt' })
  isRecent(post: Post) {
    return post.createdAt > lastWeek()
  }
}
```

Columns that map to a database field are sortable, and so are method columns with
`display({ ordering })`. Sorting uses Django's `?o=` parameter, with multi-column sort priority.
Values are escaped; return JSX (or `html` from `hono/html`) to render markup.

## Change form options

These options control the add and change forms.

| Option | Meaning |
|---|---|
| `fields` | Fields to show, in order. Nest an array to put fields on one line: `['title', ['slug', 'status']]` |
| `fieldsets` | Grouped fields: `[[title \| null, { fields, classes?, description? }], ...]`. `classes: ['collapse']` makes a group collapsible |
| `readonlyFields` | Shown as text, never written. `autoNow`/`autoNowAdd` and non-`editable` fields are always read-only |
| `prepopulatedFields` | `{ slug: ['title'] }` fills a field from others as the user types |
| `rawIdFields` | Foreign keys and many-to-many fields shown as an id input with a lookup link instead of a select. Use for large tables |
| `autocompleteFields` | Foreign keys and many-to-many fields shown as a search-as-you-type select. The related model's admin must define `searchFields` |
| `filterHorizontal` / `filterVertical` | Many-to-many fields as a filterable multi-select |
| `radioFields` | `{ status: admin.HORIZONTAL }` shows choices or a foreign key as radio buttons |
| `inlines` | Related objects edited on the same page (see below) |

Each widget comes from the model field's `formHint()`: a `TextField` becomes a textarea, a
`BooleanField` a checkbox, a field with `choices` a select, a `DateTimeField` a
`datetime-local` input (in UTC), and so on. Validation runs `fullClean()` on the instance, so
field validators, `unique` and your model's own `clean()` show their errors next to the right
field. Add form-wide checks by overriding `cleanForm(c, form)`.

The form has the usual buttons: **Save**, **Save and add another** and **Save and continue
editing**, plus **Save as new** with `saveAs = true`.

```ts title="src/blog/admin.ts"
@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  prepopulatedFields = { slug: ['title'] }
  readonlyFields = ['createdAt', 'updatedAt']
  autocompleteFields = ['tags']
  rawIdFields = ['author']
  fieldsets = [
    [null, { fields: ['title', 'slug', 'summary', 'body'] }],
    ['Publishing', { fields: ['author', 'tags', 'published', 'createdAt', 'updatedAt'], classes: ['collapse'] }],
  ]
}
```

:::note
There are no "+" related-object popups next to foreign-key and many-to-many widgets. To add a
related object, open its own add form (in another tab), then come back and pick it. `rawIdFields`
shows a lookup link to the related change list rather than a popup window.
:::

## Inlines

Inlines edit related objects on the parent's change form. `TabularInline` puts each object on
a row of a table. `StackedInline` gives each object a full form.

```ts title="src/blog/admin.ts"
import { admin, ModelAdmin, StackedInline, TabularInline } from '@ghuri/admin'

class CommentInline extends TabularInline<Comment> {
  model = Comment
  fields = ['author', 'body', 'approved']
  extra = 1          // empty forms shown (default 3)
  maxNum = 50
  canDelete = true
}

@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  inlines = [CommentInline]
}
```

An inline finds its foreign key to the parent automatically. Set `fkName` when the child has
more than one foreign key to the parent model. Without JavaScript the `extra` rows are shown;
with it an "Add another" link clones rows.

## Actions

Actions run on the rows selected in the change list. Every model gets **Delete selected**
(`delete_selected`). It shows a confirmation page that lists everything the delete will cascade
to, refuses when objects are protected or the user lacks delete permission on them, then deletes
the rows. Add your own with `action()`:

```ts title="src/blog/admin.ts"
import { action, admin, ModelAdmin } from '@ghuri/admin'
import { Post } from './models'

export const makePublished = action(
  { description: 'Mark selected posts as published', permissions: ['change'] },
  async (modelAdmin, c, queryset) => {
    const count = await queryset.update({ published: true })
    await modelAdmin.messageUser(c, `${count} posts marked as published.`, 'success')
  },
)

@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  actions = [makePublished]
}
```

An action function receives the `ModelAdmin`, the Hono context and a QuerySet of the selected
objects. It can return nothing, which sends the user back to the list, or a `Response`, for
example a CSV download or an intermediate confirmation page. `description` is the label in the
actions menu; `permissions` limits who is offered the action. Actions can also be `ModelAdmin`
methods (decorated with `@action`), and "Select all N" across pages is supported. The details
are in the [Admin reference](/docs/topics/admin-reference/#actions).

## Permissions

Only users with `isStaff` and `isActive` can log in. After that, each model admin asks four
hooks what the user may do. The defaults check the auth permissions that `migrate` creates for
every model, and active superusers pass every check:

| Hook | Default |
|---|---|
| `hasViewPermission(c, obj?)` | `blog.view_post` or `blog.change_post` |
| `hasAddPermission(c)` | `blog.add_post` |
| `hasChangePermission(c, obj?)` | `blog.change_post` |
| `hasDeletePermission(c, obj?)` | `blog.delete_post` |
| `hasModulePermission(c)` | `user.hasModulePerms('blog')` |

Users with only the view permission get read-only change forms. Override the hooks for
row-level rules. They are async, and `obj` is undefined when the question is about the model as
a whole. `getQueryset()` must return the QuerySet synchronously (QuerySets are thenable, so an
`async` method would resolve it to an array):

```ts title="src/blog/admin.ts"
import type { Context } from 'hono'
import { getUser } from '@ghuri/core'

@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  getQueryset(c: Context) {
    const user = getUser(c)
    const qs = super.getQueryset(c)
    return user.isSuperuser ? qs : qs.filter({ author: user.pk })
  }

  async hasDeletePermission(c: Context, obj?: Post) {
    return getUser(c).isSuperuser ?? false
  }
}
```

The app index and the main index list only the models a user can at least view.

## Auth models and history

When `@ghuri/auth` is installed, the admin registers `User` with `UserAdmin` and `Group` with
`GroupAdmin`. `UserAdmin` asks for the password twice on the add form (password validators
apply), stores a hash, shows the hash summary on the change form and links to a password change
form, so a raw password is never stored. To customise it, unregister it and register your
subclass:

```ts title="src/accounts/admin.ts"
import { admin, UserAdmin } from '@ghuri/admin'
import { User } from '@ghuri/auth'

admin.site.unregister(User)

@admin.register(User)
export class CustomUserAdmin extends UserAdmin {
  listDisplay = ['username', 'email', 'isStaff', 'dateJoined']
}
```

With a swapped `AUTH_USER_MODEL`, `UserAdmin` is not registered automatically; register your own
(for example `admin.site.register(Account, AccountAdmin)`).

Every add, change and delete done through the admin is written to the `LogEntry` model, with a
Django-compatible JSON change message. The **History** link on each change form shows those
entries, and the admin index shows the current user's recent actions.

## File uploads

`FileField` and `ImageField` from [`@ghuri/storage`](/docs/topics/file-storage/) render as file
inputs with the current file's link, a "Clear" checkbox and a "Change" input; the form is sent
as multipart. The upload is assigned to the model and the field's storage uploads it on save.
"Clear" empties the field but keeps the stored file, as in Django. `@ghuri/storage` is optional:
the admin detects file fields by their form hint.

## Custom admin sites

`admin.site` is the default `AdminSite`. Change its branding by setting its properties, for
example in an `AppConfig.ready()`:

```ts
admin.site.siteHeader = 'Mysite administration'
admin.site.siteTitle = 'Mysite admin'
admin.site.indexTitle = 'Dashboard'
```

For a second, separate admin (say, a limited one for editors), create another site:

```ts title="src/editors/admin.ts"
import { AdminSite, ModelAdmin } from '@ghuri/admin'
import { Post } from '../blog/models'

export const editorSite = new AdminSite({ name: 'editors', siteHeader: 'Editorial desk' })
editorSite.register(Post, class extends ModelAdmin<Post> {
  listDisplay = ['title', 'published']
})
```

```ts title="src/urls.ts"
path('editors/', editorSite.urls),   // reverse('editors:index')
```

Override `hasPermission(c)` on an `AdminSite` subclass to change who may enter at all. Custom
admin pages (via `getUrls()` and `adminSite.adminView()`) are covered in the
[Admin reference](/docs/topics/admin-reference/#custom-admin-views).

## Assets and security

The admin loads htmx (used by autocomplete) from jsDelivr by default. To serve it yourself
(behind a strict Content Security Policy, say), disable it, or add your own stylesheets and
scripts, use `ADMIN_ASSETS`:

```ts title="src/settings.ts"
ADMIN_ASSETS: { htmx: '/static/htmx.min.js', css: ['/static/admin-brand.css'] },   // htmx: false disables it
```

Every core flow (login, lists, filters, search, sorting, pagination, actions, forms, inline
`extra` rows and deletes) works without JavaScript.

The admin checks the CSRF token on every POST itself, even without `CsrfMiddleware`, though
keeping the middleware is recommended. Set `CSRF_TRUSTED_ORIGINS` when the admin is served from
a domain other than the one in the request's `Host` header. Redirects after login are restricted
to the same host, all output is escaped by Hono JSX, and responses are sent with
`Cache-Control: private, no-store`.

:::note[Customising markup]
The admin's pages are JSX components, not overridable template files: there is no equivalent of
overriding `change_form.html`. Customise through options, hooks, extra CSS in `ADMIN_ASSETS` and
custom admin views.
:::
