import { Stack } from "expo-router";
import { Platform, PlatformColor } from "react-native";
import { useAppTheme } from "../../src/theme/useAppTheme";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

export default function HomeLayout() {
  const { palette } = useAppTheme();

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.background } }}>
      <Stack.Screen name="index" />
      {/* Settings is reached from the gear in the Today header, presented as a
          sheet (same mechanism as the add-food view) rather than a tab. */}
      <Stack.Screen
        name="settings"
        options={{
          presentation: "pageSheet",
          sheetGrabberVisible: true,
          sheetCornerRadius: 18,
          contentStyle: {
            backgroundColor: iosColor("systemGroupedBackground", "#F3F4F6"),
          },
        }}
      />
    </Stack>
  );
}
