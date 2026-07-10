export type CalorieNutrition = {
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
};

export const CALORIE_MISMATCH_THRESHOLD = 0.08;

export function hasCalorieMacroMismatch(nutrition: CalorieNutrition | undefined): boolean {
  if (!nutrition) return false;

  const { calories, protein, carbs, fat } = nutrition;
  if (
    calories === undefined ||
    protein === undefined ||
    carbs === undefined ||
    fat === undefined ||
    !Number.isFinite(calories) ||
    !Number.isFinite(protein) ||
    !Number.isFinite(carbs) ||
    !Number.isFinite(fat) ||
    calories <= 0
  ) {
    return false;
  }

  const caloriesFromMacros = protein * 4 + carbs * 4 + fat * 9;
  return Math.abs(caloriesFromMacros - calories) / calories > CALORIE_MISMATCH_THRESHOLD;
}
