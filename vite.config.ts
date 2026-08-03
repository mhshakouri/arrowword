import { defineConfig } from "vite";

/* The UI is a single page app served as static assets by the same worker that
   serves the API, which is what keeps everything same-origin and CORS-free.
   See docs/SPEC.md ADR-10 and section 2. */
export default defineConfig({
  root: "src/ui",
  /* Preact through esbuild's JSX options rather than @preact/preset-vite, which
     would be a second dependency for a two-line setting. See ADR-10. */
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: {
    /* Relative to `root`, so this lands at ./dist in the repository, which is
       what the assets binding in wrangler.jsonc points at. */
    outDir: "../../dist",
    emptyOutDir: true,
    /* Section 16 budgets the play page as interactive within 3 seconds on a
       mid-range phone over 4G, so a warning here is worth reading rather than
       raising. */
    chunkSizeWarningLimit: 200,
  },
  server: {
    /* `npm run dev:ui` serves the UI while `npm run dev` serves the worker on
       8787. Proxying the API means the dev UI talks to a real Durable Object
       rather than a mock, and keeps paths identical to production. */
    proxy: {
      "/session": { target: "http://localhost:8787", ws: true },
      "/generate": { target: "http://localhost:8787" },
      "/auth": { target: "http://localhost:8787" },
    },
  },
});
