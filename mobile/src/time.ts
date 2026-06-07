export function formatRelativeTimestamp(value: number): string {
  const timestamp = new Date(value);
  const time = timestamp.getTime();
  if (!Number.isFinite(value) || value <= 0 || Number.isNaN(time)) {
    return "Never";
  }

  const elapsedMs = Math.max(Date.now() - time, 0);
  const relativeUnit: readonly [number, string] | null = elapsedMs < 60_000
    ? null
    : elapsedMs < 3_600_000
      ? [60_000, "m"]
      : elapsedMs < 86_400_000
        ? [3_600_000, "h"]
        : elapsedMs < 604_800_000
          ? [86_400_000, "d"]
          : null;

  if (elapsedMs < 60_000) {
    return "Just now";
  }

  if (relativeUnit) {
    return `${Math.floor(elapsedMs / relativeUnit[0])}${relativeUnit[1]} ago`;
  }

  return timestamp.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
