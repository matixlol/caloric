import type { ResolvedApprovalSuggestion } from "./ai-store";
import type { SearchResultFood } from "./search";

// Agent events streamed to the client. `assistant-delta` events are transient
// (used only for the live typing effect) and are never persisted for replay; the
// accumulated text lives in `assistantBuffer` on the running turn instead.
export type AgentEvent =
  | {
      kind: "assistant";
      text: string;
    }
  | {
      kind: "assistant-delta";
      text: string;
    }
  | {
      kind: "search";
      query: string;
      foods: SearchResultFood[];
    }
  | {
      kind: "approval";
      toolCallId: string;
      suggestions: ResolvedApprovalSuggestion[];
    };

export type AgentStatus = "ready";

// Messages written to the SSE stream. Durable messages (event / resolved-user-message)
// carry a monotonic `seq` so a reconnecting client can resume from a cursor.
type TurnOutbound =
  | { type: "turn"; turnId: string }
  | { type: "event"; seq?: number; event: AgentEvent }
  | { type: "resolved-user-message"; seq?: number; resolvedUserMessage: string }
  | { type: "status"; status: AgentStatus }
  | { type: "error"; error: string; message: string }
  | { type: "done" };

type DurableOutbound = Extract<TurnOutbound, { type: "event" | "resolved-user-message" }> & {
  seq: number;
};

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

type Subscriber = (message: TurnOutbound) => void;

type TurnRecord = {
  id: string;
  userId: string;
  status: "running" | "done" | "error";
  errorCode?: string;
  errorMessage?: string;
  seqCounter: number;
  // Durable events emitted so far, kept in order for replay on reconnect.
  durable: DurableOutbound[];
  // Text of the assistant message currently being streamed but not yet committed.
  assistantBuffer: string;
  subscribers: Set<Subscriber>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

export type TurnEmitter = {
  resolvedUserMessage: (message: string) => void;
  event: (event: AgentEvent) => void;
};

// How long a finished turn is retained in memory so a client that reconnects
// shortly after completion can still receive the events it missed. This is an
// in-memory registry, so turns do not survive a server restart by design.
const finishedTurnTtlMs = 5 * 60 * 1000;

// Hard ceiling on how long the detached run may take before it is aborted and
// finalized as an error. The run is intentionally decoupled from the client
// request, so without this a hung LLM call would keep the turn "running" forever
// and leak its record (the cleanup timer is only armed once a turn finalizes).
const turnDeadlineMs = 3 * 60 * 1000;

const turns = new Map<string, TurnRecord>();

const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

function encodeSseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function broadcast(record: TurnRecord, message: TurnOutbound): void {
  for (const subscriber of record.subscribers) {
    subscriber(message);
  }
}

function terminalMessage(record: TurnRecord): TurnOutbound {
  if (record.status === "error") {
    return {
      type: "error",
      error: record.errorCode ?? "ai_turn_failed",
      message: record.errorMessage ?? "Unknown error.",
    };
  }

  return { type: "status", status: "ready" };
}

function finalizeTurn(
  record: TurnRecord,
  status: "done" | "error",
  errorCode?: string,
  errorMessage?: string,
): void {
  record.status = status;
  record.errorCode = errorCode;
  record.errorMessage = errorMessage;
  record.assistantBuffer = "";

  broadcast(record, terminalMessage(record));
  broadcast(record, { type: "done" });
  record.subscribers.clear();

  record.cleanupTimer = setTimeout(() => {
    turns.delete(record.id);
  }, finishedTurnTtlMs);
  record.cleanupTimer.unref?.();
}

export function startResumableTurn(params: {
  turnId: string;
  userId: string;
  run: (emit: TurnEmitter, signal: AbortSignal) => Promise<void>;
  onError: (error: unknown) => { code: string; message: string };
}): TurnRecord {
  const record: TurnRecord = {
    id: params.turnId,
    userId: params.userId,
    status: "running",
    seqCounter: 0,
    durable: [],
    assistantBuffer: "",
    subscribers: new Set(),
  };

  turns.set(record.id, record);

  const emitDurable = (message: DistributiveOmit<DurableOutbound, "seq">): void => {
    const seq = (record.seqCounter += 1);
    const durable = { ...message, seq } as DurableOutbound;
    record.durable.push(durable);
    broadcast(record, durable);
  };

  const emitter: TurnEmitter = {
    resolvedUserMessage(message) {
      emitDurable({ type: "resolved-user-message", resolvedUserMessage: message });
    },
    event(event) {
      if (event.kind === "assistant-delta") {
        if (!event.text) {
          return;
        }

        // Transient: accumulate so a reconnecting client sees the partial text,
        // but do not assign a seq (the committed `assistant` event carries it).
        record.assistantBuffer += event.text;
        broadcast(record, { type: "event", event });
        return;
      }

      if (event.kind === "assistant") {
        // The streaming message is now committed; clear the partial buffer.
        record.assistantBuffer = "";
      }

      emitDurable({ type: "event", event });
    },
  };

  const abortController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    abortController.abort(new Error("AI turn timed out."));
  }, turnDeadlineMs);
  deadlineTimer.unref?.();

  void (async () => {
    try {
      await params.run(emitter, abortController.signal);
      finalizeTurn(record, "done");
    } catch (error) {
      const { code, message } = params.onError(error);
      finalizeTurn(record, "error", code, message);
    } finally {
      clearTimeout(deadlineTimer);
    }
  })();

  return record;
}

export function getResumableTurn(turnId: string, userId: string): TurnRecord | null {
  const record = turns.get(turnId);
  if (!record || record.userId !== userId) {
    return null;
  }

  return record;
}

// Replays durable events after `cursor`, then either streams live events until the
// turn finishes or, if the turn is already finished, sends the terminal message.
// Returns an unsubscribe function.
function subscribeToTurn(record: TurnRecord, cursor: number, sink: Subscriber): () => void {
  for (const durable of record.durable) {
    if (durable.seq > cursor) {
      sink(durable);
    }
  }

  if (record.assistantBuffer) {
    // Surface the in-progress assistant text as a (seqless) full assistant event
    // so the client can render it immediately on reconnect. The eventual committed
    // assistant event will replace it once the message finishes.
    sink({ type: "event", event: { kind: "assistant", text: record.assistantBuffer } });
  }

  if (record.status !== "running") {
    sink(terminalMessage(record));
    sink({ type: "done" });
    return () => {};
  }

  record.subscribers.add(sink);
  return () => {
    record.subscribers.delete(sink);
  };
}

export function createTurnSseResponse(record: TurnRecord, cursor: number, signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const onAbort = () => {
        finish();
      };

      const finish = () => {
        if (closed) {
          return;
        }

        closed = true;
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // Stream already closed.
        }
      };

      const sink: Subscriber = (message) => {
        if (closed) {
          return;
        }

        try {
          if (message.type === "done") {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            finish();
            return;
          }

          controller.enqueue(encoder.encode(encodeSseChunk(message)));
        } catch {
          finish();
        }
      };

      sink({ type: "turn", turnId: record.id });
      unsubscribe = subscribeToTurn(record, cursor, sink);

      // The client disconnecting only tears down this viewer; the turn keeps
      // running server-side so it can be resumed later.
      if (signal) {
        if (signal.aborted) {
          finish();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, { headers: sseHeaders });
}
