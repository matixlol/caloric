import { describe, expect, it } from "bun:test";
import {
  buildRecentLogContextPrompt,
  buildRecentLogTranscriptionPrompt,
  parseRecentLogHints,
} from "./ai-log-context";

describe("ai-log-context", () => {
  it("adds recent food context and explicit noisy transcript guidance", () => {
    const recentLogs = parseRecentLogHints([
      {
        foodName: "Banana",
        meal: "breakfast",
        dateKey: "2026-02-22",
        createdAt: 1700000000000,
      },
      {
        foodName: "Whey Protein Cookies & Cream",
        brand: "ENA",
        serving: "31 gramos",
        meal: "breakfast",
        dateKey: "2026-02-22",
        createdAt: 1700000001000,
      },
    ]);

    const prompt = buildRecentLogContextPrompt(recentLogs);

    expect(prompt).not.toBeNull();
    expect(prompt ?? "").toContain("last 3 days");
    expect(prompt ?? "").toContain("laga banana");
    expect(prompt ?? "").toContain("anana protein scoop");
    expect(prompt ?? "").toContain("ENA protein scoop");
    expect(prompt ?? "").toContain("Banana");
    expect(prompt ?? "").toContain("Whey Protein Cookies & Cream");
    expect(prompt ?? "").toContain("ENA");
  });

  it("builds a compact glossary-style transcription prompt", () => {
    const recentLogs = parseRecentLogHints([
      {
        foodName: "Banana",
        meal: "breakfast",
        dateKey: "2026-02-22",
        createdAt: 1700000000000,
      },
      {
        foodName: "Whey Protein Cookies & Cream",
        brand: "ENA",
        serving: "31 gramos",
        meal: "breakfast",
        dateKey: "2026-02-22",
        createdAt: 1700000001000,
      },
    ]);

    const prompt = buildRecentLogTranscriptionPrompt(recentLogs);

    expect(prompt).toBe("Food log. ENA Whey Protein Cookies & Cream. Banana. ENA.");
  });
});
