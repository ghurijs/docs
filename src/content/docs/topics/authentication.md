---
title: Authentication
description: Users, groups and permissions, password hashing, sessions, logging in and out, view decorators and custom user models with @ghuri/auth.
---

`@ghuri/auth` is Ghuri's `django.contrib.auth`, `contenttypes` and `sessions`. It provides users,
groups and permissions, Django-compatible password hashing, sessions, and the middleware and
helpers that attach a user to each request. API tokens and JWT (DRF's `authtoken` and
`djangorestframework-simplejwt`) ship in the same package; they are covered in
[API tokens and JWT](/docs/topics/auth-tokens/), and the REST authentication classes in
[REST authentication](/docs/topics/rest/authentication/).

## Installation

The project template installs it already:

```ts title="src/settings.ts"
import { CommonMiddleware, CsrfMiddleware, defineSettings, SecurityMiddleware } from '@ghuri/core'
import {
  AuthConfig, AuthenticationMiddleware, ContentTypesConfig, SessionMiddleware, SessionsConfig,
} from '@ghuri/auth'

export default defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig /* , your apps */],
  MIDDLEWARE: [SecurityMiddleware, SessionMiddleware, CommonMiddleware, CsrfMiddleware, AuthenticationMiddleware],
  // ...
}))
```

`SessionMiddleware` must come before `AuthenticationMiddleware`, which reads the user id from
the session. `authApps` is `[ContentTypesConfig, AuthConfig, SessionsConfig]` if you prefer to
spread it into `INSTALLED_APPS`.

The package contains five apps. Their labels and table names are Django's, so an existing Django
database (or a `dumpdata` of one) fits as is:

| App config | Label | Models (tables) |
|---|---|---|
| `ContentTypesConfig` | `contenttypes` | `ContentType` (`django_content_type`) |
| `AuthConfig` | `auth` | `User` (`auth_user`), `Group` (`auth_group`), `Permission` (`auth_permission`) |
| `SessionsConfig` | `sessions` | `Session` (`django_session`). Needed for `SESSION_ENGINE: 'db'` |
| `AuthTokenConfig` | `authtoken` | `Token` (`authtoken_token`). See [API tokens and JWT](/docs/topics/auth-tokens/) |
| `TokenBlacklistConfig` | `token_blacklist` | `OutstandingToken`, `BlacklistedToken`. JWT refresh-token revocation |

`auth` requires `contenttypes`: list `ContentTypesConfig` before `AuthConfig`, or startup fails
with `ImproperlyConfigured`.

Every app ships its initial migration, so `npx ghuri migrate` creates the tables on D1, SQLite
or Postgres without running `makemigrations` for them. After `migrate`, the `postMigrate` signal
runs `createPermissions()`, which creates a `ContentType` per model and the default permissions.

## The User model

`User` (label `auth.User`, table `auth_user`) has Django's fields in camelCase:

| Field | Type |
|---|---|
| `username` | `CharField`, unique, max 150, validated with `unicodeUsernameValidator` |
| `email` | `EmailField`, blank |
| `firstName`, `lastName` | `CharField`, blank |
| `password` | hashed password string |
| `isStaff` | may log in to the admin |
| `isActive` | inactive users cannot log in |
| `isSuperuser` | has every permission |
| `lastLogin`, `dateJoined` | `DateTimeField` |
| `groups` | many-to-many to `Group` |
| `userPermissions` | many-to-many to `Permission` |

Create users through the manager, which hashes the password for you. It takes Django's
positional arguments or an object:

```ts
import { User } from '@ghuri/auth'

const user = await User.objects.createUser('rifat', 'r@example.com', 'correct horse', { firstName: 'Rifat' })
await User.objects.createUser({ username: 'bob', email: 'bob@example.com', password: 'pw' })
const admin = await User.objects.createSuperuser('admin', 'a@example.com', 's3cret-pass')

await user.setPassword('new password')   // hashing uses WebCrypto, so it is async
await user.save()
await user.checkPassword('new password')  // true
user.setUnusablePassword()
user.hasUsablePassword()                  // false
```

Never assign `user.password` directly. It holds the hash, not the password. `setPassword` and
`checkPassword` are async because WebCrypto is; that is the main difference from Django here.

From the command line:

| Command | |
|---|---|
| `npx ghuri createsuperuser` | Prompts for the username, `REQUIRED_FIELDS` and the password twice, and runs the password validators (offering to bypass them). Non-interactive: `--no-input --username admin --email a@example.com` with `--password` or the `GHURI_SUPERUSER_PASSWORD` environment variable (and `GHURI_SUPERUSER_<FIELD>` for other fields). Without a password the user gets an unusable one |
| `npx ghuri changepassword [username]` | Prompts twice (three attempts), or takes `--password` |
| `npx ghuri clearsessions` | Deletes expired database sessions |

Add the global `--remote` flag to act on the deployed D1 database instead of the local one.

## Who is the current user?

`AuthenticationMiddleware` sets the user on the Hono context. Read it with `getUser(c)` (from
`@ghuri/core`, re-exported by `@ghuri/auth`) or `c.get('user')`:

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

Requests without a session cookie never touch the database. When there is a session, the
session and the user are loaded before the view runs (a TypeScript getter cannot lazily await,
so "lazy" here means "only when there is a session").

`getUser` lives in core, which lets REST, the admin and agents check permissions without
importing `@ghuri/auth`.

## Logging in and out

`authenticate(c, credentials)` asks each backend in `AUTHENTICATION_BACKENDS` whether the
credentials are valid. `login(c, user)` stores the user in the session and rotates both the
session key and the CSRF token. `logout(c)` flushes the session.

```tsx title="src/accounts/views.tsx"
import type { Context } from 'hono'
import { getCsrfToken, redirect } from '@ghuri/core'
import { authenticate, isSafeRedirect, login, logout } from '@ghuri/auth'

export async function loginView(c: Context) {
  let error = ''
  if (c.req.method === 'POST') {
    const form = await c.req.parseBody()
    const user = await authenticate(c, { username: String(form.username), password: String(form.password) })
    if (user) {
      await login(c, user)
      const next = c.req.query('next')
      const host = new URL(c.req.url).host
      return redirect(c, next && isSafeRedirect(next, [host]) ? next : 'blog:index')
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

`authenticate` resolves to `null` both for wrong credentials and for inactive users, and sends the
`userLoginFailed` signal. It never tells you which case applied, so you do not leak which
usernames exist. Sessions are bound to the password hash: changing a password logs out every
other session. Call `updateSessionAuthHash(c, user)` after a password change to keep the current
one.

Backends (`AUTHENTICATION_BACKENDS`, default `[ModelBackend]`): `ModelBackend` (the
`USERNAME_FIELD` and a password, rejects `isActive = false`), `AllowAllUsersModelBackend`,
`RemoteUserBackend` (with `RemoteUserMiddleware` or `PersistentRemoteUserMiddleware` and the
`REMOTE_USER_HEADER` setting), or your own `BaseBackend` subclass. Give a custom backend a
`static backendName`; that name is stored in the session.

Signals: `userLoggedIn` (updates `lastLogin`; disconnect the uid `ghuri.auth.updateLastLogin` to
opt out), `userLoggedOut` and `userLoginFailed` (credentials with sensitive values masked).

### Built-in auth views

Instead of writing the views yourself, include `authUrls`:

```ts title="src/urls.ts"
import { include, path } from '@ghuri/core'
import { authUrls } from '@ghuri/auth'

export const urlpatterns = [path('accounts/', include(authUrls))]
```

| URL | Name | |
|---|---|---|
| `login/` | `login` | `POST {username, password}` as JSON or a form. JSON answers `{ user }`; forms redirect to a safe `next` or `LOGIN_REDIRECT_URL`. `GET` returns `{ csrfToken }` or a minimal HTML form |
| `logout/` | `logout` | `POST` only |
| `password_change/` | `password_change` | `POST {oldPassword, newPassword1, newPassword2}`, login required |
| `password_reset/` | `password_reset` | `POST {email}`, then calls `sendResetEmail(c, { user, uid, token, url })` |
| `reset/<uidb64>/<token>/` | `password_reset_confirm` | `GET` checks the link, `POST {newPassword1, newPassword2}` sets the password |
| `me/` | `whoami` | The current user |

:::note
Ghuri has no mail package yet. To deliver password-reset links, subclass `PasswordResetView` or
pass `sendResetEmail` with `PasswordResetView.asView({ sendResetEmail })`. Reset tokens come from
`defaultTokenGenerator` (a Django-compatible `PasswordResetTokenGenerator`), expire after
`PASSWORD_RESET_TIMEOUT` (3 days by default) and are invalidated by a password change or a new
login.
:::

## Protecting views

Wrap view functions with the helpers:

```ts title="src/blog/urls.ts"
import { path } from '@ghuri/core'
import { loginRequired, permissionRequired, staffMemberRequired, userPassesTest } from '@ghuri/auth'
import * as views from './views'

export const urlpatterns = [
  path('drafts/', loginRequired(views.drafts), { name: 'drafts' }),
  path('<slug:slug>/edit/', permissionRequired('blog.change_post')(views.edit), { name: 'edit' }),
  path('reports/', userPassesTest((u) => u.isStaff)(views.reports), { name: 'reports' }),
  path('stats/', staffMemberRequired(views.stats), { name: 'stats' }),
]
```

Anonymous browsers are redirected to `LOGIN_URL` with `?next=`; JSON clients get `401`. A user
who is logged in but lacks access gets `403`. For class-based views, use the mixins:

```ts
import { LoginRequiredMixin, PermissionRequiredMixin, UserPassesTestMixin } from '@ghuri/auth'

class Dashboard extends LoginRequiredMixin(View) { async get(c: Context) { /* ... */ } }
class Publish extends PermissionRequiredMixin(View) { permissionRequired = 'blog.publish_post' }
class Mine extends UserPassesTestMixin(View) { testFunc(c: Context) { return getUser(c).isStaff } }
```

:::tip[If you know Django]
`login_required`, `permission_required` and `staff_member_required` are plain higher-order
functions here, because TypeScript decorators cannot decorate standalone functions. Usage in
`urls.ts` is the same as wrapping views in Django's `urls.py`. One difference: a logged-in user
without access gets `403`, not a redirect to the login page.
:::

## Permissions and groups

Each model gets four permissions after `migrate`: `add_<model>`, `change_<model>`,
`delete_<model>` and `view_<model>` (`Meta.defaultPermissions`). You check them by
`appLabel.codename`:

```ts
await user.hasPerm('blog.change_post')          // true / false
await user.hasPerms(['blog.add_post', 'blog.change_post'])
await user.hasModulePerms('blog')               // any permission in the app
await user.getAllPermissions()                  // Set<'app.codename'>, cached on the instance
user.clearPermCache()
```

Active superusers pass every check. Inactive users fail every check. Users get permissions
directly (`userPermissions`) or through groups:

```ts
import { ContentType, Group, Permission, User } from '@ghuri/auth'

const editors = await Group.objects.create({ name: 'Editors' })
await editors.permissions.add(await Permission.objects.getByNaturalKey('change_post', 'blog', 'post'))
await user.groups.add(editors)

await User.objects.withPerm('blog.change_post')   // users having it, superusers included
await ContentType.objects.getForModel(Post)        // cached
```

Declare extra permissions on a model with `Meta.permissions`:

```ts
static Meta = { permissions: [['publish_post', 'Can publish posts']] }
```

## Sessions

`SessionMiddleware` loads the session from the `sessionid` cookie and exposes it as
`c.get('session')` (or `getSession(c)`). The API is async because the data loads lazily:

```ts
const session = c.get('session')
const views = await session.get('views', 0)       // with a default
await session.set('views', views + 1)
await session.has('cart'); await session.delete('cart'); await session.pop('x')
await session.setExpiry(0)                        // expire at browser close (seconds, a Date, or null)
await session.cycleKey(); await session.flush()
```

Where sessions are stored is chosen by `SESSION_ENGINE`:

| Engine | Storage | Notes |
|---|---|---|
| `'db'` (default) | the `Session` model (`django_session`) | Strongly consistent and works everywhere. Needs `SessionsConfig` |
| `'kv'` | a Workers KV binding (`SESSION_KV_BINDING`, default `SESSIONS`) | Fast reads at the edge. KV is eventually consistent, so a logout can take up to a minute to reach other locations |
| `'cache'` | a core cache (`SESSION_CACHE_ALIAS`) | Sessions are lost when the cache evicts them |
| `'signedCookie'` | the cookie itself | No storage. Data is signed with `SECRET_KEY` but readable by the client, limited to about 4 KB, and cannot be revoked early |
| a `SessionBase` subclass | your store | |

Django's cookie settings apply with Django's defaults: `SESSION_COOKIE_NAME` (`sessionid`),
`SESSION_COOKIE_AGE` (two weeks), `SESSION_COOKIE_DOMAIN`, `SESSION_COOKIE_PATH`,
`SESSION_COOKIE_SECURE`, `SESSION_COOKIE_HTTPONLY` (`true`), `SESSION_COOKIE_SAMESITE` (`'Lax'`),
`SESSION_SAVE_EVERY_REQUEST` and `SESSION_EXPIRE_AT_BROWSER_CLOSE`. Session payloads use Django's
signed, compressed JSON encoding.

Expired database sessions are not deleted automatically. Run `npx ghuri clearsessions` from a
cron job.

## Passwords

Passwords are hashed with WebCrypto, so hashing works on Workers with no native modules. The
stored formats are exactly Django's:

| Hasher | Format | Notes |
|---|---|---|
| `PBKDF2PasswordHasher` (default) | `pbkdf2_sha256$<iterations>$<salt>$<hash>` | 100,000 iterations by default |
| `PBKDF2SHA1PasswordHasher` | `pbkdf2_sha1$...` | Legacy Django installs |
| `ScryptPasswordHasher` | `scrypt$<n>$<salt>$<r>$<p>$<hash>` | Pure-JavaScript scrypt (WebCrypto has no scrypt primitive) |

This means **you can copy users from a Django project** and their passwords keep working: the
tables match, so `dumpdata` / `loaddata` fixtures load directly. When a user logs in with a hash
whose algorithm or parameters differ from the current default, `user.checkPassword()` re-hashes
it on the spot, exactly like Django's hasher upgrades.

:::caution[Iterations and Workers CPU]
Django uses 1,000,000 PBKDF2 iterations. Ghuri defaults to **100,000**, because production
Workers' WebCrypto has refused higher counts and the free plan allows about 10 ms of CPU per
request. 100,000 iterations take roughly 25–50 ms of CPU: fine on the paid plan, possibly over
the free plan's limit (lower it there, or raise it on Node). When WebCrypto refuses a count,
Ghuri falls back to a pure-JavaScript PBKDF2 so that Django hashes always verify, but 1,000,000
iterations then cost about 0.7 s of CPU (paid plan only) until the hash is upgraded on login.
:::

bcrypt, Argon2 and MD5 hashes are not supported (WebCrypto has no implementation); reset those
passwords after moving from Django.

Configure hashers and password validation in settings. Hashers can be classes or configured
instances; the first one hashes new passwords. Validators use Django's `{ NAME, OPTIONS }` shape
(a bare class or an instance also works):

```ts title="src/settings.ts"
import {
  CommonPasswordValidator, MinimumLengthValidator, NumericPasswordValidator, PBKDF2PasswordHasher,
  ScryptPasswordHasher, UserAttributeSimilarityValidator,
} from '@ghuri/auth'

PASSWORD_HASHERS: [new PBKDF2PasswordHasher({ iterations: 600_000 }), ScryptPasswordHasher],
AUTH_PASSWORD_VALIDATORS: [
  { NAME: UserAttributeSimilarityValidator },
  { NAME: MinimumLengthValidator, OPTIONS: { minLength: 10 } },
  { NAME: CommonPasswordValidator },          // a compact built-in list; OPTIONS: { passwords: [...] } for yours
  { NAME: NumericPasswordValidator },
],
```

`AUTH_PASSWORD_VALIDATORS` is empty by default, as in Django. Validators run in
`createsuperuser`, `changepassword`, the password views, the admin's password forms and
`validatePassword(password, user?)`, which throws one `ValidationError` with every message.
`createUser` does not run them, as in Django.

`makePassword(raw)` and `checkPassword(raw, encoded, setter?)` are available on their own when
you need hashing outside the user model. `makePassword(null)` produces an unusable password.

In tests, use a fast hasher: `PASSWORD_HASHERS: [new PBKDF2PasswordHasher({ iterations: 1000 })]`.

## Custom user models

To add fields to users, define your own model from `AbstractUser` at the start of a project and
point `AUTH_USER_MODEL` at it:

```ts title="src/accounts/models.ts"
import { Model, URLField, TextField } from '@ghuri/orm'
import { AbstractUser, type UserManager } from '@ghuri/auth'

export class User extends Model({
  website: new URLField({ blank: true }),
  bio: new TextField({ blank: true }),
}, { extends: AbstractUser }) {
  declare static objects: UserManager<User>
}
```

```ts title="src/settings.ts"
INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, AccountsConfig, /* ... */],
AUTH_USER_MODEL: 'accounts.User',
```

The base classes:

- `AbstractBaseUser`: only `password`, `lastLogin` and the password helpers. Set
  `static USERNAME_FIELD`, `static EMAIL_FIELD` and `static REQUIRED_FIELDS` the way Django does.
- `PermissionsMixin`: `AbstractBaseUser` plus `isSuperuser`, `groups` and `userPermissions`. Ghuri
  model inheritance is linear, so the mixin already contains the base user
  (`{ extends: PermissionsMixin }`). `permissionsMixinFields()` gives the bare field set.
- `AbstractUser`: everything `User` has.

The built-in `UserManager` works for any `USERNAME_FIELD`
(`Account.objects.createUser('a@example.com', undefined, 'pw')` or the object form). Subclass
`BaseUserManager` for custom creation logic.

When the model is swapped, `auth.User` is not registered (there is no `auth_user` table) and
relations such as `Token.user` and the admin's `LogEntry.user` point at your model. As in Django,
the app holding the custom user model must have migrations: run
`npx ghuri makemigrations accounts` before the first `migrate`.

Code that refers to "the user model" should not import a concrete class. Use `getUserModel()` at
runtime, and the `AUTH_USER_MODEL` setting for relations:

```ts
import { getUserModel } from '@ghuri/auth'

const UserModel = getUserModel()
const staff = await UserModel.objects.filter({ isStaff: true })
```

:::caution
Change `AUTH_USER_MODEL` before your first `migrate`. Switching it afterwards is as hard as it is
in Django.
:::

## Signing

`@ghuri/auth` also ports `django.core.signing` (same salts and wire format, HMAC-SHA256 with
`SECRET_KEY`; `SECRET_KEY_FALLBACKS` are accepted when verifying):

```ts
import { dumps, loads, Signer, TimestampSigner } from '@ghuri/auth'

const s = await dumps({ userId: 1 }, { salt: 'unsubscribe', compress: true })
await loads(s, { salt: 'unsubscribe', maxAge: 3600 })     // throws BadSignature / SignatureExpired
await new Signer({ salt: 'x' }).sign('value')             // 'value:signature'
await new TimestampSigner().unsign(signed, 60)
```

Signed values, password-reset tokens and session payloads are byte-compatible with Django given
the same `SECRET_KEY`. Session rows written by Django reference Django's backend paths, so users
log in again after a move.

## Testing

Importing `@ghuri/auth` registers the test client hooks:

```ts
const client = createTestClient(app, { env })
await client.forceLogin(user)
await client.login({ username: 'ann', password: 'pw' })   // true / false
await client.logout()
```

After flushing a test database, call `ContentType.objects.clearCache()`.

## Settings

`AUTH_USER_MODEL`, `AUTHENTICATION_BACKENDS`, `PASSWORD_HASHERS`, `AUTH_PASSWORD_VALIDATORS`,
`SECRET_KEY_FALLBACKS`, `LOGIN_URL` (`/accounts/login/`), `LOGIN_REDIRECT_URL`
(`/accounts/profile/`), `LOGOUT_REDIRECT_URL`, `PASSWORD_RESET_TIMEOUT`, the `SESSION_*` settings
above, `SESSION_KV_BINDING`, `SESSION_CACHE_ALIAS`, `REMOTE_USER_HEADER` and `JWT` (alias
`SIMPLE_JWT`). All are typed on `GhuriSettings` once `@ghuri/auth` is imported.

## Tokens and JWT

For APIs and mobile clients use DRF-style tokens (`AuthTokenConfig`, one opaque key per user) or
JWT with refresh tokens. Setup, endpoints and the `JWT` settings are in
[API tokens and JWT](/docs/topics/auth-tokens/); the `@ghuri/auth/rest` authentication classes
are covered in [REST authentication](/docs/topics/rest/authentication/).
