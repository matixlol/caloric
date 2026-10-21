import { describe, expect, test } from "bun:test";
import * as Prompt from "effect/ai/Prompt";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { runAssistantLoop, type SessionState, systemMessage } from "../src/ai/Agent.ts";
import type { AgentEvent } from "../src/ai/Domain.ts";
import { AssistantModelLive, openRouterModel } from "../src/ai/Model.ts";
import { FoodSearch } from "../src/search/FoodSearch.ts";

describe("openRouterModel", () => {
  test("sets reasoning effort", () => {
    expect(openRouterModel("meta/muse-wonder", "minimal")).toEqual({
      model: "meta/muse-wonder",
      config: { reasoning: { effort: "minimal" } },
    });
  });

  test("pins an upstream provider without fallbacks", () => {
    expect(openRouterModel("thinkingmachines/inkling@together", "low")).toEqual({
      model: "thinkingmachines/inkling",
      config: { reasoning: { effort: "low" }, provider: { order: ["together"], allow_fallbacks: false } },
    });
  });
});

// OpenRouter's streaming wire format, answered by a fake HttpClient.
const chunk = (body: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "m", ...body })}\n\n`;
const usageChunk = chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0012 } });
const responses = [
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "searchFoods", arguments: '{"query":"banana"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) +
    usageChunk +
    "data: [DONE]\n\n",
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Which banana " }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: { content: "size was it, roughly?" }, finish_reason: "stop" }] }) +
    usageChunk +
    "data: [DONE]\n\n",
];

describe("AssistantModelLive over OpenRouter", () => {
  test("sends tools, media, reasoning and provider pinning, and parses the stream", async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = []; // parsed JSON request bodies
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        requests.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
        const sse = responses[requests.length - 1] ?? responses[1]!;
        return HttpClientResponse.fromWeb(request, new Response(sse, { headers: { "content-type": "text/event-stream" } }));
      }),
    );
    const model = AssistantModelLive.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENROUTER_API_KEY: "sk-test",
            AI_MODEL: "thinkingmachines/inkling@together",
            AI_REASONING_EFFORT: "low",
          }),
        ),
      ),
    );
    const search = Layer.succeed(FoodSearch, {
      searchUnified: () =>
        Effect.succeed([{ id: "f1", canonicalKey: "f1", source: "mfp" as const, sourceLabel: "MFP" as const, name: "Banana" }]),
    });

    const session: SessionState = {
      id: "s",
      userId: "u",
      conversation: [
        systemMessage("system prompt"),
        Prompt.makeMessage("user", {
          content: [
            Prompt.makePart("text", { text: "log this" }),
            Prompt.makePart("file", { mediaType: "image/jpeg", data: "data:image/jpeg;base64,/9j/AA==" }),
            Prompt.makePart("file", { mediaType: "audio/wav", data: "UklGRg==", fileName: "voice.m4a" }),
          ],
        }),
      ],
      searchResultCounter: 1,
      searchResultsByLocalId: {},
    };
    const events: Array<AgentEvent> = [];
    const costs: Array<number | undefined> = [];
    await Effect.runPromise(
      runAssistantLoop(session, {
        emit: (event) => Effect.sync(() => void events.push(event)),
        onUsage: (usage) => Effect.sync(() => void costs.push(usage.costUsd)),
      }).pipe(Effect.provide([model, search])),
    );

    const first = requests[0]!;
    expect(first.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(first.headers.authorization).toBe("Bearer sk-test");
    expect(first.headers["x-title"]).toBe("Caloric");
    expect(first.body).toMatchObject({
      model: "thinkingmachines/inkling",
      stream: true,
      reasoning: { effort: "low" },
      provider: { order: ["together"], allow_fallbacks: false },
    });
    expect(first.body.messages[1].content).toEqual([
      { type: "text", text: "log this" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AA==" } },
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
    ]);
    expect(first.body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(["searchFoods", "requestFoodApprovals"]);
    expect(first.body.tools[0].function.parameters).toMatchObject({
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" }, limit: { type: "integer" } },
    });

    // The second call replays the tool call and its result.
    const replay = requests[1]!.body.messages.slice(-2);
    expect(replay[0]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1", function: { name: "searchFoods" } }] });
    expect(replay[1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(JSON.parse(replay[1].content).foods[0]).toMatchObject({ name: "Banana", resultId: "r1" });

    expect(events.map((event) => event.kind)).toEqual(["search", "assistant-delta", "assistant"]);
    expect(events.at(-1)).toEqual({ kind: "assistant", text: "Which banana size was it, roughly?" });
    expect(costs).toEqual([0.0012, 0.0012]);
  });
});
