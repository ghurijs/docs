---
title: Billing
description: Subscriptions for SaaS apps with @ghuri/billing — Stripe Checkout, the customer portal, verified idempotent webhooks, plans, entitlements and usage limits, in the spirit of dj-stripe.
---

`@ghuri/billing` adds subscriptions to a Ghuri app: a Checkout page that starts a subscription, the
customer portal where customers change or cancel it, webhooks that keep a local copy of every
subscription up to date, and a few functions that answer "what may this subscriber do?" in app code.
It follows [dj-stripe](https://dj-stripe.dev): Stripe objects are mirrored into models with the same
names. It runs on Cloudflare Workers and Node, using `fetch` and WebCrypto rather than the Stripe
SDK, and it can bill users or tenants.

:::tip[If you know dj-stripe]
`DJSTRIPE_SUBSCRIBER_MODEL` is `BILLING.SUBSCRIBER_MODEL`, and
`DJSTRIPE_SUBSCRIBER_MODEL_REQUEST_CALLBACK` is `BILLING.SUBSCRIBER`. `djstripe_sync_models` is
`ghuri billing_sync`, and `WEBHOOK_SIGNALS` is the `webhookProcessed` signal. Models keep dj-stripe's
names (`Customer`, `Product`, `Price`, `Subscription`, `SubscriptionItem`, `Invoice`, `Event`). Their
local primary key is an auto id, and the Stripe id is in `providerId`.
:::

## Install

```sh
npm install @ghuri/billing@next
```

```ts title="src/settings.ts"
import { BillingConfig, stripe } from '@ghuri/billing'

export default defineSettings((env) => ({
  INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, BillingConfig /* , … */],
  BILLING: {
    PROVIDER: stripe({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET }),
    PLANS: {
      free: { features: [], limits: { projects: 1 } },
      pro: {
        prices: ['pro_monthly', 'pro_yearly'],          // price ids, lookup keys or product ids
        features: ['export', 'api'],
        limits: { projects: 50 },
        trialPeriodDays: 14,
      },
    },
    DEFAULT_PLAN: 'free',
    SUCCESS_URL: '/billing/thanks/?session={CHECKOUT_SESSION_ID}',
    CANCEL_URL: '/pricing/',
    RETURN_URL: '/account/',
  },
}))
```

```ts title="src/urls.ts"
import { billingUrls } from '@ghuri/billing'

export default [path('billing/', include(billingUrls))]   // checkout/, portal/, webhook/
```

Then create the tables and import your products and prices:

```sh
npx ghuri migrate
npx ghuri billing_sync
```

Keep the keys out of code. On Workers, use `wrangler secret put STRIPE_SECRET_KEY` and
`wrangler secret put STRIPE_WEBHOOK_SECRET`; in development, put them in `.dev.vars`, which is not
committed. Use test keys (`sk_test_…`) until you go live: `ghuri check --deploy` warns when a test key
runs with `DEBUG = false`.

In the Stripe dashboard, add a webhook endpoint at `https://<your app>/billing/webhook/` that sends
`checkout.session.completed`, `customer.*`, `customer.subscription.*`, `product.*`, `price.*` and
`invoice.*`. For local development, the Stripe CLI forwards events and prints the signing secret:

```sh
stripe listen --forward-to localhost:8787/billing/webhook/
```

## Plans and entitlements

A plan is a key in `BILLING.PLANS`. Its `prices` are the price ids, lookup keys or product ids that
put a subscriber on it. Its `features` and `limits` are your own vocabulary. A subscriber without an
active subscription is on `DEFAULT_PLAN`.

```ts
import { getEntitlements, getSubscription, hasActiveSubscription, hasFeature } from '@ghuri/billing'

const sub = await getSubscription(request.user)          // Subscription | null
if (!(await hasActiveSubscription(request.user))) return redirect(c, '/pricing/')
if (await hasFeature(request.user, 'export')) { … }
const { plan, limits } = await getEntitlements(request.user)
if ((await Project.objects.filter({ owner: request.user }).count()) >= (limits.projects as number)) { … }
```

| Function | Returns |
|---|---|
| `getCustomer(subject, { create? })` | the subscriber's live `Customer`; with `create: true`, one is created at Stripe |
| `getSubscription(subject)` | the current `Subscription` (an active one first, else the latest), or `null` |
| `hasActiveSubscription(subject, { plans? })` | whether the status is in `ACTIVE_STATUSES` (default `active`, `trialing`) |
| `getPlan(subject)` | `{ key, plan, subscription, active }` |
| `getEntitlements(subject)` | `{ plan, features, limits, active, subscription }` |
| `hasFeature(subject, feature)` | whether the plan lists `feature` |

A `subject` is a user or tenant instance, a `Customer`, a reference `{ type?, id }`, or a Hono
context (resolved with `BILLING.SUBSCRIBER`). To keep access while a payment is retried, add
`'past_due'` to `ACTIVE_STATUSES`.

### Protecting views

REST views use the permission classes in `@ghuri/billing/rest`:

```ts
import { HasActiveSubscription, HasFeature } from '@ghuri/billing/rest'

class ExportView extends APIView {
  static requiredPlans = ['pro']                           // optional: only these plans
  permissionClasses = [IsAuthenticated, HasActiveSubscription]
}

class SsoView extends APIView {
  permissionClasses = [HasFeature('sso')]
}
```

Plain views use the decorator. Without `redirectTo` it answers 403.

```ts
import { subscriptionRequired } from '@ghuri/billing'

const dashboard = subscriptionRequired({ redirectTo: '/pricing/' })(async (c) => render(c, <Dashboard />))
```

## Checkout and the customer portal

`POST /billing/checkout/` starts a Stripe Checkout Session for the request's subscriber. Send
`{ plan: 'pro' }` (with `interval: 'year'` to pick the yearly price) or `{ price: 'pro_monthly' }`.
A JSON request gets `{ id, url }`; a form post is redirected (`303`) to Stripe.

```html
<form method="post" action="/billing/checkout/">
  <input type="hidden" name="csrfmiddlewaretoken" value="{{ csrfToken }}">
  <input type="hidden" name="plan" value="pro">
  <button>Upgrade to Pro</button>
</form>
```

- The Stripe customer is created on the first checkout and stored in `Customer`, with the subscriber
  in its metadata (`ghuri_subscriber: 'auth.user:42'`).
- When `PLANS` lists prices, only those can be bought, so a client cannot buy an internal price.
  Without plans, any active price of an active product can be bought.
- `successUrl` and `cancelUrl` may be sent too. They must be relative or on a host in `ALLOWED_HOSTS`.
- The trial comes from `PLANS[key].trialPeriodDays`, never from the client. `CHECKOUT_OPTIONS` adds
  Stripe parameters to every session (`{ allow_promotion_codes: true }`).

`POST /billing/portal/` opens the Stripe customer portal (`{ url }` or a redirect), where customers
switch plans, update cards, download invoices and cancel. It returns to `RETURN_URL`, or to the
`returnUrl` sent with the request.

## Webhooks

The webhook view is the only way subscriptions change locally, so every change made at Stripe (in
Checkout, the portal or the dashboard) comes back through it.

- **Signatures.** The `Stripe-Signature` header is checked with HMAC-SHA256 over the raw body, and
  its timestamp must be within 300 seconds (`stripe({ tolerance })`). Anything else gets 400. While
  you rotate the secret, pass both: `webhookSecret: [env.NEW_SECRET, env.OLD_SECRET]`.
- **Idempotency.** Each event is stored in `Event` under its Stripe id before it is processed. A
  repeated delivery of a processed event answers 200 without running again. Two deliveries arriving
  at once are processed only once.
- **Sync.** Customers, products, prices, subscriptions (with their items) and invoices are upserted.
  A completed checkout links the customer to the subscriber and fetches the new subscription.
- **Ordering.** Stripe does not promise order. A subscription event older than the newest one
  already applied is skipped.
- **Failures.** If processing fails, the view answers 500 so that Stripe retries, and the event keeps
  its error. `ghuri billing_process_events` or the admin action "Process selected events again" runs
  it again.

With [`@ghuri/tasks`](/docs/topics/tasks/) installed, set `WEBHOOK_TASKS: true` to answer Stripe at
once and process the event in the `billing.processEvent` task, which retries 3 times. Billing finds
the tasks package through its interop object and does not depend on it.

## Billing tenants instead of users

In a [multi-tenant](/docs/topics/multi-tenancy/) app the tenant usually pays. Point the subscriber at
the tenant model, and tell billing how to find the tenant of a request:

```ts
import { currentTenant } from '@ghuri/tenants'

BILLING: {
  PROVIDER: stripe({ … }),
  SUBSCRIBER_MODEL: 'tenants.Tenant',
  SUBSCRIBER: () => currentTenant(),
}
```

A customer refers to its subscriber by model label and primary key (`subscriberType`,
`subscriberId`) rather than by a foreign key. Billing therefore never imports `@ghuri/tenants`, and
moving from per-user to per-tenant billing does not change the schema.

## Token budgets for agents

[Agent usage limits](/docs/topics/agents/) take a function of the subject being counted.
`usageLimits()` builds one from your plans:

```ts
import { usageLimits } from '@ghuri/billing'

BILLING: {
  PLANS: {
    free: { limits: { agentTokens: { day: 20_000 } } },
    pro: { prices: ['pro_monthly'], limits: { agentTokens: { day: 500_000, month: 5_000_000 } } },
  },
  DEFAULT_PLAN: 'free',
},
AGENTS: {
  USAGE_LIMITS: { tenant: usageLimits('agentTokens') },     // `user:` when users pay
},
```

For the scope that matches `SUBSCRIBER_MODEL` it returns the subscriber's plan limit. Other scopes
get `null` (no limit), or what you pass as `usageLimits('agentTokens', { otherwise })`. Agents call the
function before every run, so it caches each subscriber's entitlements for 60 seconds
(`cacheSeconds`). A subscription change clears the cache in the process that received the webhook;
other Workers isolates pick it up within the TTL.

## Signals

| Signal | Sent | Arguments |
|---|---|---|
| `subscriptionCreated` | a subscription is seen for the first time | `{ subscription }` |
| `subscriptionUpdated` | a known subscription changed | `{ subscription, previousStatus }` |
| `subscriptionCancelled` | a subscription became `canceled` | `{ subscription, previousStatus }` |
| `invoicePaid` | `invoice.paid` | `{ invoice }` |
| `invoicePaymentFailed` | `invoice.payment_failed` | `{ invoice }` |
| `webhookProcessed` | after every event | `{ event, type }` |

```ts
import { invoicePaymentFailed } from '@ghuri/billing'

invoicePaymentFailed.connect(async ({ invoice }) => {
  const customer = await invoice.customer
  await sendMail({ subject: 'Your payment failed', message: invoice.hostedInvoiceUrl, recipientList: [customer.email] })
})
```

## Admin, commands and checks

- `import '@ghuri/billing/admin'` in your admin module registers every model. They are read-only,
  because Stripe holds the truth.
- `ghuri billing_sync [--kinds products,prices]` imports products and prices.
- `ghuri billing_process_events [--status failed|pending|all]` runs stored events again.
- Checks: `billing.E001` no `PROVIDER`; `billing.E002` a missing or malformed secret key (a
  publishable `pk_` key is an error); `billing.E003` no webhook secret; `billing.E004` an unknown
  `SUBSCRIBER_MODEL`; `billing.E005` bad `PLANS` or `DEFAULT_PLAN`; `billing.W001` (deploy) a test key
  with `DEBUG = false`; `billing.W002` `WEBHOOK_TASKS` without `@ghuri/tasks`.

## Money

Amounts (`Price.unitAmount`, `Invoice.amountDue`, `amountPaid`, `total`, …) are integers in the
currency's minor unit (cents for USD; yen for JPY), always next to a lowercase ISO 4217 `currency`.
Never store them as floats. `formatAmount(1250, 'usd')` gives `'12.50 USD'`, and
`price.humanReadable` gives `'12.00 USD / month'`.

## Testing

`@ghuri/billing/testing` has an in-memory Stripe API, so tests need no network and no keys:

```ts
import { fakeStripe } from '@ghuri/billing/testing'

const stripe = fakeStripe()
settings.BILLING.PROVIDER = stripe.provider()

stripe.createPrice({ lookup_key: 'pro_monthly', unit_amount: 1200 })
await syncProductsAndPrices()

await client.forceLogin(user)
const { id } = await (await client.post('/billing/checkout/', { json: { plan: 'pro' } })).json()
const session = stripe.completeCheckout(id)                        // the customer paid
const { body, headers } = await stripe.webhook(stripe.event('checkout.session.completed', session))
await client.post('/billing/webhook/', { body, headers, csrf: false })

expect(await hasActiveSubscription(user)).toBe(true)
```

## Other providers

`BILLING.PROVIDER` is any object that implements `BillingProvider`: creating customers, Checkout and
portal sessions, verifying and parsing webhooks, and fetching and listing objects. The provider
returns normalized data (`SubscriptionData`, `PriceData`, …), and syncing, models and views work
only with that. Paddle and Lemon Squeezy adapters are planned.
