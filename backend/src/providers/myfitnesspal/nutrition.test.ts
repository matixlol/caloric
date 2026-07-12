import { describe, expect, it } from "bun:test";
import { getMfpNetCarbs } from "./nutrition";

describe("MFP nutrition", () => {
  it("prefers explicit net carbs", () => {
    expect(getMfpNetCarbs(23, 8, 15)).toBe(15);
  });

  it("derives net carbs when MFP only provides totals", () => {
    expect(getMfpNetCarbs(23, 8)).toBe(15);
    expect(getMfpNetCarbs(9, undefined)).toBe(9);
  });
});
