import { RuntimeContext } from "alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api } from "../api/Api.ts";
import { CurrentUser } from "../api/Authentication.ts";
import { UpstreamFailure } from "../api/Errors.ts";
import { AudioTranscoder } from "../audio/AudioTranscoder.ts";
import { Auth } from "../auth/Auth.ts";
import { aiSessionId } from "../ids.ts";
import { systemMessage, systemPrompt } from "./Agent.ts";
import type { TurnMessage, UserMessagePart } from "./Domain.ts";
import { buildRecentLogContextPrompt, parseRecentLogHints } from "./RecentLogContext.ts";
import { AiSessionObject, AiSessionObjectLive } from "./SessionObject.ts";
import { AiSessionStore } from "./SessionStore.ts";
import { makeTurnId, sessionIdOfTurn } from "./TurnId.ts";
import {
  fallbackAudioMediaType,
  parseTurnRequest,
  TurnRejected,
  type UploadedFile,
  validateAudio,
  validateImage,
} from "./TurnRequest.ts";

// --- POST /ai/session (HttpApi) ---------------------------------------------

export const AiHandlers = HttpApiBuilder.group(
  Api,
  "ai",
  Effect.fn(function* (handlers) {
    const store = yield* AiSessionStore;
    return handlers.handle("session", ({ payload }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const recentLogContext = buildRecentLogContextPrompt(parseRecentLogHints(payload.recentLogs));
        const sessionId = aiSessionId();
        yield* store.create({
          id: sessionId,
          userId: user.id,
          conversation: [systemMessage(systemPrompt), ...(recentLogContext ? [systemMessage(recentLogContext)] : [])],
        });
        return { sessionId, status: "ready" as const };
      }).pipe(
        Effect.tapCause((cause) => Effect.logError("ai_session_failed", cause)),
        Effect.mapError(() => UpstreamFailure.fromCode("ai_session_failed")),
      ),
    );
  }),
).pipe(Layer.provide(AiSessionStore.layer));

// --- Turn routes (raw: SSE and multipart) -------------------------------------

const json = (body: unknown, status: number) => HttpServerResponse.jsonUnsafe(body, { status });

// Same bodies as the HttpApi Authentication middleware.
const unauthorized = () => new TurnRejected({ status: 401, body: { _tag: "Unauthorized", error: "Unauthorized" } });
const authUnavailable = () =>
  new TurnRejected({
    status: 503,
    body: { _tag: "ServiceUnavailable", error: "auth_unavailable", message: "Service temporarily unavailable." },
  });
const sessionNotFound = () => new TurnRejected({ status: 403, body: { error: "Session not found for this user" } });

const sseFrame = (message: TurnMessage | { readonly type: "turn"; readonly turnId: string }) =>
  message.type === "done" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(message)}\n\n`;

// The turn id frame, then the session object's messages; ends after `done`.
const sseResponse = (turnId: string, messages: Stream.Stream<TurnMessage, unknown>) =>
  HttpServerResponse.stream(
    Stream.concat(Stream.succeed({ type: "turn" as const, turnId }), messages).pipe(
      Stream.takeUntil((message) => message.type === "done"),
      Stream.map(sseFrame),
      Stream.encodeText,
    ),
    { contentType: "text/event-stream; charset=utf-8", headers: { "cache-control": "no-cache, no-transform" } },
  );

const toDataUrl = (mediaType: string, bytes: Uint8Array) => `data:${mediaType};base64,${Base64.encode(bytes)}`;

export const AiRoutes = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const auth = yield* Auth;
    const store = yield* AiSessionStore;
    const transcoder = yield* AudioTranscoder;
    const sessions = yield* AiSessionObject;

    const currentUserId = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      // Explicit headers: the ambient-request form would read the body, which
      // the turn route still needs.
      const session = yield* auth.getSession(new Headers(request.headers as Record<string, string>)).pipe(
        Effect.tapCause((cause) => Effect.logError("auth.session_lookup_failed", cause)),
        Effect.mapError(authUnavailable),
      );
      if (!session) return yield* unauthorized();
      return session.user.id;
    });

    // Several audio-native models only accept WAV/MP3/FLAC, so phones keep
    // uploading compact m4a and the container decodes it. If that fails the
    // original upload is sent as-is.
    const encodeAudio = Effect.fnUntraced(function* (file: UploadedFile) {
      yield* validateAudio(file);
      const wav = yield* transcoder.toWav(file.bytes, file.contentType).pipe(
        Effect.map((bytes) => ({ mediaType: "audio/wav", base64: Base64.encode(bytes) })),
        Effect.tapCause((cause) => Effect.logError("ai_audio_decode_failed", cause)),
        Effect.orElseSucceed(() => ({ mediaType: fallbackAudioMediaType(file), base64: Base64.encode(file.bytes) })),
      );
      return { type: "audio", ...wav, ...(file.name ? { fileName: file.name } : {}) } satisfies UserMessagePart;
    });

    const postTurn = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const userId = yield* currentUserId(request);
      const parsed = yield* parseTurnRequest(request);
      if (!(yield* store.exists(parsed.sessionId, userId))) return yield* sessionNotFound();

      if (parsed.action.type === "approval") {
        // Approval cards are client-local; clear stale server state from older sessions.
        yield* store.clearPendingApprovals(parsed.sessionId, userId);
        return json({ status: "ready", events: [] }, 200);
      }

      const { message } = parsed.action;
      const images = "images" in parsed ? parsed.images : [];
      const audio = "audio" in parsed ? parsed.audio : undefined;
      if (!message && !audio && images.length === 0) {
        return yield* new TurnRejected({ status: 400, body: { error: "action.message, audio, or a photo is required" } });
      }
      const media: Array<UserMessagePart> = [];
      for (const image of images) {
        const mediaType = yield* validateImage(image);
        media.push({ type: "image", mediaType, dataUrl: toDataUrl(mediaType, image.bytes) });
      }
      if (audio) media.push(yield* encodeAudio(audio));

      const turnId = yield* Option.match(makeTurnId(parsed.sessionId), {
        onNone: () => Effect.fail(sessionNotFound()),
        onSome: Effect.succeed,
      });
      const session = sessions.getByName(parsed.sessionId);
      yield* session
        .startTurn({ turnId, sessionId: parsed.sessionId, userId, message, media })
        .pipe(Effect.catchTag("AiSessionNotFound", () => Effect.fail(sessionNotFound())));
      yield* Effect.annotateCurrentSpan({ "app.ai.turn_id": turnId, "app.ai.image_count": images.length });
      return sseResponse(turnId, session.attachTurn(turnId, -1));
    });

    const resumeTurn = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const userId = yield* currentUserId(request);
      const turnId = ((yield* HttpRouter.params).turnId ?? "").trim();
      if (!turnId) return yield* new TurnRejected({ status: 400, body: { error: "turnId is required" } });

      const notFound = new TurnRejected({ status: 404, body: { error: "turn_not_found" } });
      const sessionId = yield* Option.match(sessionIdOfTurn(turnId), {
        onNone: () => Effect.fail(notFound),
        onSome: Effect.succeed,
      });
      const session = sessions.getByName(sessionId);
      const lookup = yield* session.lookupTurn(turnId, userId);
      // The turn finished and aged out, never existed, or is another user's.
      if (lookup === "not_found") return yield* notFound;
      if (lookup === "unauthorized") return yield* new TurnRejected({ status: 404, body: { error: "turn_unauthorized" } });

      const rawCursor = (yield* HttpServerRequest.ParsedSearchParams).cursor;
      const cursor = Number(Array.isArray(rawCursor) ? rawCursor[0] : (rawCursor ?? Number.NaN));
      return sseResponse(turnId, session.attachTurn(turnId, Number.isFinite(cursor) ? cursor : -1));
    });

    const respond =
      (code: string) =>
      <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) => {
            const error = Cause.findErrorOption(cause);
            return Option.isSome(error) && error.value instanceof TurnRejected
              ? Effect.succeed(json(error.value.body, error.value.status))
              : Effect.logError(code, cause).pipe(Effect.as(json({ error: code, message: "Unknown error." }, 502)));
          }),
          // D1 and Durable Object calls read Alchemy's per-request runtime
          // context, which the Worker provides at runtime (see Db.ts).
          Effect.provide(RuntimeContext.phantom),
        );

    yield* router.add("POST", "/ai/turn", respond("ai_turn_failed")(postTurn));
    yield* router.add("GET", "/ai/turn/:turnId/stream", respond("ai_turn_stream_failed")(resumeTurn));
  }),
).pipe(Layer.provide([AiSessionStore.layer, AiSessionObjectLive]));
