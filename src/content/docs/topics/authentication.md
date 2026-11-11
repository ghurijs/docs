---
title: Authentication
description: Users, groups and permissions, password hashing, sessions, logging in and out, view decorators and custom user models with @ghuri/auth.
---

`@ghuri/auth` is Ghuri's `django.contrib.auth`. It provides users, groups and permissions,
Django-compatible password hashing, sessions, and the middleware and helpers that attach a user
to each request. Token and JWT authentication for APIs live in `@ghuri/auth/rest` and are
covered in [REST authentication](/docs/topics/rest/authentication/).

## Installation

The project template installs it already:

```ts title="src/settings.ts"
import { defineSettings, SecurityMiddleware, CommonMiddleware, CsrfMiddleware } from '@ghuri/core'
import { AuthConfig, SessionMiddleware, AuthenticationMiddleware } from '@ghuri/auth'

export default defineSettings((env) => ({
  INSTALLED_APPS: [AuthConfig /* , ... */],
  MIDDLEWARE: [SecurityMiddleware, CommonMiddleware, SessionMiddleware, CsrfMiddleware, AuthenticationMiddleware],
  // ...
}))
```

`SessionMiddleware` must come before `AuthenticationMiddleware`, which reads the user id from
the session.

## The User model

`User` (label `auth.User`) has the same fields as Django's:

| Field | Type |
|---|---|
| `username` | `CharField`, unique, max 150 |
| `email` | `EmailField`, blank |
| `firstName`, `lastName` | `CharField`, blank |
| `password` | hashed password string |
| `isStaff` | may log in to the admin |
| `isActive` | inactive users cannot log in |
| `isSuperuser` | has every permission |
| `lastLogin`, `dateJoined` | `DateTimeField` |
| `groups` | many-to-many to `Group` |
| `userPermissions` | many-to-many to `Permission` |

Create users through the manager, which hashes the password for you:

```ts
import { User } from '@ghuri/auth'

const user = await User.objects.createUser({ username: 'rifat', email: 'r@example.com', password: 'correct horse' })
const admin = await User.objects.createSuperuser({ username: 'admin', email: 'a@example.com', password: 's3cret-pass' })

await user.setPassword('new password')   // hashing uses WebCrypto, so it is async
await user.save()
await user.checkPassword('new password')  // true
```

Never assign `user.password` directly. It holds the hash, not the password. `setPassword` and
`checkPassword` are async because WebCrypto is; that is the one difference from Django here.

From the command line, `npx ghuri createsuperuser` creates an admin user and
`npx ghuri changepassword <username>` resets a password. Both accept `--remote` to act on the
deployed database.

## Who is the current user?

`AuthenticationMiddleware` sets the user on the Hono context. Read it with `getUser(c)` from
`@ghuri/core` or `c.get('user')`:

```ts title="src/blog/views.ts"
import type { Context } from 'hono'
import { getUser, json } from '@ghuri/core'

export async function me(c: Context) {
  const user = getUser(c)
  if (!user.isAuthenticated) return json(c, { user: null })
  return json(c, { id: user.pk, username: user.username, staff: user.isStaff })
}
```

When nobody is logged in, `getUser(c)` returns an `AnonymousUser`, whose `isAuthenticated` is
`false` and whose `hasPerm()` always resolves to `false`. You never get `null`.

`getUser` lives in core, which lets REST, the admin and agents check permissions without
importing `@ghuri/auth`.

## Logging in and out

`authenticate(c, credentials)` asks each backend in `AUTHENTICATION_BACKENDS` whether the
credentials are valid. `login(c, user)` stores the user in the session and rotates the session
key. `logout(c)` flushes the session.

```tsx title="src/accounts/views.tsx"
import type { Context } from 'hono'
import { redirect, getCsrfToken } from '@ghuri/core'
import { authenticate, login, logout } from '@ghuri/auth'

export async function loginView(c: Context) {
  let error = ''
  if (c.req.method === 'POST') {
    const form = await c.req.parseBody()
    const user = await authenticate(c, { username: String(form.username), password: String(form.password) })
    if (user) {
      await login(c, user)
      return redirect(c, c.req.query('next') ?? 'blog:index')
    }
    error = 'Please enter a correct username and password.'
  }
  return c.html(
    <form method="post">
      <input type="hidden" name="csrfmiddlewaretoken" value={getCsrfToken(c)} />
      {error && <p class="error">{error}</p>}
      <input name="username" autocomplete="username" />
      <input name="password" type="password" autocomplete="current-password" />
      <button>Log in</button>
    </form>,
  )
}

export async function logoutView(c: Context) {
  await logout(c)
  return redirect(c, 'home')
}
```

`authenticate` resolves to `null` both for wrong credentials and for inactive users. It never
tells you which, so you do not leak which usernames exist.

## Protecting views

Wrap view functions with the helpers:

```ts title="src/blog/urls.ts"
import { path } from '@ghuri/core'
import { loginRequired, permissionRequired, staffMemberRequired } from '@ghuri/auth'
import * as views from './views'

export const urlpatterns = [
  path('drafts/', loginRequired(views.drafts), { name: 'drafts' }),
  path('<slug:slug>/edit/', permissionRequired('blog.change_post')(views.edit), { name: 'edit' }),
  path('stats/', staffMemberRequired(views.stats), { name: 'stats' }),
]
```

`loginRequired` redirects anonymous users to `LOGIN_URL` with `?next=`. A user who is logged in
but lacks the permission gets `403` from `permissionRequired`. For class-based views, wrap
the result of `asView()`: `loginRequired(PostEditView.asView())`.

:::tip[If you know Django]
`login_required`, `permission_required` and `staff_member_required` are plain higher-order
functions here, because TypeScript decorators cannot decorate standalone functions. Usage in
`urls.ts` is the same as wrapping views in Django's `urls.py`.
:::

## Permissions and groups

Each model gets four permissions after `migrate`: `add_<model>`, `change_<model>`,
`delete_<model>` and `view_<model>`. You check them by `appLabel.codename`:

```ts
await user.hasPerm('blog.change_post')          // true / false
await user.hasPerms(['blog.add_post', 'blog.change_post'])
await user.hasModulePerms('blog')               // any permission in the app
```

Superusers pass every check. Inactive users fail every check. Users get permissions directly
(`userPermissions`) or through groups:

```ts
import { Group, Permission } from '@ghuri/auth'

const editors = await Group.objects.create({ name: 'Editors' })
const perms = await Permission.objects.filter({ contentType__appLabel: 'blog', codename__in: ['change_post', 'view_post'] })
await editors.permissions.set(perms)
await user.groups.add(editors)
```

Declare extra permissions on a model with `Meta.permissions`:

```ts
static Meta = { permissions: [['publish_post', 'Can publish posts']] }
```

## Sessions

`SessionMiddleware` loads the session from the `sessionid` cookie and exposes it as
`c.get('session')`:

```ts
const session = c.get('session')
const views = ((await session.get('views')) as number | undefined) ?? 0
await session.set('views', views + 1)
```

Where sessions are stored is chosen by `SESSION_ENGINE`:

| Engine | Storage | Notes |
|---|---|---|
| `'db'` (default) | the `Session` model | Works everywhere; one row per session |
| `'kv'` | Workers KV | Fast reads at the edge. KV is eventually consistent, so a logout can take up to a minute to reach other locations |
| `'signedCookie'` | the cookie itself | No storage. Data is signed with `SECRET_KEY` but readable by the client, and limited to about 4 KB |

Expired database sessions are not deleted automatically. Run `npx ghuri clearsessions` from a
cron job.

## Passwords

Passwords are hashed with PBKDF2-SHA256 through WebCrypto, so hashing works on Workers with
no native modules. The stored format is exactly Django's:

```
pbkdf2_sha256$870000$Jb0x6Z...$9q3lG4u...=
```

This means **you can copy users from a Django project** and their passwords keep working. Move
the `auth_user` rows with Django's `dumpdata auth.user`, rename the fields to camelCase, and
`loaddata` them. When a user logs in with a hash that uses fewer iterations than the current
default, the hash is upgraded on the spot.

Configure hashers and password validation in settings:

```ts title="src/settings.ts"
import { PBKDF2PasswordHasher, ScryptPasswordHasher, MinimumLengthValidator, CommonPasswordValidator,
  NumericPasswordValidator, UserAttributeSimilarityValidator } from '@ghuri/auth'

PASSWORD_HASHERS: [PBKDF2PasswordHasher, ScryptPasswordHasher],   // first one hashes new passwords
AUTH_PASSWORD_VALIDATORS: [
  [UserAttributeSimilarityValidator],
  [MinimumLengthValidator, { minLength: 10 }],
  [CommonPasswordValidator],
  [NumericPasswordValidator],
],
```

Validators run in `createsuperuser`, `changepassword`, the admin's password forms and
`validatePassword(password, user)`. `createUser` does not run them, as in Django.

`makePassword(raw)` and `checkPassword(raw, encoded)` are available on their own when you need
hashing outside the user model.

## Custom user models

To add fields to users, define your own model from `AbstractUser` at the start of a project and
point `AUTH_USER_MODEL` at it:

```ts title="src/accounts/models.ts"
import { Model, URLField, TextField } from '@ghuri/orm'
import { AbstractUser } from '@ghuri/auth'

export class User extends Model({
  website: new URLField({ blank: true }),
  bio: new TextField({ blank: true }),
}, { extends: AbstractUser }) {}
```

```ts title="src/settings.ts"
INSTALLED_APPS: [AuthConfig, AccountsConfig, /* ... */],
AUTH_USER_MODEL: 'accounts.User',
```

`AbstractBaseUser` gives you only `password` and `lastLogin` if you want to start from scratch.
Then set `static USERNAME_FIELD` and `static REQUIRED_FIELDS` the way Django does.

Code that refers to "the user model" should not import a concrete class. Use `getUserModel()`
at runtime, and `'auth.User'`-style strings (or the setting) for relations:

```ts
import { getUserModel } from '@ghuri/auth'

const UserModel = getUserModel()
const staff = await UserModel.objects.filter({ isStaff: true })
```

Change `AUTH_USER_MODEL` before your first `migrate`. Switching it afterwards is as hard as it is
in Django.

## Tokens and JWT

For APIs and mobile clients use `TokenAuthentication` (one opaque token per user, stored in
the `Token` model) or `JWTAuthentication` with refresh tokens. Both are documented in
[REST authentication](/docs/topics/rest/authentication/).
