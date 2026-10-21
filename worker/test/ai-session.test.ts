import { describe, expect, test } from "bun:test";
import * as Prompt from "effect/ai/Prompt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { systemMessage } from "../src/ai/Agent.ts";
import { buildRecentLogContextPrompt, parseRecentLogHints } from "../src/ai/RecentLogContext.ts";
import { AiSessionStore } from "../src/ai/SessionStore.ts";
import { makeTurnId, sessionIdOfTurn } from "../src/ai/TurnId.ts";
import { parseTurnRequest } from "../src/ai/TurnRequest.ts";
import { aiSessionId } from "../src/ids.ts";
import { TestDb } from "./TestDb.ts";

const runStore = <A, E>(effect: Effect.Effect<A, E, AiSessionStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(AiSessionStore.layer.pipe(Layer.provide(TestDb)))));

describe("AiSessionStore", () => {
  test("round-trips the conversation and scopes sessions to their user", () =>
    runStore(
      Effect.gen(function* () {
        const store = yield* AiSessionStore;
        yield* store.create({ id: "s1", userId: "u1", conversation: [systemMessage("system")] });
        expect(yield* store.exists("s1", "u1")).toBe(true);
        expect(yield* store.exists("s1", "u2")).toBe(false);
        expect(yield* store.load("s1", "u2")).toBeNull();

        const session = (yield* store.load("s1", "u1"))!;
        session.conversation.push(
          Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "a banana" })] }),
          Prompt.makeMessage("assistant", {
            content: [Prompt.makePart("tool-call", { id: "c1", name: "searchFoods", params: { query: "banana" }, providerExecuted: false })],
          }),
          Prompt.makeMessage("tool", {
            content: [Prompt.makePart("tool-result", { id: "c1", name: "searchFoods", isFailure: false, result: { foods: [] }, providerExecuted: false })],
          }),
        );
        session.searchResultCounter = 3;
        yield* store.save(session);

        const reloaded = (yield* store.load("s1", "u1"))!;
        expect(reloaded.searchResultCounter).toBe(3);
        expect(reloaded.conversation.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
        expect(reloaded.conversation[3]).toMatchObject({ content: [{ type: "tool-result", result: { foods: [] } }] });
      }),
    ));

  test("drops inline media when the conversation would exceed D1's row size", () =>
    runStore(
      Effect.gen(function* () {
        const store = yield* AiSessionStore;
        yield* store.create({ id: "s2", userId: "u1", conversation: [] });
        const session = (yield* store.load("s2", "u1"))!;
        session.conversation.push(
          Prompt.makeMessage("user", {
            content: [
              Prompt.makePart("text", { text: "lunch" }),
              Prompt.makePart("file", { mediaType: "image/jpeg", data: `data:image/jpeg;base64,${"A".repeat(1_600_000)}` }),
            ],
          }),
        );
        yield* store.save(session);
        const reloaded = (yield* store.load("s2", "u1"))!;
        expect(reloaded.conversation[0]).toMatchObject({
          content: [{ type: "text", text: "lunch" }, { type: "text", text: expect.stringContaining("no longer available") }],
        });
      }),
    ));
});

describe("turn ids", () => {
  test("carry their session id", () => {
    const sessionId = aiSessionId();
    const turnId = Option.getOrThrow(makeTurnId(sessionId));
    expect(turnId).toMatch(/^ai_turn_[0-9a-z]{26}_[0-9a-z]{26}$/);
    expect(sessionIdOfTurn(turnId)).toEqual(Option.some(sessionId));
    expect(sessionIdOfTurn("ai_turn_01h455vb4pex5vsknk084sn02q")).toEqual(Option.none());
    expect(makeTurnId("not-a-session")).toEqual(Option.none());
  });
});

const parse = (request: Request) =>
  Effect.runPromise(
    parseTurnRequest(HttpServerRequest.fromWeb(request)).pipe(
      Effect.match({ onFailure: (rejected) => ({ rejected: rejected.status, body: rejected.body }), onSuccess: (parsed) => parsed }),
    ),
  );

const jsonTurn = (body: unknown) =>
  new Request("http://x/ai/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("parseTurnRequest", () => {
  test("parses JSON user messages and approvals", async () => {
    expect(await parse(jsonTurn({ sessionId: " s ", action: { type: "user-message", message: " two eggs " } }))).toEqual({
      sessionId: "s",
      action: { type: "user-message", message: "two eggs" },
      audio: undefined,
      images: [],
    });
    expect(
      await parse(jsonTurn({ sessionId: "s", action: { type: "approval", toolCallId: "c", suggestionId: "m", approved: true } })),
    ).toEqual({ sessionId: "s", action: { type: "approval", toolCallId: "c", suggestionId: "m", approved: true } });
  });

  test("rejects bad JSON bodies with backend's messages", async () => {
    expect(await parse(new Request("http://x", { method: "POST", body: "{" }))).toEqual({
      rejected: 400,
      body: { error: "sessionId is required" },
    });
    expect(await parse(jsonTurn({ sessionId: "s", action: { type: "approval", toolCallId: "" } }))).toEqual({
      rejected: 400,
      body: { error: "Invalid action payload" },
    });
  });

  test("parses multipart uploads with audio and photos", async () => {
    const form = new FormData();
    form.set("sessionId", "s");
    form.set("actionType", "user-message");
    form.set("message", " lunch ");
    form.set("audio", new File([new Uint8Array([1, 2, 3])], "voice.m4a", { type: "audio/m4a" }));
    form.append("image", new File([new Uint8Array([9])], "photo-1.jpg", { type: "image/jpeg" }));
    form.append("image", new File([new Uint8Array([8])], "photo-2.jpg", { type: "image/jpeg" }));
    const parsed = await parse(new Request("http://x/ai/turn", { method: "POST", body: form }));
    expect(parsed).toMatchObject({
      sessionId: "s",
      action: { type: "user-message", message: "lunch" },
      audio: { name: "voice.m4a", contentType: "audio/m4a", bytes: new Uint8Array([1, 2, 3]) },
      images: [{ name: "photo-1.jpg" }, { name: "photo-2.jpg" }],
    });
  });

  test("limits multipart photos and action types", async () => {
    const form = new FormData();
    form.set("sessionId", "s");
    form.set("actionType", "user-message");
    for (let i = 0; i < 5; i++) form.append("image", new File([new Uint8Array([i + 1])], `p${i}.jpg`, { type: "image/jpeg" }));
    expect(await parse(new Request("http://x", { method: "POST", body: form }))).toEqual({
      rejected: 400,
      body: { error: "Attach at most 4 photos" },
    });
    form.set("actionType", "dance");
    expect(await parse(new Request("http://x", { method: "POST", body: form }))).toEqual({
      rejected: 400,
      body: { error: "Unsupported action type: dance" },
    });
  });
});

describe("recent log context", () => {
  test("parses hints leniently and builds the context prompt", () => {
    const hints = parseRecentLogHints([
      { foodName: "Banana", meal: "breakfast", dateKey: "2026-02-22", createdAt: 1700000000000 },
      { foodName: "  Whey   Protein ", brand: "ENA", serving: "31 gramos", createdAt: "1700000001000" },
      { foodName: 42 },
      "nope",
    ]);
    expect(hints.map((hint) => hint.foodName)).toEqual(["Whey Protein", "Banana"]);
    const prompt = buildRecentLogContextPrompt(hints) ?? "";
    expect(prompt).toContain("last 3 days");
    expect(prompt).toContain("- Whey Protein | ENA | 31 gramos");
    expect(prompt).toContain("- 2026-02-22 | breakfast | Banana");
    expect(buildRecentLogContextPrompt([])).toBeNull();
  });
});
