export const MEAL_TIMES = [
  {
    key: "breakfast",
    label: "Breakfast",
    emptyCopy: "No breakfast entries yet.",
  },
  {
    key: "lunch",
    label: "Lunch",
    emptyCopy: "No lunch entries yet.",
  },
  {
    key: "dinner",
    label: "Dinner",
    emptyCopy: "No dinner entries yet.",
  },
  {
    key: "snacks",
    label: "Snacks",
    emptyCopy: "No snacks entries yet.",
  },
] as const;

export type MealKey = (typeof MEAL_TIMES)[number]["key"];

export function normalizeMeal(rawMeal: string | string[] | null | undefined): MealKey | null {
  const meal = (Array.isArray(rawMeal) ? rawMeal[0] : rawMeal)?.trim().toLowerCase();

  if (meal === "breakfast") return "breakfast";
  if (meal === "lunch") return "lunch";
  if (meal === "dinner") return "dinner";
  if (meal === "snack" || meal === "snacks") return "snacks";

  return null;
}

export function mealLabelFor(meal: MealKey): string {
  const found = MEAL_TIMES.find((item) => item.key === meal);
  return found?.label ?? "Lunch";
}
