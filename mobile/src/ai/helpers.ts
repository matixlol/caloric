import { File as ExpoFile } from "expo-file-system";
import { createAiMessageId } from "../id";
import {
  type AgentEvent,
  type AudioUpload,
  maxRecentLogHints,
  type MaybeLoadedLogEntry,
  type RecentLogHintPayload,
  recentLogWindowMs,
  type SearchResultFood,
  type StreamingPayload,
} from "./types";

export const createMessageId = () => createAiMessageId();

export function formatRecordingDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function cloneNutrition(nutrition: SearchResultFood["nutrition"]) {
  if (!nutrition) {
    return undefined;
  }

  return {
    calories: nutrition.calories,
    protein: nutrition.protein,
    carbs: nutrition.carbs,
    fat: nutrition.fat,
    fiber: nutrition.fiber,
    sugars: nutrition.sugars,
    sodiumMg: nutrition.sodiumMg,
    potassiumMg: nutrition.potassiumMg,
  };
}

export function formatCalories(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }

  return Math.round(value).toLocaleString();
}

export function inferSearchQueryFromFoods(foods: SearchResultFood[]): string {
  const ignoredTokens = new Set([
    "and",
    "con",
    "de",
    "del",
    "deshidratada",
    "food",
    "foods",
    "fresh",
    "la",
    "las",
    "los",
    "the",
    "with",
  ]);
  const counts = new Map<string, number>();

  for (const food of foods.slice(0, 6)) {
    const seenInFood = new Set<string>();
    const rawText = `${food.name} ${food.brand ?? ""}`.toLowerCase();
    const tokens = rawText.match(/[\p{L}\p{N}]{3,}/gu) ?? [];

    for (const token of tokens) {
      if (ignoredTokens.has(token) || seenInFood.has(token)) {
        continue;
      }

      seenInFood.add(token);
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  const [topToken, topCount] =
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];

  if (topToken && topCount >= 2) {
    return topToken;
  }

  return foods[0]?.name.trim() || "search results";
}

export function isErrorLike(value: unknown): value is { message?: unknown; stack?: unknown; name?: unknown } {
  return Boolean(value && typeof value === "object");
}

export class UIError extends Error {
  details?: string;
  // Stable, machine-readable code (e.g. the server's terminal error code) used to
  // tag/fingerprint the Sentry capture so distinct failures are distinguishable.
  code?: string;
  // Structured context attached to the Sentry capture (e.g. turnId, server code).
  context?: Record<string, unknown>;

  constructor(
    message: string,
    details?: string,
    options?: { code?: string; context?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "UIError";
    this.details = details?.trim() || undefined;
    this.code = options?.code?.trim() || undefined;
    this.context = options?.context;
  }
}

export function getErrorMessage(error: unknown): string {
  if (
    isErrorLike(error) &&
    typeof error.name === "string" &&
    error.name === "UIError" &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message.trim();
  }

  return "Unknown error.";
}

export function getErrorDetails(error: unknown): string | null {
  if (isErrorLike(error) && typeof error.name === "string" && error.name === "UIError") {
    const details = (error as UIError).details;
    if (typeof details === "string" && details.trim()) {
      return details.trim();
    }
  }

  return null;
}

export function getErrorCode(error: unknown): string | null {
  if (isErrorLike(error) && typeof error.name === "string" && error.name === "UIError") {
    const code = (error as UIError).code;
    if (typeof code === "string" && code.trim()) {
      return code.trim();
    }
  }

  return null;
}

export function isStreamingPayload(value: unknown): value is StreamingPayload {
  return Boolean(value && typeof value === "object");
}

export function normalizeStreamingPayloadEvent(value: unknown): AgentEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as AgentEvent;
}

export function parseSseEventsFromChunk(chunk: string): StreamingPayload[] {
  const normalized = chunk.replace(/\r\n/g, "\n");
  const segments = normalized.split("\n\n");
  const payloads: StreamingPayload[] = [];

  for (const segment of segments) {
    const dataLines = segment
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) {
      continue;
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(data);
      if (isStreamingPayload(parsed)) {
        payloads.push(parsed);
      }
    } catch {
      // Ignore malformed SSE chunks.
    }
  }

  return payloads;
}

export function buildErrorDetails(options: {
  method: string;
  url: string;
  status?: number;
  payload?: unknown;
  underlyingError?: unknown;
}): string {
  const lines = [`${options.method} ${options.url}`];

  if (typeof options.status === "number") {
    lines.push(`status: ${options.status}`);
  }

  if (options.payload !== undefined) {
    if (typeof options.payload === "string") {
      lines.push(`payload: ${options.payload}`);
    } else {
      try {
        lines.push(`payload: ${JSON.stringify(options.payload)}`);
      } catch {
        lines.push("payload: [unserializable]");
      }
    }
  }

  if (isErrorLike(options.underlyingError) && typeof options.underlyingError.message === "string") {
    const cause = options.underlyingError.message.trim();
    if (cause) {
      lines.push(`cause: ${cause}`);
    }
  }

  return lines.join("\n");
}

export function inferAudioMeta(uri: string): Pick<AudioUpload, "mimeType" | "fileName"> {
  const extension = uri.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1]?.toLowerCase();

  const mimeType =
    extension === "m4a"
      ? "audio/m4a"
      : extension === "caf"
        ? "audio/x-caf"
        : extension === "wav"
          ? "audio/wav"
          : extension === "mp3"
            ? "audio/mpeg"
            : "audio/m4a";

  const fileExtension = extension && extension.length > 0 ? extension : "m4a";

  return {
    mimeType,
    fileName: `voice-${Date.now()}.${fileExtension}`,
  };
}

export function createAudioUploadPart(audio: AudioUpload): Blob {
  const file = new ExpoFile(audio.uri);
  return {
    name: audio.fileName,
    type: audio.mimeType,
    bytes: () => file.bytes(),
  } as unknown as Blob;
}

export function buildRecentLogHints(logs: unknown, now = Date.now()): RecentLogHintPayload[] {
  if (!logs || typeof (logs as { forEach?: unknown }).forEach !== "function") {
    return [];
  }

  const cutoff = now - recentLogWindowMs;
  const output: RecentLogHintPayload[] = [];
  const rows = logs as { forEach: (callback: (entry: MaybeLoadedLogEntry) => void) => void };

  rows.forEach((entry) => {
    if (output.length >= maxRecentLogHints) {
      return;
    }

    if (!entry || entry.$isLoaded === false) {
      return;
    }

    const foodName = typeof entry.foodName === "string" ? entry.foodName.trim() : "";
    if (!foodName) {
      return;
    }

    const createdAt = Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : undefined;
    if (createdAt !== undefined && createdAt < cutoff) {
      return;
    }

    output.push({
      foodName,
      meal: typeof entry.meal === "string" ? entry.meal.trim() : undefined,
      brand: typeof entry.brand === "string" ? entry.brand.trim() : undefined,
      serving: typeof entry.serving === "string" ? entry.serving.trim() : undefined,
      createdAt,
      dateKey: typeof entry.dateKey === "string" ? entry.dateKey.trim() : undefined,
    });
  });

  output.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return output;
}
