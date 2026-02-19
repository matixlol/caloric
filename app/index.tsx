import { Href, Link } from "expo-router";
import { Pressable, ScrollView, Text, View, useColorScheme } from "react-native";
import { useAccount } from "jazz-tools/expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CaloricAccount } from "../src/jazz/schema";

type MacroCardProps = {
  label: string;
  value: string;
  progress: `${number}%`;
  isDark: boolean;
};

type MealItemProps = {
  name: string;
  meta?: string;
  calories: string;
  isDark: boolean;
};

function MacroCard({ label, value, progress, isDark }: MacroCardProps) {
  return (
    <View className="flex-1">
      <Text className={`mb-1 text-[11px] font-bold uppercase ${isDark ? "text-moss" : "text-ink"}`}>{label}</Text>
      <Text className={`mb-1.5 text-[20px] font-bold ${isDark ? "text-mint" : "text-ink"}`} style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
      <View className={`relative h-1 ${isDark ? "bg-mint/15" : "bg-ink/10"}`}>
        <View className={`absolute inset-y-0 left-0 ${isDark ? "bg-mint" : "bg-ink"}`} style={{ width: progress }} />
      </View>
    </View>
  );
}

function MealItem({ name, meta, calories, isDark }: MealItemProps) {
  return (
    <View className={`flex-row items-start justify-between border-b py-4 ${isDark ? "border-line" : "border-ink/10"}`}>
      <View className="shrink pr-3">
        <Text className={`mb-1 text-base font-semibold ${isDark ? "text-mint" : "text-ink"}`}>{name}</Text>
        {meta ? <Text className={`text-xs font-medium ${isDark ? "text-moss" : "text-ink/40"}`}>{meta}</Text> : null}
      </View>
      <Text className={`text-base font-bold ${isDark ? "text-mint" : "text-ink"}`} style={{ fontVariant: ["tabular-nums"] }}>
        {calories}
      </Text>
    </View>
  );
}

function MealSectionHeader({ title, isDark, href }: { title: string; isDark: boolean; href?: Href }) {
  const button = (
    <Pressable className={`h-8 w-8 items-center justify-center rounded-full ${isDark ? "bg-mint" : "bg-ink"}`} accessibilityRole="button">
      <Text className={`-mt-px text-xl font-light ${isDark ? "text-night" : "text-cream"}`}>+</Text>
    </Pressable>
  );

  return (
    <View className="mb-2 flex-row items-center justify-between pt-4">
      <Text className={`text-xs font-bold uppercase ${isDark ? "text-moss" : "text-ink/40"}`}>{title}</Text>
      {href ? (
        <Link href={href} asChild>
          {button}
        </Link>
      ) : (
        button
      )}
    </View>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const isDark = useColorScheme() === "dark";
  const me = useAccount(CaloricAccount, { resolve: { root: { logs: true } } });

  if (!me.$isLoaded) {
    return (
      <View className={`flex-1 items-center justify-center ${isDark ? "bg-night" : "bg-cream"}`}>
        <Text className={`${isDark ? "text-mint" : "text-ink"}`}>Loading…</Text>
      </View>
    );
  }

  const logs = (me.root.logs ?? []).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  const lunchLogs = logs.filter((entry) => entry.meal.toLowerCase() === "lunch");

  const caloriesConsumed = logs.reduce((sum, entry) => sum + (entry.nutrition?.calories ?? 0), 0);
  const protein = logs.reduce((sum, entry) => sum + (entry.nutrition?.protein ?? 0), 0);
  const carbs = logs.reduce((sum, entry) => sum + (entry.nutrition?.carbs ?? 0), 0);
  const fat = logs.reduce((sum, entry) => sum + (entry.nutrition?.fat ?? 0), 0);

  const goal = me.root.calorieGoal || 2500;
  const progress = Math.max(0, Math.min(100, Math.round((caloriesConsumed / goal) * 100)));

  return (
    <View className={`flex-1 ${isDark ? "bg-night" : "bg-cream"}`} style={{ paddingTop: insets.top }}>
      <View className="mb-4 flex-row items-center justify-between px-6">
        <Text className={`border-b-2 pb-0.5 text-sm font-bold uppercase ${isDark ? "border-mint text-mint" : "border-ink text-ink"}`}>
          Today
        </Text>
        <Link href="/settings" asChild>
          <Pressable accessibilityRole="button">
            <Text className={`text-sm font-bold uppercase ${isDark ? "text-mint" : "text-ink"}`}>Profile</Text>
          </Pressable>
        </Link>
      </View>

      <ScrollView className="flex-1" contentContainerClassName="pb-4" showsVerticalScrollIndicator={false}>
        <View className="mb-4 px-6">
          <View className="flex-row items-end gap-2">
            <Text className={`text-[82px] font-extrabold leading-[86px] ${isDark ? "text-mint" : "text-ink"}`} style={{ fontVariant: ["tabular-nums"] }}>
              {caloriesConsumed.toLocaleString()}
            </Text>
            <Text className={`mb-2 text-2xl font-semibold ${isDark ? "text-moss" : "text-ink/40"}`} style={{ fontVariant: ["tabular-nums"] }}>
              / {goal.toLocaleString()}
            </Text>
          </View>
          <Text className={`mt-1 text-sm font-bold uppercase ${isDark ? "text-mint" : "text-ink"}`}>Calories consumed</Text>

          <View className={`mt-2 h-2 overflow-hidden ${isDark ? "bg-mint/15" : "bg-ink/10"}`}>
            <View className={`h-full ${isDark ? "bg-mint" : "bg-ink"}`} style={{ width: `${progress}%` }} />
          </View>
        </View>

        <View className="mb-4 flex-row gap-3 px-6">
          <MacroCard label="Protein" value={`${protein}g`} progress={`${Math.min(100, protein)}%`} isDark={isDark} />
          <MacroCard label="Carbs" value={`${carbs}g`} progress={`${Math.min(100, carbs)}%`} isDark={isDark} />
          <MacroCard label="Fat" value={`${fat}g`} progress={`${Math.min(100, fat)}%`} isDark={isDark} />
        </View>

        <View className="px-6">
          <MealSectionHeader title="Lunch" isDark={isDark} href="/log-food" />
          {lunchLogs.length === 0 ? (
            <Text className={`py-4 text-sm ${isDark ? "text-moss" : "text-ink/40"}`}>No lunch entries yet.</Text>
          ) : (
            lunchLogs.map((entry) => (
              <MealItem
                key={entry.$jazz.id}
                name={entry.foodName}
                meta={[entry.brand, entry.serving].filter(Boolean).join(" • ")}
                calories={String(entry.nutrition?.calories ?? 0)}
                isDark={isDark}
              />
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}
