import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Multipart from "effect/http/Multipart";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

// Parses POST /ai/turn bodies: JSON `{ sessionId, action }` or multipart with
// `sessionId`, `actionType`, `message`, an `audio` file and up to four `image`
// files. Rejections keep backend/'s status codes and `{ error }` bodies.

export class TurnRejected extends Data.TaggedError("TurnRejected")<{
  readonly status: number;
  readonly body: { readonly error: string } & Readonly<Record<string, string>>;
}> {}

const reject = (status: number, error: string, message?: string) =>
  new TurnRejected({ status, body: message === undefined ? { error } : { error, message } });

export const maxImageCount = 4;

export interface UploadedFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

const NonEmptyTrimmed = Schema.Trim.check(Schema.isMinLength(1));

const UserMessageAction = Schema.Struct({
  type: Schema.Literal("user-message"),
  message: Schema.optionalKey(Schema.Trim),
});

const ApprovalAction = Schema.Struct({
  type: Schema.Literal("approval"),
  toolCallId: NonEmptyTrimmed,
  suggestionId: NonEmptyTrimmed,
  approved: Schema.Boolean,
});

const Action = Schema.Union([UserMessageAction, ApprovalAction]);

export type ParsedTurnRequest =
  | {
      readonly sessionId: string;
      readonly action: { readonly type: "user-message"; readonly message: string };
      readonly audio: UploadedFile | undefined;
      readonly images: ReadonlyArray<UploadedFile>;
    }
  | {
      readonly sessionId: string;
      readonly action: typeof ApprovalAction.Type;
    };

const decodeAction = (input: unknown) =>
  Option.match(Schema.decodeUnknownOption(Action)(input), {
    onNone: () => Effect.fail(reject(400, "Invalid action payload")),
    onSome: Effect.succeed,
  });

const trimmedString = (value: unknown) => (Predicate.isString(value) ? value.trim() : "");

const readMultipart = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const fields = new Map<string, string>();
    const files = new Map<string, Array<UploadedFile>>();
    yield* request.multipartStream.pipe(
      Stream.runForEach((part) =>
        part._tag === "Field"
          ? Effect.sync(() => {
              if (!fields.has(part.key)) fields.set(part.key, part.value);
            })
          : Effect.map(part.contentEffect, (bytes) => {
              const list = files.get(part.key) ?? [];
              list.push({ name: part.name, contentType: part.contentType, bytes });
              files.set(part.key, list);
            }),
      ),
    );
    return { fields, files };
  }).pipe(
    // Bounds memory; the per-type limits are enforced with backend/'s messages.
    Effect.provideContext(Multipart.limitsServices({ maxFileSize: "16 MB" })),
    Effect.mapError(() => reject(400, "Invalid multipart body")),
  );

const parseMultipart = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
): Effect.fn.Return<ParsedTurnRequest, TurnRejected> {
  const { fields, files } = yield* readMultipart(request);
  const sessionId = trimmedString(fields.get("sessionId"));
  if (!sessionId) return yield* reject(400, "sessionId is required");
  const actionType = trimmedString(fields.get("actionType"));
  if (!actionType) return yield* reject(400, "actionType is required");

  if (actionType === "user-message") {
    const message = trimmedString(fields.get("message"));
    const audio = (files.get("audio") ?? []).find((file) => file.bytes.byteLength > 0);
    const images = (files.get("image") ?? []).filter((file) => file.bytes.byteLength > 0);
    if (images.length > maxImageCount) return yield* reject(400, `Attach at most ${maxImageCount} photos`);
    return { sessionId, action: { type: "user-message", message }, audio, images } satisfies ParsedTurnRequest;
  }

  if (actionType === "approval") {
    const action = yield* Option.match(
      Schema.decodeUnknownOption(ApprovalAction)({
        type: "approval",
        toolCallId: fields.get("toolCallId") ?? "",
        suggestionId: fields.get("suggestionId") ?? "",
        approved: fields.get("approved") === "true",
      }),
      { onNone: () => Effect.fail(reject(400, "Invalid action payload")), onSome: Effect.succeed },
    );
    return { sessionId, action } satisfies ParsedTurnRequest;
  }

  return yield* reject(400, `Unsupported action type: ${actionType}`);
});

const parseJson = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
): Effect.fn.Return<ParsedTurnRequest, TurnRejected> {
  const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  const record: Record<string, unknown> = Predicate.isObject(body) && !Array.isArray(body) ? body : {};
  const sessionId = trimmedString(record.sessionId);
  if (!sessionId) return yield* reject(400, "sessionId is required");
  const action = yield* decodeAction(record.action);
  return action.type === "user-message"
    ? ({ sessionId, action: { type: "user-message", message: action.message ?? "" }, audio: undefined, images: [] } satisfies ParsedTurnRequest)
    : ({ sessionId, action } satisfies ParsedTurnRequest);
});

export const parseTurnRequest = (request: HttpServerRequest.HttpServerRequest) =>
  (request.headers["content-type"] ?? "").includes("multipart/form-data") ? parseMultipart(request) : parseJson(request);

// --- Media ------------------------------------------------------------------

const maxImageBytes = 8 * 1024 * 1024;
const maxAudioBytes = 12 * 1024 * 1024;
const imageMediaTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

export const validateImage = (file: UploadedFile): Effect.Effect<string, TurnRejected> => {
  const mediaType = file.contentType.trim().toLowerCase();
  if (!imageMediaTypes.has(mediaType)) {
    return Effect.fail(reject(400, "invalid_image", "Photos must be JPEG, PNG, WebP, or HEIC."));
  }
  if (file.bytes.byteLength > maxImageBytes) {
    return Effect.fail(reject(400, "invalid_image", "Photo is too large (max 8 MB)."));
  }
  return Effect.succeed(mediaType);
};

export class AudioTooLarge extends Data.TaggedError("AudioTooLarge")<{ readonly bytes: number }> {}

export const validateAudio = (file: UploadedFile) =>
  file.bytes.byteLength > maxAudioBytes ? Effect.fail(new AudioTooLarge({ bytes: file.bytes.byteLength })) : Effect.void;

// The upload's own type, used when transcoding fails (backend/ did the same).
export const fallbackAudioMediaType = (file: UploadedFile) => {
  const type = file.contentType.trim().toLowerCase();
  return type.startsWith("audio/") ? type : "audio/mp4";
};
