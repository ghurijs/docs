---
title: Sending email
description: Send email with @ghuri/mail, Django's django.core.mail API in TypeScript — sendMail, EmailMessage, attachments and HTML alternatives, with Cloudflare Email Service, Resend, SMTP, console and test backends.
---

`@ghuri/mail` is Django's [`django.core.mail`](https://docs.djangoproject.com/en/stable/topics/email/)
translated to TypeScript: `sendMail()`, `sendMassMail()`, `mailAdmins()`, `mailManagers()`,
`EmailMessage` and `EmailMultiAlternatives`, with the backend chosen in settings. It has no runtime
dependencies.

On Cloudflare Workers it sends through the Cloudflare Email Service `send_email`
binding or [Resend](https://resend.com) over `fetch`. On Node it can do the same, or talk SMTP with
the backend in `@ghuri/mail/smtp`.

:::note[Alpha]
`@ghuri/mail` is at `0.1.0-alpha.0` and needs `@ghuri/core` `0.1.0-alpha.1` or later. Templated
email (rendering a subject and body from a component) is not part of the package yet; build the
strings in your own function.
:::

:::tip[If you know Django]
Names are camelCased and every call is `async`: `send_mail(...)` is `await sendMail(...)`,
`fail_silently=True` is `{ failSilently: true }`, `html_message=` is `{ htmlMessage }`, and
`mail.outbox` is `outbox` from `@ghuri/mail/testing`. There is no default SMTP backend: you pick one
in `EMAIL_BACKEND` (see [Differences from Django](#differences-from-django)).
:::

## Setup

```sh
npm install @ghuri/mail@next
```

Choose a backend in `src/settings.ts`. Backends are configs returned by factory functions, like
`d1()` or `kvCache()`, and secrets come from `env` inside the settings factory:

```ts title="src/settings.ts"
import { defineSettings } from '@ghuri/core'
import { cloudflareEmailBackend, consoleBackend, resendBackend } from '@ghuri/mail'

export default defineSettings((env) => ({
  // ...
  DEBUG: env.DEBUG === 'true',
  EMAIL_BACKEND:
    env.DEBUG === 'true'
      ? consoleBackend()
      : env.RESEND_API_KEY
        ? resendBackend({ apiKey: env.RESEND_API_KEY })
        : cloudflareEmailBackend({ binding: 'EMAIL' }),
  DEFAULT_FROM_EMAIL: 'Blog <noreply@blog.example.com>',
  SERVER_EMAIL: 'errors@blog.example.com',
  ADMINS: ['Jane <jane@blog.example.com>'],
  EMAIL_SUBJECT_PREFIX: '[Blog] ',
}))
```

Without `EMAIL_BACKEND`, `DEBUG` prints messages to the console and anything else raises
`ImproperlyConfigured` when you send. All mail settings are listed in the
[settings reference](/docs/reference/settings/#email-ghurimail).

For Cloudflare Email Service, add the `send_email` binding to `wrangler.jsonc`. The sender's domain
must be onboarded to Email Sending in the Cloudflare dashboard:

```jsonc title="wrangler.jsonc"
{
  "send_email": [{ "name": "EMAIL" }]
}
```

## Sending a message

`sendMail(subject, message, fromEmail, recipientList, options?)` sends one message to every
address in `recipientList` and returns the number of messages sent (`1`, or `0` when it failed
silently). Pass `null` as `fromEmail` to use `DEFAULT_FROM_EMAIL`:

```ts title="src/accounts/views.ts"
import { sendMail } from '@ghuri/mail'

await sendMail('Welcome', 'Thanks for signing up.', null, [user.email])

await sendMail('Subject here', 'Here is the message.', 'from@example.com', ['to@example.com'], {
  htmlMessage: '<p>Here is the <b>message</b>.</p>',
})
```

| Option | Default | |
|---|---|---|
| `htmlMessage` | none | HTML version, sent as a `text/html` alternative. |
| `failSilently` | `false` | Swallow delivery errors and return `0`. |
| `authUser`, `authPassword` | the backend's settings | Credentials for backends that log in (SMTP). |
| `connection` | a new `getConnection()` | Send over an existing connection. |

Send from anywhere Ghuri has loaded your settings: a view, a signal receiver, a queue or cron
handler, or a management command. A slow provider adds its latency to the request, so for
anything not urgent, send from a [queue consumer](/docs/topics/background-tasks/) instead.

### Several messages at once

`sendMassMail()` takes `[subject, message, fromEmail, recipientList]` tuples and sends them all
over one connection:

```ts
import { sendMassMail } from '@ghuri/mail'

await sendMassMail([
  ['Subject', 'Message.', 'from@example.com', ['first@example.com', 'other@example.com']],
  ['Subject', 'Message.', 'from@example.com', ['second@example.com']],
])
```

### Mail to the site staff

`mailAdmins(subject, message, options?)` and `mailManagers()` send to `ADMINS` and `MANAGERS`
from `SERVER_EMAIL`, with `EMAIL_SUBJECT_PREFIX` in front of the subject. Both accept
`htmlMessage`, `failSilently` and `connection`:

```ts
import { mailAdmins } from '@ghuri/mail'

await mailAdmins('Payment webhook failed', String(err))
```

## `EmailMessage`

`sendMail()` is a shortcut for building an `EmailMessage` and sending it. Use the class for cc,
bcc, reply-to, extra headers and attachments:

```ts
import { EmailMessage, EmailMultiAlternatives } from '@ghuri/mail'

const email = new EmailMultiAlternatives('Your invoice', 'Invoice attached.', {
  to: ['Jane <jane@example.com>'],
  bcc: ['archive@example.com'],
  replyTo: ['billing@example.com'],
  headers: { 'List-Unsubscribe': '<mailto:unsubscribe@example.com>' },
})
email.attachAlternative('<p>Invoice attached.</p>', 'text/html')
email.attach('invoice.pdf', pdfBytes) // MIME type guessed from the file name
await email.send()
```

The constructor takes `(subject, body, options)` or a single object with all of them. Options are
`fromEmail`, `to`, `cc`, `bcc`, `replyTo`, `headers`, `attachments` and `connection`.

| Member | |
|---|---|
| `attach(filename, content, mimetype?)` or `attach({ filename, content, mimetype })` | Add an attachment (`string` or bytes). There is no `attachFile()`: Workers have no file system, so read the file yourself. |
| `send(failSilently?)` | Send through `connection` or a new `getConnection()`; returns the number sent. |
| `recipients()` | Every `to`, `cc` and `bcc` address. |
| `message()` | The MIME structure as a `MIMEPart`; `message().asString()` is the RFC 5322 source. |
| `contentSubtype` | Set to `'html'` to send the body itself as HTML. |
| `extraHeaders` | The `headers` you passed. |

`EmailMultiAlternatives` adds `attachAlternative(content, mimetype)` and `bodyContains(text)`,
which is true when the body and every text alternative contain `text`.

Addresses can be plain (`jane@example.com`) or named (`Jane <jane@example.com>`). Non-ASCII names
and subjects are encoded for you, and internationalized domains are converted with IDNA.

A newline in a subject, an address or a header value raises `BadHeaderError`, as in Django, so
user input cannot inject headers.

## Connections

`getConnection(backend?, options?)` opens a connection to `EMAIL_BACKEND` (or to the backend you
pass). Reuse one connection to send many messages:

```ts
import { getConnection } from '@ghuri/mail'

const connection = getConnection()
await connection.sendMessages([email1, email2, email3])
```

`options` takes `failSilently` plus backend-specific overrides such as `username`, `password` or
`apiKey`. For SMTP, `open()` and `close()` keep one socket open across several `sendMessages()`
calls.

Delivery errors raise `EmailSendError`, which carries the provider's `status`, `code` and
`response`. With `failSilently`, failed messages are not counted instead. Configuration errors
(`ImproperlyConfigured`) always raise.

## Backends

| Factory | Runs on | |
|---|---|---|
| `cloudflareEmailBackend({ binding = 'EMAIL' })` | Workers | Cloudflare Email Service through a `send_email` binding, looked up in the request's `env`. |
| `resendBackend({ apiKey, baseUrl?, timeout?, fetch? })` | anywhere with `fetch` | The Resend HTTP API, one request per message. |
| `smtpBackend({ host, port, username, password, useTls, useSsl, timeout, tlsOptions })` | Node | From `@ghuri/mail/smtp`. STARTTLS, implicit TLS, AUTH PLAIN and LOGIN. Options left out fall back to the `EMAIL_HOST*` / `EMAIL_PORT` / `EMAIL_USE_*` / `EMAIL_TIMEOUT` settings. |
| `consoleBackend({ stream? })` | anywhere | Prints each message's MIME source. The default in `DEBUG`. |
| `locmemBackend()` | anywhere | Appends messages to `outbox` from `@ghuri/mail/testing`. |
| `dummyBackend()` | anywhere | Does nothing. |

`@ghuri/mail/smtp` imports `node:net` and `node:tls`, which is why it is a separate entry point:
the main `@ghuri/mail` entry stays Workers-safe.

```ts title="src/settings.ts (Node)"
import { smtpBackend } from '@ghuri/mail/smtp'

EMAIL_BACKEND: smtpBackend(),
EMAIL_HOST: 'smtp.example.com',
EMAIL_PORT: 587,
EMAIL_HOST_USER: env.SMTP_USER,
EMAIL_HOST_PASSWORD: env.SMTP_PASSWORD,
EMAIL_USE_TLS: true,
```

### API backends send fields, not MIME

Cloudflare and Resend take structured fields rather than a raw message. The body becomes `text`
(or `html` when `contentSubtype` is `'html'`), and a `text/html` or `text/plain` alternative fills
the other one; any other alternative type raises `EmailSendError`. Extra `From` and `Reply-To`
headers override those fields, while `To` and `Cc` headers are not sent, because the providers
deliver to the recipient lists. Cloudflare accepts a single Reply-To address and only `X-*`
headers plus a short allowlist of others.

### Writing a backend

Subclass `BaseEmailBackend`, implement `sendMessages(messages)` (and `open()` / `close()` if it
keeps a connection), and export a factory that returns `{ backend, create }`:

```ts
import { BaseEmailBackend, type EmailBackendConfig, type EmailMessage } from '@ghuri/mail'

class WebhookBackend extends BaseEmailBackend {
  async sendMessages(messages: EmailMessage[]): Promise<number> {
    for (const m of messages) {
      await fetch('https://hooks.example.com/mail', {
        method: 'POST',
        body: m.message().asString(),
      })
    }
    return messages.length
  }
}

export const webhookBackend = (): EmailBackendConfig => ({
  backend: 'webhook',
  create: (env, options) => new WebhookBackend(options),
})
```

`create()` runs once per `getConnection()` with the current request's `env`, so a backend can read
its bindings there.

## Testing

`useOutbox()` from `@ghuri/mail/testing` routes every message to the in-memory `outbox`, Django's
`mail.outbox`, whatever `EMAIL_BACKEND` says:

```ts title="src/accounts/tests.ts"
import { outbox, restoreEmailBackend, useOutbox } from '@ghuri/mail/testing'

beforeEach(() => useOutbox()) // empty the outbox and capture mail
afterEach(() => restoreEmailBackend())

it('sends a welcome email', async () => {
  await client.post('/signup/', { form: { email: 'jane@example.com' } })

  expect(outbox).toHaveLength(1)
  expect(outbox[0].subject).toBe('Welcome')
  expect(outbox[0].to).toEqual(['jane@example.com'])
})
```

`outbox` is always the same array; `clearOutbox()` empties it in place. Instead of `useOutbox()`
you can set `EMAIL_BACKEND: locmemBackend()` in the settings your tests use. See
[Testing](/docs/topics/testing/).

## Differences from Django

- **No default SMTP backend.** Workers cannot open SMTP connections, so without `EMAIL_BACKEND`
  only `DEBUG` has a fallback (the console).
- **`message()` returns a `MIMEPart`** (`get(header)`, `getParts()`, `getContent()`,
  `asString()`, `asBytes()`), not a Python `email.message.Message`. Everything on the wire is
  7-bit (quoted-printable, base64, RFC 2047).
- **No `attachFile(path)`.** Read the file and call `attach()`.
- **`ADMINS` and `MANAGERS` are address strings** (`'Jane <jane@example.com>'`), the form Django 6
  uses, not `(name, email)` tuples.
- **`failSilently` is the same in every backend**: delivery and header errors are swallowed and
  the message is not counted.
