import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(`${root}dist/web`, { recursive: true });
const result = await Bun.build({
  entrypoints: [`${root}web/app.tsx`],
  outdir: `${root}dist/web`,
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) throw new AggregateError(result.logs, "Web build failed");
for (const name of ["index.html", "manifest.webmanifest"]) {
  await copyFile(`${root}web/${name}`, `${root}dist/web/${name}`);
}
for (const name of ["icon.png", "favicon.png"]) {
  await copyFile(
    `${root}../mobile/assets/images/${name}`,
    `${root}dist/web/${name}`,
  );
}
console.log(`Built Caloric web (${result.outputs.length} bundles).`);
