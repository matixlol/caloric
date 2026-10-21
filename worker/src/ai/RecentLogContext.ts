import * as Predicate from "effect/Predicate";

// Recent diary entries the app sends with POST /ai/session, used to steer the
// model toward foods the user actually eats (and to fix voice mis-hearings).

export interface RecentLogHint {
  readonly foodName: string;
  readonly meal?: string;
  readonly brand?: string;
  readonly serving?: string;
  readonly createdAt?: number;
  readonly dateKey?: string;
}

const maxRecentLogHints = 120;
const maxDisplayHints = 40;

// Hints are best-effort context: malformed fields are dropped one by one
// instead of rejecting the request, as backend/ did.
const text = (value: unknown, maxLength: number): string | undefined => {
  if (!Predicate.isString(value)) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
};

const finite = (value: unknown): number | undefined => {
  const parsed = Predicate.isNumber(value) ? value : Predicate.isString(value) ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const parseRecentLogHints = (raw: unknown): Array<RecentLogHint> => {
  if (!Array.isArray(raw)) return [];
  const parsed: Array<RecentLogHint> = [];
  for (const item of raw) {
    if (parsed.length >= maxRecentLogHints) break;
    if (!Predicate.isObject(item) || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const foodName = text(record.foodName, 120);
    if (!foodName) continue;
    parsed.push({
      foodName,
      meal: text(record.meal, 32),
      brand: text(record.brand, 80),
      serving: text(record.serving, 80),
      createdAt: finite(record.createdAt),
      dateKey: text(record.dateKey, 24),
    });
  }
  return parsed.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
};

export const buildRecentLogContextPrompt = (hints: ReadonlyArray<RecentLogHint>): string | null => {
  if (hints.length === 0) return null;
  const lines = hints.slice(0, maxDisplayHints).map((hint) => {
    const parts = [hint.dateKey, hint.meal, hint.foodName, hint.brand, hint.serving].filter(
      (value): value is string => Boolean(value && value.trim()),
    );
    return `- ${parts.join(" | ")}`;
  });
  return [
    "User context from the last 3 days of logged foods (noisy voice hints may refer to these).",
    "Use this list to resolve likely ASR/transcription mistakes and map to likely foods before searching.",
    "Examples: 'laga banana' -> banana; incorrect ASR 'anana protein scoop' likely means intended query 'ENA protein scoop' -> the matching ENA whey/protein item from recent logs.",
    "If a phrase likely contains multiple foods, split it and search each likely item.",
    ...lines,
  ].join("\n");
};
