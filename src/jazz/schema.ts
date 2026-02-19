import { Group, co, z } from "jazz-tools";

const NutritionInfo = co.map({
  calories: z.optional(z.number()),
  protein: z.optional(z.number()),
  carbs: z.optional(z.number()),
  fat: z.optional(z.number()),
  fiber: z.optional(z.number()),
  sugars: z.optional(z.number()),
  sodiumMg: z.optional(z.number()),
  potassiumMg: z.optional(z.number()),
});

const FoodItem = co.map({
  name: z.string(),
  brand: z.optional(z.string()),
  serving: z.optional(z.string()),
  nutrition: co.optional(NutritionInfo),
});

const FoodLogEntry = co.map({
  meal: z.string(),
  foodName: z.string(),
  brand: z.optional(z.string()),
  serving: z.optional(z.string()),
  nutrition: co.optional(NutritionInfo),
  createdAt: z.number(),
});

const CaloricRoot = co.map({
  foods: co.optional(co.list(FoodItem)),
  logs: co.optional(co.list(FoodLogEntry)),
  calorieGoal: z.optional(z.number()),
});

const CaloricProfile = co.profile({
  name: z.string(),
  email: z.string(),
});

const DEFAULT_FOODS = [
  {
    name: "Greek Yogurt",
    brand: "Fage",
    serving: "170g",
    nutrition: { calories: 120, protein: 17, carbs: 6, fat: 0 },
  },
  {
    name: "Chicken Breast",
    brand: "Grilled",
    serving: "150g",
    nutrition: { calories: 248, protein: 46, carbs: 0, fat: 5 },
  },
  {
    name: "Brown Rice",
    brand: "Cooked",
    serving: "185g",
    nutrition: { calories: 216, protein: 5, carbs: 45, fat: 2 },
  },
  {
    name: "Avocado",
    brand: "Hass",
    serving: "100g",
    nutrition: { calories: 160, protein: 2, carbs: 9, fat: 15, fiber: 7 },
  },
  {
    name: "Banana",
    brand: "Medium",
    serving: "118g",
    nutrition: { calories: 105, carbs: 27, sugars: 14 },
  },
  {
    name: "Whole Egg",
    brand: "Large",
    serving: "1 egg",
    nutrition: { calories: 78, protein: 6, carbs: 1, fat: 5 },
  },
];

export const CaloricAccount = co
  .account({
    root: CaloricRoot,
    profile: CaloricProfile,
  })
  .withMigration(async (account, creationProps?: { name: string }) => {
    if (!account.$jazz.has("root")) {
      account.$jazz.set("root", {
        foods: DEFAULT_FOODS,
        logs: [],
        calorieGoal: 2500,
      });
    }

    if (!account.$jazz.has("profile")) {
      const profileGroup = Group.create();
      profileGroup.makePublic();

      account.$jazz.set(
        "profile",
        CaloricProfile.create(
          {
            name: creationProps?.name?.trim() || "New user",
            email: "",
          },
          profileGroup,
        ),
      );
      return;
    }

    const { profile, root } = await account.$jazz.ensureLoaded({
      resolve: { profile: true, root: true },
    });

    if (!profile.$jazz.has("name")) {
      profile.$jazz.set("name", creationProps?.name?.trim() || "New user");
    }

    if (!profile.$jazz.has("email")) {
      profile.$jazz.set("email", "");
    }

    if (!root.$jazz.has("foods")) {
      root.$jazz.set("foods", DEFAULT_FOODS);
    }

    if (!root.$jazz.has("logs")) {
      root.$jazz.set("logs", []);
    }

    if (!root.$jazz.has("calorieGoal")) {
      root.$jazz.set("calorieGoal", 2500);
    }

    if (root.foods && root.foods.length === 0) {
      root.foods.$jazz.push(...DEFAULT_FOODS);
    }
  });
