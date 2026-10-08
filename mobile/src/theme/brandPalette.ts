// Generated from design/brand/palette.json by generate-brand-assets.js.
import { Appearance, DynamicColorIOS, Platform, PlatformColor } from "react-native";

export const brandPalettes = {
  "light": {
    "background": "#F2F2F7",
    "card": "#FFFFFF",
    "cardElevated": "#FFFFFF",
    "inputBackground": "#E5E5EA",
    "overlay": "#F2F2F7EB",
    "label": "#000000",
    "secondaryLabel": "#636366",
    "tertiaryLabel": "#8E8E93",
    "separator": "#C6C6C8",
    "tint": "#AD4D00",
    "tintSoft": "#FFE2BE",
    "tintDisabled": "#E5E5EA",
    "buttonDisabledText": "#8E8E93",
    "buttonText": "#FFFFFF",
    "userBubble": "#AD4D00",
    "assistantBubble": "#E5E5EA"
  },
  "dark": {
    "background": "#000000",
    "card": "#1C1C1E",
    "cardElevated": "#2C2C2E",
    "inputBackground": "#2C2C2E",
    "overlay": "#000000EB",
    "label": "#FFFFFF",
    "secondaryLabel": "#AEAEB2",
    "tertiaryLabel": "#8E8E93",
    "separator": "#38383A",
    "tint": "#FFA536",
    "tintSoft": "#49321E",
    "tintDisabled": "#3A3A3C",
    "buttonDisabledText": "#8E8E93",
    "buttonText": "#22231D",
    "userBubble": "#FFA536",
    "assistantBubble": "#2C2C2E"
  }
} as const;
export const brandAccent = "#FF8400";
export const brandInk = "#22231D";
export const getBrandPalette = (isDark: boolean) => brandPalettes[isDark ? "dark" : "light"];

const roles: Record<string, keyof typeof brandPalettes.light> = {
  systemGroupedBackground: "background", secondarySystemGroupedBackground: "card",
  systemBackground: "cardElevated", secondarySystemBackground: "inputBackground",
  tertiarySystemGroupedBackground: "inputBackground", label: "label",
  secondaryLabel: "secondaryLabel", tertiaryLabel: "tertiaryLabel",
  separator: "separator", systemBlue: "tint", tertiarySystemFill: "tintDisabled",
  secondarySystemFill: "assistantBubble", quaternarySystemFill: "inputBackground",
};
export function bentoColor(name: string, fallback: string, isDark?: boolean) {
  const role = roles[name];
  if (Platform.OS === "ios" && name !== "systemBlue") return PlatformColor(name);
  if (!role) return Platform.OS === "ios" ? PlatformColor(name) : fallback;
  if (isDark === undefined && Platform.OS === "ios") {
    return DynamicColorIOS({ light: brandPalettes.light[role], dark: brandPalettes.dark[role] });
  }
  return getBrandPalette(isDark ?? Appearance.getColorScheme() === "dark")[role];
}
