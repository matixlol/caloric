import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useAppTheme } from "../../src/theme/useAppTheme";

export default function TabsLayout() {
  const { isDark, palette } = useAppTheme();

  return (
    <NativeTabs
      blurEffect={isDark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
      backgroundColor={palette.background}
      disableTransparentOnScrollEdge
      minimizeBehavior="onScrollDown"
      tintColor={palette.label}
      iconColor={{
        default: palette.secondaryLabel,
        selected: palette.label,
      }}
      labelStyle={{
        default: { color: palette.secondaryLabel },
        selected: { color: palette.label },
      }}
      shadowColor={palette.separator}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
        <NativeTabs.Trigger.Label>Today</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="ai">
        <NativeTabs.Trigger.Icon
          sf={{ default: "sparkles", selected: "sparkles" }}
          md="auto_awesome"
        />
        <NativeTabs.Trigger.Label>AI Log</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} md="settings" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
