export function getMfpNetCarbs(
  carbohydrates: number | undefined,
  fiber: number | undefined,
  netCarbs?: number,
): number | undefined {
  if (netCarbs !== undefined) {
    return netCarbs;
  }

  if (carbohydrates !== undefined && fiber !== undefined) {
    return Math.max(0, carbohydrates - fiber);
  }

  return carbohydrates;
}
