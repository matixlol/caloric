import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Platform, PlatformColor } from "react-native";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

export default function TabsLayout() {
  return (
    <NativeTabs
      blurEffect="systemChromeMaterial"
      disableTransparentOnScrollEdge
      minimizeBehavior="onScrollDown"
      iconColor={{
        default: iosColor("secondaryLabel", "#6B7280"),
        selected: iosColor("label", "#111827"),
      }}
      labelStyle={{
        default: { color: iosColor("secondaryLabel", "#6B7280") },
        selected: { color: iosColor("label", "#111827") },
      }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
        <NativeTabs.Trigger.Label>Today</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} md="settings" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
