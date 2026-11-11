---
title: Permissions
description: Decide who may call an API view, with built-in classes, model permissions, object permissions and custom classes.
---

Authentication tells you **who** made the request. Permissions decide whether they are
**allowed** to. A view's `permissionClasses` are checked after authentication and before the
handler runs; if any class denies the request the client gets `403 Forbidden`, or
`401 Unauthorized` when the user is not authenticated and an authentication class can issue a
challenge.

```ts
import { ModelViewSet, IsAuthenticatedOrReadOnly } from '@ghuri/rest'

export class PostViewSet extends ModelViewSet<Post> {
  permissionClasses = [IsAuthenticatedOrReadOnly]
}
```

The default for views that do not set `permissionClasses` is
`REST_FRAMEWORK.DEFAULT_PERMISSION_CLASSES`, which is `[AllowAny]` unless you change it. Most
projects should set a stricter default:

```ts title="src/settings.ts"
REST_FRAMEWORK: {
  DEFAULT_PERMISSION_CLASSES: [IsAuthenticated],
}
```

:::tip[If you know Django]
Same classes and semantics as DRF: `has_permission` → `hasPermission`,
`has_object_permission` → `hasObjectPermission`, `DjangoModelPermissions` → `ModelPermissions`,
`DjangoObjectPermissions` → `ObjectPermissions`. Composition uses methods (`IsAdminUser.or(...)`)
because TypeScript has no operator overloading for `|` and `&`.
:::

## Built-in classes

| Class | Allows |
|---|---|
| `AllowAny` | Everyone |
| `IsAuthenticated` | Authenticated users |
| `IsAdminUser` | Users with `isStaff` |
| `IsAuthenticatedOrReadOnly` | Everyone for `GET`, `HEAD`, `OPTIONS`; authenticated users otherwise |
| `ModelPermissions` | Authenticated users holding the model permission for the method |
| `ModelPermissionsOrAnonReadOnly` | As above, plus anonymous read access |
| `ObjectPermissions` | Per-object permissions from your authentication backend |

### Model permissions

`ModelPermissions` maps HTTP methods to the permissions that `@ghuri/auth` creates for every
model after `migrate`:

| Method | Required permission |
|---|---|
| `GET`, `HEAD`, `OPTIONS` | none (add `view` with `ModelPermissions.withView()`) |
| `POST` | `blog.add_post` |
| `PUT`, `PATCH` | `blog.change_post` |
| `DELETE` | `blog.delete_post` |

It reads the model from the view's `queryset` (or `getQueryset()`), so it only works on
model-backed views. Assign the permissions to users or groups in the
[admin](/docs/topics/admin/) or in code:

```ts
const editors = await Group.objects.get({ name: 'Editors' })
const perms = await Permission.objects.filter({ codename__in: ['add_post', 'change_post'] })
await editors.permissions.add(...perms)
```

## Object permissions

`hasPermission(request, view)` runs for every request. `hasObjectPermission(request, view, obj)`
runs when the view calls `getObject()`, which every detail action of the generic views and
viewsets does. If you write a custom action that loads an object some other way, call
`this.checkObjectPermissions(obj)` yourself.

List actions never check object permissions, because doing so would mean one check per row.
Filter the queryset instead:

```ts
getQueryset() {
  return Post.objects.filter({ author: this.request.user.pk })
}
```

## Writing a permission class

Extend `BasePermission` and implement either or both methods. Both may be async and both default
to `true`.

```ts title="src/blog/permissions.ts"
import { BasePermission, SAFE_METHODS, type APIRequest } from '@ghuri/rest'
import type { Post } from './models'

export class IsAuthorOrReadOnly extends BasePermission {
  message = 'Only the author can change this post.'

  hasObjectPermission(request: APIRequest, view: unknown, post: Post) {
    if (SAFE_METHODS.includes(request.method)) return true
    return post.authorId === request.user.pk
  }
}
```

`message` (and optionally `code`) replace the default `detail` in the 403 response.

A permission that consults the database:

```ts
export class IsBlogMember extends BasePermission {
  async hasPermission(request: APIRequest) {
    if (!request.user.isAuthenticated) return false
    return Membership.objects.filter({ user: request.user.pk, active: true }).exists()
  }
}
```

## Composing permissions

Every permission class has static `and`, `or` and `not` helpers that return a new class:

```ts
import { IsAdminUser, IsAuthenticated, IsAuthenticatedOrReadOnly } from '@ghuri/rest'
import { IsAuthorOrReadOnly } from './permissions'

export class PostViewSet extends ModelViewSet<Post> {
  // staff can do anything; everyone else needs to be the author for writes
  permissionClasses = [IsAuthenticatedOrReadOnly, IsAdminUser.or(IsAuthorOrReadOnly)]
}

// readers who are logged in but not staff
permissionClasses = [IsAuthenticated.and(IsAdminUser.not())]
```

Listing several classes in `permissionClasses` is an implicit `and`: all must pass.

## Per-action permissions

Override `getPermissions()` to vary by action, or pass `permissionClasses` to `@action`:

```ts
export class PostViewSet extends ModelViewSet<Post> {
  getPermissions() {
    if (this.action === 'destroy') return [new IsAdminUser()]
    return super.getPermissions()
  }

  @action({ detail: true, methods: ['post'], permissionClasses: [IsAdminUser] })
  async feature(c: Context) { ... }
}
```

## The same permissions everywhere

Permission classes are not only for HTTP. The [agents package](/docs/topics/agents/) runs model
and viewset tools through the same `permissionClasses`, with the agent's request user, so an LLM
calling `posts_destroy` is held to exactly the rules a client calling `DELETE /api/posts/1/` is.
