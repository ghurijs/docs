---
title: OpenAPI
description: Generate an OpenAPI 3.1 schema from your URL patterns and serve Swagger UI or Scalar docs.
---

`@ghuri/rest` generates an [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document from your
URL patterns. It walks every API view and viewset reachable from `ROOT_URLCONF`, and describes
paths, methods, parameters, request bodies and responses using your serializers' JSON Schema.

:::note[Alpha]
The schema generator and its override hooks (`@extendSchema`, `getSchemaOperation`) are the part
of `@ghuri/rest` most likely to change before 0.1. The output format is standard OpenAPI 3.1 and
will stay that way.
:::

:::tip[If you know Django]
This covers what most DRF projects install `drf-spectacular` for: `SpectacularAPIView` is
`SchemaView`, `SpectacularSwaggerView` is `SwaggerUIView`, and `@extend_schema` is
`@extendSchema`. It is built in, and it already speaks OpenAPI 3.1, so nullable fields use
`type: ['string', 'null']`.
:::

## Serving the schema and docs

```ts title="src/urls.ts"
import { path, include } from '@ghuri/core'
import { SchemaView, SwaggerUIView, ScalarView } from '@ghuri/rest'
import { router } from './api/urls'

export const urlpatterns = [
  path('api/', include(router.urls)),
  path('api/schema/', SchemaView.asView({ title: 'Blog API', version: '1.0.0' }), { name: 'schema' }),
  path('api/docs/', SwaggerUIView.asView({ urlName: 'schema' }), { name: 'swagger-ui' }),
  path('api/reference/', ScalarView.asView({ urlName: 'schema' }), { name: 'scalar' }),
]
```

- `GET /api/schema/` returns the schema as JSON (`?format=yaml` for YAML).
- `GET /api/docs/` serves Swagger UI, loaded from a CDN, pointed at the schema.
- `GET /api/reference/` serves [Scalar](https://scalar.com) the same way.

Neither UI adds a build step or bundles assets into your Worker. If your content security policy
forbids third-party scripts, pass `cdn` to point at assets you host yourself.

The docs views use the same permission system as any other view. To publish docs only to staff:

```ts
SchemaView.asView({ title: 'Blog API', permissionClasses: [IsAdminUser] })
```

## Generating a schema file

For client generation or CI checks, call `generateSchema()` yourself. A small
[management command](/docs/topics/management-commands/) is enough to write it to disk:

```ts title="src/api/commands/openapi.ts"
import { BaseCommand, type ArgumentParser, type CommandIO } from '@ghuri/core'
import { generateSchema } from '@ghuri/rest'
import { writeFile } from 'node:fs/promises'
import { urlpatterns } from '../../urls'

export class OpenAPICommand extends BaseCommand {
  static help = 'Write the OpenAPI schema to a file.'
  addArguments(parser: ArgumentParser) {
    parser.option('--file <path>', { default: 'openapi.json' })
  }
  async handle(args: Record<string, unknown>, io: CommandIO) {
    const schema = await generateSchema(urlpatterns, { title: 'Blog API', version: '1.0.0' })
    await writeFile(String(args.file), JSON.stringify(schema, null, 2))
    io.stdout(io.style.success(`Wrote ${args.file}`))
  }
}
```

Commands run in Node through the CLI, so importing `node:fs` there is fine. The same function
works in a test that fails when the API changes shape unexpectedly:

```ts
import { generateSchema } from '@ghuri/rest'
import { urlpatterns } from '../src/urls'

const schema = await generateSchema(urlpatterns, { title: 'Blog API', version: '1.0.0' })
expect(schema).toMatchSnapshot()
```

Feed the file to `openapi-typescript`, `orval` or any OpenAPI 3.1 generator for typed clients.

## What gets documented

| Source | Becomes |
|---|---|
| URL route and converters (`<int:pk>`) | `paths`, path parameters with types |
| Viewset actions and `APIView` methods | operations, `operationId` (`posts_list`, `posts_publish`) |
| `serializerClass` / `getSerializerClass()` | request and response `components.schemas` |
| `readOnly` / `writeOnly` fields | separate request and response schemas when they differ |
| Model field `helpText`, `choices`, `maxLength` | `description`, `enum`, `maxLength` |
| `paginationClass` | wrapped list response (`count`, `next`, `previous`, `results`) |
| Filter backends | query parameters (`search`, `ordering`, `filtersetFields`) |
| `authenticationClasses` | `securitySchemes` and per-operation `security` |
| `permissionClasses` allowing anonymous access | operation without required security |

`helpText` on model fields is the cheapest documentation you will ever write. It shows up in the
admin, in this schema and in the tool descriptions of [agents](/docs/topics/agents/).

## Adjusting operations

Use the `@extendSchema` decorator on a handler or action to add or replace parts of an operation:

```ts
import { extendSchema, ModelViewSet, action } from '@ghuri/rest'

export class PostViewSet extends ModelViewSet<Post> {
  @extendSchema({
    summary: 'Publish a post',
    description: 'Marks the post as published. Idempotent.',
    request: null,
    responses: { 200: { type: 'object', properties: { status: { type: 'string' } } } },
    tags: ['posts'],
  })
  @action({ detail: true, methods: ['post'] })
  async publish(c: Context) { ... }
}
```

Plain function views registered with `path()` are not API views and are left out. To document
one, wrap it with `apiView()` and give it a serializer, or exclude a view explicitly with
`@extendSchema({ exclude: true })`.

For changes that apply to the whole document (servers, extra tags, vendor extensions), pass a
`postprocess` function:

```ts
SchemaView.asView({
  title: 'Blog API',
  version: '1.0.0',
  postprocess: (schema) => ({ ...schema, servers: [{ url: 'https://api.example.com' }] }),
})
```

## Introspection for tools

The generator is built on the same introspection API the agents package uses: `router.registry`
for routes and actions, and `serializer.jsonSchema()` for shapes. If you write your own tooling
(a typed SDK generator, a contract test), start there rather than parsing the OpenAPI document.
