import * as Cloudflare from "alchemy/Cloudflare";

// The app's D1 database. Paths are relative to worker/, where alchemy runs.
export const Database = Cloudflare.D1.Database("Database", {
  migrations: "./drizzle",
});
