import { type SearchFood as SharedSearchFood } from "../food-search";

export const BACKEND_BASE_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL?.trim() ?? "").replace(/\/+$/, "") ||
  "https://backend.caloric.mati.lol";

export type Meal = "breakfast" | "lunch" | "dinner" | "snacks";

export type ApprovalOutput = {
  approved: boolean;
  reason?: string;
};

export type ChatStatus = "ready" | "streaming";

export type SearchResultFood = SharedSearchFood & {
  resultId: string;
};

export type ResolvedApprovalSuggestion = {
  suggestionId: string;
  resultId: string;
  meal: Meal;
  portion: number;
  reason: string;
  food: SearchResultFood;
  output?: ApprovalOutput;
};

export type TextUIMessage = {
  id: string;
  kind: "text";
  role: "user" | "assistant";
  text: string;
};

export type AudioUIMessage = {
  id: string;
  kind: "audio";
  role: "user";
  label: string;
  durationLabel: string;
};

export type SearchUIMessage = {
  id: string;
  kind: "search";
  query?: string;
  foods: SearchResultFood[];
};

export type ApprovalUIMessage = {
  id: string;
  kind: "approval";
  toolCallId: string;
  suggestions: ResolvedApprovalSuggestion[];
};

export type UIMessage = TextUIMessage | AudioUIMessage | SearchUIMessage | ApprovalUIMessage;

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
      query?: string;
      foods: SearchResultFood[];
    }
  | {
      kind: "approval";
      toolCallId: string;
      suggestions: ResolvedApprovalSuggestion[];
    };

export type AgentAction = {
  type: "user-message";
  message?: string;
};

export type AudioUpload = {
  uri: string;
  mimeType: string;
  fileName: string;
};

export type TurnStreamOutcome = {
  // "ready"/"error" mean the server finished the turn; null means the stream ended
  // without a terminal message (e.g. the request was cancelled / app backgrounded)
  // and the turn is still running server-side, ready to be resumed.
  terminal: ChatStatus | "error" | null;
  errorMessage?: string;
};

export type ActiveTurn = {
  turnId: string;
  // Highest durable event sequence number applied so far; the resume cursor.
  appliedSeq: number;
  // Whether the server-resolved user message (e.g. an audio transcription) should
  // be rendered. False for typed messages, which are shown optimistically already.
  appendResolvedUserMessage: boolean;
};

export type RecentLogHintPayload = {
  foodName: string;
  meal?: string;
  brand?: string;
  serving?: string;
  createdAt?: number;
  dateKey?: string;
};

export type MaybeLoadedLogEntry = {
  $isLoaded?: boolean;
  foodName?: string;
  meal?: string;
  brand?: string;
  serving?: string;
  createdAt?: number;
  dateKey?: string;
};

export type StreamingPayload = {
  type?: unknown;
  status?: unknown;
  event?: unknown;
  resolvedUserMessage?: unknown;
  error?: unknown;
  message?: unknown;
  turnId?: unknown;
  seq?: unknown;
};

export const recentLogWindowMs = 3 * 24 * 60 * 60 * 1000;
export const maxRecentLogHints = 80;
// How long to wait before re-attaching to a turn whose stream was interrupted,
// and after a failed resume attempt, plus how many consecutive failures to
// tolerate before giving up on the turn.
export const interruptResumeDelayMs = 800;
export const resumeRetryDelayMs = 2000;
export const maxResumeRetries = 5;
export const recordingLockDistance = 54;
export const recordingCancelDistance = 82;
export const recordingWaveHeights = [10, 18, 12, 24, 15, 28, 12, 22, 16, 26, 13, 19, 11, 21];
export const audioBubbleWaveHeights = [8, 14, 10, 18, 12, 20, 9, 16, 11, 15];
