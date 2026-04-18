import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { macroColors } from "../theme/macroColors";

type NutritionLike = {
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
};

type MacroBadgesProps = {
  nutrition?: NutritionLike;
  multiplier?: number;
  containerStyle?: StyleProp<ViewStyle>;
};

function formatCalories(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return `${Math.round(value).toLocaleString()} kcal`;
}

function formatMacroValue(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }

  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}g`;
}

export function MacroBadges({
  nutrition,
  multiplier = 1,
  containerStyle,
}: MacroBadgesProps) {
  if (!nutrition) {
    return null;
  }

  const badges = [
    {
      key: "calories",
      label: formatCalories(
        nutrition.calories !== undefined ? nutrition.calories * multiplier : undefined,
      ),
      prefix: null,
      colors: macroColors.calories,
    },
    {
      key: "protein",
      label: formatMacroValue(
        nutrition.protein !== undefined ? nutrition.protein * multiplier : undefined,
      ),
      prefix: "P",
      colors: macroColors.protein,
    },
    {
      key: "carbs",
      label: formatMacroValue(
        nutrition.carbs !== undefined ? nutrition.carbs * multiplier : undefined,
      ),
      prefix: "C",
      colors: macroColors.carbs,
    },
    {
      key: "fat",
      label: formatMacroValue(nutrition.fat !== undefined ? nutrition.fat * multiplier : undefined),
      prefix: "F",
      colors: macroColors.fat,
    },
  ].filter((badge) => badge.label);

  if (badges.length === 0) {
    return null;
  }

  return (
    <View style={[styles.row, containerStyle]}>
      {badges.map((badge) => (
        <View
          key={badge.key}
          style={[
            styles.badge,
            {
              backgroundColor: badge.colors.background,
            },
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              {
                color: badge.colors.text,
              },
            ]}
          >
            {badge.prefix ? `${badge.prefix} ${badge.label}` : badge.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    marginTop: 6,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  badge: {
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgeText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
});
