---
title: Applications
description: AppConfig, INSTALLED_APPS, the app registry, and how apps register models, migrations, admin classes and commands.
---

A Ghuri project is a list of applications. Each app is a directory under `src/` that owns a slice
of functionality (models, views, URLs, admin classes, commands) and is described by an
`AppConfig` subclass. `ghuri startapp <name>` creates one.

## AppConfig

```ts title="src/blog/app.ts"
import { AppConfig, onSchedule } from '@ghuri/core'
import * as models from './models'
import * as migrations from './migrations'
import * as admin from './admin'
import * as signals from './signals'
import { PublishScheduledCommand } from './commands/publish-scheduled'
import { publishScheduledPosts } from './tasks'

export class BlogConfig extends AppConfig {
  name = 'blog'
  verboseName = 'Blog'
  path = import.meta.dirname
  models = models
  migrations = migrations
  admin = admin
  modules = { signals }
  commands = { publishscheduled: PublishScheduledCommand }

  ready() {
    onSchedule('0 * * * *', () => publishScheduledPosts())
  }
}
```

| Attribute | Purpose |
|---|---|
| `name` | Required. The app's name, and its default label. |
| `label` | Unique short name used in model labels (`blog.Post`), permissions (`blog.add_post`) and table names (`blog_post`). Defaults to the last segment of `name`. Read the effective value with `config.appLabel`. |
| `verboseName` | Human-readable name shown in the admin. Defaults to the capitalised label (`config.displayName`). |
| `path` | The app's directory. Only the CLI uses it, to know where to write migrations. Set it to `import.meta.dirname`. |
| `models` | The app's models module. Every exported `Model` class is registered under this app's label. |
| `migrations` | The generated `migrations/index.ts` module. |
| `admin` | The admin module. Importing it runs `admin.site.register(...)` calls. |
| `modules` | Any other modules the app wants loaded at startup: signal receivers, agents, check registrations. Assigning the import is enough; Ghuri does not call anything on them. |
| `commands` | Management commands: `{ name: CommandClass }`. |
| `ready()` | Called once per isolate after every app is loaded and every model is registered. May be async. |

Add the class to `INSTALLED_APPS`:

```ts title="src/settings.ts"
INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, AdminConfig, BlogConfig],
```

Entries can be classes (instantiated for you) or instances, which is handy for configuring a
third-party app: `new AgentsConfig()` or a subclass with a different `label`.

:::tip[If you know Django]
`AppConfig` is Django's `AppConfig`, and `ready()` is where you connect signals, as in Django.
The difference is that Ghuri never imports modules by convention. Django finds `models.py` and
`admin.py` by name at startup; a Worker is a single bundle with no filesystem, so an app
**imports** its own modules and hands them to the config. If a model is not exported from the
module assigned to `models`, Ghuri does not know it exists. `modules` plays the role of the
"import this so its side effects run" lines you would otherwise put in `ready()`.
:::

## Why imports instead of discovery

Explicit imports have three benefits beyond working on Workers:

1. The bundler sees every model, migration and admin class, so tree-shaking and type checking
   cover all of them.
2. There is no startup scan, which keeps cold starts short.
3. "Where is this registered?" always has an answer you can jump to in your editor.

The cost is one line per module in `app.ts`, which `startapp` writes for you.

## Load order

On the first request in an isolate (or the first cron trigger or queue batch, or when the CLI or
a test calls `app.setup(env)`), `apps.populate(INSTALLED_APPS)` runs:

1. Each entry is instantiated, its label is checked for uniqueness, and its `commands` are
   registered.
2. Hooks registered by packages with `apps.onPopulate()` run. The ORM's hook walks every config's
   `models` and registers each `Model` class with that app's label, resolving lazy relations
   (`() => User`, `'auth.User'`) once every model is known.
3. `ready()` is called on every config, in `INSTALLED_APPS` order, and awaited.

`populate()` is idempotent for the same list. If it fails, the registry is reset, so the next
request tries again and reports the error rather than serving a half-loaded app.

Order matters in the same places it does in Django: an app that overrides another app's admin
registration or command must come after it.

## The app registry

`apps` is the registry. Packages use it to find models by label; you will mostly use it in
generic code, management commands and data migrations.

```ts
import { apps } from '@ghuri/core'

apps.isInstalled('blog')                    // true
apps.getAppConfig('blog').verboseName       // 'Blog'
apps.getAppConfigs()                        // every config, in INSTALLED_APPS order
const Post = apps.getModel('blog.Post')     // or apps.getModel('blog', 'post'); case-insensitive
for (const model of apps.getModels()) {     // apps.getModels('blog') for one app
  console.log(model._meta.label)
}
```

`getModel()` and `getAppConfig()` throw a `LookupError` for unknown labels, and `getModel()`
throws `AppRegistryNotReady` if called before population starts. `apps.ready` is `true` once
every `ready()` has finished.

## Reusable apps

Because an app is just a directory with an `AppConfig`, you can publish one as an npm package.
Export the config class from the package entry and ship its compiled migrations; users add it to
`INSTALLED_APPS` like any built-in app. Ghuri's own packages are apps built exactly this way:
`@ghuri/auth` ships `ContentTypesConfig`, `AuthConfig`, `SessionsConfig`, `AuthTokenConfig` and
`TokenBlacklistConfig`; `@ghuri/admin` ships `AdminConfig`; `@ghuri/agents` ships `AgentsConfig`.

Choose a distinctive `label` for a reusable app, since labels must be unique across the project
and appear in table names.
