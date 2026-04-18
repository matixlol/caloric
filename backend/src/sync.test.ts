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
});
