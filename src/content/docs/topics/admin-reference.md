---
title: Admin reference
description: Every ModelAdmin option, the built-in and custom list filters, actions and their permissions, inline options, hooks, URL names and AdminSite customisation in @ghuri/admin.
---

Reference for `@ghuri/admin`. For setup and a guided tour, read [The admin](/docs/topics/admin/)
first. Options are class fields; Django's `snake_case` names become `camelCase`
(`list_display` is `listDisplay`). Hooks receive the Hono context `c` where Django passes
`request`; use `getUser(c)` for `request.user`.

## ModelAdmin options

### Change list

| Option | Default | |
|---|---|---|
| `listDisplay` | `['__str__']` | Columns: field names, `'author__username'` paths, `ModelAdmin` method names, model method names, or functions |
| `listDisplayLinks` | first column | Columns linking to the change form; `null` for none |
| `listFilter` | `[]` | Field names (`'published'`, `'author__isStaff'`), `SimpleListFilter` subclasses, or `['field', FilterClass]`. See [List filters](#list-filters) |
| `listSelectRelated` | `false` | `true` (all foreign keys), field names, or `false` (the foreign keys shown in `listDisplay`) |
| `listPerPage` | `100` | Rows per page |
| `listMaxShowAll` | `200` | Largest result count for which "Show all" is offered |
| `listEditable` | `[]` | Fields edited in place on the change list, saved with one "Save" button |
| `searchFields` | `[]` | `'title'` (icontains), `'^slug'` (istartswith), `'=email'` (iexact), `'@body'` (treated as icontains), `'author__username'`. Words are ANDed, fields ORed; `"quoted phrases"` stay together |
| `searchHelpText` | `null` | Text under the search box |
| `dateHierarchy` | `null` | A date or datetime field: year → month → day drill-down links |
| `ordering` | the model's `Meta.ordering` | Default ordering; the pk is appended for a stable order |
| `sortableBy` | all columns | Restrict sortable columns |
| `showFullResultCount` | `true` | Show "N results (M total)" when filtered; `false` saves a `COUNT` query |
| `actions` | `[]` | Extra actions, added to the site-wide `delete_selected`; `null` disables actions. See [Actions](#actions) |
| `actionsOnTop` / `actionsOnBottom` | `true` / `false` | Where the action bar is shown |
| `actionsSelectionCounter` | `true` | Show "N of M selected" |
| `emptyValueDisplay` | the site's `'-'` | Shown for empty values |
| `preserveFilters` | `true` | Keep the change list filters across add, change and delete |

Sorting uses Django's `?o=` parameter (`?o=2.-1` sorts by column 2 ascending, then column 1
descending); column headers show the sort priority with toggle and remove links.

```ts
class PostAdmin extends ModelAdmin<Post> {
  listDisplay = ['title', 'author', 'status', 'wordCount']
  listDisplayLinks = ['title']
  listFilter = ['status', 'author', 'createdAt', DecadeFilter, ['category', RelatedOnlyFieldListFilter]]
  listSelectRelated = ['author']
  searchFields = ['^title', 'body', 'author__username']
  dateHierarchy = 'createdAt'
  ordering = ['-createdAt']
  listPerPage = 50
  listEditable = ['status']
}
```

### Forms

| Option | Default | |
|---|---|---|
| `fields` | all editable fields | Field names; nest an array to put fields on one line: `['title', ['slug', 'status']]` |
| `exclude` | `null` | Fields left off the form |
| `fieldsets` | one unnamed fieldset | `[[name \| null, { fields, classes?, description? }], ...]`. `classes: ['collapse']` renders a `<details>`, `['wide']` widens labels |
| `readonlyFields` | `[]` | Field names, method names or functions, shown as text. Non-editable fields (`autoNowAdd`, ...) are always read-only |
| `prepopulatedFields` | `{}` | `{ slug: ['title'] }`: slugified as you type (JavaScript), on new and empty fields |
| `rawIdFields` | `[]` | Foreign key or many-to-many as an id input with a lookup link (comma-separated ids for many-to-many) |
| `autocompleteFields` | `[]` | Foreign key or many-to-many with search-as-you-type (htmx). The related model's admin needs `searchFields` |
| `filterHorizontal` / `filterVertical` | `[]` | Many-to-many as a filterable multi-select |
| `radioFields` | `{}` | `{ status: HORIZONTAL }`: choices or a foreign key as radio buttons (`HORIZONTAL` / `VERTICAL`) |
| `formfieldOverrides` | `{}` | Per model field type, keyed by `internalType`: `{ TextField: { widget: 'text', attrs: { size: 80 } } }` |
| `saveAs` | `false` | Show "Save as new" |
| `saveAsContinue` | `true` | After "Save as new", continue editing the new object |
| `saveOnTop` | `false` | Show the save buttons above the form too |
| `viewOnSite` | `true` | "View on site" uses `obj.getAbsoluteUrl()`; or a function `(obj) => url`, or `false` |
| `inlines` | `[]` | Inline classes. See [Inlines](#inlines) |

```ts
class PostAdmin extends ModelAdmin<Post> {
  fieldsets = [
    [null, { fields: ['title', 'slug', 'body'] }],
    ['Publishing', {
      fields: [['published', 'publishedAt'], 'author', 'tags'],
      classes: ['collapse'],
      description: 'Visible on the site once published.',
    }],
  ]
  readonlyFields = ['createdAt', 'wordCount']
  prepopulatedFields = { slug: ['title'] }
  autocompleteFields = ['author']
  filterHorizontal = ['tags']
  radioFields = { status: admin.VERTICAL }
  saveAs = true
}
```

### Widgets

Forms are built from each model field's `formHint()`, converted with `field.toPython()` and
validated with the model's `fullClean()` (null, blank, choices, validators, `clean()`, foreign-key
existence and uniqueness). Non-field errors appear above the form.

| Model field | Widget |
|---|---|
| `CharField`, `SlugField`, `UUIDField`, ... | `<input type="text">` with `maxlength` |
| `TextField` | `<textarea>` |
| `EmailField` / `URLField` | `type="email"` / `type="url"` |
| integer, float, decimal, duration | `type="number"` with `step`, `min`, `max` |
| `BooleanField` | checkbox |
| `DateField` / `TimeField` / `DateTimeField` | `type="date"` / `type="time"` / `type="datetime-local"`, in UTC |
| `JSONField` | `<textarea>`, pretty-printed and validated |
| fields with `choices` | `<select>` (or radios) |
| `ForeignKey` / `OneToOneField` | `<select>`, raw id, autocomplete or radios |
| `ManyToManyField` | multi-select, filter box, raw ids or autocomplete |
| `FileField` / `ImageField` | file input with "Currently: link", "Clear" and "Change" (multipart) |

Add form-wide validation with `cleanForm(c, form)`:

```ts
class EventAdmin extends ModelAdmin<Event> {
  cleanForm(c: Context, form: ModelForm) {
    const { start, end } = form.cleanedData as any
    if (start && end && end < start) form.addError('end', 'The end must be after the start.')
  }
}
```

There are no separate `ModelForm` classes to declare. At a lower level,
`getFormFields(c, obj, fieldNames?)` returns the `FormField`s (override it to add virtual fields,
as `UserAdmin` does for its password fields), `formfieldForDbField(c, field)` builds one, and
`getFieldQueryset(c, field)` limits foreign-key and many-to-many choices.

## Columns: `display()`

`display({ description, ordering, boolean, emptyValue })` (Django's `@admin.display`) decorates a
`listDisplay` or `readonlyFields` callable:

| Option | |
|---|---|
| `description` | Column header or label (Django's `short_description`) |
| `ordering` | Field (or `-field`) to sort by when the header is clicked (Django's `admin_order_field`) |
| `boolean` | Render the value as a yes / no / unknown icon |
| `emptyValue` | Text for empty values |

```tsx
import { display, ModelAdmin } from '@ghuri/admin'

class PostAdmin extends ModelAdmin<Post> {
  listDisplay = ['title', 'isRecent', 'colored', 'authorName']

  @display({ description: 'Recent?', boolean: true, ordering: '-createdAt' })
  isRecent(obj: Post) { return obj.createdAt > lastWeek() }

  @display({ description: 'Status' })
  colored(obj: Post) { return <span style={`color: ${obj.color}`}>{obj.status}</span> }   // JSX is rendered

  // without decorators
  authorName = display({ description: 'Author', emptyValue: '(nobody)' }, async (obj: Post) => (await obj.author)?.username)
}
```

Callables may be async. Values are escaped; return JSX or `html` from `hono/html` for markup, and
never build HTML from user data with `raw()`.

## List filters

### Built-in field filters

A field name in `listFilter` picks a filter from the field's type:

| Class | Used for | Choices |
|---|---|---|
| `BooleanFieldListFilter` | `BooleanField` | All / Yes / No (/ Unknown when nullable) |
| `ChoicesFieldListFilter` | fields with `choices` | All and each choice |
| `RelatedFieldListFilter` | foreign key, many-to-many, reverse relations | All and one link per related object |
| `DateFieldListFilter` | `DateField`, `DateTimeField` | Any date / Today / Past 7 days / This month / This year (/ No date / Has date when nullable) |
| `AllValuesFieldListFilter` | everything else | Every distinct value |

Two more are chosen explicitly with `['field', FilterClass]`:

| Class | |
|---|---|
| `RelatedOnlyFieldListFilter` | Like `RelatedFieldListFilter`, but only related objects actually in use |
| `EmptyFieldListFilter` | Empty / Not empty |

```ts
listFilter = ['published', ['category', RelatedOnlyFieldListFilter], ['summary', EmptyFieldListFilter]]
```

`FieldListFilter.register(test, FilterClass, takePriority?)` adds a filter class for the fields
matching `test` (Django's `FieldListFilter.register`).

### Custom filters: `SimpleListFilter`

Subclass `SimpleListFilter`, set `title` and `parameterName`, and implement `lookups()` and
`queryset()`:

```ts
import type { Context } from 'hono'
import type { QuerySet } from '@ghuri/orm'
import { type ModelAdmin, SimpleListFilter } from '@ghuri/admin'

class DecadeFilter extends SimpleListFilter {
  title = 'decade born'
  parameterName = 'decade'

  lookups(c: Context, modelAdmin: ModelAdmin) {
    return [['80s', 'in the eighties'], ['90s', 'in the nineties']] as Array<[string, string]>
  }

  queryset(c: Context, qs: QuerySet<any>) {
    if (this.value() === '80s') return qs.filter({ birthday__gte: '1980-01-01', birthday__lt: '1990-01-01' })
    if (this.value() === '90s') return qs.filter({ birthday__gte: '1990-01-01', birthday__lt: '2000-01-01' })
    return qs
  }
}
```

| Member | |
|---|---|
| `title` | Heading shown as "By <title>". Required |
| `parameterName` | Query-string parameter. Required |
| `lookups(c, modelAdmin)` | `[value, label]` pairs for the links. May be async. The filter is hidden when it returns none |
| `queryset(c, qs)` | The filtered QuerySet, or `qs` unchanged when inactive |
| `value()` | The selected value, or `null` |

:::caution
Return the QuerySet **synchronously** from `queryset()`. QuerySets are thenable, so an `async`
method would resolve it to an array. From async code, return `{ qs }` instead.
:::

For full control, extend `ListFilter` and implement `hasOutput()`, `choices(cl)`,
`queryset(c, qs)` and `expectedParameters()`.

### Query-string lookups

Lookups on local fields in the query string (`?views__gte=100`) work like Django's. Lookups that
span relations are only allowed for paths listed in `listFilter` or `dateHierarchy`
(`lookupAllowed(lookup, value, c)`); others redirect to `?e=1`.

## Actions

An action function has the signature `(modelAdmin, c, queryset) => void | Response` (sync or
async). Return nothing to redirect back to the change list (with any flash messages), or a
`Response`, such as a confirmation page or a file download. `action()` attaches options:

| Option | |
|---|---|
| `description` | Label in the action menu (Django's `short_description`). `%(verbose_name_plural)s` is replaced with the model's plural name |
| `permissions` | `['add' \| 'change' \| 'delete' \| 'view' \| 'x']`. The action is offered when any of `hasAddPermission(c)`, ..., or `hasXPermission(c)` is true |

```ts
import { action, ModelAdmin } from '@ghuri/admin'
import { getUser } from '@ghuri/core'

export const makePublished = action(
  { description: 'Mark selected %(verbose_name_plural)s as published', permissions: ['change'] },
  async (modelAdmin, c, queryset) => {
    const n = await queryset.update({ published: true })
    await modelAdmin.messageUser(c, `${n} posts were published.`, 'success')
  },
)

class PostAdmin extends ModelAdmin<Post> {
  actions = [makePublished, 'archive']

  @action({ description: 'Archive', permissions: ['publish'] })
  async archive(c: Context, queryset: QuerySet<Post>) {
    await queryset.update({ archived: true })
  }

  async hasPublishPermission(c: Context) {
    return getUser(c).hasPerm('blog.publish_post')
  }
}
```

Entries in `actions` can be functions, names of `ModelAdmin` methods (methods receive
`(c, queryset)`), or names of site-wide actions. Without a `description`, the label is the
humanized function name.

`messageUser(c, message, level)` adds a flash message; levels are `'debug'`, `'info'`,
`'success'`, `'warning'` and `'error'` (or the exported `DEBUG`, `INFO`, `SUCCESS`, `WARNING`,
`ERROR` constants).

### `delete_selected`

"Delete selected ..." (`deleteSelected`, named `delete_selected`) is a site-wide action that
requires the `delete` permission. Its confirmation page lists every object that will be deleted,
including cascades, and refuses when objects are protected or the user lacks delete permission
on any of them. Deletion goes through `deleteQueryset(c, qs)`.

| | |
|---|---|
| `admin.site.disableAction('delete_selected')` | Remove it everywhere. Name it in a `ModelAdmin`'s `actions` to re-enable it for that admin |
| `admin.site.addAction(fn, name?)` | Add a site-wide action |
| `admin.site.getAction(name)` | Look one up |
| `actions = null` | No actions (and no checkboxes) on one admin |

"Select all N" (selecting across pages) is supported.

## Inlines

`TabularInline` (rows of a table) and `StackedInline` (one full form per object) both extend
`InlineModelAdmin`:

```ts
import { ModelAdmin, StackedInline, TabularInline } from '@ghuri/admin'

class CommentInline extends TabularInline<Comment> {
  model = Comment
  extra = 1
  minNum = 0
  maxNum = 10
  canDelete = true
  showChangeLink = true
  fkName = 'post'      // only when Comment has several foreign keys to Post
  readonlyFields = ['createdAt']
}

class PostAdmin extends ModelAdmin<Post> {
  inlines = [CommentInline]
}
```

| Option | Default | |
|---|---|---|
| `model` | required | The inline model |
| `fkName` | auto-detected | The foreign key to the parent; required when there are several |
| `extra` | `3` | Empty forms shown |
| `minNum` / `maxNum` | `null` | Minimum and maximum number of forms |
| `canDelete` | `true` | Show "Delete" checkboxes |
| `showChangeLink` | `false` | Link each row to the object's own change form |
| `verboseName` / `verboseNamePlural` | the model's | Heading |
| `classes` | `[]` | CSS classes, e.g. `['collapse']` |
| `description` | unset | Text above the inline |

Inlines also take the form options (`fields`, `exclude`, `fieldsets`, `readonlyFields`,
`rawIdFields`, `autocompleteFields`, `formfieldOverrides`, ...) and the hooks `getExtra(c, obj)`,
`getMinNum(c, obj)` and `getMaxNum(c, obj)`. Permission hooks default to the inline model's
permissions; for auto-created many-to-many through models they use the parent's `change` (and
`view`) permission.

Without JavaScript the `extra` rows are shown; with it an "Add another ..." link clones rows. Form
fields are named like Django's formsets (`comments-0-text`, `comments-TOTAL_FORMS`, ...); the
prefix is the reverse accessor name, such as `comments` or `commentSet`.

## Hooks

Override these like Django's methods:

| Hook | |
|---|---|
| `getQueryset(c)` | Base queryset of every view. Return it synchronously |
| `getSearchResults(c, qs, term)` | `[qs, mayHaveDuplicates]` |
| `getListDisplay(c)`, `getListDisplayLinks(c, list)`, `getListFilter(c)`, `getSearchFields(c)`, `getSortableBy(c)`, `getListSelectRelated(c)`, `getOrdering(c)` | Per-request change list options |
| `getFields(c, obj)`, `getFieldsets(c, obj)`, `getReadonlyFields(c, obj)`, `getPrepopulatedFields(c, obj)`, `getExclude(c, obj)`, `getAutocompleteFields(c)` | Per-request form options |
| `getInlines(c, obj)`, `getInlineInstances(c, obj)` | Inlines |
| `getFormFields(c, obj, names?)`, `formfieldForDbField(c, field)`, `getFieldQueryset(c, field)`, `cleanForm(c, form)` | Form construction (Django's `get_form`) |
| `getChangeformInitialData(c)` | Initial values of the add form (default: the query string, `?title=Hi`) |
| `getObject(c, id)` | The object of the change, delete and history views |
| `saveModel(c, obj, form, change)`, `saveRelated(c, form, formsets, change)`, `saveFormset(c, form, formset, change)` | Saving |
| `deleteModel(c, obj)`, `deleteQueryset(c, qs)` | Deleting |
| `responseAdd(c, obj, data)`, `responseChange(c, obj, data)`, `responseDelete(c, repr)` | Redirects after saving (`_continue`, `_addanother`, `_saveasnew`) |
| `logAddition`, `logChange`, `logDeletion` | `LogEntry` records |
| `messageUser(c, message, level)` | Flash message |
| `lookupAllowed(lookup, value, c)` | Query-string filtering policy |
| `getActions(c)`, `getAction(spec)`, `responseAction(c, data, qs)` | Actions |
| `getUrls()` | URL patterns (add custom views) |
| `getDeletedObjects(objs, c)` | Objects listed on delete confirmations |
| `getViewOnSiteUrl(obj)`, `getEmptyValueDisplay()` | |

### Permission hooks

| Hook | Default |
|---|---|
| `hasViewPermission(c, obj?)` | `app.view_model` or `app.change_model` |
| `hasAddPermission(c)` | `app.add_model` |
| `hasChangePermission(c, obj?)` | `app.change_model` |
| `hasDeletePermission(c, obj?)` | `app.delete_model` |
| `hasModulePermission(c)` | `user.hasModulePerms(appLabel)` |

Active superusers pass every check. Users with only the view permission get read-only change
forms with no save buttons, and their POSTs answer `403`. The index and app pages list only
models the user may see. `AdminSite.hasPermission(c)` (default: active staff) guards the whole
site.

## Custom admin views

```tsx
import { path } from '@ghuri/core'

class PostAdmin extends ModelAdmin<Post> {
  getUrls() {
    return [
      path('stats/', this.adminSite.adminView((c) => this.stats(c)), { name: 'blog_post_stats' }),
      ...super.getUrls(),
    ]
  }

  async stats(c: Context) {
    const total = await Post.objects.count()
    return this.adminSite.renderPage(c, 'Post statistics', <p>{total} posts</p>)
  }
}
// /admin/blog/post/stats/, reverse('admin:blog_post_stats')
```

`adminSite.adminView(view)` requires a staff user (others are sent to the login page), checks
CSRF on unsafe methods and disables caching. `adminSite.renderPage(c, title, content)` renders
inside the admin chrome, `adminSite.render(c, jsx)` renders any page, and
`adminSite.eachContext(c)` returns the base template context.

## Customising the site

```ts
import { AdminSite } from '@ghuri/admin'

class MyAdminSite extends AdminSite {
  siteHeader = 'Acme back office'     // <h1> in the header
  siteTitle = 'Acme'                  // <title> suffix
  indexTitle = 'Dashboard'            // index page title
  siteUrl = '/'                       // "View site" link (null hides it)
  emptyValueDisplay = '—'
  enableNavSidebar = true
}

export const staffSite = new MyAdminSite({ name: 'staff' })   // URL namespace
staffSite.register(Post, PostAdmin)
// urls.ts: path('staff/', staffSite.urls), then reverse('staff:index')
```

| Attribute | Default |
|---|---|
| `name` | `'admin'` (the URL namespace) |
| `siteHeader` | `'Ghuri administration'` |
| `siteTitle` | `'Ghuri site admin'` |
| `indexTitle` | `'Site administration'` |
| `siteUrl` | `'/'` |
| `emptyValueDisplay` | `'-'` |
| `enableNavSidebar` | `true` |

The same keys can be passed to the constructor (`new AdminSite({ name, siteHeader, ... })`), or
set on the default site in place: `admin.site.siteHeader = 'Acme'`. Override `hasPermission(c)`,
`getUrls()`, `index(c)` and `getAppList(c)` like Django's. `@admin.register(Post, { site: staffSite })`
registers on another site.

### Assets

`ADMIN_ASSETS` configures the admin's front-end assets:

```ts title="src/settings.ts"
ADMIN_ASSETS: { htmx: '/static/htmx.min.js', css: ['/static/admin-brand.css'], js: [] },
```

| Key | Default | |
|---|---|---|
| `htmx` | jsDelivr CDN | URL of htmx (used by autocomplete); `false` or `null` disables it |
| `css` | `[]` | Extra stylesheets on every admin page |
| `js` | `[]` | Extra deferred scripts on every admin page |

The admin's own stylesheet and script are served at `<admin>/static/admin.css` and
`<admin>/static/admin.js` with long-lived immutable caching (their URLs carry the version).

## Users and groups

When `auth` is installed, `UserAdmin` and `GroupAdmin` are registered on `admin.site`, unless you
register your own or `AUTH_USER_MODEL` swaps the user model (then register yours). Like Django's:

- the add form asks for the username and the password twice (password validators apply), stores
  a hash, then continues to the full form;
- the change form shows the hash summary (algorithm, iterations, masked salt and hash) and links
  to `<id>/password/` (`admin:auth_user_password_change`) to set a new password;
- `groups`, `userPermissions` and a group's `permissions` use the filter widget.

`admin.site.unregister(User); admin.site.register(User, MyUserAdmin)` replaces it (subclass
`UserAdmin`).

## URL names

All live in the site's namespace (`admin:` for `admin.site`):

| Name | URL |
|---|---|
| `index` | `/admin/` |
| `login`, `logout` | `login/`, `logout/` (POST only) |
| `password_change`, `password_change_done` | `password_change/`, `password_change/done/` |
| `app_list` (`app_label`) | `<app_label>/` |
| `<app>_<model>_changelist` | `<app>/<model>/` |
| `<app>_<model>_add` | `<app>/<model>/add/` |
| `<app>_<model>_change` / `_delete` / `_history` (`object_id`) | `<app>/<model>/<id>/change/`, ... |
| `auth_user_password_change` | `auth/user/<id>/password/` |
| `autocomplete` | `autocomplete/` |
| `static` (`path`) | `static/admin.css`, `static/admin.js` |

```ts
import { quote } from '@ghuri/admin'

reverse('admin:blog_post_change', { object_id: quote(post.pk) })
```

Primary keys in URLs are escaped with Django's `quote()` / `unquote()`, both exported.

## Testing

```ts
import { createTestClient } from '@ghuri/core/testing'

const client = createTestClient(app, { env })
await client.forceLogin(await User.objects.createSuperuser('admin', 'a@example.com', 'pw'))
const res = await client.post('/admin/blog/post/add/', {
  form: { title: 'Hi', slug: 'hi', 'comments-TOTAL_FORMS': '0', 'comments-INITIAL_FORMS': '0' },
})
expect(res.status).toBe(302)
```

## Differences from Django

- Views are async and receive the Hono context `c` instead of `request`.
- No `ModelForm` classes: override `getFormFields()`, `formfieldForDbField()` or `cleanForm()`.
  `formfieldOverrides` is keyed by the field's `internalType`.
- Dates and times use native `date`, `time` and `datetime-local` inputs, in UTC; display uses
  Django's default formats in `TIME_ZONE`.
- Templates are JSX components, not overridable template files. Customise through options, hooks,
  `ADMIN_ASSETS.css` and custom views.
- No "+" related-object popups, no `jsi18n`, no `view_on_site` redirect view (links go straight
  to `getAbsoluteUrl()`), no "show facets", and no `@` full-text search (it is treated as
  `icontains`).
- Autocomplete is a search box and select powered by htmx, not Select2.
- Delete confirmations do not list auto-created many-to-many through rows.
- Logout is POST-only, as in Django 5.
