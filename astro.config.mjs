// @ts-check
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightLlmsTxt from 'starlight-llms-txt'

export default defineConfig({
  site: 'https://ghurijs.github.io',
  base: '/docs',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Ghuri',
      description:
        'Django for TypeScript. Start on Cloudflare Workers with D1 and R2, move to Postgres on any VPS by changing settings.',
      logo: { light: './src/assets/logo-light.svg', dark: './src/assets/logo-dark.svg', alt: 'Ghuri', replacesTitle: true },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/ghurijs' }],
      editLink: { baseUrl: 'https://github.com/ghurijs/docs/edit/main/' },
      lastUpdated: true,
      customCss: ['./src/styles/custom.css'],
      plugins: [
        starlightLlmsTxt({
          projectName: 'Ghuri',
          description:
            'Ghuri is a Django-style web framework for TypeScript, built on Hono and Drizzle, that runs on Cloudflare Workers (D1, R2, KV) by default and on Node with Postgres by changing settings.',
          details: [
            'Important notes for language models:',
            '',
            '- Ghuri is TypeScript, not Python. Never write Python, `manage.py`, decorators or `snake_case` method names in a Ghuri project. Commands are `npx ghuri <command>` (`makemigrations`, `migrate`, `startapp`, `createsuperuser`, `shell`, `test`).',
            '- The APIs mirror Django and Django REST framework concepts, but options and methods are camelCase: `maxLength`, `orderBy`, `selectRelated`, `valuesList`, `performCreate`. Settings keys stay `UPPER_SNAKE` (`INSTALLED_APPS`, `DATABASES`).',
            "- Keyword arguments become an object and the `__` lookup syntax is unchanged: `Post.objects.filter({ author__username: 'rifat', title__icontains: 'x' }).orderBy('-createdAt')`.",
            '- Anything that touches the database is async: `await` QuerySets, `get()`, `save()`, related objects (`await post.author`) and serializer output.',
            '- Nothing is discovered by name: apps import their own models, migrations and admin modules; `INSTALLED_APPS` holds classes; `settings.ts` exports `defineSettings((env) => ({ ... }))`.',
            '- Packages are scoped under `@ghuri/*` (for example `@ghuri/orm`, `@ghuri/auth`, `@ghuri/rest`, `@ghuri/admin`, `@ghuri/mail`, `@ghuri/tenants`, `@ghuri/agents`).',
            '- Only use features documented here. Do not assume a Django or DRF feature exists in Ghuri because it exists in Django; if it is not in these docs, say so instead of inventing an API.',
          ].join('\n'),
          promote: [
            'index*',
            'getting-started/introduction',
            'getting-started/installation',
            'getting-started/project-layout',
            'django-developers',
            'tutorial/**',
            'topics/settings',
            'topics/applications',
            'topics/urls-and-views',
            'topics/middleware',
            'topics/models',
            'topics/queries',
            'topics/relations',
            'topics/migrations',
            'topics/transactions',
            'topics/admin*',
            'topics/rest',
            'topics/rest/serializers',
            'topics/rest/views',
            'topics/rest/routers',
            'topics/rest/**',
            'topics/**',
            'reference/**',
          ],
          demote: ['deployment/**', 'contributing'],
          exclude: ['contributing'],
          // Starlight's heading anchor links render as "[Section titled …](#…)" noise.
          customSelectors: { all: ['.sl-anchor-link'] },
          customSets: [
            {
              label: 'ORM',
              description: 'models, fields, QuerySets and lookups, relations, migrations and transactions',
              paths: [
                'topics/models',
                'topics/queries',
                'topics/relations',
                'topics/migrations',
                'topics/transactions',
                'reference/fields',
                'reference/lookups',
              ],
            },
            {
              label: 'REST framework',
              description: 'serializers, views and viewsets, routers, permissions, pagination, filtering, throttling and OpenAPI',
              paths: ['topics/rest', 'topics/rest/**'],
            },
            {
              label: 'Admin',
              description: 'registering models with the admin site and the ModelAdmin reference',
              paths: ['topics/admin', 'topics/admin-reference'],
            },
            {
              label: 'Auth',
              description: 'users, groups and permissions, sessions, tokens and JWT, and REST authentication and permission classes',
              paths: [
                'topics/authentication',
                'topics/auth-tokens',
                'topics/rest/authentication',
                'topics/rest/permissions',
              ],
            },
            {
              label: 'Agents',
              description: 'AI agents built from models, viewsets and permissions, and exposing them over MCP',
              paths: ['topics/agents', 'topics/agents-mcp', 'topics/mcp-oauth'],
            },
            {
              label: 'Deployment',
              description: 'deploying to Cloudflare Workers, Node with Postgres and Docker, and migrating from D1 to Postgres',
              paths: ['deployment/**'],
            },
          ],
        }),
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { slug: 'getting-started/introduction' },
            { slug: 'getting-started/installation' },
            { slug: 'getting-started/project-layout' },
            { slug: 'django-developers' },
            { slug: 'topics/ai-assisted-development' },
          ],
        },
        {
          label: 'Tutorial: a blog',
          items: [
            { slug: 'tutorial/part-1-models' },
            { slug: 'tutorial/part-2-migrations' },
            { slug: 'tutorial/part-3-admin' },
            { slug: 'tutorial/part-4-rest-api' },
            { slug: 'tutorial/part-5-deploy' },
          ],
        },
        {
          label: 'Topics',
          items: [
            { slug: 'topics/settings' },
            { slug: 'topics/applications' },
            { slug: 'topics/urls-and-views' },
            { slug: 'topics/middleware' },
            {
              label: 'Models and databases',
              items: [
                { slug: 'topics/models' },
                { slug: 'topics/queries' },
                { slug: 'topics/relations' },
                { slug: 'topics/migrations' },
                { slug: 'topics/transactions' },
              ],
            },
            {
              label: 'Admin',
              items: [{ slug: 'topics/admin' }, { slug: 'topics/admin-reference' }],
            },
            {
              label: 'REST framework',
              items: [
                { slug: 'topics/rest' },
                { slug: 'topics/rest/serializers' },
                { slug: 'topics/rest/views' },
                { slug: 'topics/rest/routers' },
                { slug: 'topics/rest/permissions' },
                { slug: 'topics/rest/authentication' },
                { slug: 'topics/rest/pagination' },
                { slug: 'topics/rest/filtering' },
                { slug: 'topics/rest/throttling' },
                { slug: 'topics/rest/openapi' },
              ],
            },
            { slug: 'topics/graphql' },
            { slug: 'topics/websockets' },
            { slug: 'topics/authentication' },
            { slug: 'topics/auth-tokens' },
            { slug: 'topics/social-login' },
            { slug: 'topics/login-strategies' },
            { slug: 'topics/file-storage' },
            { slug: 'topics/storage-backends' },
            { slug: 'topics/caching' },
            { slug: 'topics/email' },
            { slug: 'topics/multi-tenancy' },
            { slug: 'topics/signals' },
            { slug: 'topics/background-tasks' },
            { slug: 'topics/management-commands' },
            { slug: 'topics/testing' },
            {
              label: 'AI agents',
              items: [{ slug: 'topics/agents' }, { slug: 'topics/agents-mcp' }, { slug: 'topics/mcp-oauth' }],
            },
          ],
        },
        {
          label: 'Deployment',
          items: [
            { slug: 'deployment/cloudflare' },
            { slug: 'deployment/node-postgres' },
            { slug: 'deployment/docker' },
            { slug: 'deployment/d1-to-postgres' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'reference/cli' },
            { slug: 'reference/settings' },
            { slug: 'reference/fields' },
            { slug: 'reference/lookups' },
          ],
        },
        { label: 'Contributing', items: [{ slug: 'contributing' }] },
      ],
    }),
  ],
})
