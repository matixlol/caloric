import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
    <View className="flex-1">
      <Text className="mb-1 text-[11px] font-bold uppercase text-ink">
        {label}
      </Text>
      <Text
        className="mb-1.5 text-[20px] font-bold text-ink"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
      <View className="relative h-1 bg-ink/10">
        <View className="absolute inset-y-0 left-0 bg-ink" style={{ width: progress }} />
      </View>
    </View>
  );
}

function MealItem({ name, meta, calories }: MealItemProps) {
  return (
    <View className="flex-row items-start justify-between border-b border-ink/10 py-4">
      <View className="shrink pr-3">
        <Text className="mb-1 text-base font-semibold text-ink">{name}</Text>
        {meta ? <Text className="text-xs font-medium text-ink/40">{meta}</Text> : null}
      </View>
      <Text className="text-base font-bold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
        {calories}
      </Text>
    </View>
  );
}

function MealSectionHeader({ title }: { title: string }) {
  return (
    <View className="mb-2 flex-row items-center justify-between pt-4">
      <Text className="text-xs font-bold uppercase text-ink/40">{title}</Text>
      <Pressable className="h-8 w-8 items-center justify-center rounded-full bg-ink" accessibilityRole="button">
        <Text className="-mt-px text-xl font-light text-cream">+</Text>
      </Pressable>
    </View>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-cream" style={{ paddingTop: insets.top }}>
      <View className="mb-4 flex-row items-center justify-between px-6">
        <Text className="border-b-2 border-ink pb-0.5 text-sm font-bold uppercase text-ink">
          TODAY, 24 OCT
        </Text>
        <Text className="text-sm font-bold uppercase text-ink">PROFILE</Text>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-4"
        showsVerticalScrollIndicator={false}
      >
        <View className="mb-4 px-6">
          <View className="flex-row items-end gap-2">
            <Text
              className="text-[82px] font-extrabold leading-[86px] text-ink"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              1,240
            </Text>
            <Text className="mb-2 text-2xl font-semibold text-ink/40" style={{ fontVariant: ["tabular-nums"] }}>
              / 2,500
            </Text>
          </View>
          <Text className="mt-1 text-sm font-bold uppercase text-ink">
            CALORIES REMAINING
          </Text>

          <View className="mt-2 h-2 overflow-hidden bg-ink/10">
            <View className="h-full w-[50.4%] bg-ink" />
          </View>
        </View>

        <View className="mb-4 flex-row gap-3 px-6">
          <MacroCard label="PROTEIN" value="82g" progress="65%" />
          <MacroCard label="CARBS" value="145g" progress="42%" />
          <MacroCard label="FAT" value="35g" progress="28%" />
        </View>

        <View className="px-6">
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
