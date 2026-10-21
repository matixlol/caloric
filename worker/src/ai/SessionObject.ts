import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Prompt from "effect/ai/Prompt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { FoodSearch } from "../search/FoodSearch.ts";
import { runAssistantLoop } from "./Agent.ts";
import {
  AiSessionNotFound,
  AiStoreError,
  type StartTurnInput,
  type TurnLookup,
} from "./Domain.ts";
import { AssistantModelLive } from "./Model.ts";
import { AiSessionStore } from "./SessionStore.ts";
import { turnEventStream } from "./Sse.ts";
import { makeTurnRunner, type TurnStorage } from "./Turns.ts";

// One Durable Object per AI session (addressed by session id). It is the only
// writer of the session's conversation while a turn runs, runs turns detached
// from requests, and keeps their events for replay (see Turns.ts).

export interface AiSessionObjectShape {
  // Supersedes any running turn, appends the user message to the stored
  // session and starts the turn. Fails when the session isn't the user's.
  readonly startTurn: (input: StartTurnInput) => Effect.Effect<void, AiSessionNotFound | AiStoreError>;
  readonly lookupTurn: (turnId: string, userId: string) => Effect.Effect<TurnLookup>;
  readonly fetch: HttpEffect<Cloudflare.DurableObjectState | RuntimeContext>;
  readonly alarm: (info?: Cloudflare.AlarmInvocationInfo) => Effect.Effect<void>;
}

export class AiSessionObject extends Cloudflare.DurableObject<AiSessionObject, AiSessionObjectShape>()("AiSession", {
  errors: [AiSessionNotFound, AiStoreError],
}) {}

const userMessage = (input: StartTurnInput): Prompt.Message => {
  const text = input.message ? [Prompt.makePart("text", { text: input.message })] : [];
  const media = input.media.map((part) =>
    part.type === "image"
      ? Prompt.makePart("file", { mediaType: part.mediaType, data: part.dataUrl })
      : Prompt.makePart("file", { mediaType: part.mediaType, data: part.base64, fileName: part.fileName }),
  );
  return Prompt.makeMessage("user", { content: [...text, ...media] });
};

export const AiSessionObjectLive = AiSessionObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const store = yield* AiSessionStore;
    const foodSearch = yield* FoodSearch;
    const model = yield* LanguageModel.LanguageModel;

    return Effect.gen(function* () {
      // Storage calls need the instance's runtime context; turns run detached
      // from the call that started them, so it is captured once here.
      const runtime = yield* RuntimeContext;
      const inRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, RuntimeContext, runtime);
      const storage: TurnStorage = {
        get: (key) => inRuntime(state.storage.get(key)),
        put: (entries) => inRuntime(state.storage.put(entries)),
        list: (prefix) => inRuntime(state.storage.list({ prefix })),
        delete: (keys) => inRuntime(state.storage.delete([...keys])).pipe(Effect.asVoid),
        getAlarm: inRuntime(state.storage.getAlarm()),
        setAlarm: (at) => inRuntime(state.storage.setAlarm(at)),
      };

      const runner = makeTurnRunner({
        storage,
        onFailure: (cause) =>
          Effect.logError("ai.turn_failed", cause).pipe(Effect.as({ code: "ai_turn_failed", message: "Unknown error." })),
        keepAlive: (running) => inRuntime(state.waitUntil(running)),
      });
      // Starting is load-then-save on the shared conversation; serialize it.
      const starting = yield* Semaphore.make(1);

      const startTurn = Effect.fn("AiSession.startTurn")(function* (input: StartTurnInput) {
        yield* runner.supersede;
        const session = yield* store.load(input.sessionId, input.userId);
        if (!session) return yield* new AiSessionNotFound({ sessionId: input.sessionId });
        session.conversation.push(userMessage(input));
        yield* store.save(session);

        yield* runner.start({
          turnId: input.turnId,
          userId: input.userId,
          run: (emit) =>
            Effect.gen(function* () {
              if (input.message) yield* emit.resolvedUserMessage(input.message);
              yield* runAssistantLoop(session, {
                emit: emit.event,
                onUsage: (usage) => Effect.logInfo("ai.model.usage").pipe(Effect.annotateLogs({ ...usage })),
              });
              yield* inRuntime(store.save(session));
            }).pipe(
              Effect.provideService(LanguageModel.LanguageModel, model),
              Effect.provideService(FoodSearch, foodSearch),
              Effect.annotateLogs({ sessionId: input.sessionId, turnId: input.turnId }),
            ),
        });
      }, starting.withPermit);

      return {
        startTurn,
        lookupTurn: runner.lookup,
        // GET /attach?turnId=&cursor= streams the turn as SSE (messages after
        // `cursor`; callers check ownership with lookupTurn first). Served over
        // fetch rather than RPC: Alchemy closes an RPC call's scope when it
        // returns, which would cut a live stream short.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const params = new URL(request.url, "http://ai-session").searchParams;
          const turnId = params.get("turnId") ?? "";
          const cursor = Number(params.get("cursor") ?? Number.NaN);
          return turnEventStream(turnId, runner.attach(turnId, Number.isFinite(cursor) ? cursor : -1));
        }),
        alarm: () => runner.alarm.pipe(Effect.catchCause((cause) => Effect.logError("ai.turn_alarm_failed", cause))),
      } satisfies AiSessionObjectShape;
    });
  }),
).pipe(Layer.provide([AiSessionStore.layer, AssistantModelLive]));
