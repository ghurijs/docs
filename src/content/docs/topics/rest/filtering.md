---
title: Filtering
description: Narrow list endpoints with getQueryset, FieldFilter, SearchFilter and OrderingFilter.
---

There are two ways to filter what a list endpoint returns, and most APIs use both:

1. **In code**, by overriding `getQueryset()`. Use this for rules the client must not be able to
   change, such as "users only see their own drafts".
2. **From the query string**, with filter backends. Use this for choices the client makes, such
   as `?published=true&search=workers&ordering=-createdAt`.

:::tip[If you know Django]
`SearchFilter` and `OrderingFilter` are DRF's. `FieldFilter` covers the common part of
`django-filter`'s `DjangoFilterBackend`: `filtersetFields` is `filterset_fields`, and lookups use
the same `__` syntax as the ORM (`?createdAt__gte=2026-01-01`). It is also exported as
`DjangoFilterBackend`, so ported code keeps working.
:::

:::note
There is no `FilterSet` class yet. For complex filters, override `getQueryset()` or write a
filter backend.
:::

## Filtering in `getQueryset()`

```ts
export class PostViewSet extends ModelViewSet<Post> {
  serializerClass = PostSerializer

  getQueryset() {
    const user = this.request.user
    const qs = Post.objects.selectRelated('author')
    if (user.isStaff) return qs
    if (user.isAuthenticated) return qs.filter(Q({ published: true }).or(Q({ author: user.pk })))
    return qs.filter({ published: true })
  }
}
```

Because `getObject()` looks objects up within `getQueryset()`, the same rule protects detail
routes: an anonymous request for an unpublished post gets `404`, not `403`.

## Filter backends

Set them project-wide or per view:

```ts title="src/settings.ts"
REST_FRAMEWORK: {
  DEFAULT_FILTER_BACKENDS: [FieldFilter, SearchFilter, OrderingFilter],
}
```

```ts
export class PostViewSet extends ModelViewSet<Post> {
  filterBackends = [FieldFilter, SearchFilter, OrderingFilter]
  filtersetFields = ['published', 'author', 'tags__name']
  searchFields = ['title', 'body', 'author__username']
  orderingFields = ['createdAt', 'title']
  ordering = ['-createdAt']   // default when the client does not ask
}
```

Backends run in order inside `filterQueryset()`, before pagination.

## FieldFilter

Maps query parameters to ORM lookups for the fields you allow:

```
GET /api/posts/?published=true
GET /api/posts/?author=3
GET /api/posts/?tags__name=cloudflare
```

`filtersetFields` can be an array (exact matches only) or an object listing allowed lookups per
field:

```ts
filtersetFields = {
  published: ['exact'],
  createdAt: ['gte', 'lte', 'year'],
  title: ['icontains'],
  tags__name: ['exact', 'in'],
}
```

```
GET /api/posts/?createdAt__gte=2026-01-01&title__icontains=hono
GET /api/posts/?tags__name__in=cloudflare,postgres
```

Values are converted with the model field's `toPython()`, so `?published=false` becomes the
boolean `false` and `?createdAt__gte=2026-01-01` becomes a `Date` (a bare date on a
`DateTimeField` means midnight UTC). `in` takes comma-separated values and `range` exactly two.
An invalid value returns `400` with the field error. Parameters for fields and lookups you did
not allow are ignored, never passed through to the ORM.

When filtering across a many-to-many relation (`tags__name`), the backend adds `.distinct()` so
a post with two matching tags is returned once.

## SearchFilter

A single `?search=` parameter matched against several fields. Each whitespace-separated term must
match at least one field (terms are `AND`ed, fields are `OR`ed).

```
GET /api/posts/?search=cloudflare workers
```

Prefix a field name to change the lookup:

| Prefix | Lookup |
|---|---|
| (none) | `icontains` |
| `^` | `istartswith` |
| `=` | `iexact` |
| `@` | full-text in DRF; mapped to `icontains` here |
| `$` | `iregex` (Postgres and Node SQLite; D1 has no regex support) |

```ts
searchFields = ['^title', 'body', '=author__username']
```

Terms are split on whitespace and commas; `"quoted phrases"` stay together. Searching across a
to-many relation adds `.distinct()`. The parameter name comes from `SEARCH_PARAM`.

`icontains` compiles to `LIKE` on SQLite/D1 and `ILIKE` on Postgres. Neither uses a normal index,
so on large tables consider a dedicated search column or Postgres full-text search through a
custom backend.

## OrderingFilter

```
GET /api/posts/?ordering=-createdAt
GET /api/posts/?ordering=title,-createdAt
```

Only fields in `orderingFields` are accepted (`'__all__'` allows any model field, which you rarely
want on a public API). Without `orderingFields`, the serializer's readable model-backed fields are
allowed, as in DRF. Unknown fields are ignored. `ordering` on the view is the default; without it
the queryset keeps the model's `Meta.ordering`. The parameter name comes from `ORDERING_PARAM`.

## Writing a filter backend

Implement `filterQueryset(request, qs, view)`. Optionally implement
`getSchemaOperationParameters(view)` so the parameters show up in the
[OpenAPI schema](/docs/topics/rest/openapi/).

```ts title="src/blog/filters.ts"
import { BaseFilterBackend, type APIRequest } from '@ghuri/rest'
import type { QuerySet } from '@ghuri/orm'

export class RecentFilter extends BaseFilterBackend {
  filterQueryset(request: APIRequest, qs: QuerySet<any>) {
    const days = Number(request.query.recent)
    if (!days) return qs
    const since = new Date(Date.now() - days * 86_400_000)
    return qs.filter({ createdAt__gte: since })
  }

  getSchemaOperationParameters() {
    return [{ name: 'recent', in: 'query', schema: { type: 'integer' }, description: 'Only items from the last N days' }]
  }
}
```
