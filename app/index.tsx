import { Pressable, ScrollView, Text, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
      <Text className={`mb-1 text-[11px] font-bold uppercase ${isDark ? "text-moss" : "text-ink"}`}>
        {label}
      </Text>
      <Text
        className={`mb-1.5 text-[20px] font-bold ${isDark ? "text-mint" : "text-ink"}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
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

function MealSectionHeader({ title, isDark }: { title: string; isDark: boolean }) {
  return (
    <View className="mb-2 flex-row items-center justify-between pt-4">
      <Text className={`text-xs font-bold uppercase ${isDark ? "text-moss" : "text-ink/40"}`}>{title}</Text>
      <Pressable className={`h-8 w-8 items-center justify-center rounded-full ${isDark ? "bg-mint" : "bg-ink"}`} accessibilityRole="button">
        <Text className={`-mt-px text-xl font-light ${isDark ? "text-night" : "text-cream"}`}>+</Text>
      </Pressable>
    </View>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const isDark = useColorScheme() === "dark";

  return (
    <View className={`flex-1 ${isDark ? "bg-night" : "bg-cream"}`} style={{ paddingTop: insets.top }}>
      <View className="mb-4 flex-row items-center justify-between px-6">
        <Text className={`border-b-2 pb-0.5 text-sm font-bold uppercase ${isDark ? "border-mint text-mint" : "border-ink text-ink"}`}>
          TODAY, 24 OCT
        </Text>
        <Text className={`text-sm font-bold uppercase ${isDark ? "text-mint" : "text-ink"}`}>PROFILE</Text>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-4"
        showsVerticalScrollIndicator={false}
      >
        <View className="mb-4 px-6">
          <View className="flex-row items-end gap-2">
            <Text
              className={`text-[82px] font-extrabold leading-[86px] ${isDark ? "text-mint" : "text-ink"}`}
              style={{ fontVariant: ["tabular-nums"] }}
            >
              1,240
            </Text>
            <Text className={`mb-2 text-2xl font-semibold ${isDark ? "text-moss" : "text-ink/40"}`} style={{ fontVariant: ["tabular-nums"] }}>
              / 2,500
            </Text>
          </View>
          <Text className={`mt-1 text-sm font-bold uppercase ${isDark ? "text-mint" : "text-ink"}`}>
            CALORIES REMAINING
          </Text>

          <View className={`mt-2 h-2 overflow-hidden ${isDark ? "bg-mint/15" : "bg-ink/10"}`}>
            <View className={`h-full w-[50.4%] ${isDark ? "bg-mint" : "bg-ink"}`} />
          </View>
        </View>

        <View className="mb-4 flex-row gap-3 px-6">
          <MacroCard label="PROTEIN" value="82g" progress="65%" isDark={isDark} />
          <MacroCard label="CARBS" value="145g" progress="42%" isDark={isDark} />
          <MacroCard label="FAT" value="35g" progress="28%" isDark={isDark} />
        </View>

        <View className="px-6">
          <MealSectionHeader title="LUNCH" isDark={isDark} />
          <MealItem
            name="Grilled Chicken Salad"
            meta="High Protein • No Dressing"
            calories="450"
            isDark={isDark}
          />
          <MealItem name="Iced Americano" meta="Black" calories="15" isDark={isDark} />

          <MealSectionHeader title="BREAKFAST" isDark={isDark} />
          <MealItem
            name="Oatmeal & Berries"
            meta="Almond Milk • Blueberries"
            calories="320"
            isDark={isDark}
          />
          <MealItem name="Boiled Egg" meta="Large" calories="78" isDark={isDark} />
          <MealItem name="Black Coffee" calories="5" isDark={isDark} />
        </View>
      </ScrollView>
    </View>
  );
}
