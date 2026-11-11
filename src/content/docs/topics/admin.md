---
title: The admin
description: Register models with the Ghuri admin, customise change lists and forms, write actions, control permissions and build custom admin sites.
---

`@ghuri/admin` is a port of Django's admin: a staff-only interface, generated from your models,
for trusted users to create, read, update and delete data. Pages are rendered on the server with
Hono JSX and enhanced with htmx. One embedded stylesheet provides a Django-admin look with light
and dark themes. Users run no build step, and the admin works the same on Workers and Node.

## Setting it up

The project template already does all three steps:

1. `AdminConfig` (from `@ghuri/admin`) is in `INSTALLED_APPS`. `AuthConfig` and the session and
   authentication middleware must be installed too, because the admin logs users in with
   sessions.
2. `path('admin/', admin.site.urls)` is in the root `urls.ts`.
3. Each app's `AppConfig` imports its `admin.ts` module (`admin = admin`). Importing that module
   runs its registrations.

```ts title="src/urls.ts"
import { path } from '@ghuri/core'
import { admin } from '@ghuri/admin'

export const urlpatterns = [
  path('admin/', admin.site.urls),
]
```

Create a user who can log in with `npx ghuri createsuperuser`.

:::tip[If you know Django]
Django finds `admin.py` through `autodiscover()`. Ghuri has no filesystem to scan, so each app
imports its admin module from `app.ts` instead. Everything after that is the same:
`admin.site.register()`, `@admin.register()`, `ModelAdmin`, inlines, actions and
`AdminSite`.
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

`admin.site.unregister(Model)` removes a registration. Use it to replace an admin registered
by another app, such as the built-in `UserAdmin`.

## Change list options

These options control the list of objects at `/admin/<app>/<model>/`.

| Option | Meaning |
|---|---|
| `listDisplay` | Columns. Field names, `__`-paths such as `'author__username'`, or names of methods on the `ModelAdmin`. Default: the object's `toString()` |
| `listDisplayLinks` | Which columns link to the change form. Default: the first |
| `listFilter` | Fields shown in the filter sidebar. Booleans, choices, dates, foreign keys and many-to-many fields each get a suitable filter |
| `searchFields` | Fields searched by the search box, combined with `__icontains` and OR. Prefix with `^` for `startswith` or `=` for `iexact` |
| `dateHierarchy` | A date or datetime field that gets year → month → day drill-down links above the list |
| `ordering` | Default ordering, e.g. `['-createdAt']`. Falls back to the model's `Meta.ordering` |
| `listPerPage` | Page size. Default `100` |
| `listSelectRelated` | Fields to `selectRelated()` on the list query |

A column can be a method that returns a computed value. It may be async:

```ts title="src/blog/admin.ts"
@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  listDisplay = ['title', 'author', 'published', 'commentCount']
  listSelectRelated = ['author']

  async commentCount(post: Post) {
    return post.comments.count()
  }
}
```

Every column header is sortable when it maps to a database field. Method columns are not
sortable.

## Change form options

These options control the add and change forms.

| Option | Meaning |
|---|---|
| `fields` | Flat list of fields to show, in order |
| `fieldsets` | Grouped fields: `[[title \| null, { fields, classes?, description? }], ...]`. `classes: ['collapse']` makes a group collapsible |
| `readonlyFields` | Shown as text, never written. `autoNow`/`autoNowAdd` and non-`editable` fields are always read-only |
| `prepopulatedFields` | `{ slug: ['title'] }` fills a field from others as the user types |
| `rawIdFields` | Foreign keys shown as an id input with a lookup popup instead of a select. Use for large tables |
| `autocompleteFields` | Foreign keys and many-to-many fields shown as a search-as-you-type select. The related model's admin must define `searchFields` |
| `inlines` | Related objects edited on the same page (see below) |

Each widget comes from the model field's `formHint()`: a `TextField` becomes a textarea, a
`BooleanField` a checkbox, a field with `choices` a select, a `DateTimeField` a datetime input,
and so on. Validation runs `fullClean()` on the instance, so field validators, `unique` and your
model's own `clean()` show their errors next to the right field.

The form has the usual three buttons: **Save**, **Save and add another** and **Save and continue
editing**.

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

## Inlines

Inlines edit related objects on the parent's change form. `TabularInline` puts each object on
a row of a table. `StackedInline` gives each object a full form.

```ts title="src/blog/admin.ts"
import { TabularInline, StackedInline } from '@ghuri/admin'

class CommentInline extends TabularInline<Comment> {
  model = Comment
  fields = ['author', 'body', 'approved']
  extra = 1          // empty forms shown for new objects
  maxNum = 50
  canDelete = true
}

@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  inlines = [CommentInline]
}
```

An inline finds its foreign key to the parent automatically. Set `fkName` when the child has
more than one foreign key to the parent model.

## Actions

Actions run on the rows selected in the change list. Every model gets **Delete selected**. It
shows a confirmation page that lists everything the delete will cascade to, then deletes the
rows. Add your own as functions:

```ts title="src/blog/admin.ts"
import type { Context } from 'hono'
import type { QuerySet } from '@ghuri/orm'
import { admin, ModelAdmin, type AdminAction } from '@ghuri/admin'
import { Post } from './models'

const makePublished: AdminAction<Post> = Object.assign(
  async (modelAdmin: ModelAdmin<Post>, c: Context, queryset: QuerySet<Post>) => {
    const count = await queryset.update({ published: true })
    modelAdmin.messageUser(c, `${count} posts marked as published.`)
  },
  { shortDescription: 'Mark selected posts as published' },
)

@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  actions = [makePublished]
}
```

An action receives the `ModelAdmin`, the Hono context and a QuerySet of the selected objects.
It can return nothing, which sends the user back to the list, or a `Response`, for example a
CSV download or a redirect to an intermediate page. `shortDescription` is the label in the
actions menu.

## Permissions

Only users with `isStaff` (and `isActive`) can log in. After that, each model admin asks four
hooks what the user may do. The defaults check the auth permissions that `migrate` creates for
every model:

| Hook | Default |
|---|---|
| `hasViewPermission(c, obj?)` | `blog.view_post` or `blog.change_post` |
| `hasAddPermission(c)` | `blog.add_post` |
| `hasChangePermission(c, obj?)` | `blog.change_post` |
| `hasDeletePermission(c, obj?)` | `blog.delete_post` |

Override them for row-level rules. The hooks are async, and `obj` is undefined when the
question is about the model as a whole:

```ts title="src/blog/admin.ts"
import type { Context } from 'hono'
import { getUser } from '@ghuri/core'

@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  getQueryset(c: Context) {
    const user = getUser(c)
    const qs = super.getQueryset(c)
    return user.isSuperuser ? qs : qs.filter({ authorId: user.pk })
  }

  async hasDeletePermission(c: Context, obj?: Post) {
    return getUser(c).isSuperuser ?? false
  }
}
```

The app index and the main index list only the models a user can at least view.

## Auth models and history

When `@ghuri/auth` is installed, the admin registers `User` with `UserAdmin` and `Group` with
`GroupAdmin`. `UserAdmin` hashes the password on the add form and links to a password change
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

Every add, change and delete done through the admin is written to the `LogEntry` model. The
**History** link on each change form shows those entries, and the admin index shows the current
user's recent actions.

## File uploads

When `@ghuri/storage` is installed, `FileField` and `ImageField` render as file inputs. The
admin streams the upload to the field's storage (R2 by default) and shows a link to the current
file with a "clear" checkbox. See [File storage](/docs/topics/file-storage/).

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

export const editorSite = new AdminSite({ name: 'editors' })
editorSite.siteHeader = 'Editorial desk'
editorSite.register(Post, class extends ModelAdmin<Post> {
  listDisplay = ['title', 'published']
})
```

```ts title="src/urls.ts"
path('editors/', editorSite.urls),
```

Override `hasPermission(c)` on an `AdminSite` subclass to change who may enter at all.

## Assets and security

The admin loads htmx from a CDN by default. To serve it yourself (behind a strict Content
Security Policy, say), point `ADMIN_ASSETS` at your own copies:

```ts title="src/settings.ts"
ADMIN_ASSETS: { htmx: '/static/htmx.min.js' },
```

Every admin form is protected by `CsrfMiddleware`. Keep it in `MIDDLEWARE`, and set
`CSRF_TRUSTED_ORIGINS` when the admin is served from a domain other than the one in the
request's `Host` header.

:::note[Alpha]
Overriding the admin's markup (Django's per-template overrides such as `change_form.html`) is
not settled yet. Today you can add CSS through `ADMIN_ASSETS` and replace whole pages by
overriding `ModelAdmin` view methods. A supported JSX component override API is planned and may
change how those methods are named.
:::
