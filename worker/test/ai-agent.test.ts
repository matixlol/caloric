import { describe, expect, test } from "bun:test";
import * as LanguageModel from "effect/ai/LanguageModel";
import type * as Prompt from "effect/ai/Prompt";
import type * as Response from "effect/ai/Response";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { runAssistantLoop, type SessionState } from "../src/ai/Agent.ts";
import type { AgentEvent } from "../src/ai/Domain.ts";
import { FoodSearch, type FoodSearchResult } from "../src/search/FoodSearch.ts";

type Step = { text?: string; tools?: Array<{ name: string; input: unknown }> };

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };

const stepParts = (step: Step, index: number): Array<Response.StreamPartEncoded> => {
  const parts: Array<Response.StreamPartEncoded> = [];
  if (step.text) {
    parts.push({ type: "text-start", id: "t" });
    for (const delta of step.text.match(/.{1,5}/gs) ?? []) parts.push({ type: "text-delta", id: "t", delta });
    parts.push({ type: "text-end", id: "t" });
  }
  (step.tools ?? []).forEach((tool, i) =>
    parts.push({ type: "tool-call", id: `call-${index}-${i}`, name: tool.name, params: tool.input }),
  );
  parts.push({
    type: "finish",
    reason: step.tools ? "tool-calls" : "stop",
    usage,
    metadata: { openrouter: { usage: { cost: 0.001, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } },
  });
  return parts;
};

// A LanguageModel that answers each call with the next scripted step and
// records the prompts it was sent.
const scriptedModel = (steps: Array<Step> | ((prompt: Prompt.Prompt) => Step)) => {
  const prompts: Array<Prompt.Prompt> = [];
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.die("not used"),
      streamText: (options) => {
        prompts.push(options.prompt);
        const step = typeof steps === "function" ? steps(options.prompt) : (steps[prompts.length - 1] ?? { text: "done" });
        return Stream.fromIterable(stepParts(step, prompts.length));
      },
    }),
  );
  return { layer, prompts };
};

const food = (id: string, name: string): FoodSearchResult => ({
  id,
  canonicalKey: id,
  source: "mfp",
  sourceLabel: "MFP",
  name,
  serving: "1 medium",
  nutrition: { calories: 105 },
});

const fakeSearch = (search: (query: string) => Effect.Effect<ReadonlyArray<FoodSearchResult>>) =>
  Layer.succeed(FoodSearch, { searchUnified: (query) => search(query) });

const session = (): SessionState => ({
  id: "s",
  userId: "u",
  conversation: [],
  searchResultCounter: 1,
  searchResultsByLocalId: {},
});

const run = (
  state: SessionState,
  model: Layer.Layer<LanguageModel.LanguageModel>,
  search: Layer.Layer<FoodSearch> = fakeSearch(() => Effect.succeed([food("f1", "Banana")])),
) => {
  const events: Array<AgentEvent> = [];
  const costs: Array<number | undefined> = [];
  return Effect.runPromise(
    runAssistantLoop(state, {
      emit: (event) => Effect.sync(() => void events.push(event)),
      onUsage: (usage) => Effect.sync(() => void costs.push(usage.costUsd)),
    }).pipe(Effect.provide([model, search])),
  ).then(() => ({ events, costs }));
};

describe("runAssistantLoop parallel search", () => {
  test("runs a step's searches concurrently and keeps result IDs in call order", async () => {
    const model = scriptedModel((prompt) =>
      prompt.content.some((message) => message.role === "tool")
        ? { tools: [{ name: "requestFoodApprovals", input: { suggestions: [{ resultId: "r2", meal: "Lunch", portion: "1.1", reason: "bread" }] } }] }
        : { tools: [{ name: "searchFoods", input: { query: "slow apple" } }, { name: "searchFoods", input: { query: "fast bread" } }] },
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const search = fakeSearch((query) =>
      Effect.gen(function* () {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        yield* Effect.sleep(query.startsWith("slow") ? 40 : 5);
        inFlight--;
        return [food(query, query.split(" ")[1]!)];
      }),
    );
    const { events, costs } = await run(session(), model.layer, search);

    expect(maxInFlight).toBe(2);
    expect(events.filter((e) => e.kind === "search").map((e) => (e as { query: string }).query)).toEqual(["slow apple", "fast bread"]);
    expect(events.at(-1)).toMatchObject({
      kind: "approval",
      toolCallId: "call-2-0",
      suggestions: [{ resultId: "r2", meal: "lunch", portion: 1, food: { name: "bread", resultId: "r2" } }],
    });
    expect(costs).toEqual([0.001, 0.001]);
  });
});

describe("runAssistantLoop tools", () => {
  test("returns tool errors to the model for invalid input and unknown result IDs", async () => {
    const model = scriptedModel([
      { tools: [{ name: "searchFoods", input: { query: "x" } }] },
      { tools: [{ name: "requestFoodApprovals", input: { suggestions: [{ resultId: "r9", meal: "lunch", portion: 1, reason: "?" }] } }] },
      { text: "Which banana did you mean exactly?" },
    ]);
    const state = session();
    await run(state, model.layer);
    const toolResults = state.conversation.flatMap((message) =>
      message.role === "tool" ? message.content.map((part) => (part.type === "tool-result" ? part.result : null)) : [],
    );
    expect(toolResults).toEqual([{ error: "Invalid searchFoods input." }, { error: "Unknown result IDs: r9" }]);
  });

  test("stores the transcript as assistant and tool messages", async () => {
    const model = scriptedModel([
      { tools: [{ name: "searchFoods", input: { query: "banana", limit: "3" } }] },
      { tools: [{ name: "requestFoodApprovals", input: { suggestions: [{ resultId: "r1", meal: "brunch", portion: 0.1, reason: "one" }] } }] },
    ]);
    const state = session();
    const { events } = await run(state, model.layer);
    expect(state.conversation.map((message) => message.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
    expect(state.searchResultsByLocalId.r1?.name).toBe("Banana");
    expect(state.searchResultCounter).toBe(2);
    expect(events.at(-1)).toMatchObject({ kind: "approval", suggestions: [{ meal: "lunch", portion: 0.25 }] });
  });
});

describe("runAssistantLoop repair", () => {
  test("retries when a tool call is printed as text and never streams the leak", async () => {
    const model = scriptedModel([
      { text: "call:default_api:searchFoods{query:banana}" },
      { tools: [{ name: "searchFoods", input: { query: "banana" } }] },
      { tools: [{ name: "requestFoodApprovals", input: { suggestions: [{ resultId: "r1", meal: "snacks", portion: 1, reason: "one banana" }] } }] },
    ]);
    const state = session();
    const { events } = await run(state, model.layer);

    expect(model.prompts).toHaveLength(3);
    expect(JSON.stringify(model.prompts[1]!.content)).toContain("Automatic note from the app");
    expect(events.some((e) => (e.kind === "assistant" || e.kind === "assistant-delta") && e.text.includes("default_api"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "approval", suggestions: [{ meal: "snacks", portion: 1 }] });
    // The nudge is transient and the leaked reply is dropped from the stored history.
    expect(JSON.stringify(state.conversation)).not.toContain("default_api");
    expect(JSON.stringify(state.conversation)).not.toContain("Automatic note");
  });

  test("retries a silent stop after searching, at most twice", async () => {
    const model = scriptedModel([{ tools: [{ name: "searchFoods", input: { query: "banana" } }] }, {}, {}, {}]);
    await run(session(), model.layer);
    expect(model.prompts).toHaveLength(4);
  });

  test("streams normal text unchanged", async () => {
    const model = scriptedModel([{ text: "What size was the banana you ate today?" }]);
    const { events } = await run(session(), model.layer);
    expect(model.prompts).toHaveLength(1);
    expect(events.filter((e) => e.kind === "assistant-delta").map((e) => (e as { text: string }).text).join("")).toBe(
      "What size was the banana you ate today?",
    );
    expect(events.at(-1)).toEqual({ kind: "assistant", text: "What size was the banana you ate today?" });
  });
});
