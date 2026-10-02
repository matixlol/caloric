import { Hono } from "hono";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../../dist/web/", import.meta.url));
const assets = new Set([
  "app.js",
  "app.css",
  "icon.png",
  "favicon.png",
  "manifest.webmanifest",
]);

// An explicit allowlist keeps backend sources and secrets out of static serving.
export function createWebRoutes() {
  const routes = new Hono();
  // Preserve the association previously served by caloric.mati.lol's worker.
  routes.get("/.well-known/apple-app-site-association", (c) =>
    c.json({
      applinks: {},
      webcredentials: { apps: ["BQ7842UUHJ.lol.mati.caloric"] },
      appclips: {},
    }),
  );
  routes.get("/web/:asset", async (c) => {
    const name = c.req.param("asset");
    if (!assets.has(name)) return c.notFound();
    const file = Bun.file(`${directory}${name}`);
    if (!(await file.exists())) return c.notFound();
    return new Response(file, {
      headers: {
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  routes.get("/", async (c) => {
    const file = Bun.file(`${directory}index.html`);
    if (!(await file.exists()))
      return c.text("Run bun run web:build to build the web app.", 503);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    return c.html(await file.text());
  });
  return routes;
}
