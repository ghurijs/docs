---
title: Docker
description: A multi-stage Dockerfile for a Ghuri project, docker compose with Postgres and MinIO, and running migrations on release.
---

Containers are the most portable way to run the Node build of a Ghuri project: the same image
runs on Fly.io, Railway, Render, ECS, Kubernetes or a single VPS with docker compose. Read
[Node and Postgres on a VPS](/docs/deployment/node-postgres/) first; this page assumes the
environment-driven settings and the `build:node` script described there.

## Dockerfile

A three-stage build: install all dependencies and compile, install production dependencies
only, then copy both into a slim runtime image.

```dockerfile title="Dockerfile"
# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:node

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8000
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The ghuri CLI loads TypeScript sources, so keep them for `migrate` and friends.
COPY package.json tsconfig.json ./
COPY src ./src
USER node
EXPOSE 8000
CMD ["node", "dist/server.js"]
```

Three details matter:

- **`src/` is copied into the runtime image.** The server runs the compiled `dist/server.js`,
  but `ghuri migrate` and other management commands load your settings and migrations from
  TypeScript with jiti. Without `src/` you cannot run them inside the container.
- **`@ghuri/cli` must be a production dependency** for the same reason. The generated
  `package.json` lists it under `devDependencies`, so move it (`npm install @ghuri/cli@next`
  moves it to `dependencies`). `jiti` is already a dependency. If you would rather keep the image
  minimal, run migrations from CI or a separate "release" image built from the `build` stage.
- **`wrangler.jsonc` is not copied.** Without it the CLI builds `env` from `process.env`
  alone, which is what you want in a container.

If you skip the build step, drop the `build` stage and the `dist` copy and start the server
the way `npm start` does: `CMD ["node", "--import", "jiti/register", "src/server.ts"]`.

Add a `.dockerignore` so local state does not end up in the image:

```text title=".dockerignore"
node_modules
dist
.wrangler
.dev.vars
.env
.git
media
*.sqlite3
```

## docker compose for local production-like runs

This compose file runs the app with Postgres and [MinIO](https://min.io) as an S3-compatible
store, which is close to a typical self-hosted production setup.

```yaml title="compose.yaml"
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_DB: mysite
      POSTGRES_USER: mysite
      POSTGRES_PASSWORD: mysite
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mysite"]
      interval: 2s
      retries: 30

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio-secret
    ports: ["9000:9000", "9001:9001"]
    volumes: [media:/data]

  migrate:
    build: .
    command: ["npx", "ghuri", "migrate"]
    env_file: .env.docker
    depends_on:
      db: { condition: service_healthy }

  web:
    build: .
    env_file: .env.docker
    ports: ["8000:8000"]
    depends_on:
      migrate: { condition: service_completed_successfully }
      minio: { condition: service_started }

volumes:
  pgdata:
  media:
```

```ini title=".env.docker"
SECRET_KEY=dev-only-not-secret
DEBUG=false
ALLOWED_HOSTS=localhost,127.0.0.1
DATABASE_URL=postgres://mysite:mysite@db:5432/mysite
S3_ENDPOINT=http://minio:9000
S3_BUCKET=mysite-media
S3_ACCESS_KEY_ID=minio
S3_SECRET_ACCESS_KEY=minio-secret
S3_REGION=us-east-1
MEDIA_PUBLIC_URL=http://localhost:9000/mysite-media
```

Create the bucket once (in the MinIO console at `http://localhost:9001`, or with `mc mb`), then:

```sh
docker compose up --build
docker compose run --rm web npx ghuri createsuperuser
```

## Running migrations on release

Never run `ghuri migrate` from the web container's `CMD`. When several replicas start at once
they race to apply the same migration. Run it exactly once per release instead:

| Platform | Where migrations go |
|---|---|
| docker compose | a one-shot `migrate` service the web service depends on (above) |
| Fly.io | `[deploy] release_command = "npx ghuri migrate"` in `fly.toml` |
| Render | "Pre-Deploy Command": `npx ghuri migrate` |
| Kubernetes | a `Job` (or Helm pre-upgrade hook) running `npx ghuri migrate` |
| CI | a step before the rollout, with the production `DATABASE_URL` |

As on any platform, ship backwards-compatible migrations: add columns as nullable or with a
default first, deploy, and only then remove what the old code needed.

:::tip[If you know Django]
This is the same pattern as running `python manage.py migrate` in a release phase. There is no
`collectstatic` step: admin assets are embedded in `@ghuri/admin`, and user uploads go to S3,
MinIO or R2 through `STORAGES`.
:::

## Health checks

Add a cheap view and point your orchestrator at it:

```ts title="src/urls.ts"
path('healthz/', (c) => c.text('ok'), { name: 'healthz' }),
```

If you want the check to fail when the database is unreachable, run a trivial query:

```ts
import { connections } from '@ghuri/orm'

path('healthz/', async (c) => {
  const conn = await connections.get()
  await conn.execute('SELECT 1')
  return c.text('ok')
}),
```

## See also

- [Node and Postgres on a VPS](/docs/deployment/node-postgres/)
- [Migrating from D1 to Postgres](/docs/deployment/d1-to-postgres/)
