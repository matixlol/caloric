import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
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

export class DbBatchError extends Data.TaggedError("DbBatchError")<{ readonly cause: unknown }> {}

// Query builders for a batch. They are plain (promise) Drizzle builders: the
// batch runs them, so they are never awaited or yielded themselves.
export type BatchDb = DrizzleD1Database;

export type Batch = readonly [BatchItem<"sqlite">, ...Array<BatchItem<"sqlite">>];

// Every D1 query is a network round trip to the database's primary (Miami)
// from wherever the Worker runs (the edge, usually Buenos Aires: ~145ms).
// Queries that don't depend on each other run concurrently (`Effect.all`); a
// batch sends statements that must run in order, such as a write and the
// reads that show its result, as one round trip. D1 runs a batch as a single
// transaction.
export class DbBatch extends Context.Service<
  DbBatch,
  {
    readonly run: <T extends Batch>(build: (db: BatchDb) => T) => Effect.Effect<BatchResponse<T>, DbBatchError>;
  }
>()("caloric/db/DbBatch") {
  static readonly layer = Layer.effect(
    DbBatch,
    Effect.gen(function* () {
      const database = yield* Database;
      const d1 = yield* Cloudflare.D1.QueryDatabase(database);
      return DbBatch.of({
        run: (build) =>
          Effect.flatMap(d1.raw, (raw) => {
            const db = drizzle(raw as never);
            return Effect.tryPromise({
              try: () => db.batch(build(db)),
              catch: (cause) => new DbBatchError({ cause }),
            });
          }).pipe(withRuntime),
      });
    }),
  );
}
