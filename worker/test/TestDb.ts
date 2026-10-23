import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BatchDb, Db, DbBatch, DbBatchError } from "../src/db/Db.ts";

const migrationsDir = join(import.meta.dir, "..", "drizzle");

const migrationStatements = () =>
  readdirSync(migrationsDir)
    .sort()
    .flatMap((dir) => readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8").split("--> statement-breakpoint"))
    .map((statement) => statement.trim())
    .filter(Boolean);

// A throwaway SQLite file with the D1 migrations applied, exposed as the app's
// `Db` and `DbBatch` services. Query builders behave the same on bun:sqlite as
// on D1. Batches run their statements in order inside a transaction, as D1 does.
export const TestDb = Layer.unwrap(
  Effect.gen(function* () {
    const filename = join(tmpdir(), `caloric-test-${crypto.randomUUID()}.sqlite`);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
      }),
    );

    const db = Layer.effect(
      Db,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const statement of migrationStatements()) {
          yield* sql.unsafe(statement);
        }
        const db = yield* SQLiteBunDrizzle.makeWithDefaults();
        return db as unknown as Db["Service"];
      }).pipe(Effect.orDie),
    );

    const batch = Layer.effect(
      DbBatch,
      Effect.acquireRelease(
        Effect.sync(() => new Database(filename)),
        (sqlite) => Effect.sync(() => sqlite.close()),
      ).pipe(
        Effect.map((sqlite) => {
          const batchDb = drizzle({ client: sqlite }) as unknown as BatchDb;
          return DbBatch.of({
            run: (build) =>
              Effect.tryPromise({
                try: async () => {
                  const queries = build(batchDb);
                  sqlite.run("BEGIN");
                  try {
                    const results: Array<unknown> = [];
                    for (const query of queries) results.push(await query);
                    sqlite.run("COMMIT");
                    return results as never;
                  } catch (error) {
                    sqlite.run("ROLLBACK");
                    throw error;
                  }
                },
                catch: (cause) => new DbBatchError({ cause }),
              }),
          });
        }),
      ),
    );

    // The batch connection opens after migrations have created the schema.
    return Layer.provideMerge(batch, db).pipe(Layer.provide(SqliteClient.layer({ filename })));
  }),
);
