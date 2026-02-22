export type RecentLogHint = {
  foodName: string;
  meal?: string;
  brand?: string;
  serving?: string;
  createdAt?: number;
  dateKey?: string;
};

const maxRecentLogHints = 120;
const maxDisplayHints = 40;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, maxLength);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

export function parseRecentLogHints(raw: unknown): RecentLogHint[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const parsed: RecentLogHint[] = [];

  for (const item of raw) {
    if (parsed.length >= maxRecentLogHints) {
      break;
    }

    const record = asRecord(item);
    if (!record) {
      continue;
    }

    const foodName = asTrimmedString(record.foodName, 120);
    if (!foodName) {
      continue;
    }

    parsed.push({
      foodName,
      meal: asTrimmedString(record.meal, 32),
      brand: asTrimmedString(record.brand, 80),
      serving: asTrimmedString(record.serving, 80),
      createdAt: asFiniteNumber(record.createdAt),
      dateKey: asTrimmedString(record.dateKey, 24),
    });
  }

  parsed.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return parsed;
}

export function buildRecentLogContextPrompt(hints: RecentLogHint[]): string | null {
  if (hints.length === 0) {
    return null;
  }

  const lines = hints.slice(0, maxDisplayHints).map((hint) => {
    const parts = [hint.dateKey, hint.meal, hint.foodName, hint.brand, hint.serving].filter(
      (value): value is string => Boolean(value && value.trim()),
    );
    return `- ${parts.join(" | ")}`;
  });

  if (lines.length === 0) {
    return null;
  }

  return [
    "User context from the last 3 days of logged foods (noisy voice hints may refer to these).",
    "Use this list to resolve likely ASR/transcription mistakes and map to likely foods before searching.",
    "Examples: 'laga banana' -> banana; incorrect ASR 'anana protein scoop' likely means intended query 'ena protein scoop' -> the matching Ena whey/protein item from recent logs.",
    "If a phrase likely contains multiple foods, split it and search each likely item.",
    ...lines,
  ].join("\n");
}
