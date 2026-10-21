import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { TurnMessage } from "../src/ai/Domain.ts";
import * as Fiber from "effect/Fiber";
import { makeTurnRunner, type TurnEmitter, type TurnRunnerOptions, type TurnStorage } from "../src/ai/Turns.ts";

const memoryStorage = () => {
  const data = new Map<string, unknown>();
  const state = { alarm: null as number | null };
  const storage: TurnStorage = {
    get: <A>(key: string) => Effect.sync(() => data.get(key) as A | undefined),
    put: (entries) => Effect.sync(() => Object.entries(entries).forEach(([key, value]) => data.set(key, structuredClone(value)))),
    list: <A>(prefix: string) =>
      Effect.sync(() => new Map([...data].filter(([key]) => key.startsWith(prefix)) as Array<[string, A]>)),
    delete: (keys) => Effect.sync(() => keys.forEach((key) => data.delete(key))),
    getAlarm: Effect.sync(() => state.alarm),
    setAlarm: (at) => Effect.sync(() => void (state.alarm = at)),
  };
  return { storage, data, state };
};

const makeRunner = (storage: TurnStorage, options?: Pick<TurnRunnerOptions, "deadline" | "retention">) =>
  makeTurnRunner({
    storage,
    onFailure: () => Effect.succeed({ code: "ai_turn_failed", message: "Unknown error." }),
    ...options,
  });

const collect = (stream: Stream.Stream<TurnMessage>) => Stream.runCollect(stream);
const assistantTexts = (messages: ReadonlyArray<TurnMessage>) =>
  messages.flatMap((m) => (m.type === "event" && m.event.kind === "assistant" ? [m.event.text] : []));
const seqs = (messages: ReadonlyArray<TurnMessage>) => messages.flatMap((m) => ("seq" in m ? [m.seq] : []));

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("turn runner", () => {
  test("replays events emitted before attaching, then streams live to completion", () =>
    run(
      Effect.gen(function* () {
        const { storage } = memoryStorage();
        const runner = makeRunner(storage);
        const reached = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        yield* runner.start({
          turnId: "t1",
          userId: "u1",
          run: (emit: TurnEmitter) =>
            Effect.gen(function* () {
              yield* emit.resolvedUserMessage("hello");
              yield* emit.event({ kind: "assistant-delta", text: "Hi" });
              yield* emit.event({ kind: "assistant-delta", text: " there" });
              yield* emit.event({ kind: "assistant", text: "Hi there" });
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(gate);
              yield* emit.event({ kind: "assistant", text: "all done" });
            }),
        });
        yield* Deferred.await(reached);
        const fiber = yield* Effect.forkChild(collect(runner.attach("t1", -1)));
        yield* Deferred.succeed(gate, undefined);
        const messages = yield* Fiber.join(fiber);

        expect(messages[0]).toEqual({ type: "resolved-user-message", resolvedUserMessage: "hello", seq: 1 });
        expect(assistantTexts(messages)).toEqual(["Hi there", "all done"]);
        expect(seqs(messages)).toEqual([1, 2, 3]);
        expect(messages.at(-2)).toEqual({ type: "status", status: "ready" });
        expect(messages.at(-1)).toEqual({ type: "done" });
      }),
    ));

  test("keeps running after a viewer disconnects and resumes from a cursor without duplicates", () =>
    run(
      Effect.gen(function* () {
        const { storage } = memoryStorage();
        const runner = makeRunner(storage);
        const gate1 = yield* Deferred.make<void>();
        const gate2 = yield* Deferred.make<void>();
        yield* runner.start({
          turnId: "t2",
          userId: "u1",
          run: (emit) =>
            Effect.gen(function* () {
              yield* emit.event({ kind: "assistant", text: "part one" });
              yield* Deferred.await(gate1);
              yield* emit.event({ kind: "search", query: "eggs", foods: [] });
              yield* Deferred.await(gate2);
              yield* emit.event({ kind: "assistant", text: "part two" });
            }),
        });

        // The first viewer reads one event, then disconnects.
        const first = yield* collect(runner.attach("t2", -1).pipe(Stream.take(1)));
        expect(first).toMatchObject([{ type: "event", seq: 1 }]);

        yield* Deferred.succeed(gate1, undefined);
        const resumed = yield* Effect.forkChild(collect(runner.attach("t2", 1)));
        yield* Deferred.succeed(gate2, undefined);
        const messages = yield* Fiber.join(resumed);

        expect(assistantTexts(messages)).toEqual(["part two"]);
        expect(seqs(messages)).toEqual([2, 3]);
        expect(messages.at(-1)).toEqual({ type: "done" });
      }),
    ));

  test("surfaces the in-progress assistant text to a reconnecting viewer", () =>
    run(
      Effect.gen(function* () {
        const { storage } = memoryStorage();
        const runner = makeRunner(storage);
        const reached = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        yield* runner.start({
          turnId: "t3",
          userId: "u1",
          run: (emit) =>
            Effect.gen(function* () {
              yield* emit.event({ kind: "assistant-delta", text: "strea" });
              yield* emit.event({ kind: "assistant-delta", text: "ming" });
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(gate);
              yield* emit.event({ kind: "assistant", text: "streaming done" });
            }),
        });
        yield* Deferred.await(reached);
        const attached = yield* Deferred.make<void>();
        const viewer = yield* Effect.forkChild(
          collect(runner.attach("t3", -1).pipe(Stream.tap(() => Deferred.succeed(attached, undefined)))),
        );
        yield* Deferred.await(attached);
        yield* Deferred.succeed(gate, undefined);
        const messages = yield* Fiber.join(viewer);
        expect(assistantTexts(messages)).toEqual(["streaming", "streaming done"]);
      }),
    ));

  test("reports a terminal error when the run fails", () =>
    run(
      Effect.gen(function* () {
        const { storage } = memoryStorage();
        const failures: Array<string> = [];
        const runner = makeTurnRunner({
          storage,
          onFailure: (cause) =>
            Effect.sync(() => {
              failures.push(String(Cause.squash(cause)));
              return { code: "ai_turn_failed", message: "boom" };
            }),
        });
        yield* runner.start({ turnId: "t4", userId: "u1", run: () => Effect.fail("kaboom") });
        const messages = yield* collect(runner.attach("t4", -1));
        expect(messages).toEqual([{ type: "error", error: "ai_turn_failed", message: "boom" }, { type: "done" }]);
        expect(failures).toEqual(["kaboom"]);
      }),
    ));

  test("scopes turn lookup to the owning user", () =>
    run(
      Effect.gen(function* () {
        const { storage } = memoryStorage();
        const runner = makeRunner(storage);
        yield* runner.start({ turnId: "t5", userId: "owner", run: () => Effect.void });
        expect(yield* runner.lookup("t5", "owner")).toBe("found");
        expect(yield* runner.lookup("t5", "intruder")).toBe("unauthorized");
        expect(yield* runner.lookup("missing", "owner")).toBe("not_found");
      }),
    ));

  test("supersedes a still-running turn when a new turn starts", () =>
    run(
      Effect.gen(function* () {
        const { storage } = memoryStorage();
        const runner = makeRunner(storage);
        const started = yield* Deferred.make<void>();
        yield* runner.start({
          turnId: "old",
          userId: "u1",
          run: (emit) =>
            emit.event({ kind: "assistant", text: "old turn" }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
            ),
        });
        yield* Deferred.await(started);
        yield* runner.start({ turnId: "new", userId: "u1", run: (emit) => emit.event({ kind: "assistant", text: "new turn" }) });

        const old = yield* collect(runner.attach("old", -1));
        expect(old.at(-2)).toMatchObject({ type: "error", error: "ai_turn_superseded" });
        const fresh = yield* collect(runner.attach("new", -1));
        expect(fresh.at(-2)).toEqual({ type: "status", status: "ready" });
      }),
    ));

  test("times out a turn that runs past its deadline", () =>
    run(
      Effect.gen(function* () {
        const { storage } = memoryStorage();
        const runner = makeRunner(storage, { deadline: "30 millis" });
        yield* runner.start({ turnId: "slow", userId: "u1", run: () => Effect.never });
        const messages = yield* collect(runner.attach("slow", -1));
        expect(messages.at(-2)).toMatchObject({ type: "error", error: "ai_turn_timeout" });
      }),
    ));

  test("replays a finished turn from storage after the object restarts", () =>
    run(
      Effect.gen(function* () {
        const { storage } = memoryStorage();
        const first = makeRunner(storage);
        yield* first.start({
          turnId: "t6",
          userId: "u1",
          run: (emit) =>
            emit.resolvedUserMessage("two eggs").pipe(Effect.andThen(emit.event({ kind: "assistant", text: "Logged." }))),
        });
        yield* collect(first.attach("t6", -1));

        const restarted = makeRunner(storage);
        expect(yield* restarted.lookup("t6", "u1")).toBe("found");
        const messages = yield* collect(restarted.attach("t6", 1));
        expect(messages).toEqual([
          { type: "event", event: { kind: "assistant", text: "Logged." }, seq: 2 },
          { type: "status", status: "ready" },
          { type: "done" },
        ]);
      }),
    ));

  test("finishes a turn orphaned by a restart and deletes it after retention", () =>
    run(
      Effect.gen(function* () {
        const { storage, data, state } = memoryStorage();
        const first = makeRunner(storage, { retention: "20 millis" });
        yield* first.start({ turnId: "t7", userId: "u1", run: (emit) => emit.event({ kind: "assistant", text: "hi" }).pipe(Effect.andThen(Effect.never)) });
        yield* Effect.sleep("5 millis");
        expect(state.alarm).not.toBeNull();

        // A new instance on the same storage: the running turn has no fiber.
        const restarted = makeRunner(storage, { retention: "20 millis" });
        const messages = yield* collect(restarted.attach("t7", -1));
        expect(messages.at(-2)).toMatchObject({ type: "error", error: "ai_turn_interrupted" });

        yield* Effect.sleep("30 millis");
        state.alarm = null;
        yield* restarted.alarm;
        expect([...data.keys()]).toEqual([]);
        expect(yield* restarted.lookup("t7", "u1")).toBe("not_found");
      }),
    ));
});
