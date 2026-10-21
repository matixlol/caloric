import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { isProduction } from "../Stage.ts";

// The app's D1 database. Paths are relative to worker/, where alchemy runs.
// Production's database survives `alchemy destroy`.
export const Database = Cloudflare.D1.Database("Database", {
  migrations: "./drizzle",
}).pipe(RemovalPolicy.retain(isProduction));
