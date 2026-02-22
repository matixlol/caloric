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
        brand: "Ena",
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
    expect(prompt ?? "").toContain("ena protein scoop");
    expect(prompt ?? "").toContain("Banana");
    expect(prompt ?? "").toContain("Whey Protein Cookies & Cream");
    expect(prompt ?? "").toContain("Ena");
  });

  it("builds a short transcription prompt with likely phrases and recent names", () => {
    const recentLogs = parseRecentLogHints([
      {
        foodName: "Banana",
        meal: "breakfast",
        dateKey: "2026-02-22",
        createdAt: 1700000000000,
      },
      {
        foodName: "Whey Protein Cookies & Cream",
        brand: "Ena",
        serving: "31 gramos",
        meal: "breakfast",
        dateKey: "2026-02-22",
        createdAt: 1700000001000,
      },
    ]);

    const prompt = buildRecentLogTranscriptionPrompt(recentLogs);

    expect(prompt).not.toBeNull();
    expect(prompt ?? "").toContain("Food logging voice note");
    expect(prompt ?? "").toContain("Preserve brand names when possible");
    expect(prompt ?? "").toContain("log banana");
    expect(prompt ?? "").toContain("whey protein cookies and cream");
    expect(prompt ?? "").toContain("Ena Whey Protein Cookies & Cream");
    expect(prompt ?? "").toContain("Banana");
  });
});
