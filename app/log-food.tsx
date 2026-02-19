import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAccount } from "jazz-tools/expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CaloricAccount } from "../src/jazz/schema";

function FoodRow({
  name,
  meta,
  calories,
  selected,
  onPress,
}: {
  name: string;
  meta: string;
  calories: number;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      className={`mb-3 rounded-2xl border p-4 ${selected ? "border-ink bg-ink/5" : "border-ink/10 bg-white"}`}
      onPress={onPress}
      accessibilityRole="button"
    >
      <View className="flex-row items-center justify-between">
        <View className="shrink pr-3">
          <Text className="text-base font-bold text-ink">{name}</Text>
          <Text className="mt-1 text-xs font-medium text-ink/50">{meta}</Text>
        </View>
        <Text className="text-lg font-bold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
          {calories}
        </Text>
      </View>
    </Pressable>
  );
}

export default function LogFoodScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useAccount(CaloricAccount, { resolve: { root: { foods: true, logs: true } } });
  const [selectedFoodId, setSelectedFoodId] = useState<string | null>(null);

  if (!me.$isLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-cream">
        <Text className="text-sm font-semibold uppercase text-ink/40">Loading foods…</Text>
      </View>
    );
  }

  const foods = (me.root.foods ?? []).filter(Boolean);
  const selectedFood = foods.find((food) => food?.$jazz.id === selectedFoodId) || null;

  const handleAddToLog = () => {
    if (!selectedFood) return;

    if (!me.root.logs) {
      me.root.$jazz.set("logs", []);
    }

    me.root.logs?.$jazz.push({
      meal: "lunch",
      foodName: selectedFood.name,
      brand: selectedFood.brand,
      serving: selectedFood.serving,
      nutrition: selectedFood.nutrition
        ? {
            calories: selectedFood.nutrition.calories,
            protein: selectedFood.nutrition.protein,
            carbs: selectedFood.nutrition.carbs,
            fat: selectedFood.nutrition.fat,
            fiber: selectedFood.nutrition.fiber,
            sugars: selectedFood.nutrition.sugars,
            sodiumMg: selectedFood.nutrition.sodiumMg,
            potassiumMg: selectedFood.nutrition.potassiumMg,
          }
        : undefined,
      createdAt: Date.now(),
    });

    router.back();
  };

  return (
    <View className="flex-1 bg-cream">
      <View className="flex-row items-center justify-between px-6 pb-5" style={{ paddingTop: insets.top + 20 }}>
        <Pressable accessibilityRole="button" onPress={() => router.back()}>
          <Text className="text-sm font-bold uppercase tracking-wide text-ink/40">Cancel</Text>
        </Pressable>
        <Text className="text-[11px] font-bold uppercase text-ink">Log Lunch</Text>
        <View className="w-[52px]" />
      </View>

      <ScrollView className="flex-1 px-6" showsVerticalScrollIndicator={false}>
        <Text className="mb-2 mt-2 text-[32px] font-extrabold text-ink">Choose a Food</Text>
        <Text className="mb-6 text-sm font-semibold uppercase text-ink/40">Saved food items from Jazz DB</Text>

        {foods.map((food) => {
          if (!food) return null;
          const calories = food.nutrition?.calories ?? 0;
          const meta = [food.brand, food.serving].filter(Boolean).join(" • ") || "No serving details";

          return (
            <FoodRow
              key={food.$jazz.id}
              name={food.name}
              meta={meta}
              calories={calories}
              selected={selectedFoodId === food.$jazz.id}
              onPress={() => setSelectedFoodId(food.$jazz.id)}
            />
          );
        })}
      </ScrollView>

      <View className="px-6 pt-6" style={{ paddingBottom: insets.bottom + 20 }}>
        <Pressable
          className={`rounded-xl p-5 ${selectedFood ? "bg-ink" : "bg-ink/30"}`}
          accessibilityRole="button"
          disabled={!selectedFood}
          onPress={handleAddToLog}
        >
          <Text className="text-center text-base font-bold uppercase tracking-wide text-cream">Add to Log</Text>
        </Pressable>
      </View>
    </View>
  );
}
