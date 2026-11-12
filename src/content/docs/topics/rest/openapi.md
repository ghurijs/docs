---
title: OpenAPI
description: Generate an OpenAPI 3.1 schema from your URL patterns and serve Swagger UI or Scalar docs.
---

`@ghuri/rest` generates an [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document from your
URL patterns. It walks every API view and viewset reachable from `ROOT_URLCONF` (or the patterns
or router you pass), and describes paths, methods, parameters, request bodies and responses
using your serializers' JSON Schema.

:::tip[If you know Django]
This covers what most DRF projects install `drf-spectacular` for: `SpectacularAPIView` is
`SchemaView`, `SpectacularSwaggerView` is `SwaggerUIView`, and `@extend_schema` is
`@extendSchema`. There is no Redoc view; `ScalarView` serves a reference page instead. It is built
in, and it already speaks OpenAPI 3.1, so nullable fields use `type: ['string', 'null']`.
:::

## Serving the schema and docs

```ts title="src/urls.ts"
import { path, include } from '@ghuri/core'
import { SchemaView, SwaggerUIView, ScalarView } from '@ghuri/rest'
import { router } from './api/urls'

export const urlpatterns = [
  path('api/schema/', SchemaView.asView({ title: 'Blog API', version: '1.0.0' }), { name: 'schema' }),
  path('api/docs/', SwaggerUIView.asView({ urlName: 'schema' }), { name: 'swagger-ui' }),
  path('api/reference/', ScalarView.asView({ urlName: 'schema' }), { name: 'scalar' }),
  path('api/', include(router.urls)),
]
```

Projects created with `ghuri startproject` already have these three routes. They come before the
router's `include()` so that a viewset registered as `schema` or `docs` can't shadow them.

- `GET /api/schema/` returns the schema as JSON (also as `application/vnd.oai.openapi+json`).
  The document is generated once and cached per URL conf; pass `cacheSchema: false` to rebuild
  it on every request.
- `GET /api/docs/` serves Swagger UI, loaded from a CDN, pointed at the schema. It sends the
  `csrftoken` cookie as `X-CSRFToken`, so "Try it out" works with session authentication.
- `GET /api/reference/` serves [Scalar](https://scalar.com) the same way.

`SchemaView` options: `title`, `version`, `description`, `info`, `servers`, and `patterns` plus
`prefix` to document only part of the site (`patterns: router, prefix: 'api/'`). The docs views
find the schema by `urlName` (reversed in the current namespace), or take a literal `schemaUrl`.

:::note
`SchemaView` serves JSON only; there is no YAML renderer. `ghuri generateschema` (below) writes
YAML or JSON files.
:::

Neither UI adds a build step or bundles assets into your Worker. If your content security policy
forbids third-party scripts, pass `cdn` (for example
`SwaggerUIView.asView({ urlName: 'schema', cdn: '/static/swagger-ui' })`) to point at assets you
host yourself.

The docs views use the same permission system as any other view. To publish docs only to staff:

```ts
SchemaView.asView({ title: 'Blog API', permissionClasses: [IsAdminUser] })
```

## Generating a schema file

For client generation, or to commit the schema and review how it changes, write it to a file
with `generateschema` (DRF's command). It comes from `RestFrameworkConfig`, which
`startproject` adds to `INSTALLED_APPS`. Older projects can add it themselves:

```ts title="src/settings.ts"
import { RestFrameworkConfig } from '@ghuri/rest'

INSTALLED_APPS: [/* … */, RestFrameworkConfig],
```

```sh
npx ghuri generateschema                          # YAML to stdout
npx ghuri generateschema --file openapi.yaml
npx ghuri generateschema --file openapi.json      # JSON, from the extension
npx ghuri generateschema --format openapi-json --url https://api.example.com
```

It documents `ROOT_URLCONF`. If that routes a `SchemaView`, the command takes the view's `title`,
`version`, `description`, `servers`, `patterns` and `prefix`, so the file is the same document
that `/api/schema/` serves. `--title`, `--description`, `--api-version` and `--url` override
them. See the [CLI reference](/docs/reference/cli/#generateschema-restframeworkconfig) for every
option.

Feed the file to `openapi-typescript`, `orval` or any OpenAPI 3.1 generator for typed clients, or
import it into Postman or Insomnia. To fail CI when the API changes without the committed file
being updated:

```sh
npx ghuri generateschema --file openapi.yaml && git diff --exit-code openapi.yaml
```

### From code

`generateSchema()` returns the same document as a plain object, for a snapshot test that fails
when the API changes shape, or for your own command:

```ts
import { generateSchema } from '@ghuri/rest'
import { urlpatterns } from '../src/urls'

const schema = generateSchema(urlpatterns, { title: 'Blog API', version: '1.0.0' })
expect(schema).toMatchSnapshot()

// or just one router, mounted under api/
generateSchema(router, { title: 'Blog API', prefix: 'api/' })
```

`generateSchema()` is synchronous. Pass `servers` to fill the `servers` list.

## What gets documented

| Source | Becomes |
|---|---|
| URL route and converters (`<int:pk>`) | `paths`, path parameters with types |
| Viewset actions and `APIView` methods | operations, `operationId` (`listPosts`, `createPost`, `partialUpdatePost`, `publishPost`) |
| `serializerClass` / `getSerializerClass()` | request and response `components.schemas` |
| `readOnly` / `writeOnly` fields | separate `PostRequest` / `PatchedPostRequest` input schemas and a `Post` output schema |
| Model field `helpText`, `choices`, `maxLength` | `description`, `enum`, `maxLength` |
| `paginationClass` | wrapped list response (`count`, `next`, `previous`, `results`) and its query parameters |
| Filter backends | query parameters (`search`, `ordering`, `filtersetFields`) |
| Permissions, throttles, lookups | `400`, `401`, `403`, `404` and `429` responses where they can happen |
| `authenticationClasses` with a static `securityScheme` | `securitySchemes` and per-operation `security` |
| `permissionClasses` allowing anonymous access | an empty `{}` entry in `security` (authentication optional) |

The authentication classes in `@ghuri/auth/rest` all carry a `securityScheme`; see
[API authentication](/docs/topics/rest/authentication/#openapi-security-schemes). `.json` format
suffix routes are left out.

`helpText` on model fields is the cheapest documentation you will ever write. It shows up in the
admin, in this schema and in the tool descriptions of [agents](/docs/topics/agents/).

## Adjusting operations

Use the `@extendSchema` decorator on a handler or action to add or replace parts of an operation.
Like `@action`, it works as a TC39 or legacy decorator, or as a wrapper:
`extendSchema({...})(fn)`. On a class it applies to every method.

```ts
import { extendSchema, ModelViewSet, action, type APIRequest } from '@ghuri/rest'

export class PostViewSet extends ModelViewSet<Post> {
  @extendSchema({
    summary: 'Publish a post',
    description: 'Marks the post as published. Idempotent.',
    request: null,
    responses: { 200: { type: 'object', properties: { status: { type: 'string' } } } },
    tags: ['posts'],
  })
  @action({ detail: true, methods: ['post'] })
  async publish(request: APIRequest) { ... }
}
```

`extendSchema` options: `operationId`, `summary`, `description`, `tags`, `deprecated`, `exclude`,
`request` (a serializer class or instance, a JSON Schema, or `null` for no body), `responses` (a
serializer or schema, or a map such as `{ 200: PublishResultSerializer, 404: null }`),
`parameters` (extra OpenAPI parameter objects) and `extensions` (merged into the operation last).

For a whole view, set `schema` to an `AutoSchema`:

```ts
import { AutoSchema } from '@ghuri/rest'

export class PostViewSet extends ModelViewSet<Post> {
  schema = new AutoSchema({ tags: ['blog'], operationIdBase: 'BlogPost', componentName: 'BlogPost' })
}
```

`schema = null` leaves a view out, as does `@extendSchema({ exclude: true })` on one operation.
Subclass `AutoSchema` (and set it as `DEFAULT_SCHEMA_CLASS`) to change the generation itself.
Plain function views registered with `path()` are not API views and are left out. To document
one, wrap it with `apiView()`.

For changes to the whole document (extra tags, vendor extensions), subclass `SchemaView` and
post-process the result of `generate()`:

```ts
class BlogSchemaView extends SchemaView {
  override generate() {
    const doc = super.generate()
    return { ...doc, 'x-logo': { url: '/static/logo.svg' } }
  }
}
```

## Introspection for tools

The generator is built on the same introspection API the agents package uses: `router.registry`
for routes and actions (see [Routers](/docs/topics/rest/routers/#introspection)), and
`serializer.jsonSchema()` for shapes. If you write your own tooling (a typed SDK generator, a
contract test), start there rather than parsing the OpenAPI document. `getEndpoints(patterns)`
and `SchemaGenerator` are exported for lower-level access.
