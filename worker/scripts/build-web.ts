// Builds the web app into dist/public, the Worker's static-assets directory.
// URL layout matches backend/: "/" is the app shell, "/web/<asset>" the bundle
// and icons, plus the Apple app-site-association file.
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = join(root, "..", "backend", "web");
const icons = join(root, "..", "mobile", "assets", "images");
const out = join(root, "dist", "public");

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "web"), { recursive: true });
await mkdir(join(out, ".well-known"), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(source, "app.tsx")],
  outdir: join(out, "web"),
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) throw new AggregateError(result.logs, "Web build failed");

await copyFile(join(source, "index.html"), join(out, "index.html"));
await copyFile(join(source, "manifest.webmanifest"), join(out, "web", "manifest.webmanifest"));
for (const name of ["icon.png", "favicon.png"]) {
  await copyFile(join(icons, name), join(out, "web", name));
}

// Previously served by caloric.mati.lol's worker; keeps password autofill
// associated with the iOS app.
await writeFile(
  join(out, ".well-known", "apple-app-site-association"),
  JSON.stringify({ applinks: {}, webcredentials: { apps: ["BQ7842UUHJ.lol.mati.caloric"] }, appclips: {} }),
);

await writeFile(
  join(out, "_headers"),
  `/
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin

/index.html
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin

/web/*
  Cache-Control: no-cache
  X-Content-Type-Options: nosniff

/.well-known/apple-app-site-association
  Content-Type: application/json
`,
);

console.log(`Built Caloric web (${result.outputs.length} bundles) into dist/public.`);
