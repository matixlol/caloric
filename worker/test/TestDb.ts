import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Db } from "../src/db/Db.ts";

const migrationsDir = join(import.meta.dir, "..", "drizzle");

const migrationStatements = () =>
  readdirSync(migrationsDir)
    .sort()
    .flatMap((dir) => readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8").split("--> statement-breakpoint"))
    .map((statement) => statement.trim())
    .filter(Boolean);

// An in-memory SQLite database with the D1 migrations applied, exposed as the
// app's `Db` service. Query builders behave the same on bun:sqlite as on D1.
export const TestDb = Layer.effect(
  Db,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of migrationStatements()) {
      yield* sql.unsafe(statement);
    }
    const db = yield* SQLiteBunDrizzle.makeWithDefaults();
    return db as unknown as Db["Service"];
  }).pipe(Effect.orDie),
).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })));
