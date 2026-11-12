---
title: 'Part 3: The admin'
description: Create a superuser, register models with the admin and customise the change list and forms.
---

Ghuri ships an admin modelled on Django's: a staff-only site that lets trusted users create,
edit and delete your models. It is rendered on the server with Hono JSX and enhanced with htmx,
so it runs on Workers and needs no frontend build.

## Create an admin user

```sh
npx ghuri createsuperuser
```

```
Username: admin
Email address: admin@example.com
Password:
Password (again):
Superuser created successfully.
```

Visit `http://localhost:8787/admin/` and log in. You will see the **Authentication and
Authorization** section with Users and Groups. The admin registers those itself because
`AuthConfig` is installed. Your blog models are not there yet.

`createsuperuser` also works without prompts, which is handy in scripts and CI:
`GHURI_SUPERUSER_PASSWORD=… npx ghuri createsuperuser --no-input --username admin --email admin@example.com`.

## Register the blog models

Open `src/blog/admin.ts`, which `startapp` created with a commented-out example, and register
the models:

```ts title="src/blog/admin.ts"
import { admin } from '@ghuri/admin'
import { Post, Tag, Comment } from './models'

admin.site.register(Post)
admin.site.register(Tag)
admin.site.register(Comment)
```

`BlogConfig` already imports this module (`admin = admin` in `app.ts`), and importing it is
what runs the `register` calls. Reload the admin index and a **Blog** section appears with all
three models.

Click **Posts**. The change list shows each post using its `toString()`. Click one to get a form
generated from the model fields: a text input for `title`, a textarea for `body`, a checkbox for
`published`, a select for `author` and a multi-select for `tags`. Required fields, `maxLength`
and `unique` are validated on save, and errors show next to the field.

:::note
Unlike Django, related-object selects have no green "+" button to create a related object in
a popup. Create the tag first (or use an inline), then pick it.
:::

The **History** link on each object lists every change made through the admin, recorded in the
`LogEntry` model.

## Customise the admin

The defaults are useful, but the admin becomes much better once you tell it about your data.
Replace the `Post` registration with a `ModelAdmin` class:

```ts title="src/blog/admin.ts"
import { action, admin, ModelAdmin, TabularInline } from '@ghuri/admin'
import { Post, Tag, Comment } from './models'

class CommentInline extends TabularInline<Comment> {
  model = Comment
  extra = 0
  fields = ['author', 'body', 'approved']
}

const makePublished = action(
  { description: 'Mark selected posts as published', permissions: ['change'] },
  async (modelAdmin, c, queryset) => {
    const n = await queryset.update({ published: true })
    await modelAdmin.messageUser(c, `${n} posts were published.`, 'success')
  },
)

@admin.register(Post)
export class PostAdmin extends ModelAdmin<Post> {
  listDisplay = ['title', 'author', 'published', 'createdAt']
  listFilter = ['published', 'createdAt', 'tags']
  searchFields = ['title', 'body', 'author__username']
  prepopulatedFields = { slug: ['title'] }
  readonlyFields = ['createdAt', 'updatedAt']
  fieldsets = [
    [null, { fields: ['title', 'slug', 'body'] }],
    ['Publishing', { fields: ['author', 'tags', 'published', 'createdAt', 'updatedAt'], classes: ['collapse'] }],
  ]
  inlines = [CommentInline]
  actions = [makePublished]
  dateHierarchy = 'createdAt'
  ordering = ['-createdAt']
  listPerPage = 50
}

@admin.register(Tag)
export class TagAdmin extends ModelAdmin<Tag> {
  searchFields = ['name']
}

admin.site.register(Comment)
```

Reload the post list. You now have:

- **Columns** for title, author, published and created date, sortable by clicking the header.
- A **filter sidebar** for published, created date and tags.
- A **search box** that searches title, body and the author's username.
- A **date hierarchy** above the list to drill down by year, month and day.
- An **action** in the bulk actions menu, next to the built-in "Delete selected".

On the change form, the slug fills itself in as you type a title, the publishing fields sit in
a collapsible fieldset, and comments are edited inline at the bottom.

:::tip[If you know Django]
`ModelAdmin` options use the same names in camelCase: `list_display` → `listDisplay`,
`search_fields` → `searchFields`, `prepopulated_fields` → `prepopulatedFields`, and so on.
`@admin.register(Post)` is the decorator you know (a standard TC39 decorator, so no
`experimentalDecorators` flag). `action({ description, permissions }, fn)` is
`@admin.action(description=..., permissions=[...])`, and actions receive `(modelAdmin, c, queryset)`
where Django passes `(modeladmin, request, queryset)`.
:::

## Permissions

The admin is for staff only: a user needs `isStaff` to log in, and then sees only the models
they have permissions for. Ghuri creates four permissions for every model after `migrate`:
`blog.add_post`, `blog.change_post`, `blog.delete_post` and `blog.view_post`. Superusers have
all of them.

To give an editor access to posts but not comments, create a group in the admin, give it the
post permissions, and add the user to it. For finer control, override the permission hooks:

```ts title="src/blog/admin.ts"
import type { Context } from 'hono'
import { getUser } from '@ghuri/core'

export class PostAdmin extends ModelAdmin<Post> {
  // ...
  async hasChangePermission(c: Context, obj?: Post) {
    if (obj && obj.authorId !== getUser(c).pk) return getUser(c).isSuperuser ?? false
    return super.hasChangePermission(c, obj)
  }
}
```

Read [The admin](/docs/topics/admin/) for inlines, custom sites, autocomplete and file uploads,
and the [admin reference](/docs/topics/admin-reference/) for every `ModelAdmin` option.

Next: [Part 4: A REST API](/docs/tutorial/part-4-rest-api/).
