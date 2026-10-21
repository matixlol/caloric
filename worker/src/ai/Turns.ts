import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { AgentEvent, DurableMessage, TerminalMessage, TurnLookup, TurnMessage } from "./Domain.ts";

// Resumable turns for one AI session. The session's Durable Object owns a
// runner: it runs each turn detached from any request, persists durable events
// (with a monotonic `seq`) so clients can replay after a cursor, fans live
// events out to attached streams, enforces a deadline and supersedes a running
// turn when a new one starts. Storage is abstract so tests run in memory.

export interface TurnStorage {
  readonly get: <A>(key: string) => Effect.Effect<A | undefined>;
  readonly put: (entries: Record<string, unknown>) => Effect.Effect<void>;
  readonly list: <A>(prefix: string) => Effect.Effect<ReadonlyMap<string, A>>;
  readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly getAlarm: Effect.Effect<number | null>;
  readonly setAlarm: (at: number) => Effect.Effect<void>;
}

export interface TurnEmitter {
  readonly resolvedUserMessage: (message: string) => Effect.Effect<void>;
  readonly event: (event: AgentEvent) => Effect.Effect<void>;
}

export interface TurnFailure {
  readonly code: string;
  readonly message: string;
}

interface TurnMeta {
  readonly turnId: string;
  readonly userId: string;
  readonly status: "running" | "done" | "error";
  readonly deadlineAt: number;
  readonly error?: TurnFailure;
  readonly expiresAt?: number;
}

interface LiveTurn {
  meta: TurnMeta;
  seq: number;
  readonly durable: Array<DurableMessage>;
  // Text of the assistant message being streamed but not yet committed.
  assistantBuffer: string;
  readonly subscribers: Set<(message: TurnMessage) => void>;
  fiber?: Fiber.Fiber<void, unknown>;
  // Set before interrupting the run so it finishes with a specific code
  // (timeout, supersede) instead of the generic failure mapping.
  interruptReason?: TurnFailure;
}

export const superseded: TurnFailure = {
  code: "ai_turn_superseded",
  message: "This AI turn was superseded by a newer message.",
};
export const timedOut: TurnFailure = {
  code: "ai_turn_timeout",
  message: "The AI response took too long. Please try again.",
};
// The object restarted (deploy, eviction) while the turn was running.
export const interrupted: TurnFailure = {
  code: "ai_turn_interrupted",
  message: "The AI response was interrupted. Please try again.",
};

const metaKey = (turnId: string) => `meta:${turnId}`;
const eventPrefix = (turnId: string) => `event:${turnId}:`;
const eventKey = (turnId: string, seq: number) => `${eventPrefix(turnId)}${String(seq).padStart(6, "0")}`;

const terminalMessage = (meta: TurnMeta): TerminalMessage =>
  meta.status === "error"
    ? { type: "error", error: meta.error?.code ?? "ai_turn_failed", message: meta.error?.message ?? "Unknown error." }
    : { type: "status", status: "ready" };

const done: TurnMessage = { type: "done" };

export interface TurnRunnerOptions {
  readonly storage: TurnStorage;
  // Maps an unexpected failure to the client-facing code (and logs it).
  readonly onFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<TurnFailure>;
  // Keeps the host alive while a detached run is in flight (DO waitUntil).
  readonly keepAlive?: (running: Effect.Effect<unknown>) => Effect.Effect<void>;
  readonly deadline?: Duration.Input;
  readonly retention?: Duration.Input;
}

export const makeTurnRunner = (options: TurnRunnerOptions) => {
  const { storage } = options;
  const deadlineMs = Duration.toMillis(Duration.fromInputUnsafe(options.deadline ?? "3 minutes"));
  const retentionMs = Duration.toMillis(Duration.fromInputUnsafe(options.retention ?? "5 minutes"));
  const turns = new Map<string, LiveTurn>();

  const broadcast = (live: LiveTurn, message: TurnMessage) => {
    for (const subscriber of live.subscribers) subscriber(message);
  };

  const scheduleAlarm = (at: number) =>
    Effect.gen(function* () {
      const current = yield* storage.getAlarm;
      if (current === null || current > at) yield* storage.setAlarm(at);
    });

  const finishedMeta = (meta: TurnMeta, now: number, error?: TurnFailure): TurnMeta => ({
    ...meta,
    status: error ? "error" : "done",
    ...(error ? { error } : {}),
    expiresAt: now + retentionMs,
  });

  const finalize = (live: LiveTurn, error: TurnFailure | undefined) =>
    Effect.gen(function* () {
      const meta = finishedMeta(live.meta, yield* Clock.currentTimeMillis, error);
      live.meta = meta;
      live.assistantBuffer = "";
      live.fiber = undefined;
      broadcast(live, terminalMessage(meta));
      broadcast(live, done);
      live.subscribers.clear();
      yield* storage.put({ [metaKey(meta.turnId)]: meta });
      yield* scheduleAlarm(meta.expiresAt!);
    });

  // A turn stored as running that no fiber in this instance owns.
  const finalizeOrphan = (meta: TurnMeta) =>
    Effect.gen(function* () {
      const finished = finishedMeta(meta, yield* Clock.currentTimeMillis, interrupted);
      yield* storage.put({ [metaKey(meta.turnId)]: finished });
      yield* scheduleAlarm(finished.expiresAt!);
      return finished;
    });

  const emitter = (live: LiveTurn): TurnEmitter => {
    const durable = (message: DurableMessage) =>
      Effect.suspend(() => {
        live.durable.push(message);
        broadcast(live, message);
        return storage.put({ [eventKey(live.meta.turnId, message.seq)]: message });
      });
    return {
      resolvedUserMessage: (resolvedUserMessage) =>
        Effect.suspend(() => durable({ type: "resolved-user-message", resolvedUserMessage, seq: ++live.seq })),
      event: (event) =>
        Effect.suspend(() => {
          if (event.kind === "assistant-delta") {
            // Transient: buffered so a reconnecting client sees the partial
            // text, but seqless (the committed `assistant` event carries one).
            if (!event.text) return Effect.void;
            live.assistantBuffer += event.text;
            broadcast(live, { type: "event", event });
            return Effect.void;
          }
          if (event.kind === "assistant") live.assistantBuffer = "";
          return durable({ type: "event", event, seq: ++live.seq });
        }),
    };
  };

  // Interrupts the running turn (if any) and waits for it to finalize. A
  // session's conversation is one document, so two runs would clobber it.
  const supersede = Effect.gen(function* () {
    for (const live of turns.values()) {
      if (live.fiber) {
        live.interruptReason ??= superseded;
        yield* Fiber.interrupt(live.fiber);
      }
    }
  });

  const start = Effect.fnUntraced(function* (params: {
    readonly turnId: string;
    readonly userId: string;
    readonly run: (emit: TurnEmitter) => Effect.Effect<void, unknown>;
  }) {
    yield* supersede;
    const now = yield* Clock.currentTimeMillis;
    const meta: TurnMeta = { turnId: params.turnId, userId: params.userId, status: "running", deadlineAt: now + deadlineMs };
    const live: LiveTurn = { meta, seq: 0, durable: [], assistantBuffer: "", subscribers: new Set() };
    turns.set(meta.turnId, live);
    yield* storage.put({ [metaKey(meta.turnId)]: meta });
    // Backstop for the in-memory deadline if the object is evicted mid-turn.
    yield* scheduleAlarm(meta.deadlineAt);

    const run = params.run(emitter(live)).pipe(
      // Its own scope: the caller's (e.g. an RPC call's) closes right away.
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: Duration.millis(deadlineMs),
        orElse: () =>
          Effect.sync(() => {
            live.interruptReason ??= timedOut;
          }).pipe(Effect.andThen(Effect.interrupt)),
      }),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? finalize(live, undefined)
          : live.interruptReason
            ? finalize(live, live.interruptReason)
            : Effect.flatMap(options.onFailure(exit.cause), (failure) => finalize(live, failure)),
      ),
      Effect.ignore,
    );
    // Detached: the run must outlive the request that started it (clients
    // disconnect when the app backgrounds). Its kill switches are the
    // deadline and being superseded.
    const fiber = yield* Effect.forkDetach(run, { startImmediately: false });
    live.fiber = fiber;
    if (options.keepAlive) yield* options.keepAlive(Fiber.await(fiber));
  });

  const lookup = Effect.fnUntraced(function* (turnId: string, userId: string) {
    const meta = turns.get(turnId)?.meta ?? (yield* storage.get<TurnMeta>(metaKey(turnId)));
    if (!meta) return "not_found" satisfies TurnLookup;
    return meta.userId === userId ? "found" : "unauthorized";
  });

  const liveStream = (live: LiveTurn, cursor: number) =>
    Stream.callback<TurnMessage>((queue) => {
      const subscriber = (message: TurnMessage) => {
        Queue.offerUnsafe(queue, message);
        if (message.type === "done") Queue.endUnsafe(queue);
      };
      // Replay and subscribe in one synchronous step so no event is missed
      // or delivered twice.
      return Effect.sync(() => {
        for (const message of live.durable) if (message.seq > cursor) Queue.offerUnsafe(queue, message);
        if (live.assistantBuffer) {
          // The in-progress text as a seqless full message; the committed
          // assistant event replaces it once the message finishes.
          Queue.offerUnsafe(queue, { type: "event", event: { kind: "assistant", text: live.assistantBuffer } });
        }
        if (live.meta.status !== "running") {
          Queue.offerUnsafe(queue, terminalMessage(live.meta));
          subscriber(done);
          return;
        }
        live.subscribers.add(subscriber);
      }).pipe(Effect.andThen(Effect.addFinalizer(() => Effect.sync(() => live.subscribers.delete(subscriber)))));
    });

  const storedStream = (turnId: string, cursor: number) =>
    Effect.gen(function* () {
      const stored = yield* storage.get<TurnMeta>(metaKey(turnId));
      if (!stored) return Stream.empty;
      const meta = stored.status === "running" ? yield* finalizeOrphan(stored) : stored;
      const events = yield* storage.list<DurableMessage>(eventPrefix(turnId));
      const replay = [...events.values()].filter((message) => message.seq > cursor).sort((a, b) => a.seq - b.seq);
      return Stream.fromIterable<TurnMessage>([...replay, terminalMessage(meta), done]);
    });

  // Durable messages after `cursor`, then live messages until the turn ends,
  // closing with the terminal message and `done`.
  const attach = (turnId: string, cursor: number): Stream.Stream<TurnMessage> =>
    Stream.unwrap(
      Effect.suspend(() => {
        const live = turns.get(turnId);
        return live ? Effect.succeed(liveStream(live, cursor)) : storedStream(turnId, cursor);
      }),
    );

  // Deadline backstop and retention cleanup; re-arms itself for the next due turn.
  const alarm = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const metas = yield* storage.list<TurnMeta>("meta:");
    let next: number | undefined;
    const due = (at: number) => {
      next = next === undefined ? at : Math.min(next, at);
    };
    for (const meta of metas.values()) {
      const live = turns.get(meta.turnId);
      const current = live?.meta ?? meta;
      if (current.status === "running") {
        if (current.deadlineAt > now) {
          due(current.deadlineAt);
        } else if (live?.fiber) {
          live.interruptReason ??= timedOut;
          yield* Fiber.interrupt(live.fiber);
        } else {
          due((yield* finalizeOrphan(current)).expiresAt!);
        }
      } else if ((current.expiresAt ?? 0) > now) {
        due(current.expiresAt!);
      } else {
        const events = yield* storage.list(eventPrefix(current.turnId));
        yield* storage.delete([metaKey(current.turnId), ...events.keys()]);
        turns.delete(current.turnId);
      }
    }
    if (next !== undefined) yield* scheduleAlarm(next);
  });

  return { start, supersede, lookup, attach, alarm };
};

export type TurnRunner = ReturnType<typeof makeTurnRunner>;
