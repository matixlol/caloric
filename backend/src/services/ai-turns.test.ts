import { describe, expect, it } from "bun:test";
import { createTurnSseResponse, getResumableTurn, startResumableTurn, type TurnEmitter } from "./ai-turns";

type Payload = Record<string, unknown> & { type?: string };

function parseSse(text: string): Payload[] {
  const payloads: Payload[] = [];
  for (const segment of text.split("\n\n")) {
    const trimmed = segment.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const data = trimmed.slice("data:".length).trim();
    if (data === "[DONE]") {
      payloads.push({ type: "done" });
      continue;
    }

    payloads.push(JSON.parse(data) as Payload);
  }

  return payloads;
}

async function readAll(response: Response): Promise<Payload[]> {
  return parseSse(await response.text());
}

// Reads a streaming response until `count` payloads have been seen, then cancels
// the reader to simulate the client disconnecting mid-turn.
async function readThenDisconnect(response: Response, count: number): Promise<Payload[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const payloads: Payload[] = [];

  while (payloads.length < count) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const segments = buffer.split("\n\n");
    buffer = segments.pop() ?? "";
    for (const segment of segments) {
      payloads.push(...parseSse(`${segment}\n\n`));
    }
  }

  await reader.cancel();
  return payloads;
}

const noopOnError = () => ({ code: "test_error", message: "test error" });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("ai-turns resumable runner", () => {
  it("replays events emitted before the subscriber attaches, then streams live to completion", async () => {
    const gate = deferred();
    const record = startResumableTurn({
      turnId: "ai_turn_test_full",
      sessionId: "session_ai_turn_test_full",
      userId: "user-1",
      onError: noopOnError,
      run: async (emit: TurnEmitter) => {
        // These run synchronously, before the response below subscribes.
        emit.resolvedUserMessage("hello");
        emit.event({ kind: "assistant-delta", text: "Hi" });
        emit.event({ kind: "assistant-delta", text: " there" });
        emit.event({ kind: "assistant", text: "Hi there" });
        await gate.promise;
        emit.event({ kind: "assistant", text: "all done" });
      },
    });

    const response = createTurnSseResponse(record, -1);
    gate.resolve();
    const payloads = await readAll(response);

    expect(payloads[0]).toEqual({ type: "turn", turnId: "ai_turn_test_full" });

    const resolved = payloads.find((p) => p.type === "resolved-user-message");
    expect(resolved).toMatchObject({ resolvedUserMessage: "hello", seq: 1 });

    const assistantEvents = payloads.filter(
      (p) => p.type === "event" && (p.event as { kind?: string })?.kind === "assistant",
    );
    expect(assistantEvents.map((p) => (p.event as { text: string }).text)).toEqual(["Hi there", "all done"]);
    // The committed assistant events carry monotonic seqs; deltas do not.
    expect(assistantEvents.map((p) => p.seq)).toEqual([2, 3]);

    expect(payloads.some((p) => p.type === "status" && p.status === "ready")).toBe(true);
    expect(payloads.at(-1)).toEqual({ type: "done" });
  });

  it("keeps running after a subscriber disconnects and resumes from a cursor without duplicates", async () => {
    const gate1 = deferred();
    const gate2 = deferred();
    const record = startResumableTurn({
      turnId: "ai_turn_test_resume",
      sessionId: "session_ai_turn_test_resume",
      userId: "user-1",
      onError: noopOnError,
      run: async (emit: TurnEmitter) => {
        emit.event({ kind: "assistant", text: "part one" }); // seq 1
        await gate1.promise;
        emit.event({ kind: "search", query: "eggs", foods: [] }); // seq 2
        await gate2.promise;
        emit.event({ kind: "assistant", text: "part two" }); // seq 3
      },
    });

    // First viewer reads the turn id + first event, then disconnects.
    const firstViewer = createTurnSseResponse(record, -1);
    const firstPayloads = await readThenDisconnect(firstViewer, 2);
    expect(firstPayloads[0]).toEqual({ type: "turn", turnId: "ai_turn_test_resume" });
    expect(firstPayloads[1]).toMatchObject({ type: "event", seq: 1 });

    // The turn keeps going server-side even though no one is listening.
    gate1.resolve();

    // Reconnect from the cursor we had applied (seq 1).
    const secondViewer = createTurnSseResponse(record, 1);
    gate2.resolve();
    const resumed = await readAll(secondViewer);

    // The already-seen seq-1 assistant event must not be replayed.
    const resumedAssistantTexts = resumed
      .filter((p) => p.type === "event" && (p.event as { kind?: string })?.kind === "assistant")
      .map((p) => (p.event as { text: string }).text);
    expect(resumedAssistantTexts).toEqual(["part two"]);

    const resumedSeqs = resumed.filter((p) => typeof p.seq === "number").map((p) => p.seq);
    expect(resumedSeqs).toEqual([2, 3]);
    expect(resumed.some((p) => p.type === "status" && p.status === "ready")).toBe(true);
    expect(resumed.at(-1)).toEqual({ type: "done" });
  });

  it("surfaces the in-progress assistant text to a reconnecting subscriber", async () => {
    const gate = deferred();
    const record = startResumableTurn({
      turnId: "ai_turn_test_partial",
      sessionId: "session_ai_turn_test_partial",
      userId: "user-1",
      onError: noopOnError,
      run: async (emit: TurnEmitter) => {
        emit.event({ kind: "assistant-delta", text: "strea" });
        emit.event({ kind: "assistant-delta", text: "ming" });
        await gate.promise;
        emit.event({ kind: "assistant", text: "streaming done" });
      },
    });

    // Subscribe while the assistant message is still mid-stream (buffer = "streaming").
    const viewer = createTurnSseResponse(record, -1);
    gate.resolve();
    const payloads = await readAll(viewer);

    const assistantTexts = payloads
      .filter((p) => p.type === "event" && (p.event as { kind?: string })?.kind === "assistant")
      .map((p) => (p.event as { text: string }).text);

    // First the buffered partial (seqless), then the committed message.
    expect(assistantTexts).toEqual(["streaming", "streaming done"]);
  });

  it("reports a terminal error to subscribers when the run throws", async () => {
    const record = startResumableTurn({
      turnId: "ai_turn_test_error",
      sessionId: "session_ai_turn_test_error",
      userId: "user-1",
      onError: () => ({ code: "ai_turn_failed", message: "boom" }),
      run: async () => {
        throw new Error("kaboom");
      },
    });

    const payloads = await readAll(createTurnSseResponse(record, -1));
    const errorPayload = payloads.find((p) => p.type === "error");
    expect(errorPayload).toMatchObject({ error: "ai_turn_failed", message: "boom" });
    expect(payloads.at(-1)).toEqual({ type: "done" });
  });

  it("scopes turn lookup to the owning user", async () => {
    const record = startResumableTurn({
      turnId: "ai_turn_test_owner",
      sessionId: "session_ai_turn_test_owner",
      userId: "owner",
      onError: noopOnError,
      run: async () => {
        // Finishes immediately.
      },
    });

    expect(getResumableTurn(record.id, "owner")?.id).toBe(record.id);
    expect(getResumableTurn(record.id, "intruder")).toBeNull();
    expect(getResumableTurn("ai_turn_missing", "owner")).toBeNull();
  });

  it("supersedes a still-running turn when a new turn starts on the same session", async () => {
    const firstAborted = deferred();
    const first = startResumableTurn({
      turnId: "ai_turn_test_supersede_old",
      sessionId: "session_supersede",
      userId: "user-1",
      onError: () => ({ code: "ai_turn_failed", message: "should not be used" }),
      run: async (emit: TurnEmitter, signal: AbortSignal) => {
        emit.event({ kind: "assistant", text: "old turn" });
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              firstAborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    });

    const second = startResumableTurn({
      turnId: "ai_turn_test_supersede_new",
      sessionId: "session_supersede",
      userId: "user-1",
      onError: noopOnError,
      run: async (emit: TurnEmitter) => {
        emit.event({ kind: "assistant", text: "new turn" });
      },
    });

    await firstAborted.promise;

    // The old turn finalizes with the distinct supersede code, not the generic
    // onError mapping; the new turn completes normally.
    const oldPayloads = await readAll(createTurnSseResponse(first, -1));
    const oldError = oldPayloads.find((p) => p.type === "error");
    expect(oldError).toMatchObject({ error: "ai_turn_superseded" });

    const newPayloads = await readAll(createTurnSseResponse(second, -1));
    expect(newPayloads.some((p) => p.type === "status" && p.status === "ready")).toBe(true);
  });
});
