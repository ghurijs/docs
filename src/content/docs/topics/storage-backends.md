---
title: Storage backends
description: Reference for @ghuri/storage backends (R2 binding, S3-compatible, filesystem, in-memory), the STORAGES settings, the Storage and FieldFile APIs, presigned URLs and serving media.
---

Reference for `@ghuri/storage`. For an introduction to storages, `FileField` and uploads, start
with [File storage](/docs/topics/file-storage/).

## Settings

| Key | Default | Meaning |
|---|---|---|
| `STORAGES` | none | `{ alias: StorageConfig \| Storage }`. `default` is used by `FileField` and `defaultStorage()` |
| `MEDIA_URL` | `'/media/'` | Base URL for backends without their own `publicUrl` / `baseUrl` |
| `DELETE_FILES_ON_MODEL_DELETE` | `false` | Delete stored files when model instances are deleted |

The keys are added to `GhuriSettings` by declaration merging, so they are type-checked once you
import `@ghuri/storage`. Each `STORAGES` entry is a config `{ backend, create(env) }`, the same
shape as `CACHES`. It is created once per `env` (once per isolate on Workers) and cached;
`storages.get(alias)` returns the instance for the current request. A plain `Storage` instance is
accepted too.

```ts title="src/settings.ts"
import { r2, s3 } from '@ghuri/storage'

STORAGES: {
  default: r2('MEDIA', { publicUrl: 'https://media.example.com' }),
  private: s3({
    endpoint: env.S3_ENDPOINT,
    bucket: 'private',
    accessKeyId: env.S3_KEY,
    secretAccessKey: env.S3_SECRET,
  }),
},
```

## Backends

| Backend | Factory | Class | Presigned URLs | Runs on |
|---|---|---|---|---|
| Cloudflare R2 (binding) | `r2()` | `R2Storage` | no | Workers |
| S3-compatible | `s3()` | `S3Storage` | yes | Workers, Node |
| Filesystem | `fileSystemStorage()` from `@ghuri/storage/fs` | `FileSystemStorage` | no | Node only |
| In-memory | `memoryStorage()` | `MemoryStorage` | no | anywhere |

### Cloudflare R2 (binding)

```jsonc title="wrangler.jsonc"
{
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "my-app-media" }]
}
```

```ts
import { r2 } from '@ghuri/storage'

STORAGES: {
  default: r2('MEDIA', { publicUrl: 'https://media.example.com', cacheControl: 'public, max-age=31536000' }),
}
```

| Argument / option | |
|---|---|
| `binding` | The binding name, or the bucket object itself. A missing binding raises `ImproperlyConfigured` |
| `publicUrl` | A custom domain or `https://pub-<hash>.r2.dev` connected to the bucket. Without it, `url()` uses `MEDIA_URL` and you serve files with [`serveMedia()`](#serving-media) |
| `cacheControl` | Default `Cache-Control` stored with new objects |

The content type, `cacheControl` and `contentDisposition` are stored as R2 `httpMetadata`, and
`metadata` as `customMetadata`. Byte ranges are served natively. `wrangler dev` gives you a local
bucket; `wrangler r2 bucket create my-app-media` creates the real one.

:::caution
The R2 binding cannot create presigned URLs: `presignedUrl()` throws `NotSupportedError`. If you
need them, add a second storage with `s3()` pointing at R2's S3 endpoint. It can address the same
bucket.
:::

### S3-compatible (AWS S3, R2's S3 API, MinIO)

```ts
import { s3 } from '@ghuri/storage'

// Cloudflare R2 through its S3 API (works outside Workers too; region defaults to "auto")
s3({
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  bucket: 'my-app-media',
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
})

// AWS S3 (virtual-hosted URLs; endpoint defaults to https://s3.<region>.amazonaws.com)
s3({
  region: 'eu-west-1',
  bucket: 'my-app-media',
  accessKeyId: env.AWS_ACCESS_KEY_ID,
  secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  publicUrl: 'https://d123.cloudfront.net',
})

// MinIO or any self-hosted S3 (path-style URLs)
s3({ endpoint: 'http://localhost:9000', bucket: 'media', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' })
```

| Option | Default | |
|---|---|---|
| `endpoint` | `https://s3.<region>.amazonaws.com` | Service URL |
| `bucket` | required | |
| `accessKeyId`, `secretAccessKey` | required | |
| `sessionToken` | unset | Temporary credentials |
| `region` | `'auto'` for R2 endpoints, else `'us-east-1'` | |
| `publicUrl` | `MEDIA_URL` | Base of `url()` |
| `forcePathStyle` | path-style except on `amazonaws.com` | |
| `cacheControl` | unset | Default `Cache-Control` for new objects |
| `fetch` | global `fetch` | Custom fetch function |

Requests are signed with SigV4 by [aws4fetch](https://github.com/mhart/aws4fetch). There is no
AWS SDK dependency, so it works on Workers and Node alike.

:::note
On AWS, grant `s3:ListBucket` as well as `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject`.
Without it S3 answers `403` instead of `404` for missing keys, which breaks `exists()` (used to
pick free names).
:::

### Filesystem (Node or a VPS)

```ts
import { fileSystemStorage } from '@ghuri/storage/fs'   // Node only (node:fs): never import it in a Worker

STORAGES: { default: fileSystemStorage({ location: '/var/www/media', baseUrl: '/media/' }) }
```

| Option | Default | |
|---|---|---|
| `location` | required | Root directory (Django's `MEDIA_ROOT`) |
| `baseUrl` | `MEDIA_URL` | Base of `url()` |
| `filePermissions` | `0o644` | Mode of new files |
| `directoryPermissions` | `0o755` | Mode of new directories |

Files are created with `O_EXCL`, so concurrent uploads never overwrite each other, and names that
escape `location` are rejected. Content types are guessed from the extension. In production let
nginx or Caddy serve the directory (`location /media/ { alias /var/www/media/; }`), or use
`serveMedia()`.

### In-memory (tests)

```ts
import { memoryStorage } from '@ghuri/storage'

const media = memoryStorage()     // media.storage is the MemoryStorage instance (files, clear())
STORAGES: { default: media }
```

The only option is `baseUrl` (default `MEDIA_URL`). Files live in a `Map` for the lifetime of the
process or isolate.

### Custom backends

Extend `Storage` and implement `_save`, `stat`, `open`, `delete`, `listdir` and `url` (and
optionally `presignedUrl`). Naming, collision handling, `exists`, `size` and content
normalization come from the base class. Wrap it in a config for `STORAGES`:

```ts
import { createStoredFile, Storage, type BackendSaveOptions, type OpenOptions } from '@ghuri/storage'

class MyStorage extends Storage {
  readonly backend = 'mine'
  protected async _save(name: string, body: Uint8Array | Blob, opts: BackendSaveOptions) { /* ... */ return name }
  async stat(name: string) { /* ... */ return null }
  async open(name: string, opts?: OpenOptions) { /* ... */ return createStoredFile(info, stream, range) }
  async delete(name: string) {}
  async listdir(path?: string) { return { dirs: [], files: [] } }
  url(name: string) { return this.joinUrl('https://files.example.com/', name) }
}

STORAGES: { default: { backend: 'mine', create: (env) => new MyStorage(env.API_KEY) } }
```

## The Storage API

```ts
import { defaultStorage, storages } from '@ghuri/storage'

const storage = storages.get()            // or storages.get('private'), defaultStorage()

const name = await storage.save('reports/q1.csv', csvString, { contentType: 'text/csv' })
// 'reports/q1.csv', or 'reports/q1_Ab3dE9x.csv' if that name was taken
const file = await storage.open(name)     // StoredFile | null
await file?.text()                        // or .body (ReadableStream), .bytes(), .arrayBuffer(), .blob()
await storage.open(name, { range: { offset: 0, length: 1024 } })   // byte ranges (also { suffix: n })
await storage.exists(name); await storage.size(name); await storage.getModifiedTime(name)
await storage.stat(name)                  // { name, size, contentType, etag, lastModified } | null
storage.url(name)                         // public URL
await storage.listdir('reports')          // { dirs: string[], files: string[] }
await storage.delete(name)                // missing files are fine
```

| Method | Notes |
|---|---|
| `save(name \| null, content, opts?)` | `content`: `Blob`, `File`, `ArrayBuffer`, a typed array, `ReadableStream` or string. `name = null` uses the `File`'s name. Returns the final name. Options: `contentType`, `maxLength`, `overwrite`, `cacheControl`, `contentDisposition`, `metadata` |
| `open(name, { range? })` | A `StoredFile` (its body can be read once) or `null`. `size` is the full object size, `range` the slice returned |
| `stat(name)` | Metadata or `null` |
| `exists(name)` / `size(name)` / `getModifiedTime(name)` | `size` and `getModifiedTime` throw `FileNotFoundError` |
| `delete(name)` | Idempotent |
| `url(name)` | Public URL (synchronous) |
| `presignedUrl(name, opts?)` | S3 backends only; others throw `NotSupportedError` |
| `listdir(path?)` | Immediate sub-directories and files of `path` |
| `generateFilename(name)` | Django's `generate_filename`: cleans the base name (`My Cat?.JPG` becomes `My_Cat.JPG`) and rejects `..` |
| `getValidName(name)` | Django's `get_valid_filename` |
| `getAvailableName(name, maxLength?)` | A free name: appends `_` and 7 random characters before the extension on collision, truncating to `maxLength` |

The content type on save is the explicit `contentType`, else the Blob's `type`, else a guess from
the extension, else `application/octet-stream`. `ReadableStream` content is buffered first,
because R2 and S3 need a known length. Unsafe names (absolute paths, `..`, NUL bytes) raise
`SuspiciousFileOperation`, a core `SuspiciousOperation`, so views answer `400`.

Errors: `StorageError` (backend failures, with `status` and `code`), `FileNotFoundError`,
`NotSupportedError` and `SuspiciousFileOperation`.

## FileField options

```ts
new FileField({
  uploadTo: 'docs/%Y/%m/',          // strftime tokens (UTC), or (instance, filename) => string
  storage: 'private',               // alias (default 'default'), a Storage, a config, or () => Storage
  maxLength: 100,                   // varchar length of the stored name (default 100)
  accept: '.pdf,application/pdf',   // the admin's <input accept>
  deleteWithModel: false,           // default: DELETE_FILES_ON_MODEL_DELETE
  validators: [new FileExtensionValidator(['pdf'])],
  blank: true,
})
new ImageField({ uploadTo: 'photos/', widthField: 'width', heightField: 'height' })
```

`fullClean()` checks `blank`, the stored name's `maxLength` and your validators (they receive the
`FieldFile`). Bundled validators: `FileExtensionValidator(['pdf'])` and
`validateImageFileExtension`. Image content is validated at upload time: anything that is not a
PNG, JPEG, GIF, WebP, BMP, AVIF or HEIC raises `ValidationError` from `save()` before the row or
the file is written. Dimensions are parsed for PNG, JPEG, GIF, WebP and BMP (AVIF and HEIC
dimensions are `null`).

Both fields deconstruct for migrations (`uploadTo`, `storage`, `maxLength` when not 100,
`widthField`, `heightField`; callables are recorded by name).

## The FieldFile API

`post.attachment` is always a `FieldFile` (an `ImageFieldFile` for `ImageField`), also when
empty.

| Member | |
|---|---|
| `name` | The stored name (`'docs/2026/04/report.pdf'`), or `null` when empty |
| `url` | `storage.url(name)`; throws when empty |
| `isEmpty` | `true` when no file is set |
| `committed` | `false` while assigned content waits to be uploaded by `save()` |
| `await size()`, `await exists()` | Through the storage (or the pending content) |
| `await open(opts?)` | A `StoredFile`; throws `FileNotFoundError` when missing |
| `await presignedUrl(opts?)` | S3 backends only |
| `await save(name, content, { save = true })` | Django's `FieldFile.save`: applies `uploadTo` and `generateFilename`, uploads, then saves the model unless `save: false` |
| `await delete({ save = true })` | Deletes the stored file, clears the field (and image dimensions), saves the model |
| `toJSON()` / `String(file)` | **The stored name**, not the URL (`null` / `''` when empty) |
| `storage`, `instance`, `field` | |
| `width`, `height`, `await dimensions()` | `ImageFieldFile` only |

Assigning files:

```ts
import { ContentFile, upload } from '@ghuri/storage'

post.cover = upload(file)                     // a File; or upload(bytes, 'cover.png') for unnamed content
await post.save()                             // uploads pending files first, then INSERT / UPDATE

post.cover = 'covers/existing.png'            // a name already in the storage
post.cover = null                             // clear the field (the stored file is kept)
await post.cover.save('cover.png', new ContentFile(bytes))   // Django style; saves the model too
```

Pending files are uploaded by `instance.save()` and `Model.objects.create()`, respecting
`save({ updateFields })`.

## Serving media

```ts title="src/urls.ts"
import { path } from '@ghuri/core'
import { mediaPatterns, serveMedia } from '@ghuri/storage'

export const urlpatterns = [
  path('media/<path:name>', serveMedia()),             // the default storage
  // or: ...mediaPatterns('media/'),
  path('private-media/<path:name>', serveMedia({ storage: 'private', cacheControl: 'private, max-age=60' })),
]
```

| Option | Default | |
|---|---|---|
| `storage` | `'default'` | Alias, `Storage` or config |
| `param` | `'name'` | Route parameter holding the file name |
| `cacheControl` | `'public, max-age=3600'` | `Cache-Control` of responses |
| `download` | `false` | Add `Content-Disposition: attachment` |

`serveMedia()` handles:

- `ETag` / `If-None-Match` and `Last-Modified` / `If-Modified-Since`, answering `304`
- single `Range` requests (`206` with `Content-Range`, `416` when unsatisfiable, `If-Range`);
  multi-range requests get the whole file
- `HEAD`, `405` for other methods, `404` for missing files and `..` traversal
- `X-Content-Type-Options: nosniff`, plus `Content-Security-Policy: sandbox` for HTML, SVG and
  XML, so uploaded documents cannot run script on your origin

**In development**, serve media through the app: leave `publicUrl` unset, keep
`MEDIA_URL: '/media/'` and mount `serveMedia()` (or `mediaPatterns()`). With `wrangler dev` the R2
binding points at a local bucket; with `memoryStorage()` the files vanish on restart.

**In production** on Workers, `serveMedia()` is a good way to serve a private R2 bucket (wrap the
view to add authentication). For public files, set `publicUrl` and skip the view. On a VPS, let
nginx serve `location` directly.

## Presigned URLs and direct uploads

```ts
const storage = storages.get('private')                          // an s3() storage
await storage.presignedUrl('invoices/42.pdf', { expiresIn: 300 })               // GET, 5 minutes
await storage.presignedUrl('invoices/42.pdf', { download: 'Invoice 42.pdf' })   // force a download name
await storage.presignedUrl(`uploads/${crypto.randomUUID()}.jpg`, { method: 'PUT', expiresIn: 600 })
await post.attachment.presignedUrl({ expiresIn: 60 })
```

| Option | Default | |
|---|---|---|
| `expiresIn` | `3600` | Seconds, 1 to 604800 |
| `method` | `'GET'` | `'GET'`, `'PUT'`, `'HEAD'` or `'DELETE'` |
| `download` | unset | Force a download name (`response-content-disposition`, GET only) |
| `responseContentType` | unset | Override the response `Content-Type` (GET only) |

`PUT` URLs let browsers upload straight to S3, R2 or MinIO, bypassing the Workers request-size
limit (configure the bucket's CORS). Afterwards assign the key: `post.attachment = key`.

## Moving from R2 to S3 (or a disk)

The database stores only names, so moving is: copy the objects, then change `STORAGES`.

1. Copy the bucket with `rclone sync r2:my-app-media s3:my-app-media`, or with Ghuri, keeping
   the old backend under another alias:

   ```ts
   const from = storages.get('old'), to = storages.get('default')
   async function copy(dir = '') {
     const { dirs, files } = await from.listdir(dir)
     for (const f of files) {
       const name = dir ? `${dir}/${f}` : f
       const file = (await from.open(name))!
       await to.save(name, await file.blob(), { overwrite: true, contentType: file.contentType })
     }
     for (const d of dirs) await copy(dir ? `${dir}/${d}` : d)
   }
   ```

2. Switch settings to `STORAGES: { default: s3({...}) }` (or `fileSystemStorage({...})` from
   `@ghuri/storage/fs` on Node).
3. If URLs were public, point the CDN or `publicUrl` at the new bucket.
