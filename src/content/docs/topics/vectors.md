---
title: Vectors and RAG
description: Embeddings, vector stores and retrieval with @ghuri/vectors — Cloudflare Vectorize on Workers, pgvector on Postgres, model indexes kept up to date on save, tenant-safe search and a search tool for agents.
---

`@ghuri/vectors` gives a Ghuri app retrieval: it splits documents into chunks, embeds them, stores
the vectors and finds the chunks closest to a question. You then hand those chunks to a model
(retrieval-augmented generation, RAG). Stores sit behind adapters chosen in settings, like caches
and task backends, so the same code runs on **Workers + D1 + Vectorize** and on
**Node + Postgres + pgvector**.

:::tip[If you know Django]
Django has no vector store. The closest analogue, whose names Ghuri borrows, is
**django-haystack**:

- a `SearchIndex` of a model is a `ModelIndex`;
- `index_queryset()` is `indexQueryset`;
- the realtime signal processor is `autoIndex`;
- the commands are `update_index`, `clear_index` and `rebuild_index`.

The pgvector store uses pgvector-python's vocabulary: `hnsw` / `ivfflat` indexes, `m`,
`ef_construction`, `lists` and the `vector_cosine_ops` opclasses.
:::

## Install

```sh
npm install @ghuri/vectors@next
```

Add `VectorsConfig` to `INSTALLED_APPS` and run `npx ghuri migrate`. The app adds two tables:

- `vectors_vectordocument`, the manifest of indexed documents. It lets Ghuri skip unchanged
  documents, and Vectorize needs it to delete documents.
- `vectors_vectorembedding`, used only by `databaseStore()`.

## Settings

`VECTORS` maps aliases to stores. Each store has one embedding model:

```ts title="src/settings.ts"
import { defineSettings } from '@ghuri/core'
import { pgvector, vectorize, VectorsConfig } from '@ghuri/vectors'

export default defineSettings((env) => ({
  INSTALLED_APPS: [/* … */, VectorsConfig],
  VECTORS: {
    default: env.VECTORIZE
      ? vectorize('VECTORIZE', { embedding: 'workers-ai:@cf/baai/bge-base-en-v1.5' })   // Workers
      : pgvector({ database: 'default', embedding: 'openai:text-embedding-3-small' }),  // Node + Postgres
  },
}))
```

The two branches above use different embedding models. That is fine, because each deployment
keeps its own vectors. Use the same model on both when you move vectors between them.

| Store | Runs on | Search | For |
|---|---|---|---|
| `vectorize(binding, opts)` | Workers, a Vectorize binding | approximate (Vectorize) | Workers in production |
| `pgvector(opts)` | Postgres with the `vector` extension: postgres.js, Hyperdrive, PGlite | `hnsw` (default) or `ivfflat` index | Node in production |
| `databaseStore(opts)` | any `DATABASES` alias: D1, SQLite, Postgres | exact, reads one namespace's rows | small apps, tests |
| `memoryStore(opts)` | the process | exact | tests, scripts |

Options every store takes:

- `embedding`: a model id, an AI SDK model or an `Embedder` (see below). The type makes it optional, but a
  store without one raises `InvalidVectorStore` the first time it needs to embed, and `ghuri check`
  reports `vectors.E004`. Set it on every store.
- `dimensions`: the vector length. Known for the built-in model ids; otherwise taken from the first
  embedding. `pgvector()` needs it to create its table.
- `metric`: `'cosine'` (default), `'euclidean'` or `'dot-product'`.
- `providerOptions`: options for the embedding provider (API key, base URL).

### Cloudflare Vectorize

Create the index with the embedding model's dimensions and metric, and bind it:

```sh
npx wrangler vectorize create mysite-default --dimensions=768 --metric=cosine
```

```jsonc title="wrangler.jsonc"
"vectorize": [{ "binding": "VECTORIZE", "index_name": "mysite-default" }],
"ai": { "binding": "AI" }
```

To filter on a metadata key, Vectorize needs a metadata index for that key:

```sh
npx wrangler vectorize create-metadata-index mysite-default --property-name=status --type=string
```

Vectorize is eventually consistent: a new vector becomes searchable a few seconds after `index()`
returns. Miniflare does not simulate Vectorize, so `wrangler dev` uses the remote index.

### pgvector

Run `npx ghuri createvectortable` (Django's `createcachetable` for vectors). It runs `CREATE
EXTENSION IF NOT EXISTS vector`, then creates the store's table (`vectors_pgembedding` by default)
and its `hnsw` index. Options:

- `table`;
- `index`: `'hnsw'`, `'ivfflat'` or `null` for exact search;
- `m` and `efConstruction` for `hnsw`, `lists` for `ivfflat`.

For local tests, PGlite loads pgvector from `@electric-sql/pglite-pgvector`.

### Embedding models

Write a model as `'<provider>:<model id>'`, as you do for agent models. The built-in providers need
no extra package:

| Provider | Example | Credentials |
|---|---|---|
| `workers-ai:` | `workers-ai:@cf/baai/bge-base-en-v1.5` (768), `bge-small-en-v1.5` (384), `bge-m3` (1024) | the AI binding (`AGENTS.AI_BINDING`, default `AI`) |
| `openai:` | `openai:text-embedding-3-small` (1536) | `OPENAI_API_KEY`; `OPENAI_BASE_URL` or `baseURL` for compatible APIs |
| `ghuri-ai:` | `ghuri-ai:openai/text-embedding-3-small` | `GHURI_AI_URL`, `GHURI_AI_API_KEY`; sends `x-ghuri-tenant` |

Provider options (`apiKey`, `baseURL`, `headers`) form one object:

- A store's `providerOptions` **replace** `AGENTS.PROVIDERS[provider]` entirely. They are not merged,
  so a store that sets only `baseURL` does not inherit the `apiKey` from `AGENTS`.
- Without `providerOptions`, the object is `AGENTS.PROVIDERS[provider]`, so one key serves agents and
  vectors.
- Then each key the object lacks is read from the environment: `OPENAI_API_KEY` and `OPENAI_BASE_URL`
  for `openai:`, `GHURI_AI_API_KEY` and `GHURI_AI_URL` for `ghuri-ai:`.

You can also pass any AI SDK embedding model, such as `google.textEmbeddingModel('text-embedding-004')`.
To add a provider, call `registerEmbeddingProvider(name, factory)`.

## Indexes

An index is a named set of documents on a store. Define indexes in an app module that the app
loads, so workers and commands can find them by name:

```ts title="src/support/vectors.ts"
import { VectorIndex } from '@ghuri/vectors'

export const handbook = new VectorIndex('support.handbook', {
  chunk: { size: 1000, overlap: 200 },   // characters; false = one chunk per document
})
```

```ts title="src/support/app.ts"
import * as vectors from './vectors'
export class SupportConfig extends AppConfig {
  name = 'support'
  override modules = { vectors }
}
```

```ts
await handbook.index([
  { key: 'refunds', text: refundPolicy, metadata: { section: 'billing', year: 2026 } },
  { key: 'shipping', text: shippingPolicy, metadata: { section: 'delivery' } },
])

const hits = await handbook.search('how long do refunds take?', { k: 5 })
// [{ key: 'refunds', chunk: 0, score: 0.83, text: 'Refunds are paid…', metadata: { section: 'billing', year: 2026 } }, …]

await handbook.delete('shipping')
await handbook.clear()            // every document of this index (in the current tenant)
await handbook.keys()             // indexed keys, from the manifest
```

How indexing works:

- **Chunking.** `index()` splits text on paragraphs, then lines, sentences and words. Sizes are
  characters, not tokens. Pass `chunk: (text) => string[]` to use your own splitter.
- **Unchanged documents.** With the `vectors` app installed, `index()` skips a document whose text,
  metadata, model and chunking have not changed (`{ force: true }` embeds it anyway). When a
  document shrinks, its extra chunks are deleted.
- **Failures.** Everything is embedded before anything is written, so a failed model call leaves
  the index as it was.
- **Metadata.** Values are strings, numbers or booleans. Keys starting with `_` are reserved: they
  hold the document key, the chunk number and the chunk text.
- **Results.** `search()` returns chunks best first. `score` is the cosine similarity, the euclidean
  distance (lower is closer) or the dot product, as the store reports it.

### Filters

Filters use Django lookups on metadata:

```ts
await handbook.search('refunds', {
  filter: { section: 'billing', year__gte: 2025, lang__in: ['en', 'bn'] },
  exclude: { status: 'draft' },
  minScore: 0.5,   // cosine and dot-product stores only
})
```

| Lookup | Operator |
|---|---|
| `field` or `field__exact` | `$eq` |
| `field__in` | `$in` |
| `field__gt`, `__gte`, `__lt`, `__lte` | `$gt`, `$gte`, `$lt`, `$lte` |
| `exclude: { field }` / `exclude: { field__in }` | `$ne` / `$nin` |

Filters become Vectorize filters, `jsonb` conditions on pgvector, and plain JavaScript on the
other stores. An unknown lookup raises `FilterError`.

## Model indexes

`ModelIndex` indexes the rows of a model:

```ts title="src/blog/vectors.ts"
import { ModelIndex } from '@ghuri/vectors'
import { Post } from './models'

export const posts = new ModelIndex(Post, {
  // name defaults to 'blog.post'
  text: (post) => `${post.title}\n\n${post.body}`,       // or field names: ['title', 'body']
  metadata: (post) => ({ status: post.status, authorId: post.authorId }),
  indexQueryset: (qs) => qs.filter({ status: 'published' }),
})
```

```ts
const hits = await posts.search('cancelling a subscription', { k: 5 })
hits[0].object   // the Post (one query for all hits; rows deleted meanwhile are dropped)
```

- `autoIndex` (on by default) re-indexes a row on `postSave` and removes it on `postDelete`.
  `loaddata` saves (`raw`) are skipped, and the work runs after the transaction commits.
- A row that leaves `indexQueryset`, for example a post moved back to draft, is removed from the
  index on its next save.
- Re-saving a row whose text and metadata did not change costs no embedding call.
- `posts.index(objs)`, `posts.delete(objsOrPks)` and `posts.update()` (what `update_index` runs) are
  available for scripts.

## Tenants

With `@ghuri/tenants` installed, indexes are scoped to the current tenant. The default,
`tenant: 'auto'`, turns scoping on when a `tenant` context carrier is registered.

- The tenant goes into the store namespace (`support.handbook|t=42`). On Vectorize, that is native
  namespace isolation. On the other stores, it is a `namespace = …` condition that every query
  carries.
- Without a current tenant, `index()`, `search()`, `delete()`, `clear()` and `keys()` raise `TenantRequired`,
  and so does `ModelIndex.update()`.
  This includes code inside `withoutTenant()`. There is no search across tenants.
- Background indexing and `update_index --tenant <pk>` run as the right tenant.
- `ModelIndex` loads hits through the model's manager, so tenant managers apply too.

For content shared by every tenant, such as docs or terms, use `new VectorIndex('docs',
{ tenant: false })`.

## Background indexing

Embedding calls a model, which is slow and can fail. With [`@ghuri/tasks`](/docs/topics/tasks/)
installed, automatic re-indexing runs as the `vectors.index` task (3 attempts). `@ghuri/vectors`
does not import `@ghuri/tasks`; it uses the tasks interop object, as agents do.

```ts
await handbook.index(docs, { background: true })    // enqueue; returns { taskResultId }
new ModelIndex(Post, { text: ['title', 'body'], background: 'auto' })   // the default for autoIndex
```

Model jobs carry primary keys, and the worker reloads the rows. Document jobs carry the text, so
keep them under the 128 KB limit of a Queues message.

## Agents

`@ghuri/vectors/agents` turns an index into a tool for [agents](/docs/topics/agents/):

```ts title="src/support/agents.ts"
import { Agent } from '@ghuri/agents'
import { formatHits, searchTool } from '@ghuri/vectors/agents'
import { handbook } from './vectors'

export class SupportAgent extends Agent {
  model = 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast'
  instructions = 'Answer from the handbook. Search it before answering.'
  tools = [
    searchTool(handbook, {
      description: 'Search the support handbook.',
      k: 5,
      filter: (ctx) => (ctx.user.isAuthenticated ? undefined : { audience: 'public' }),
    }),
  ]
}
```

- The tool takes `{ query, k? }` and returns `{ results: [{ key, score, text, metadata }] }`.
- It is marked read-only (`readOnlyHint`) for MCP clients.
- `formatHits(hits)` and `retrieve(index, query)` build a `[1] (key) text` context block, for
  putting retrieved passages straight into a prompt.

## Commands

| Command | Does |
|---|---|
| `ghuri update_index [index…] [--tenant pk] [--namespace name] [--batch-size 100] [--force]` | index every row of model indexes; unchanged rows are skipped, deleted rows removed. Plain `VectorIndex`es are skipped, because there are no rows to read |
| `ghuri clear_index [index…] [--tenant pk] [--namespace name]` | delete every vector of the indexes, plain ones too |
| `ghuri rebuild_index [index…] [--tenant pk] [--namespace name] [--batch-size 100]` | clear, then update every row again. Plain `VectorIndex`es are cleared but not refilled |
| `ghuri createvectortable [--store alias]` | create pgvector tables |

`ghuri check` reports:

- `vectors.E001`: a `VECTORS` entry is not a store;
- `vectors.E002`: an index names an unknown store;
- `vectors.E003`: Vectorize or `databaseStore()` is used without the `vectors` app;
- `vectors.E004`: a store has no embedding model;
- `vectors.E005`: a Vectorize binding is missing from `wrangler.jsonc`;
- `vectors.E006`: a pgvector store does not know its dimensions;
- `vectors.W001` / `W002`: a memory or database store is used with `DEBUG` off;
- `vectors.W003`: a `workers-ai:` model is used without an `ai` binding.

## Testing

```ts
import { fakeEmbedding, fakeVectorize, memoryStore, useVectorStore } from '@ghuri/vectors/testing'

const embedding = fakeEmbedding({ dimensions: 64 })   // deterministic; texts sharing words are close
const { restore } = useVectorStore(memoryStore({ embedding }))
// … or exercise the Vectorize store with an in-memory binding:
const env = { VECTORIZE: fakeVectorize({ dimensions: 64 }) }
```

`fakeEmbedding()` counts its calls (`calls`, `texts`), so a test can assert that re-saving an
unchanged row did not embed it again.

## Differences from Django

- There is no vector field yet. Vectors live in stores, not in model columns. A `VectorField` with
  pgvector-python's `CosineDistance` / `L2Distance` lookups is planned.
- Haystack's default signal processor does nothing; Ghuri's `autoIndex` is on by default.
- Index names are explicit strings (`'blog.post'` by default for models), because workers find
  indexes by name.
