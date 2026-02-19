import { useRouter } from "expo-router";
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
  tertiaryLabel: iosColor("tertiaryLabel", "#9CA3AF"),
  separator: iosColor("separator", "#E5E7EB"),
  tint: iosColor("systemBlue", "#2563EB"),
};

function MacroRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function MealRow({ name, meta, calories, isLast }: { name: string; meta?: string; calories: number; isLast: boolean }) {
  return (
    <View style={[styles.row, !isLast && styles.rowWithDivider]}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{name}</Text>
        {meta ? <Text style={styles.rowSubtitle}>{meta}</Text> : null}
      </View>
      <Text style={styles.rowValue}>{calories.toLocaleString()}</Text>
    </View>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useAccount(CaloricAccount, {
    resolve: { root: { logs: { $each: { nutrition: true } } } },
  });

  if (!me.$isLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }

  const logs = (me.root.logs ?? [])
    .filter(
      (entry): entry is NonNullable<typeof entry> & { $isLoaded: true } =>
        Boolean(entry?.$isLoaded),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const lunchLogs = logs.filter(
    (entry) => typeof entry.meal === "string" && entry.meal.toLowerCase() === "lunch",
  );

  const caloriesConsumed = logs.reduce((sum, entry) => sum + (entry.nutrition?.calories ?? 0), 0);
  const protein = logs.reduce((sum, entry) => sum + (entry.nutrition?.protein ?? 0), 0);
  const carbs = logs.reduce((sum, entry) => sum + (entry.nutrition?.carbs ?? 0), 0);
  const fat = logs.reduce((sum, entry) => sum + (entry.nutrition?.fat ?? 0), 0);

  const goal = me.root.calorieGoal || 2500;
  const progress = Math.max(0, Math.min(100, Math.round((caloriesConsumed / goal) * 100)));

  return (
    <View style={styles.screen}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.contentContainer,
          {
            paddingTop: insets.top + 4,
            paddingBottom: insets.bottom + 24,
          },
        ]}
      >
        <Text style={styles.largeTitle}>Today</Text>

        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>Calories</Text>
          <View style={styles.summaryValueRow}>
            <Text style={styles.summaryValue}>{caloriesConsumed.toLocaleString()}</Text>
            <Text style={styles.summaryGoal}>/ {goal.toLocaleString()}</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
        </View>

        <Text style={styles.sectionTitle}>Macros</Text>
        <View style={styles.card}>
          <MacroRow label="Protein" value={`${protein}g`} />
          <View style={styles.divider} />
          <MacroRow label="Carbs" value={`${carbs}g`} />
          <View style={styles.divider} />
          <MacroRow label="Fat" value={`${fat}g`} />
        </View>

        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Lunch</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.navigate("/log-food")}
            style={styles.linkButton}
          >
            <Text style={styles.linkButtonText}>Add Food</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          {lunchLogs.length === 0 ? (
            <Text style={styles.emptyText}>No lunch entries yet.</Text>
          ) : (
            lunchLogs.map((entry, index) => (
              <MealRow
                key={entry.$jazz.id}
                name={entry.foodName}
                meta={[entry.brand, entry.serving].filter(Boolean).join(" • ")}
                calories={entry.nutrition?.calories ?? 0}
                isLast={index === lunchLogs.length - 1}
              />
            ))
          )}
        </View>
      </ScrollView>
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
    gap: 12,
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
  summaryCard: {
    backgroundColor: palette.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 16,
  },
  summaryLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: palette.secondaryLabel,
  },
  summaryValueRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    marginTop: 8,
  },
  summaryValue: {
    fontSize: 46,
    lineHeight: 50,
    fontWeight: "700",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  summaryGoal: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "500",
    color: palette.secondaryLabel,
    fontVariant: ["tabular-nums"],
    marginBottom: 2,
  },
  progressTrack: {
    marginTop: 12,
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.tertiaryLabel,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: palette.tint,
  },
  sectionHeaderRow: {
    marginTop: 8,
    paddingHorizontal: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    paddingHorizontal: 4,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.secondaryLabel,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  linkButton: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  linkButtonText: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
    color: palette.tint,
  },
  card: {
    backgroundColor: palette.card,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  rowWithDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.separator,
  },
  rowMain: {
    flex: 1,
    paddingVertical: 10,
  },
  rowLabel: {
    fontSize: 17,
    lineHeight: 22,
    color: palette.label,
  },
  rowTitle: {
    fontSize: 17,
    lineHeight: 22,
    color: palette.label,
  },
  rowSubtitle: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
    color: palette.secondaryLabel,
  },
  rowValue: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: palette.label,
    fontVariant: ["tabular-nums"],
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: palette.separator,
  },
  emptyText: {
    paddingVertical: 14,
    fontSize: 15,
    lineHeight: 20,
    color: palette.secondaryLabel,
  },
});
