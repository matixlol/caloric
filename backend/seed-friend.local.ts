// Local-only seed: a fake friend ("Alex Rivera") with several days of foods + settings.
// Run with DATABASE_URL pointing at the local Postgres. Safe to re-run (idempotent).
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

const FRIEND_ID = "seed_friend_alex";
const DISPLAY_NAME = "Alex Rivera";
const FRIEND_CODE = "ALEXFR";

function dateKey(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type Nutrition = { calories: number; protein: number; carbs: number; fat: number };
type SeedEntry = {
  meal: "breakfast" | "lunch" | "dinner" | "snacks";
  foodName: string;
  brand?: string;
  serving?: string;
  portion: number;
  nutrition: Nutrition;
};

// days[0] = today, days[1] = yesterday, ...
const days: SeedEntry[][] = [
  [
    { meal: "breakfast", foodName: "Greek yogurt with berries", serving: "1 bowl", portion: 1, nutrition: { calories: 320, protein: 24, carbs: 38, fat: 8 } },
    { meal: "lunch", foodName: "Chicken burrito bowl", brand: "Chipotle", serving: "1 bowl", portion: 1, nutrition: { calories: 705, protein: 45, carbs: 78, fat: 24 } },
    { meal: "dinner", foodName: "Salmon, rice & broccoli", serving: "1 plate", portion: 1, nutrition: { calories: 640, protein: 42, carbs: 55, fat: 26 } },
    { meal: "snacks", foodName: "Apple", serving: "1 medium", portion: 1, nutrition: { calories: 95, protein: 0, carbs: 25, fat: 0 } },
  ],
  [
    { meal: "breakfast", foodName: "Oatmeal with banana", serving: "1 bowl", portion: 1, nutrition: { calories: 350, protein: 10, carbs: 64, fat: 7 } },
    { meal: "lunch", foodName: "Turkey & swiss sandwich", serving: "1 sandwich", portion: 1, nutrition: { calories: 480, protein: 32, carbs: 44, fat: 18 } },
    { meal: "dinner", foodName: "Spaghetti bolognese", serving: "1.5 cups", portion: 1, nutrition: { calories: 720, protein: 34, carbs: 92, fat: 22 } },
    { meal: "snacks", foodName: "Whey protein shake", brand: "Optimum Nutrition", serving: "1 scoop", portion: 1, nutrition: { calories: 160, protein: 30, carbs: 5, fat: 2 } },
  ],
  [
    { meal: "breakfast", foodName: "Eggs, toast & avocado", serving: "2 eggs", portion: 1, nutrition: { calories: 430, protein: 21, carbs: 30, fat: 26 } },
    { meal: "lunch", foodName: "Salmon poke bowl", serving: "1 bowl", portion: 1, nutrition: { calories: 590, protein: 34, carbs: 70, fat: 18 } },
    { meal: "dinner", foodName: "Chicken & veggie stir fry", serving: "1 plate", portion: 1, nutrition: { calories: 560, protein: 40, carbs: 48, fat: 20 } },
  ],
  [
    { meal: "breakfast", foodName: "Berry protein smoothie", serving: "16 oz", portion: 1, nutrition: { calories: 300, protein: 25, carbs: 42, fat: 5 } },
    { meal: "lunch", foodName: "Caesar salad with chicken", serving: "1 large", portion: 1, nutrition: { calories: 520, protein: 38, carbs: 22, fat: 30 } },
    { meal: "dinner", foodName: "Cheeseburger & fries", brand: "Five Guys", serving: "1 burger", portion: 1, nutrition: { calories: 980, protein: 42, carbs: 78, fat: 54 } },
    { meal: "snacks", foodName: "Dark chocolate", serving: "2 squares", portion: 1, nutrition: { calories: 120, protein: 2, carbs: 13, fat: 8 } },
  ],
  [
    { meal: "breakfast", foodName: "Buttermilk pancakes", serving: "3 pancakes", portion: 1, nutrition: { calories: 430, protein: 9, carbs: 68, fat: 14 } },
    { meal: "lunch", foodName: "Salmon avocado sushi", serving: "8 pieces", portion: 1, nutrition: { calories: 540, protein: 24, carbs: 76, fat: 16 } },
    { meal: "dinner", foodName: "Grilled chicken & sweet potato", serving: "1 plate", portion: 1, nutrition: { calories: 610, protein: 46, carbs: 58, fat: 18 } },
    { meal: "snacks", foodName: "Almonds", serving: "1 oz", portion: 1, nutrition: { calories: 165, protein: 6, carbs: 6, fat: 14 } },
  ],
];

const settings = { calorieGoal: 2200, macroProteinPct: 30, macroCarbsPct: 40, macroFatPct: 30 };

await sql`
  INSERT INTO social_profiles (user_id, display_name, friend_code, created_at, updated_at)
  VALUES (${FRIEND_ID}, ${DISPLAY_NAME}, ${FRIEND_CODE}, now(), now())
  ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name, friend_code = excluded.friend_code, updated_at = now()
`;

await sql`
  INSERT INTO user_settings (user_id, data, updated_at)
  VALUES (${FRIEND_ID}, ${sql.json(settings)}, now())
  ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = now()
`;

// Reset previously-seeded entries so re-running doesn't duplicate.
await sql`DELETE FROM user_food_entries WHERE user_id = ${FRIEND_ID}`;

const now = Date.now();
let total = 0;
for (let d = 0; d < days.length; d++) {
  const dk = dateKey(d);
  const dayBase = now - d * 86_400_000;
  const mealIndex: Record<string, number> = {};
  for (const e of days[d]) {
    const idx = mealIndex[e.meal] = (mealIndex[e.meal] ?? -1) + 1;
    const createdAt = Math.floor(dayBase + idx * 60_000);
    const id = `food_entry_seed_${d}_${total}`;
    const data: Record<string, unknown> = {
      meal: e.meal,
      foodName: e.foodName,
      portion: e.portion,
      nutrition: e.nutrition,
      createdAt,
      dateKey: dk,
      sortIndex: idx,
    };
    if (e.brand) data.brand = e.brand;
    if (e.serving) data.serving = e.serving;
    await sql`
      INSERT INTO user_food_entries (user_id, id, data, updated_at, deleted_at)
      VALUES (${FRIEND_ID}, ${id}, ${sql.json(data)}, now(), null)
    `;
    total++;
  }
}

console.log(`Seeded friend ${FRIEND_ID} (${DISPLAY_NAME}, code ${FRIEND_CODE}) with ${total} entries across ${days.length} days: ${days.map((_, d) => dateKey(d)).join(", ")}`);
await sql.end();
