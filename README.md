# Ghuri docs

Documentation site for [Ghuri](https://github.com/ghurijs/ghuri), built with
[Astro Starlight](https://starlight.astro.build). Published at
<https://ghurijs.github.io/docs/>.

```sh
npm install
npm run dev      # http://localhost:4321/docs/
npm run build    # static site in dist/
```

Pages live in `src/content/docs/`; the sidebar is defined in `astro.config.mjs`.
Pushes to `main` deploy to GitHub Pages via `.github/workflows/deploy.yml`.
