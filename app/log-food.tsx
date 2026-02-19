import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useAccount } from "jazz-tools/expo";
import {
  Platform,
  PlatformColor,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CaloricAccount } from "../src/jazz/schema";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

const palette = {
  background: iosColor("systemGroupedBackground", "#F3F4F6"),
  card: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
  label: iosColor("label", "#111827"),
  secondaryLabel: iosColor("secondaryLabel", "#6B7280"),
  separator: iosColor("separator", "#E5E7EB"),
  tint: iosColor("systemBlue", "#2563EB"),
  tintDisabled: iosColor("systemGray3", "#D1D5DB"),
  buttonText: iosColor("white", "#FFFFFF"),
};

function FoodRow({
  name,
  meta,
  calories,
  selected,
  isLast,
  onPress,
}: {
  name: string;
  meta: string;
  calories: number;
  selected: boolean;
  isLast: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.foodRow, !isLast && styles.foodRowDivider]}
    >
      <View style={styles.foodMain}>
        <Text style={styles.foodName}>{name}</Text>
        <Text style={styles.foodMeta}>{meta}</Text>
      </View>
      <View style={styles.foodRight}>
        <Text style={styles.foodCalories}>{calories.toLocaleString()}</Text>
        <Text style={styles.foodUnit}>kcal</Text>
      </View>
      {selected ? <Text style={styles.selectedMark}>✓</Text> : null}
    </Pressable>
  );
}

export default function LogFoodScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useAccount(CaloricAccount, {
    resolve: { root: { foods: { $each: { nutrition: true } }, logs: true } },
  });
  const [selectedFoodId, setSelectedFoodId] = useState<string | null>(null);
  const canUseGlass =
    Platform.OS === "ios" && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

  if (!me.$isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading foods…</Text>
      </View>
    );
  }

  const foods = (me.root.foods ?? []).filter(
    (food): food is NonNullable<typeof food> & { $isLoaded: true } =>
      Boolean(food?.$isLoaded),
  );
  const selectedFood = foods.find((food) => food.$jazz.id === selectedFoodId) || null;

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

    router.navigate("/");
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.contentContainer,
          {
            paddingTop: insets.top + 4,
            paddingBottom: insets.bottom + 96,
          },
        ]}
      >
        <Text style={styles.largeTitle}>Foods</Text>
        <Text style={styles.subtitle}>Pick one item to add to lunch</Text>

        <View style={styles.card}>
          {foods.map((food, index) => {
            const calories = food.nutrition?.calories ?? 0;
            const meta =
              [food.brand, food.serving].filter(Boolean).join(" • ") ||
              "No serving details";

            return (
              <FoodRow
                key={food.$jazz.id}
                name={food.name}
                meta={meta}
                calories={calories}
                selected={selectedFoodId === food.$jazz.id}
                isLast={index === foods.length - 1}
                onPress={() => setSelectedFoodId(food.$jazz.id)}
              />
            );
          })}
        </View>
      </ScrollView>

      <View style={[styles.actionBarContainer, { paddingBottom: insets.bottom + 12 }]}>
        {canUseGlass ? (
          <GlassView
            glassEffectStyle="regular"
            tintColor="rgba(255,255,255,0.2)"
            style={StyleSheet.absoluteFillObject}
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!selectedFood}
          onPress={handleAddToLog}
          style={[styles.actionButton, !selectedFood && styles.actionButtonDisabled]}
        >
          <Text style={styles.actionButtonText}>Add to Lunch</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  contentContainer: {
    paddingHorizontal: 16,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.background,
  },
  loadingText: {
    fontSize: 16,
    color: palette.secondaryLabel,
  },
  largeTitle: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: "700",
    color: palette.label,
    paddingHorizontal: 4,
  },
  subtitle: {
    marginTop: 2,
    marginBottom: 14,
    paddingHorizontal: 4,
    fontSize: 15,
    lineHeight: 20,
    color: palette.secondaryLabel,
  },
  card: {
    backgroundColor: palette.card,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  foodRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
  },
  foodRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.separator,
  },
  foodMain: {
    flex: 1,
  },
  foodName: {
    fontSize: 17,
    lineHeight: 22,
    color: palette.label,
  },
  foodMeta: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
    color: palette.secondaryLabel,
  },
  foodRight: {
    alignItems: "flex-end",
    minWidth: 64,
  },
  foodCalories: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  foodUnit: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "500",
    color: palette.secondaryLabel,
  },
  selectedMark: {
    fontSize: 18,
    lineHeight: 22,
    color: palette.tint,
    fontWeight: "700",
  },
  actionBarContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: "rgba(255,255,255,0.35)",
    overflow: "hidden",
  },
  actionButton: {
    borderRadius: 12,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.tint,
  },
  actionButtonDisabled: {
    backgroundColor: palette.tintDisabled,
  },
  actionButtonText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.buttonText,
  },
});
