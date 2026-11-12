---
title: File storage
description: Store uploaded files on R2, S3, the filesystem or in memory with the Storage API, FileField and ImageField.
---

`@ghuri/storage` puts every file your app saves behind one `Storage` interface, a port of
Django's file storage API. On Cloudflare the usual backend is an R2 bucket binding. On a VPS it
can be S3 (or any S3-compatible service, including R2 itself) or the local filesystem. Your code
calls `storages.get()` or uses a `FileField`, never `env.MEDIA` directly, so moving between
backends is a settings change.

This page is an overview. Every backend's options, the full `Storage` and `FieldFile` APIs,
presigned URLs and serving media are in [Storage backends](/docs/topics/storage-backends/).

## Configuring storages

`STORAGES` maps aliases to backend configs. `default` is used whenever you do not name one.
`@ghuri/storage` is a library, not an app: there is nothing to add to `INSTALLED_APPS`.

```ts title="src/settings.ts"
import { r2 } from '@ghuri/storage'

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
| `r2(binding, { publicUrl?, cacheControl? })` | `@ghuri/storage` | Workers | Uses the R2 binding from `wrangler.jsonc`. No presigned URLs |
| `s3({ endpoint?, bucket, accessKeyId, secretAccessKey, region?, publicUrl?, ... })` | `@ghuri/storage` | anywhere | Signs requests with `aws4fetch`. Works with AWS S3, MinIO and R2's S3 API |
| `fileSystemStorage({ location, baseUrl? })` | `@ghuri/storage/fs` | Node only | Files under a local directory |
| `memoryStorage({ baseUrl? })` | `@ghuri/storage` | anywhere | Per process or isolate. For tests |

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
`r2()` and `s3()` play the role of `django-storages`, `fileSystemStorage` is
`FileSystemStorage` and `memoryStorage` is `InMemoryStorage`. `MEDIA_URL` means the same thing.
There is no `MEDIA_ROOT`: the filesystem backend takes `location` directly.
:::

## FileField and ImageField

Add a file to a model with `FileField`, or `ImageField` when it must be an image:

```ts title="src/blog/models.ts"
import { CharField, IntegerField, Model } from '@ghuri/orm'
import { FileField, ImageField } from '@ghuri/storage'

export class Post extends Model({
  title: new CharField({ maxLength: 200 }),
  cover: new ImageField({ uploadTo: 'covers/', widthField: 'coverWidth', heightField: 'coverHeight', blank: true }),
  coverWidth: new IntegerField({ null: true, blank: true }),
  coverHeight: new IntegerField({ null: true, blank: true }),
  attachment: new FileField({
    uploadTo: 'attachments/%Y/%m/',
    storage: 'private',
    blank: true,
  }),
  // ...
}) {}
```

- `uploadTo` is a prefix with strftime tokens (`%Y`, `%m`, `%d`, in UTC), or a function
  `(instance, filename) => string`.
- `storage` is a `STORAGES` alias (default `'default'`), a `Storage`, a config, or a function
  returning a `Storage`.
- The database column stores only the file **name** (`FileField` extends `CharField`; the
  column is a `varchar(100)` by default, raise it with `maxLength`). Names are portable across
  D1, SQLite and Postgres, and `dumpdata` / `loaddata` move names, not bytes.
- `ImageField` detects the format from the file's **magic bytes** (PNG, JPEG, GIF, WebP, BMP,
  AVIF, HEIC), ignoring the client's MIME type and extension, and fills `widthField` /
  `heightField` on upload.

On an instance the field's value is always a `FieldFile`, also when empty (check `isEmpty`):

```ts
const post = await Post.objects.get({ slug: 'hello-ghuri' })

post.cover.name            // 'covers/hello.png' (null when empty)
post.cover.url             // 'https://media.example.com/covers/hello.png'
await post.cover.size()    // 48213
const file = await post.cover.open()   // StoredFile; throws FileNotFoundError when missing
const bytes = await file.arrayBuffer()

await post.cover.save('hello.png', blob)   // uploads, sets the name, saves the instance
await post.cover.delete()                  // removes the file, clears the field, saves the instance
post.cover.toJSON()                        // 'covers/hello.png': the stored name, not the URL
```

`toJSON()` returns the stored name because `model.toJSON()` feeds fixtures and must round-trip
through `new Model(json)` on any backend; URLs depend on settings. Use `file.url` for clients.
The REST framework's file fields output the URL.

Deleting a model instance **keeps** its files by default, as in Django: other rows, backups or
caches may still point at them. Opt in with `DELETE_FILES_ON_MODEL_DELETE: true` or per field
with `deleteWithModel: true`; files are then deleted after the transaction commits (cascades and
`qs.delete()` included). Replacing a file never deletes the old one.

## Uploading files

### From a view

Hono parses multipart bodies into `File` objects. Wrap one with `upload()` and assign it; the
next `save()` uploads it before writing the row:

```ts title="src/blog/views.ts"
import type { Context } from 'hono'
import { BadRequest, json } from '@ghuri/core'
import { getObjectOr404 } from '@ghuri/orm'
import { upload } from '@ghuri/storage'
import { Post } from './models'

export async function uploadCover(c: Context) {
  const post = await getObjectOr404(Post.objects.all(), { slug: c.req.param('slug') })
  const form = await c.req.formData()
  const file = form.get('cover')
  if (!(file instanceof File)) throw new BadRequest('Send the image in a "cover" field.')

  post.cover = upload(file)       // or: await post.cover.save(file.name, file)
  await post.save()               // uploads first, then UPDATE; invalid images raise ValidationError
  return json(c, { url: post.cover.url, width: post.coverWidth })
}
```

`upload()` exists because model attributes are typed as `FieldFile`; at runtime assigning a
`File` directly also works. Uploaded names are reduced to their base name and cleaned
(`My Cat?.JPG` becomes `My_Cat.JPG`); collisions get a random suffix. To point a field at a file
that is already in storage, assign its name: `post.cover = 'covers/existing.png'`.

:::caution
Bulk operations (`bulkCreate()`, `qs.update()`) cannot upload and raise an error for pending
files. Upload first with `file.save(name, content, { save: false })`. Stream inputs are buffered
in memory before upload (R2 and S3 need a known length), and Workers cap request bodies (100 MB
on most plans): use presigned `PUT` uploads for large files.
:::

### Through the REST framework

A `ModelSerializer` maps `FileField` and `ImageField` to serializer fields of the same name.
Send `multipart/form-data` and the file is saved when the serializer saves; on output the field
is the file's URL (`UPLOADED_FILES_USE_URL`, on by default):

```sh
curl -X PATCH https://mysite.example.workers.dev/blog/api/posts/hello-ghuri/ \
  -H 'Authorization: Token …' \
  -F cover=@hello.png
# {"id":1, "title":"Hello, Ghuri", "cover":"https://media.example.com/covers/hello.png", ...}
```

### In the admin

The admin renders file fields as file inputs with "Currently", "Clear" and "Change" controls.
See [The admin](/docs/topics/admin/).

## Using storages directly

You do not need a model to store a file. Get a storage by alias and use the `Storage` API:

```ts
import { defaultStorage, storages } from '@ghuri/storage'

const storage = storages.get('default')        // or defaultStorage()

const name = await storage.save('reports/2026-11.csv', csvString, { contentType: 'text/csv' })
// name may differ: if the file exists, a random suffix is added ('reports/2026-11_Ab3dE9x.csv')

await storage.exists(name)          // true
await storage.size(name)            // bytes
storage.url(name)                   // public URL (synchronous)
const file = await storage.open(name)
const text = await file?.text()
await storage.listdir('reports')    // { dirs: [], files: ['2026-11.csv'] }
await storage.delete(name)          // missing files are fine
```

`save()` accepts a `Blob`, `File`, `ArrayBuffer`, typed array, `ReadableStream` or string, and
returns the final name. `open()` returns `null` when the file does not exist. See
[Storage backends](/docs/topics/storage-backends/#the-storage-api) for every method, byte
ranges and custom backends.

## Serving files

There are two ways files reach browsers.

**A public URL.** Give the backend a `publicUrl`, and `url()` returns `${publicUrl}/${name}`.
With R2, attach a custom domain to the bucket (or enable its `r2.dev` URL) in the Cloudflare
dashboard. Files are then served from Cloudflare's cache and your Worker never sees those
requests. This is the recommended setup for public media.

**Through your app.** Without a `publicUrl`, `url()` returns `${MEDIA_URL}${name}`. Mount
`serveMedia()` at that path and Ghuri streams files out of storage:

```ts title="src/urls.ts"
import { path } from '@ghuri/core'
import { serveMedia } from '@ghuri/storage'

export const urlpatterns = [
  // ...
  path('media/<path:name>', serveMedia()),
]
```

`serveMedia` handles `ETag` / `Last-Modified` (answering `304`), byte ranges (`206`), `HEAD`,
and sandboxes HTML and SVG uploads so they cannot run script on your origin. Use it in
development, and for private files: wrap it in `loginRequired` or write your own view that checks
permissions before calling `storage.open()`.

For private files on S3 (or R2 through its S3 API), hand out short-lived links instead:
`await storage.presignedUrl(name, { expiresIn: 300 })` or `await post.attachment.presignedUrl()`.
Presigned URLs are not available on the R2 binding; see
[Storage backends](/docs/topics/storage-backends/#presigned-urls-and-direct-uploads).
