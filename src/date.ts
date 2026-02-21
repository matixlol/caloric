const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function localDateKeyFromTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function getTodayLocalDateKey(): string {
  return localDateKeyFromTimestamp(Date.now());
}

export function parseLocalDateKey(dateKey: string): Date | null {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const parsed = new Date(year, month - 1, day);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

export function normalizeLocalDateKey(
  maybeDateKey: string | undefined,
  fallbackTimestamp: number,
): string {
  if (maybeDateKey && parseLocalDateKey(maybeDateKey)) {
    return maybeDateKey;
  }

  return localDateKeyFromTimestamp(fallbackTimestamp);
}

export function shiftLocalDateKey(dateKey: string, deltaDays: number): string {
  const baseDate = parseLocalDateKey(dateKey) ?? new Date();
  const shiftedDate = new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate() + deltaDays,
  );

  return localDateKeyFromTimestamp(shiftedDate.getTime());
}
