---
title: Management commands
description: Write your own ghuri commands with BaseCommand, register them on an AppConfig, and call them from code and tests.
---

Everything you run as `npx ghuri <command>` is a management command: `migrate`,
`createsuperuser`, `dumpdata`. Apps can add their own. The [CLI reference](/docs/reference/cli/)
lists the built-in ones; this page is about writing yours.

## How commands run

The `ghuri` CLI runs on your machine (or in CI, or in a container), not inside a deployed
Worker. For each invocation it:

1. finds your settings through `package.json#ghuri.settings` (or `src/settings.ts`, or
   `--settings <path>`),
2. builds an `env` from `wrangler.jsonc` bindings (local simulation by default, real
   Cloudflare resources with `--remote`), merged with `.dev.vars` and `process.env`,
3. calls `app.setup(env)`, which resolves settings and populates `INSTALLED_APPS`,
4. runs the command inside that context, so models, storage and caches all work.

Because of step 2, **every command accepts `--remote`**. Your own commands get it for free:
`npx ghuri publish_scheduled --remote` acts on the production D1 database and R2 bucket.

## Writing a command

Subclass `BaseCommand` from `@ghuri/core`. Give it a `help` string, declare arguments in
`addArguments`, and do the work in `handle`:

```ts title="src/blog/commands/publish-scheduled.ts"
import { BaseCommand, CommandError, type ArgumentParser, type CommandIO } from '@ghuri/core'
import { Post } from '../models'

export class PublishScheduledCommand extends BaseCommand {
  static help = 'Publish draft posts whose title starts with a date that has passed.'

  addArguments(parser: ArgumentParser) {
    parser
      .argument('slugs', { help: 'Only consider these posts', variadic: true })
      .option('--dry-run', { help: 'Show what would be published without saving', default: false })
      .option('-l, --limit <n>', { help: 'Publish at most n posts', default: '100' })
  }

  async handle(args: Record<string, unknown>, io: CommandIO) {
    const limit = Number(args.limit)
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CommandError('--limit must be a positive integer.')
    }

    let qs = Post.objects.filter({ published: false })
    const slugs = args.slugs as string[] | undefined
    if (slugs?.length) qs = qs.filter({ slug__in: slugs })

    const posts = await qs.orderBy('createdAt').slice(0, limit)
    for (const post of posts) {
      if (args.dryRun) {
        io.stdout(`Would publish ${io.style.bold(post.title)}`)
        continue
      }
      post.published = true
      await post.save({ updateFields: ['published'] })
      io.stdout(io.style.success(`Published "${post.title}"`))
    }
    if (posts.length === 0) io.stdout(io.style.notice('Nothing to publish.'))
  }
}
```

- **Arguments** are positional. `variadic: true` collects the rest into an array, and
  `required: true` makes the CLI fail without one.
- **Options** use commander-style flags: `'--dry-run'` is a boolean, `'-l, --limit <n>'` takes a
  value and `'--port [port]'` an optional one. Names are camelCased from the long flag, so
  `--dry-run` becomes `args.dryRun`; a `'--no-input'` style flag sets `args.input` to `false`.
- **`handle`** may return a number, used as the process exit code. Returning nothing means `0`.
- **`CommandError(message, returncode = 1)`** prints the message in the error style without a
  stack trace and exits with `returncode`. Any other exception prints a full stack trace.

## Output and prompts

Write through `io`, not `console.log`, so tests can capture output:

| Member | Purpose |
|---|---|
| `io.stdout(msg)` / `io.stderr(msg)` | Write a line |
| `io.style.success / warning / error / notice / bold` | Wrap text in colours when the terminal supports them |
| `io.prompt?(question, { password?, default? })` | Ask for input. `password: true` hides typing |
| `io.confirm?(question, { default? })` | Ask yes or no |

`prompt` and `confirm` are **optional**. They are undefined when stdin is not a terminal (CI,
`--no-input`) and in tests. Check before calling, and have a non-interactive fallback:

```ts
if (!args.force) {
  const ok = io.confirm ? await io.confirm('Delete all drafts?', { default: false }) : false
  if (!ok) throw new CommandError('Aborted. Pass --force to run without confirmation.')
}
```

## Registering commands

Commands belong to an app. List them on the `AppConfig` under the name users will type:

```ts title="src/blog/app.ts"
import { AppConfig } from '@ghuri/core'
import * as models from './models'
import { PublishScheduledCommand } from './commands/publish-scheduled'

export class BlogConfig extends AppConfig {
  name = 'blog'
  models = models
  commands = {
    publish_scheduled: PublishScheduledCommand,
  }
}
```

```sh
npx ghuri publish_scheduled --dry-run
npx ghuri help publish_scheduled
```

If two apps register the same name, the app listed **later** in `INSTALLED_APPS` wins, and an
app command also replaces a built-in command of the same name (except `help`). To override a
command from a package, list your app after it.

:::note
This is the opposite of Django, where the first app in `INSTALLED_APPS` wins.
:::

:::tip[If you know Django]
This is `BaseCommand` with `help`, `add_arguments(parser)` and `handle(*args, **options)`, in
camelCase. `self.stdout.write(self.style.SUCCESS(...))` becomes
`io.stdout(io.style.success(...))`, and `CommandError` works the same. The one structural change
is discovery: Django looks for `management/commands/*.py`, while Ghuri apps list their commands
on the `AppConfig`, because a bundled app cannot scan directories.
:::

## Calling commands from code

`callCommand(nameOrClass, args?, io?)` runs a command in the current context, like Django's
`call_command`. It is mostly useful in tests and data scripts:

```ts
import { callCommand, bufferIO } from '@ghuri/core'

const io = bufferIO()
await callCommand('publish_scheduled', { dryRun: true, limit: '10' }, io)
console.log(io.out)   // ['Would publish Hello, Ghuri', ...]
```

`bufferIO()` collects `stdout` lines in `io.out` and `stderr` lines in `io.err`, with styling
turned off. Arguments are passed already parsed, under their camelCase names; parsing and
defaults from `addArguments` are not applied, so pass every value the command reads.

Calling by class (`callCommand(PublishScheduledCommand, ...)`) works even if the command is not
registered.

## Running commands on a schedule

Commands are for people and CI. For work that runs on a schedule in production, put the logic in
a function that both a command and an `onSchedule()` cron handler call:

```ts title="src/blog/app.ts"
import { AppConfig, onSchedule } from '@ghuri/core'
import { PublishScheduledCommand, publishScheduled } from './commands/publish-scheduled'

export class BlogConfig extends AppConfig {
  name = 'blog'
  commands = { publish_scheduled: PublishScheduledCommand }

  ready() {
    onSchedule('*/15 * * * *', () => publishScheduled({ limit: 100 }))
  }
}
```

See [Background tasks](/docs/topics/background-tasks/) for cron triggers and queues.
