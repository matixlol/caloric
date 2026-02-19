import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function MacroItem({ label, grams, dotClass }: { label: string; grams: string; dotClass: string }) {
  return (
    <View className="flex-row items-center justify-between">
      <View className="flex-row items-center">
        <View className={`mr-2 h-2 w-2 rounded-full ${dotClass}`} />
        <Text className="text-sm font-semibold text-ink">{label}</Text>
      </View>
      <Text className="text-sm font-bold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
        {grams}
      </Text>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between border-b border-ink/10 py-3">
      <Text className="text-sm font-medium text-ink/40">{label}</Text>
      <Text className="text-sm font-bold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
    </View>
  );
}

export default function LogFoodScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View className="flex-1 bg-cream">
      <View className="flex-row items-center justify-between px-6 pb-5" style={{ paddingTop: insets.top + 20 }}>
        <Pressable accessibilityRole="button" onPress={() => router.back()}>
          <Text className="text-sm font-bold uppercase tracking-wide text-ink/40">CANCEL</Text>
        </Pressable>
        <Text className="text-[11px] font-bold uppercase text-ink">LOG LUNCH</Text>
        <View className="w-[52px]" />
      </View>

      <ScrollView className="flex-1 px-6" showsVerticalScrollIndicator={false}>
        <Text className="mb-1 mt-3 text-[32px] font-extrabold text-ink">Avocado Toast</Text>
        <Text className="mb-8 text-sm font-semibold uppercase text-ink/40">Artisan Sourdough</Text>

        <View className="mb-10 flex-row items-center justify-between border-y border-ink/10 py-6">
          <View>
            <Text className="mb-2 text-[11px] font-bold uppercase text-ink/40">SERVING SIZE</Text>
            <Text className="border-b-2 border-ink pb-0.5 text-2xl font-bold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
              1.5 <Text className="text-sm font-semibold text-ink/40">SLICES</Text>
            </Text>
          </View>

          <View className="items-end">
            <Text className="mb-2 text-[11px] font-bold uppercase text-ink/40">TOTAL WEIGHT</Text>
            <Text className="text-lg font-bold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
              210g
            </Text>
          </View>
        </View>

        <View className="mb-10 flex-row items-center gap-10">
          <View className="relative h-[120px] w-[120px] items-center justify-center">
            <View className="absolute h-[120px] w-[120px] rounded-full border-[10px] border-ink/10" />
            <View
              className="absolute h-[120px] w-[120px] rounded-full border-[10px] border-transparent border-r-ink border-t-ink"
              style={{ transform: [{ rotate: "-90deg" }] }}
            />
            <View
              className="absolute h-[120px] w-[120px] rounded-full border-[10px] border-transparent border-b-ink/60"
              style={{ transform: [{ rotate: "-72deg" }] }}
            />
            <View
              className="absolute h-[120px] w-[120px] rounded-full border-[10px] border-transparent border-l-ink/30"
              style={{ transform: [{ rotate: "36deg" }] }}
            />

            <Text className="text-2xl font-extrabold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
              385
            </Text>
            <Text className="text-[10px] font-bold uppercase text-ink/40">KCAL</Text>
          </View>

          <View className="flex-1 gap-4">
            <MacroItem label="Protein" grams="12g" dotClass="bg-ink" />
            <MacroItem label="Carbs" grams="42g" dotClass="bg-ink/60" />
            <MacroItem label="Fat" grams="18g" dotClass="bg-ink/30" />
          </View>
        </View>

        <View className="mb-6">
          <Text className="mb-4 text-[11px] font-bold uppercase text-ink/40">NUTRITION DETAILS</Text>
          <DetailRow label="Dietary Fiber" value="9g" />
          <DetailRow label="Sugars" value="2g" />
          <DetailRow label="Sodium" value="310mg" />
          <DetailRow label="Potassium" value="450mg" />
        </View>
      </ScrollView>

      <View className="px-6 pt-6" style={{ paddingBottom: insets.bottom + 20 }}>
        <Pressable className="rounded-xl bg-ink p-5" accessibilityRole="button">
          <Text className="text-center text-base font-bold uppercase tracking-wide text-cream">ADD TO LOG</Text>
        </Pressable>
      </View>
    </View>
  );
}
