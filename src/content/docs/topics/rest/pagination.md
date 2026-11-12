---
title: Pagination
description: Page-number, limit/offset and cursor pagination for list endpoints.
---

List endpoints of generic views and viewsets are paginated when a pagination class is set. There
is no default, so turn it on project-wide:

```ts title="src/settings.ts"
import { PageNumberPagination } from '@ghuri/rest'

REST_FRAMEWORK: {
  DEFAULT_PAGINATION_CLASS: PageNumberPagination,
  PAGE_SIZE: 20,
}
```

or per view with `paginationClass` (`null` disables it for that view).

Pagination happens in the database: the paginator slices the QuerySet, which compiles to
`LIMIT`/`OFFSET` (or a `WHERE` on the ordering column for cursors). It never loads the whole
table into the Worker.

:::tip[If you know Django]
Same three classes as DRF, same query parameters and same response envelope, so existing DRF
clients work unchanged. Attribute names are `camelCase`: `page_size_query_param` →
`pageSizeQueryParam`, `max_page_size` → `maxPageSize`.
:::

## PageNumberPagination

```
GET /api/posts/?page=3
```

```json
{
  "count": 412,
  "next": "http://localhost:8787/api/posts/?page=4",
  "previous": "http://localhost:8787/api/posts/?page=2",
  "results": [ ... ]
}
```

Customize by subclassing:

```ts title="src/blog/pagination.ts"
import { PageNumberPagination } from '@ghuri/rest'

export class StandardPagination extends PageNumberPagination {
  pageSize = 25
  pageSizeQueryParam = 'page_size'   // lets clients ask for ?page_size=100
  maxPageSize = 100
  lastPageStrings = ['last']         // ?page=last (the default)
}
```

`pageSize` defaults to `PAGE_SIZE`; when neither is set, the list is not paginated.

An out-of-range page returns `404` with `{"detail": "Invalid page."}`.

## LimitOffsetPagination

```
GET /api/posts/?limit=10&offset=40
```

Same envelope as above. Attributes: `defaultLimit` (falls back to `PAGE_SIZE`), `limitQueryParam`,
`offsetQueryParam`, `maxLimit`.

## CursorPagination

Cursor pagination gives stable pages over data that changes while the client pages through it,
and avoids the cost of large `OFFSET`s and of `COUNT(*)`. The trade-off: no total count and no
jumping to an arbitrary page.

```ts
import { CursorPagination } from '@ghuri/rest'

export class PostCursorPagination extends CursorPagination {
  pageSize = 20
  ordering = '-createdAt'    // the default; must be a unique, unchanging column (or end with one)
}
```

`ordering` defaults to `'-createdAt'` (DRF uses `'-created'`), so set it when your model has no
`createdAt` field. Double-underscore lookups are rejected. If the view has an `OrderingFilter`,
the client's `?ordering=` is used instead. `pageSizeQueryParam` and `maxPageSize` work as on
`PageNumberPagination`.

```json
{
  "next": "http://localhost:8787/api/posts/?cursor=cD0yMDI2LTExLTEy",
  "previous": null,
  "results": [ ... ]
}
```

The ordering column should be indexed. Add it to `Meta.indexes` on the model:

```ts
static Meta = { ordering: ['-createdAt'], indexes: [{ fields: ['createdAt'] }] }
```

Cursor pagination is the right default for feeds, activity logs and anything a mobile app
scrolls through.

## The count query on D1

`PageNumberPagination` and `LimitOffsetPagination` run a `COUNT(*)` alongside the page query.
On D1 that query reads every matching row, and D1 bills by rows read. For large, frequently
listed tables either filter the queryset so the count stays small or use `CursorPagination`.

## Paginating custom actions

Generic views do this for you in `list`. In your own actions, call the hooks:

```ts
@action({ detail: false })
async drafts(request: APIRequest) {
  const qs = this.filterQueryset(this.getQueryset().filter({ published: false }))
  const page = await this.paginateQueryset(qs)
  if (page) {
    return this.getPaginatedResponse(await this.getSerializer({ instance: page, many: true }).getData())
  }
  return new APIResponse(await this.getSerializer({ instance: qs, many: true }).getData())
}
```

## Custom envelopes

Override `getPaginatedResponse(data)` to change the response shape, and
`getPaginatedResponseSchema(schema)` so the [OpenAPI schema](/docs/topics/rest/openapi/) matches:

```ts
export class MetaPagination extends PageNumberPagination {
  override getPaginatedResponse(data: unknown) {
    return new APIResponse({
      data,
      meta: { total: this.count, page: this.pageNumber, pages: this.numPages },
    })
  }

  override getPaginatedResponseSchema(schema: JSONSchema): JSONSchema {
    return {
      type: 'object',
      properties: {
        data: schema,
        meta: { type: 'object', properties: { total: { type: 'integer' }, page: { type: 'integer' }, pages: { type: 'integer' } } },
      },
    }
  }
}
```

`JSONSchema` is a type exported from `@ghuri/rest`. After `paginateQueryset()`, a
`PageNumberPagination` exposes `count`, `pageNumber` and `numPages`; a `LimitOffsetPagination`
exposes `count`, `limit` and `offset`.
