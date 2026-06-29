export const QUICK_ADD_FOOD_NAME = "Quick add";
export const QUICK_ADD_MANUAL_SERVING = "Manual entry";

export const QUICK_ADD_MAX_TYPED_CALORIES = 10000;
export const QUICK_ADD_MAX_TYPED_MACRO_GRAMS = 1000;

export function isQuickAddEntry(entry: { foodName: string }): boolean {
  return entry.foodName === QUICK_ADD_FOOD_NAME;
}

export function parseCalorieInput(value: string): number | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const parsedValue = Number(trimmedValue);
  if (
    !Number.isFinite(parsedValue) ||
    parsedValue <= 0 ||
    parsedValue > QUICK_ADD_MAX_TYPED_CALORIES
  ) {
    return null;
  }

  return Math.round(parsedValue);
}

export function parseOptionalMacroInput(value: string): number | null | undefined {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return undefined;
  }

  const parsedValue = Number(trimmedValue);
  if (
    !Number.isFinite(parsedValue) ||
    parsedValue < 0 ||
    parsedValue > QUICK_ADD_MAX_TYPED_MACRO_GRAMS
  ) {
    return null;
  }

  return Math.round(parsedValue * 10) / 10;
}
