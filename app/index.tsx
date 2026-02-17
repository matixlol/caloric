import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const COLORS = {
  bg: "#FFFFFF",
  ink: "#104028",
  inkDim: "rgba(16, 64, 40, 0.4)",
  inkLight: "rgba(16, 64, 40, 0.1)",
} as const;

type MacroCardProps = {
  label: string;
  value: string;
  progress: `${number}%`;
};

type MealItemProps = {
  name: string;
  meta?: string;
  calories: string;
};

function MacroCard({ label, value, progress }: MacroCardProps) {
  return (
    <View style={styles.macroCard}>
      <Text style={[styles.macroLabel, styles.label]}>{label}</Text>
      <Text style={[styles.macroValue, styles.tabular]}>{value}</Text>
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: progress }]} />
      </View>
    </View>
  );
}

function MealItem({ name, meta, calories }: MealItemProps) {
  return (
    <View style={styles.mealItem}>
      <View style={styles.mealInfo}>
        <Text style={styles.mealName}>{name}</Text>
        {meta ? <Text style={styles.mealMeta}>{meta}</Text> : null}
      </View>
      <Text style={[styles.mealCals, styles.tabular]}>{calories}</Text>
    </View>
  );
}

function MealSectionHeader({ title }: { title: string }) {
  return (
    <View style={styles.sectionHeaderRow}>
      <Text style={[styles.sectionHeader, styles.label]}>{title}</Text>
      <Pressable style={styles.quickAddBtn} accessibilityRole="button">
        <Text style={styles.quickAddText}>+</Text>
      </Pressable>
    </View>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.appContainer, { paddingTop: insets.top }]}>
      <View style={styles.headerTop}>
        <Text style={[styles.headerTopText, styles.date]}>TODAY, 24 OCT</Text>
        <Text style={styles.headerTopText}>PROFILE</Text>
      </View>

      <ScrollView
        style={styles.scrollContainer}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <View style={styles.displayNumContainer}>
            <Text style={[styles.displayNum, styles.tabular]}>1,240</Text>
            <Text style={[styles.goalText, styles.tabular]}>/ 2,500</Text>
          </View>
          <Text style={[styles.displayUnit, styles.label]}>
            CALORIES REMAINING
          </Text>

          <View style={styles.dailyProgressContainer}>
            <View style={styles.dailyProgressFill} />
          </View>
        </View>

        <View style={styles.macros}>
          <MacroCard label="PROTEIN" value="82g" progress="65%" />
          <MacroCard label="CARBS" value="145g" progress="42%" />
          <MacroCard label="FAT" value="35g" progress="28%" />
        </View>

        <View style={styles.mealsSection}>
          <MealSectionHeader title="LUNCH" />
          <MealItem
            name="Grilled Chicken Salad"
            meta="High Protein • No Dressing"
            calories="450"
          />
          <MealItem name="Iced Americano" meta="Black" calories="15" />

          <MealSectionHeader title="BREAKFAST" />
          <MealItem
            name="Oatmeal & Berries"
            meta="Almond Milk • Blueberries"
            calories="320"
          />
          <MealItem name="Boiled Egg" meta="Large" calories="78" />
          <MealItem name="Black Coffee" calories="5" />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  appContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  hero: {
    paddingHorizontal: 24,
    marginBottom: 16,
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    paddingHorizontal: 24,
  },
  headerTopText: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.ink,
    textTransform: "uppercase",
    letterSpacing: -0.28,
  },
  date: {
    borderBottomWidth: 2,
    borderBottomColor: COLORS.ink,
    paddingBottom: 2,
  },
  displayNumContainer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  displayNum: {
    fontSize: 82,
    lineHeight: 86,
    letterSpacing: -3.28,
    fontWeight: "800",
    color: COLORS.ink,
  },
  goalText: {
    fontSize: 24,
    color: COLORS.inkDim,
    fontWeight: "600",
    letterSpacing: -0.48,
    marginBottom: 8,
  },
  displayUnit: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.ink,
    marginTop: 4,
  },
  dailyProgressContainer: {
    marginTop: 8,
    height: 8,
    backgroundColor: COLORS.inkLight,
    borderRadius: 0,
    overflow: "hidden",
  },
  dailyProgressFill: {
    height: "100%",
    width: "50.4%",
    backgroundColor: COLORS.ink,
  },
  macros: {
    flexDirection: "row",
    paddingHorizontal: 24,
    gap: 12,
    marginBottom: 16,
  },
  macroCard: {
    flex: 1,
  },
  macroLabel: {
    fontSize: 11,
    color: COLORS.ink,
    marginBottom: 4,
  },
  macroValue: {
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 6,
    color: COLORS.ink,
  },
  progressBar: {
    height: 4,
    backgroundColor: COLORS.inkLight,
    position: "relative",
  },
  progressFill: {
    position: "absolute",
    left: 0,
    right: "auto",
    top: 0,
    bottom: 0,
    backgroundColor: COLORS.ink,
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 16,
  },
  mealsSection: {
    paddingHorizontal: 24,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 16,
    marginBottom: 8,
  },
  sectionHeader: {
    fontSize: 12,
    color: COLORS.inkDim,
  },
  quickAddBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  quickAddText: {
    color: COLORS.bg,
    fontSize: 20,
    lineHeight: 20,
    fontWeight: "300",
    marginTop: -1,
  },
  mealItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.inkLight,
  },
  mealInfo: {
    flexDirection: "column",
    flexShrink: 1,
    paddingRight: 12,
  },
  mealName: {
    fontSize: 16,
    fontWeight: "600",
    color: COLORS.ink,
    marginBottom: 4,
  },
  mealMeta: {
    fontSize: 12,
    fontWeight: "500",
    color: COLORS.inkDim,
  },
  mealCals: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.ink,
  },
  label: {
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: -0.22,
  },
  tabular: {
    fontVariant: ["tabular-nums"],
  },
});
