---
title: Applications
description: AppConfig, INSTALLED_APPS, the app registry, and how apps register models, migrations, admin classes and commands.
---

A Ghuri project is a list of applications. Each app is a directory under `src/` that owns a slice
of functionality (models, views, URLs, admin classes, commands) and is described by an
`AppConfig` subclass. `ghuri startapp <name>` creates one.

## AppConfig

```ts title="src/blog/app.ts"
import { AppConfig } from '@ghuri/core'
import * as models from './models'
import * as migrations from './migrations'
import * as admin from './admin'
import { PublishScheduledCommand } from './commands/publish-scheduled'

export class BlogConfig extends AppConfig {
  name = 'blog'
  verboseName = 'Blog'
  path = import.meta.dirname
  models = models
  migrations = migrations
  admin = admin
  commands = { publishscheduled: PublishScheduledCommand }

  async ready() {
    await import('./signals')
  }
}
```

| Attribute | Purpose |
|---|---|
| `name` | Required. The app's name, and its default label. |
| `label` | Unique short name used in model labels (`blog.Post`), permissions (`blog.add_post`) and table names (`blog_post`). Defaults to the last segment of `name`. |
| `verboseName` | Human-readable name shown in the admin. Defaults to the capitalised label. |
| `path` | The app's directory. Only the CLI uses it, to know where to write migrations. Set it to `import.meta.dirname`. |
| `models` | The app's models module. Every exported `Model` class is registered under this app's label. |
| `migrations` | The generated `migrations/index.ts` module. |
| `admin` | The admin module. Importing it runs `admin.site.register(...)` calls. |
| `commands` | Management commands: `{ name: CommandClass }`. |
| `ready()` | Called once per isolate after every app is loaded and every model is registered. |

Add the class to `INSTALLED_APPS`:

```ts title="src/settings.ts"
INSTALLED_APPS: [AuthConfig, AdminConfig, BlogConfig],
```

Entries can be classes (instantiated for you) or instances, which is handy for configuring a
third-party app: `new AgentsConfig()` or a subclass with a different `label`.

:::tip[If you know Django]
`AppConfig` is Django's `AppConfig`, and `ready()` is where you connect signals, as in Django.
The difference is that Ghuri never imports modules by convention. Django finds `models.py` and
`admin.py` by name at startup; a Worker is a single bundle with no filesystem, so an app
**imports** its own modules and hands them to the config. If a model is not exported from the
module assigned to `models`, Ghuri does not know it exists.
:::

## Why imports instead of discovery

Explicit imports have three benefits beyond working on Workers:

1. The bundler sees every model, migration and admin class, so tree-shaking and type checking
   cover all of them.
2. There is no startup scan, which keeps cold starts short.
3. "Where is this registered?" always has an answer you can jump to in your editor.

The cost is one line per module in `app.ts`, which `startapp` writes for you.

## Load order

On the first request in an isolate (or when the CLI or a test calls `app.setup(env)`),
`apps.populate(INSTALLED_APPS)` runs:

1. Each entry is instantiated, and its label is checked for uniqueness.
2. Hooks registered by packages run. The ORM's hook walks every config's `models` and registers
   each `Model` class with that app's label, resolving lazy relations (`() => User`,
   `'auth.User'`) once every model is known.
3. `ready()` is called on every config, in `INSTALLED_APPS` order.

Order matters in the same places it does in Django: an app that overrides another app's admin
registration or command must come after it.

## The app registry

`apps` is the registry. Packages use it to find models by label; you will mostly use it in
generic code, management commands and data migrations.

```ts
import { apps } from '@ghuri/core'

apps.isInstalled('blog')                    // true
apps.getAppConfig('blog').verboseName       // 'Blog'
const Post = apps.getModel('blog.Post')     // case-insensitive model name
for (const model of apps.getModels()) {
  console.log(model._meta.label)
}
```

`getModel()` throws a `LookupError` for unknown labels and `AppRegistryNotReady` if called before
population finishes.

## Reusable apps

Because an app is just a directory with an `AppConfig`, you can publish one as an npm package.
Export the config class from the package entry and ship its compiled migrations; users add it to
`INSTALLED_APPS` like any built-in app. `@ghuri/auth`, `@ghuri/admin` and `@ghuri/agents` are
apps built exactly this way: `AuthConfig`, `AdminConfig` and `AgentsConfig`.

Choose a distinctive `label` for a reusable app, since labels must be unique across the project
and appear in table names.
