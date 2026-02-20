export const MIN_PORTION = 0.25;
const DEFAULT_PORTION = 1;

export const PORTION_DELTAS = [
  { label: "-1", delta: -1 },
  { label: "-1/4", delta: -0.25 },
  { label: "+1/4", delta: 0.25 },
  { label: "+1", delta: 1 },
] as const;

function roundToQuarter(value: number) {
  return Math.round(value * 4) / 4;
}

export function sanitizePortion(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_PORTION;
  }

  return Math.max(MIN_PORTION, roundToQuarter(value));
}

export function formatMixedQuarter(value: number) {
  const portion = sanitizePortion(value);
  let whole = Math.floor(portion);
  let quarter = Math.round((portion - whole) * 4);

  if (quarter === 4) {
    whole += 1;
    quarter = 0;
  }

  if (quarter === 0) {
    return String(whole);
  }

  const fraction =
    quarter === 1 ? "1/4" : quarter === 2 ? "1/2" : quarter === 3 ? "3/4" : `${quarter}/4`;

  return whole > 0 ? `${whole} ${fraction}` : fraction;
}

export function formatPortionLabel(value: number) {
  const portion = sanitizePortion(value);
  const suffix = portion === 1 ? "portion" : "portions";
  return `${formatMixedQuarter(portion)} ${suffix}`;
}

export function formatPortionDecimal(value: number) {
  const portion = sanitizePortion(value);
  if (Number.isInteger(portion)) {
    return String(portion);
  }

  return portion.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
