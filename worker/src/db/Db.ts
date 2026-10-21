import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Database } from "./Database.ts";

const make = Effect.gen(function* () {
  const database = yield* Database;
  const d1 = yield* Cloudflare.D1.QueryDatabase(database);
  return yield* Drizzle.D1(d1);
});

// Drizzle over the Worker's D1 binding. Queries are Effects.
// D1 queries read the binding from Alchemy's per-request RuntimeContext. HttpApi
// handlers can't declare it, so repositories mark it satisfied at the type level;
// the Worker provides the real context to every request at runtime.
export const withRuntime = Effect.provide(RuntimeContext.phantom);

export class Db extends Context.Service<Db, Effect.Success<typeof make>>()("caloric/db/Db") {
  static readonly layer = Layer.effect(Db, make);
}
