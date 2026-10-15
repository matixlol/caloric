import { buildRecentLogContextPrompt, parseRecentLogHints } from "../ai-log-context";
import { config } from "../config";
import { isObjectRecord, jsonResponse, requireAuthenticatedUser } from "../http";
import { createAiSessionId, createAiTurnId } from "../id";
import { logError, summarizeText } from "../logging";
import { Sentry } from "../lib/sentry";
import { z } from "zod";
import { fastSystemPrompt, runAssistantLoop, systemPrompt, type AssistantModel } from "./ai-agent";
import { createAssistantModel } from "./ai-models";
import {
  createAiSession,
  loadAiSession,
  saveAiSession,
  type AiSessionState,
  type AssistantVariant,
} from "./ai-store";
import {
  createTurnSseResponse,
  getResumableTurn,
  isResumableTurnPresent,
  startResumableTurn,
} from "./ai-turns";
import { transcodeAudioToWav } from "./audio";
import { searchUnifiedFoods } from "./search";

const UserMessageActionSchema = z.object({
  type: z.literal("user-message"),
  message: z.string().trim().optional(),
});

const ApprovalActionSchema = z.object({
  type: z.literal("approval"),
  toolCallId: z.string().trim().min(1),
  suggestionId: z.string().trim().min(1),
  approved: z.boolean(),
});

const JsonActionSchema = z.discriminatedUnion("type", [UserMessageActionSchema, ApprovalActionSchema]);

type AgentAction = z.infer<typeof JsonActionSchema>;
type UserMessageAction = z.infer<typeof UserMessageActionSchema>;
type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

const maxImageCount = 4;
const maxImageBytes = 8 * 1024 * 1024;
const imageMediaTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

const sentryPayloadMaxLength = 80_000;
const geminiSpanCallCounters = new WeakMap<object, number>();

function truncateForSentry(value: string, maxLength = sentryPayloadMaxLength): { value: string; truncated: boolean } {
  if (value.length <= maxLength) {
    return {
      value,
      truncated: false,
    };
  }

  return {
    value: `${value.slice(0, maxLength - 3)}...`,
    truncated: true,
  };
}

function headerRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    Array.from(headers.entries()).map(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      return [
        key,
        normalizedKey === "authorization" || normalizedKey === "x-goog-api-key" ? "[redacted]" : value,
      ];
    }),
  );
}

async function requestBodyText(request: Request): Promise<string | null> {
  if (!request.body) {
    return null;
  }

  try {
    return await request.clone().text();
  } catch (error) {
    return `[unavailable: ${stringifyUnknownError(error)}]`;
  }
}

function addGeminiSpanEvent(
  name: string,
  attributes: Record<string, string | number | boolean | null | undefined>,
): void {
  const compactAttributes: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      compactAttributes[key] = value;
    }
  }

  Sentry.getActiveSpan()?.addEvent(name, compactAttributes);
}

function nextGeminiSpanCallIndex(): number {
  const span = Sentry.getActiveSpan();
  if (!span) {
    return 1;
  }

  const next = (geminiSpanCallCounters.get(span) ?? 0) + 1;
  geminiSpanCallCounters.set(span, next);
  span.setAttributes({
    "app.ai.gemini.call_count": next,
  });

  return next;
}

async function fetchWithGeminiSentryLogging(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
  const callIndex = nextGeminiSpanCallIndex();
  const startedAt = performance.now();
  const rawRequestBody = await requestBodyText(request);
  const requestBody = rawRequestBody ? truncateForSentry(rawRequestBody) : null;

  addGeminiSpanEvent("gemini.request", {
    "app.ai.gemini.call_index": callIndex,
    "http.request.method": request.method,
    "url.full": request.url,
    "http.request.headers": JSON.stringify(headerRecord(request.headers)),
    "http.request.body": requestBody?.value,
    "http.request.body_length": rawRequestBody?.length ?? 0,
    "http.request.body_truncated": requestBody?.truncated ?? false,
  });

  try {
    const response = await fetch(request);
    const clonedResponse = response.clone();

    clonedResponse
      .text()
      .then((rawResponseBody) => {
        const responseBody = truncateForSentry(rawResponseBody);
        addGeminiSpanEvent("gemini.response", {
          "app.ai.gemini.call_index": callIndex,
          "http.response.status_code": response.status,
          "http.response.headers": JSON.stringify(headerRecord(response.headers)),
          "http.response.body": responseBody.value,
          "http.response.body_length": rawResponseBody.length,
          "http.response.body_truncated": responseBody.truncated,
          "app.ai.gemini.duration_ms": Math.round(performance.now() - startedAt),
        });
      })
      .catch((error) => {
        addGeminiSpanEvent("gemini.response_body_failed", {
          "app.ai.gemini.call_index": callIndex,
          "http.response.status_code": response.status,
          "app.ai.gemini.error": stringifyUnknownError(error),
          "app.ai.gemini.duration_ms": Math.round(performance.now() - startedAt),
        });
      });

    return response;
  } catch (error) {
    addGeminiSpanEvent("gemini.fetch_failed", {
      "app.ai.gemini.call_index": callIndex,
      "app.ai.gemini.error": stringifyUnknownError(error),
      "app.ai.gemini.duration_ms": Math.round(performance.now() - startedAt),
    });

    throw error;
  }
}

function stringifyUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function captureUnknownError(code: string, error: unknown) {
  const isConnectionClosed =
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.includes("connection was closed") ||
      error.message.includes("Connection closed") ||
      error.message.includes("stream closed"));

  const errorForCapture =
    error instanceof Error ? error : new Error(`${code}: ${summarizeText(stringifyUnknownError(error), 500)}`);

  Sentry.getActiveSpan()?.setAttributes({
    "app.error.code": code,
    "app.error.exposed": false,
    "app.error.is_connection_closed": isConnectionClosed,
  });

  logError(`api.${code}`, errorForCapture);

  if (!isConnectionClosed) {
    Sentry.captureException(errorForCapture);
  }
}

function reportUnknownError(code: string, error: unknown): Response {
  captureUnknownError(code, error);

  return jsonResponse(
    {
      error: code,
      message: "Unknown error.",
    },
    502,
  );
}

function modelProviderKeys() {
  return {
    googleAiStudioApiKey: config.googleAiStudioApiKey,
    openRouterApiKey: config.openRouterApiKey,
    fetch: fetchWithGeminiSentryLogging as typeof fetch,
  };
}

function createSessionModel(variant: AssistantVariant): AssistantModel {
  return variant === "next"
    ? createAssistantModel(config.aiNextModel, config.aiNextThinkingLevel, modelProviderKeys())
    : createAssistantModel(`google:${config.geminiModel}`, config.geminiThinkingLevel, modelProviderKeys());
}

function isNextAssistantUser(userId: string): boolean {
  return config.aiNextUserIds.includes("*") || config.aiNextUserIds.includes(userId);
}

async function encodeAudioFile(audioFile: File, decodeToWav = false): Promise<{ data: string; mediaType: string }> {
  if (audioFile.size <= 0) {
    throw new Error("Audio snippet was empty.");
  }

  if (audioFile.size > 12 * 1024 * 1024) {
    throw new Error("Audio snippet is too large (max 12 MB).");
  }

  const bytes = new Uint8Array(await audioFile.arrayBuffer());
  if (decodeToWav) {
    // Several audio-native models only accept WAV/MP3/FLAC, so phones keep
    // uploading compact m4a and the server decodes it.
    try {
      return { data: (await transcodeAudioToWav(bytes)).toString("base64"), mediaType: "audio/wav" };
    } catch (error) {
      captureUnknownError("ai_audio_decode_failed", error);
    }
  }

  const data = Buffer.from(bytes).toString("base64");
  const mediaType = audioFile.type.trim().toLowerCase().startsWith("audio/") ? audioFile.type.trim().toLowerCase() : "audio/mp4";

  return {
    data,
    mediaType,
  };
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function encodeImageFile(imageFile: File): Promise<{ data: string; mediaType: string }> {
  const mediaType = imageFile.type.trim().toLowerCase();
  if (!imageMediaTypes.has(mediaType)) {
    throw new Error("Photos must be JPEG, PNG, WebP, or HEIC.");
  }

  if (imageFile.size <= 0 || imageFile.size > maxImageBytes) {
    throw new Error("Photo is too large (max 8 MB).");
  }

  return {
    data: Buffer.from(await imageFile.arrayBuffer()).toString("base64"),
    mediaType,
  };
}

async function parseTurnRequest(request: Request): Promise<
  | {
      sessionId: string;
      action: AgentAction;
      audioFile: File | null;
      imageFiles: File[];
    }
  | Response
> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonResponse({ error: "Invalid multipart body" }, 400);
    }

    const rawSessionId = formData.get("sessionId");
    const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
    if (!sessionId) {
      return jsonResponse({ error: "sessionId is required" }, 400);
    }

    const rawActionType = formData.get("actionType");
    const actionType = typeof rawActionType === "string" ? rawActionType.trim() : "";
    if (!actionType) {
      return jsonResponse({ error: "actionType is required" }, 400);
    }

    if (actionType === "user-message") {
      const rawMessage = formData.get("message");
      const message = typeof rawMessage === "string" ? rawMessage.trim() : undefined;
      const parsedAction = UserMessageActionSchema.safeParse({
        type: "user-message",
        ...(message ? { message } : {}),
      });
      if (!parsedAction.success) {
        return jsonResponse({ error: "Invalid action payload" }, 400);
      }

      const audioField = formData.get("audio");
      const audioFile = audioField instanceof File && audioField.size > 0 ? audioField : null;
      const imageFiles = formData.getAll("image").filter((field): field is File => field instanceof File && field.size > 0);
      if (imageFiles.length > maxImageCount) {
        return jsonResponse({ error: `Attach at most ${maxImageCount} photos` }, 400);
      }

      return {
        sessionId,
        action: parsedAction.data,
        audioFile,
        imageFiles,
      };
    }

    if (actionType === "approval") {
      const parsedAction = ApprovalActionSchema.safeParse({
        type: "approval",
        toolCallId: typeof formData.get("toolCallId") === "string" ? formData.get("toolCallId") : "",
        suggestionId: typeof formData.get("suggestionId") === "string" ? formData.get("suggestionId") : "",
        approved: formData.get("approved") === "true",
      });

      if (!parsedAction.success) {
        return jsonResponse({ error: "Invalid action payload" }, 400);
      }

      return {
        sessionId,
        action: parsedAction.data,
        audioFile: null,
        imageFiles: [],
      };
    }

    return jsonResponse({ error: `Unsupported action type: ${actionType}` }, 400);
  }

  const body = await parseJsonBody(request);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    return jsonResponse({ error: "sessionId is required" }, 400);
  }

  const parsedAction = JsonActionSchema.safeParse(body?.action);
  if (!parsedAction.success) {
    return jsonResponse({ error: "Invalid action payload" }, 400);
  }

  return {
    sessionId,
    action: parsedAction.data,
    audioFile: null,
    imageFiles: [],
  };
}

export async function handleAiSessionRequest(request: Request): Promise<Response> {
  const auth = await requireAuthenticatedUser(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const body = await parseJsonBody(request);
    const recentLogHints = parseRecentLogHints(body?.recentLogs);
    const recentLogContextPrompt = buildRecentLogContextPrompt(recentLogHints);

    Sentry.getActiveSpan()?.setAttributes({
      "app.ai.endpoint": "/ai/session",
      "app.ai.recent_log_count": recentLogHints.length,
    });

    // The client's hidden toggle wins; otherwise the server-side allowlist decides.
    const variant: AssistantVariant =
      body?.variant === "next" || body?.variant === "classic"
        ? body.variant
        : isNextAssistantUser(auth.userId)
          ? "next"
          : "classic";
    Sentry.getActiveSpan()?.setAttribute("app.ai.variant", variant);

    const sessionId = createAiSessionId();
    await createAiSession({
      id: sessionId,
      userId: auth.userId,
      variant,
      conversation: [
        {
          role: "system",
          content: variant === "next" ? fastSystemPrompt : systemPrompt,
        },
        ...(recentLogContextPrompt
          ? [
              {
                role: "system" as const,
                content: recentLogContextPrompt,
              },
            ]
          : []),
      ],
      searchResultCounter: 1,
      searchResultsByLocalId: {},
      pendingApprovals: {},
    });

    return jsonResponse({
      sessionId,
      status: "ready",
      variant,
    });
  } catch (error) {
    return reportUnknownError("ai_session_failed", error);
  }
}

export async function handleAiConfigRequest(request: Request): Promise<Response> {
  const auth = await requireAuthenticatedUser(request);
  if (auth instanceof Response) {
    return auth;
  }

  const variant: AssistantVariant = isNextAssistantUser(auth.userId) ? "next" : "classic";
  return jsonResponse({ variant });
}

export async function handleAiTurnRequest(request: Request): Promise<Response> {
  const auth = await requireAuthenticatedUser(request);
  if (auth instanceof Response) {
    return auth;
  }

  const parsed = await parseTurnRequest(request);
  if (parsed instanceof Response) {
    return parsed;
  }

  const session = await loadAiSession(parsed.sessionId, auth.userId);
  if (!session) {
    return jsonResponse({ error: "Session not found for this user" }, 403);
  }

  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.endpoint": "/ai/turn",
    "app.ai.session_id": parsed.sessionId,
    "app.ai.action_type": parsed.action.type,
    "app.ai.has_audio": Boolean(parsed.audioFile),
    "app.ai.image_count": parsed.imageFiles.length,
    "app.ai.variant": session.variant,
    "app.ai.pending_approval_count": Object.keys(session.pendingApprovals).length,
  });

  try {
    if (parsed.action.type === "user-message") {
      if (parsed.imageFiles.length > 0 && session.variant !== "next") {
        return jsonResponse({ error: "Photos require the next assistant" }, 400);
      }

      return await handleUserMessageAction(request, session, parsed.action, parsed.audioFile, parsed.imageFiles);
    }

    return handleApprovalAction(request, session, parsed.action);
  } catch (error) {
    return reportUnknownError("ai_turn_failed", error);
  }
}

async function handleUserMessageAction(
  request: Request,
  session: AiSessionState,
  action: UserMessageAction,
  audioFile: File | null,
  imageFiles: File[],
): Promise<Response> {
  const message = action.message?.trim() ?? "";

  if (!message && !audioFile && imageFiles.length === 0) {
    return jsonResponse({ error: "action.message, audio, or a photo is required" }, 400);
  }

  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.user_message_length": message.length,
  });

  if (audioFile || imageFiles.length > 0) {
    type UserPart =
      | { type: "text"; text: string }
      | { type: "image"; image: string; mediaType: string }
      | { type: "file"; data: string; mediaType: string; filename?: string };
    const content: UserPart[] = [];

    if (message) {
      content.push({
        type: "text",
        text: message,
      });
    }

    for (const imageFile of imageFiles) {
      let encodedImage: { data: string; mediaType: string };
      try {
        encodedImage = await encodeImageFile(imageFile);
      } catch (error) {
        return jsonResponse({ error: "invalid_image", message: error instanceof Error ? error.message : "Invalid photo." }, 400);
      }

      content.push({
        type: "image",
        image: encodedImage.data,
        mediaType: encodedImage.mediaType,
      });
    }

    if (audioFile) {
      const encodedAudio = await encodeAudioFile(audioFile, session.variant === "next" && config.aiNextAudioWav);
      content.push({
        type: "file",
        data: encodedAudio.data,
        mediaType: encodedAudio.mediaType,
        filename: audioFile.name || undefined,
      });
    }

    session.conversation.push({
      role: "user",
      content,
    });
  } else {
    session.conversation.push({
      role: "user",
      content: message,
    });
  }

  // Approval cards are now client-local only; clear any stale server-side state from older sessions.
  session.pendingApprovals = {};
  await saveAiSession(session);

  // Run the turn detached from this request so it keeps going (and stays
  // resumable) even if the client disconnects, e.g. when the app is backgrounded.
  // Deliberately do NOT forward `request.signal` here: it aborts as soon as the
  // client disconnects (which the app does on backgrounding), and wiring it into
  // the run would abort the in-flight LLM call and finalize the turn as an error
  // even though the user only backgrounded mid-turn. The run is bounded by the
  // internal deadline and by being superseded by a newer turn on this session;
  // `request.signal` still tears down this SSE viewer below.
  const record = startResumableTurn({
    turnId: createAiTurnId(),
    userId: session.userId,
    sessionId: session.id,
    onError: (error) => {
      captureUnknownError("ai_turn_failed", error);
      return { code: "ai_turn_failed", message: "Unknown error." };
    },
    run: async (emit, signal) => {
      if (message) {
        emit.resolvedUserMessage(message);
      }

      await runAssistantLoop(session, {
        assistant: createSessionModel(session.variant),
        search: searchUnifiedFoods,
        repair: session.variant === "next",
        parallelSearch: session.variant === "next",
        onEvent: emit.event,
        signal,
      });

      await saveAiSession(session);
    },
  });

  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.turn_id": record.id,
  });

  return createTurnSseResponse(record, -1, request.signal);
}

export async function handleAiTurnStreamRequest(request: Request, turnIdParam: string | undefined): Promise<Response> {
  const auth = await requireAuthenticatedUser(request);
  if (auth instanceof Response) {
    return auth;
  }

  const turnId = turnIdParam?.trim() ?? "";
  if (!turnId) {
    return jsonResponse({ error: "turnId is required" }, 400);
  }

  const record = getResumableTurn(turnId, auth.userId);
  if (!record) {
    if (isResumableTurnPresent(turnId)) {
      // The turn exists but belongs to a different user.
      return jsonResponse({ error: "turn_unauthorized" }, 404);
    }

    // The turn finished and aged out of memory, or never existed.
    return jsonResponse({ error: "turn_not_found" }, 404);
  }

  const cursorParam = new URL(request.url).searchParams.get("cursor");
  const parsedCursor = cursorParam === null ? Number.NaN : Number(cursorParam);
  const cursor = Number.isFinite(parsedCursor) ? parsedCursor : -1;

  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.endpoint": "/ai/turn/:turnId/stream",
    "app.ai.turn_id": turnId,
    "app.ai.resume_cursor": cursor,
  });

  return createTurnSseResponse(record, cursor, request.signal);
}

async function handleApprovalAction(request: Request, session: AiSessionState, action: ApprovalAction): Promise<Response> {
  Sentry.getActiveSpan()?.setAttributes({
    "app.ai.approval.tool_call_id": action.toolCallId,
    "app.ai.approval.suggestion_id": action.suggestionId,
    "app.ai.approval.approved": action.approved,
  });
  session.pendingApprovals = {};
  await saveAiSession(session);

  return jsonResponse({
    status: "ready",
    events: [],
  });
}
