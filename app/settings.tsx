import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function SectionTitle({ title }: { title: string }) {
  return <Text className="mb-6 mt-8 text-xs font-bold uppercase tracking-wide text-ink/40">{title}</Text>;
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View className="flex-1 bg-cream" style={{ paddingTop: insets.top + 20 }}>
      <View className="mb-8 flex-row items-center justify-between px-6">
        <Pressable accessibilityRole="button" onPress={() => router.back()}>
          <Text className="border-b-2 border-ink pb-0.5 text-sm font-bold uppercase text-ink">BACK</Text>
        </Pressable>
        <Text className="text-sm font-bold uppercase text-ink">SETTINGS</Text>
      </View>

      <ScrollView className="flex-1 px-6" showsVerticalScrollIndicator={false}>
        <SectionTitle title="Goals" />
        <View className="mb-10">
          <View className="mb-3 flex-row items-end justify-between">
            <Text className="text-base font-semibold text-ink">Daily Calorie Goal</Text>
            <Text className="text-[32px] font-extrabold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
              2,500
            </Text>
          </View>
          <View className="relative my-5 h-1 bg-ink/10">
            <View className="absolute h-5 w-5 rounded-full bg-ink" style={{ left: "50.4%", top: -8, marginLeft: -10 }} />
          </View>
        </View>

        <SectionTitle title="Macro Ratios" />
        <View className="mb-4 flex-row gap-3">
          <View className="flex-1 border-b-2 border-ink pb-2">
            <Text className="mb-1 text-[11px] font-bold uppercase text-ink/40">Protein</Text>
            <Text className="text-xl font-bold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
              30%
            </Text>
          </View>
          <View className="flex-1 border-b-2 border-ink pb-2">
            <Text className="mb-1 text-[11px] font-bold uppercase text-ink/40">Carbs</Text>
            <Text className="text-xl font-bold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
              50%
            </Text>
          </View>
          <View className="flex-1 border-b-2 border-ink pb-2">
            <Text className="mb-1 text-[11px] font-bold uppercase text-ink/40">Fat</Text>
            <Text className="text-xl font-bold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
              20%
            </Text>
          </View>
        </View>

      </ScrollView>

      <View className="bg-cream px-6 pb-6 pt-6" style={{ paddingBottom: insets.bottom + 20 }}>
        <Pressable className="rounded-xl bg-ink px-4 py-[18px]" accessibilityRole="button">
          <Text className="text-center text-base font-bold uppercase tracking-wide text-cream">Save Changes</Text>
        </Pressable>
      </View>
    </View>
  );
}
