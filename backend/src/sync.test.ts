import { describe, expect, it } from "bun:test";
import { lte, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { userSettings } from "./db/schema";
import { parseSyncPushBody, shouldApplyIncomingWrite } from "./sync";

describe("sync", () => {
  it("accepts valid sync push payloads with tombstones", () => {
    const payload = parseSyncPushBody({
      foodEntries: [
        {
          id: "entry-1",
          data: {
            meal: "lunch",
            foodName: "Chicken Breast",
            portion: 1,
            createdAt: 1700000000000,
            dateKey: "2026-04-18",
            sortIndex: 3,
          },
          updatedAt: 1700000001000,
          deletedAt: 1700000002000,
        },
      ],
      recipes: [{ id: "recipe-1", data: { name: "Bowl", createdAt: 1700000000000, items: [{ id: "recipe_item-1", foodName: "Rice", portion: 0.5, nutrition: { calories: 200 } }] }, updatedAt: 1700000002500 }],
      settings: {
        id: "settings",
        data: {
          calorieGoal: 2500,
          macroProteinPct: 30,
          macroCarbsPct: 50,
          macroFatPct: 20,
        },
        updatedAt: 1700000003000,
      },
    });

    expect(payload.foodEntries).toHaveLength(1);
    expect(payload.recipes).toHaveLength(1);
    expect(payload.foodEntries[0]?.deletedAt).toBe(1700000002000);
    expect(payload.settings?.id).toBe("settings");
  });

  it("rejects stale writes when the stored row is newer", () => {
    expect(shouldApplyIncomingWrite(new Date("2026-04-18T12:00:00.000Z"), Date.parse("2026-04-18T11:59:59.000Z"))).toBe(
      false,
    );
  });

  it("accepts writes with equal or newer timestamps", () => {
    const timestamp = Date.parse("2026-04-18T12:00:00.000Z");

    expect(shouldApplyIncomingWrite(timestamp, timestamp)).toBe(true);
    expect(shouldApplyIncomingWrite(timestamp, timestamp + 1)).toBe(true);
    expect(shouldApplyIncomingWrite(null, timestamp)).toBe(true);
  });

  it("encodes timestamp guards with the column encoder", () => {
    const dialect = new PgDialect();
    const timestamp = new Date("2026-04-18T19:02:59.228Z");

    const rawGuard = dialect.sqlToQuery(sql`${userSettings.updatedAt} <= ${timestamp}`);
    const typedGuard = dialect.sqlToQuery(lte(userSettings.updatedAt, timestamp));

    expect(rawGuard.params[0]).toBe(timestamp);
    expect(typedGuard.params[0]).toBe(timestamp.toISOString());
  });

  it("bootstrap maps food and recipe query results to the correct collections", async () => {
    // Isolate module mocks so database/auth substitutions cannot leak into other
    // tests. This executes the real handler without opening a database connection.
    const child = Bun.spawn([process.execPath, "-e", `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      import { userFoodEntries, userRecipes, userSettings } from "./db/schema.ts";
      const food = { id: "food-1", data: { foodName: "Rice", meal: "lunch" }, updatedAt: new Date(1234) };
      const recipe = { id: "recipe-1", data: { name: "Bowl", items: [] }, updatedAt: new Date(5678) };
      const settings = { data: { calorieGoal: 2370 }, updatedAt: new Date(9012) };
      const rows = new Map([[userFoodEntries, [food]], [userRecipes, [recipe]], [userSettings, [settings]]]);
      mock.module("./db/index.ts", () => ({ db: {
        select: () => ({ from: (table) => ({ where: () => ({
          orderBy: async () => rows.get(table), limit: async () => rows.get(table)
        }) }) })
      } }));
      mock.module("./auth.ts", () => ({ authenticateUserRequest: async () => ({ userId: "test-user" }) }));
      const { handleSyncBootstrapRequest } = await import("./services/sync.ts");
      const response = await handleSyncBootstrapRequest(new Request("http://localhost/sync/bootstrap"));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        foodEntries: [{ id: food.id, data: food.data, updatedAt: 1234 }],
        recipes: [{ id: recipe.id, data: recipe.data, updatedAt: 5678 }],
        settings: { id: "settings", data: settings.data, updatedAt: 9012 }
      });
      console.log("Bootstrap mapping passed without database or auth connections.");
    `], {
      cwd: new URL("./", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(output).toContain("Bootstrap mapping passed");
  });
});
