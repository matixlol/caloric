// Compares read-only responses from backend/ and the Worker for one signed-in
// user. Both must serve the same data (e.g. after import-postgres.ts) and share
// BETTER_AUTH_SECRET, so the same session cookie authenticates against both.
//
//   bun scripts/contract-check.ts --old <url> --new <url> --cookie '<name=value>'
//     [--date 2026-10-21] [--search apple]
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    old: { type: "string" },
    new: { type: "string" },
    cookie: { type: "string" },
    date: { type: "string" },
    search: { type: "string" },
  },
});
if (!args.old || !args.new || !args.cookie) throw new Error("--old, --new and --cookie are required");

const get = async (base: string, path: string) => {
  const response = await fetch(new URL(path, base), { headers: { Cookie: args.cookie!, Accept: "application/json" } });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body };
};

// Error bodies gained a `_tag` field in the Worker; clients ignore it. Rows
// with ids are compared as sets: backend/ didn't order ties deterministically.
const hasId = (value: unknown): value is { id: string } =>
  Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.every(hasId) ? [...value].sort((a, b) => a.id.localeCompare(b.id)) : value;
    return items.map(normalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "_tag")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
};

const firstDifference = (a: unknown, b: unknown, path = "$"): string | undefined => {
  if (JSON.stringify(a) === JSON.stringify(b)) return undefined;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const difference = firstDifference(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (difference) return difference;
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 200)} !== ${JSON.stringify(b)?.slice(0, 200)}`;
};

const overview = await get(args.old, "/social/me");
const friend = (overview.body as { friends?: Array<{ userId: string }> }).friends?.[0]?.userId;
const date = args.date ?? new Date().toISOString().slice(0, 10);

const paths = [
  "/health",
  "/api/auth/get-session",
  "/sync/bootstrap",
  "/social/me",
  `/social/daily-summaries?dateKey=${date}`,
  ...(friend ? [`/social/friends/${encodeURIComponent(friend)}/day?dateKey=${date}`] : []),
  "/social/daily-summaries?dateKey=not-a-date",
  "/sync/bootstrap?unused=1",
  ...(args.search ? [`/search?query=${encodeURIComponent(args.search)}&source=openfoodfacts`] : []),
];

let failures = 0;
for (const path of paths) {
  const [before, after] = await Promise.all([get(args.old, path), get(args.new, path)]);
  const difference =
    before.status !== after.status
      ? `status ${before.status} !== ${after.status}`
      : firstDifference(normalize(before.body), normalize(after.body));
  if (difference) failures += 1;
  console.log(`${difference ? "DIFF" : "same"}  ${path}${difference ? `\n      ${difference}` : ""}`);
}
console.log(failures === 0 ? "\nAll responses match." : `\n${failures} endpoint(s) differ.`);
process.exit(failures === 0 ? 0 : 1);
