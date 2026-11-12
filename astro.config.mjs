// @ts-check
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

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
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { slug: 'getting-started/introduction' },
            { slug: 'getting-started/installation' },
            { slug: 'getting-started/project-layout' },
            { slug: 'django-developers' },
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
            { slug: 'topics/signals' },
            { slug: 'topics/background-tasks' },
            { slug: 'topics/management-commands' },
            { slug: 'topics/testing' },
            {
              label: 'AI agents',
              items: [{ slug: 'topics/agents' }, { slug: 'topics/agents-mcp' }],
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
