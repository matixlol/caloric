import { describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { runAssistantLoop } from "./ai-agent";
import type { AiSessionState } from "./ai-store";
import type { AgentEvent } from "./ai-turns";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Step = { text?: string; tool?: { name: string; input: unknown } };

function scriptedModel(steps: Step[]) {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      const step = steps[prompts.length - 1] ?? { text: "done" };
      const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
      if (step.text) {
        chunks.push({ type: "text-start", id: "t" });
        for (const part of step.text.match(/.{1,5}/gs) ?? []) chunks.push({ type: "text-delta", id: "t", delta: part });
        chunks.push({ type: "text-end", id: "t" });
      }
      if (step.tool) {
        chunks.push({ type: "tool-call", toolCallId: `call-${prompts.length}`, toolName: step.tool.name, input: JSON.stringify(step.tool.input) });
      }
      chunks.push({ type: "finish", finishReason: { unified: step.tool ? "tool-calls" : "stop", raw: undefined }, usage });
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
  return { model, prompts };
}

function session(): AiSessionState {
  return {
    id: "s",
    userId: "u",
    variant: "next",
    conversation: [{ role: "user", content: "a banana" }],
    searchResultCounter: 1,
    searchResultsByLocalId: {},
    pendingApprovals: {},
  };
}

const search = async () => [{ id: "f1", name: "Banana", serving: "1 medium", nutrition: { calories: 105 } }] as never[];

describe("runAssistantLoop parallel search", () => {
  test("runs a step's searches concurrently and keeps result IDs in call order", async () => {
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const first = prompt.filter((m) => m.role === "tool").length === 0;
        const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
        if (first) {
          chunks.push({ type: "tool-call", toolCallId: "a", toolName: "searchFoods", input: JSON.stringify({ query: "slow apple" }) });
          chunks.push({ type: "tool-call", toolCallId: "b", toolName: "searchFoods", input: JSON.stringify({ query: "fast bread" }) });
        } else {
          chunks.push({
            type: "tool-call",
            toolCallId: "c",
            toolName: "requestFoodApprovals",
            input: JSON.stringify({ suggestions: [{ resultId: "r2", meal: "lunch", portion: 1, reason: "bread" }] }),
          });
        }
        chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage });
        return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
      },
    });
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const search = async (query: string) => {
      started.push(query);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await Bun.sleep(query.startsWith("slow") ? 40 : 5);
      inFlight--;
      return [{ id: query, name: query.split(" ")[1]! }] as never[];
    };
    const events: AgentEvent[] = [];
    await runAssistantLoop(session(), { assistant: { id: "mock", model }, search, parallelSearch: true, onEvent: (e) => events.push(e) });

    expect(maxInFlight).toBe(2);
    expect(events.filter((e) => e.kind === "search").map((e) => (e as { query: string }).query)).toEqual(["slow apple", "fast bread"]);
    expect(events.at(-1)).toMatchObject({ kind: "approval", suggestions: [{ resultId: "r2", food: { name: "bread" } }] });
  });
});

describe("runAssistantLoop repair", () => {
  test("retries when a tool call is printed as text and never streams the leak", async () => {
    const { model, prompts } = scriptedModel([
      { text: "call:default_api:searchFoods{query:banana}" },
      { tool: { name: "searchFoods", input: { query: "banana" } } },
      { tool: { name: "requestFoodApprovals", input: { suggestions: [{ resultId: "r1", meal: "snacks", portion: 1, reason: "one banana" }] } } },
    ]);
    const events: AgentEvent[] = [];
    const state = session();
    await runAssistantLoop(state, { assistant: { id: "mock", model }, search, repair: true, onEvent: (e) => events.push(e) });

    expect(prompts).toHaveLength(3);
    expect(JSON.stringify(prompts[1])).toContain("Automatic note from the app");
    expect(events.some((e) => (e.kind === "assistant" || e.kind === "assistant-delta") && e.text.includes("default_api"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "approval", suggestions: [{ meal: "snacks", portion: 1 }] });
    // The nudge is transient and the leaked reply is dropped from the stored history.
    expect(JSON.stringify(state.conversation)).not.toContain("default_api");
    expect(JSON.stringify(state.conversation)).not.toContain("Automatic note");
  });

  test("retries a silent stop after searching, at most twice", async () => {
    const { model, prompts } = scriptedModel([{ tool: { name: "searchFoods", input: { query: "banana" } } }, {}, {}, {}]);
    await runAssistantLoop(session(), { assistant: { id: "mock", model }, search, repair: true });
    expect(prompts).toHaveLength(4);
  });

  test("streams normal text unchanged and keeps classic behaviour without repair", async () => {
    const { model, prompts } = scriptedModel([{ text: "What size was the banana you ate today?" }]);
    const events: AgentEvent[] = [];
    await runAssistantLoop(session(), { assistant: { id: "mock", model }, search, repair: true, onEvent: (e) => events.push(e) });
    expect(prompts).toHaveLength(1);
    expect(events.filter((e) => e.kind === "assistant-delta").map((e) => (e as { text: string }).text).join("")).toBe("What size was the banana you ate today?");

    const classic = scriptedModel([{ text: "call:default_api:searchFoods{query:banana}" }]);
    const classicEvents: AgentEvent[] = [];
    await runAssistantLoop(session(), { assistant: { id: "mock", model: classic.model }, search, onEvent: (e) => classicEvents.push(e) });
    expect(classic.prompts).toHaveLength(1);
    expect(classicEvents.at(-1)).toMatchObject({ kind: "assistant", text: "call:default_api:searchFoods{query:banana}" });
  });
});
