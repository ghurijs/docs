---
title: File storage
description: Store uploaded files on R2, S3, the filesystem or in memory with the Storage API, FileField and ImageField.
---

`@ghuri/storage` puts every file your app saves behind one `Storage` interface. On Cloudflare
the default backend is an R2 bucket. On a VPS it can be S3 (or any S3-compatible service,
including R2 itself) or the local filesystem. Your code calls `storage.save()` and
`post.cover.url`, and the backend is chosen in settings.

## Configuring storages

`STORAGES` maps aliases to backend configs. `default` is used whenever you do not name one.

```ts title="src/settings.ts"
import { r2, s3, memoryStorage } from '@ghuri/storage'

export default defineSettings((env) => ({
  // ...
  STORAGES: {
    default: r2('MEDIA', { publicUrl: 'https://media.example.com' }),
  },
  MEDIA_URL: '/media/',
}))
```

The backends:

| Config | Import | Runs on | Notes |
|---|---|---|---|
| `r2(binding, { publicUrl? })` | `@ghuri/storage` | Workers | Uses the R2 binding from `wrangler.jsonc` |
| `s3({ endpoint, bucket, accessKeyId, secretAccessKey, region?, publicUrl? })` | `@ghuri/storage` | anywhere | Signs requests with `aws4fetch`. Works with AWS S3, MinIO and R2's S3 API |
| `fileSystemStorage({ location, baseUrl })` | `@ghuri/storage/fs` | Node only | Files under a local directory |
| `memoryStorage()` | `@ghuri/storage` | anywhere | Lost on restart. For tests |

A typical portable setup picks the backend from the environment:

```ts title="src/settings.ts"
STORAGES: {
  default: env.MEDIA
    ? r2('MEDIA')
    : s3({
        endpoint: env.S3_ENDPOINT,
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        publicUrl: env.MEDIA_PUBLIC_URL,
      }),
},
```

Because `s3()` speaks R2's S3-compatible API, a Node deployment can keep using the same R2
bucket it used on Workers. Moving to Postgres does not force you to move files.

:::tip[If you know Django]
This is Django's `STORAGES` setting with backend factories in place of dotted class paths.
`r2()` and `s3()` play the role of `django-storages`, and `fileSystemStorage` is
`FileSystemStorage`. `MEDIA_URL` means the same thing. There is no `MEDIA_ROOT`: the filesystem
backend takes `location` directly.
:::

## FileField and ImageField

Add a file to a model with `FileField`, or `ImageField` when it must be an image:

```ts title="src/blog/models.ts"
import { Model, CharField } from '@ghuri/orm'
import { FileField, ImageField } from '@ghuri/storage'

export class Post extends Model({
  title: new CharField({ maxLength: 200 }),
  cover: new ImageField({ uploadTo: 'covers/', blank: true }),
  attachment: new FileField({
    uploadTo: (post, filename) => `attachments/${new Date().getFullYear()}/${filename}`,
    storage: 'private',
    blank: true,
  }),
  // ...
}) {}
```

- `uploadTo` is a prefix string or a function `(instance, filename) => string`.
- `storage` is a `STORAGES` alias. It defaults to `default`.
- The database column stores only the file **name** (a `varchar(100)` by default; raise it
  with `maxLength`).
- `ImageField` checks that the upload has an image MIME type.

On an instance the field's value is a `FieldFile`:

```ts
const post = await Post.objects.get({ slug: 'hello-ghuri' })

post.cover.name            // 'covers/hello.png'
post.cover.url             // 'https://media.example.com/covers/hello.png'
await post.cover.size()    // 48213
const file = await post.cover.open()   // StoredFile | null
const bytes = await file?.arrayBuffer()

await post.cover.save('hello.png', blob)   // stores the file, sets the name, saves the instance
await post.cover.delete()                  // removes the file and clears the field
```

Deleting a model instance does **not** delete its files, as in Django. Files may be shared, and
an aborted transaction could otherwise leave rows pointing at nothing. Clean up with a
`postDelete` [signal](/docs/topics/signals/) if you need to.

## Uploading files

### From a view

Hono parses multipart bodies into `File` objects, which you hand straight to the field:

```ts title="src/blog/views.ts"
import type { Context } from 'hono'
import { json, BadRequest } from '@ghuri/core'
import { getObjectOr404 } from '@ghuri/orm'
import { Post } from './models'

export async function uploadCover(c: Context) {
  const post = await getObjectOr404(Post.objects.all(), { slug: c.req.param('slug') })
  const body = await c.req.parseBody()
  const file = body.cover
  if (!(file instanceof File)) throw new BadRequest('Send the image in a "cover" field.')

  await post.cover.save(file.name, file)
  return json(c, { url: post.cover.url })
}
```

The file is streamed to the backend. On Workers the upload never touches a disk.

### Through the REST framework

A `ModelSerializer` maps `FileField` and `ImageField` to serializer fields of the same name.
Send `multipart/form-data` and the file is saved when the serializer saves; on output the field
is the file's URL:

```sh
curl -X PATCH https://mysite.example.workers.dev/blog/api/posts/hello-ghuri/ \
  -H 'Authorization: Token …' \
  -F cover=@hello.png
# {"id":1, "title":"Hello, Ghuri", "cover":"https://media.example.com/covers/hello.png", ...}
```

### In the admin

The admin renders file fields as file inputs when `@ghuri/storage` is installed. See
[The admin](/docs/topics/admin/).

## Using storages directly

You do not need a model to store a file. Get a storage by alias and use the `Storage` API:

```ts
import { storages, defaultStorage } from '@ghuri/storage'

const storage = storages.get('default')        // or defaultStorage()

const name = await storage.save('reports/2026-11.csv', csvString, { contentType: 'text/csv' })
// name may differ: if the file exists, a random suffix is added ('reports/2026-11_a8f3k2.csv')

await storage.exists(name)          // true
await storage.size(name)            // bytes
storage.url(name)                   // public URL
const file = await storage.open(name)
const text = await file?.text()
await storage.listdir('reports/')   // { dirs: [], files: ['2026-11.csv'] }
await storage.delete(name)
```

`save()` accepts a `Blob`, `ArrayBuffer`, `ReadableStream` or string, and returns the final
name. `open()` returns `null` when the file does not exist; the result has `body` (a
`ReadableStream`), `size`, `contentType`, `etag`, `arrayBuffer()` and `text()`.

To write a custom backend, extend `Storage` and implement `save`, `open`, `delete`, `exists`,
`size` and `url`. Wrap it in a config object, `{ backend: 'myStorage', create(env) { return new MyStorage(env) } }`,
and put that in `STORAGES`.

## Serving files

There are two ways files reach browsers.

**A public URL.** Give the backend a `publicUrl`, and `url()` returns
`${publicUrl}/${name}`. With R2, attach a custom domain to the bucket (or enable its `r2.dev`
URL) in the Cloudflare dashboard. Files are then served from Cloudflare's cache and your
Worker never sees those requests. This is the recommended setup for public media.

**Through your app.** Without a `publicUrl`, `url()` returns `${MEDIA_URL}${name}`. Mount
`serveMedia()` at that path and Ghuri streams files out of storage:

```ts title="src/urls.ts"
import { serveMedia } from '@ghuri/storage'

export const urlpatterns = [
  // ...
  path('media/<path:name>', serveMedia()),
]
```

`serveMedia` sets `Content-Type`, `Content-Length` and `ETag`, and answers `304` for
conditional requests. Use it in development, and for private files: wrap it in
`loginRequired` or write your own view that checks permissions before calling
`storage.open()`.

For private files on S3, `url()` can instead return a short-lived presigned URL. Set
`presign: { expiresIn: 300 }` in the `s3()` options and leave out `publicUrl`.
