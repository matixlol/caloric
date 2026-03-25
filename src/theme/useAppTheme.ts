import { useMemo } from "react";
import { Platform, PlatformColor, useColorScheme } from "react-native";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

function createAppPalette(isDark: boolean) {
  return {
    background: iosColor("systemGroupedBackground", isDark ? "#09090B" : "#F3F4F6"),
    card: iosColor("secondarySystemGroupedBackground", isDark ? "#18181B" : "#FFFFFF"),
    cardElevated: iosColor("systemBackground", isDark ? "#111113" : "#FFFFFF"),
    inputBackground: iosColor("secondarySystemBackground", isDark ? "#111113" : "#FFFFFF"),
    overlay: isDark ? "rgba(9, 9, 11, 0.86)" : "rgba(243, 244, 246, 0.92)",
    label: iosColor("label", isDark ? "#FAFAFA" : "#111827"),
    secondaryLabel: iosColor("secondaryLabel", isDark ? "#A1A1AA" : "#6B7280"),
    tertiaryLabel: iosColor("tertiaryLabel", isDark ? "#71717A" : "#9CA3AF"),
    separator: iosColor("separator", isDark ? "#27272A" : "#D1D5DB"),
    tint: isDark ? "#3B82F6" : "#2563EB",
    tintDisabled: iosColor("tertiarySystemFill", isDark ? "#2B2B31" : "#D1D5DB"),
    buttonDisabledText: isDark ? "#A1A1AA" : "#6B7280",
    buttonText: "#FFFFFF",
    success: iosColor("systemGreen", isDark ? "#22C55E" : "#16A34A"),
    error: iosColor("systemRed", isDark ? "#F87171" : "#DC2626"),
    userBubble: "#2563EB",
    assistantBubble: iosColor("secondarySystemFill", isDark ? "#27272A" : "#E5E7EB"),
  };
}

export type AppPalette = ReturnType<typeof createAppPalette>;

export type AppTheme = {
  colorScheme: "light" | "dark";
  isDark: boolean;
  markdownTheme: "light" | "dark";
  palette: AppPalette;
};

export function useAppTheme(): AppTheme {
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";

  return useMemo(() => {
    const isDark = colorScheme === "dark";

    return {
      colorScheme,
      isDark,
      markdownTheme: colorScheme,
      palette: createAppPalette(isDark),
    };
  }, [colorScheme]);
}

export function useThemedStyles<T>(createStyles: (theme: AppTheme) => T) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme, createStyles]);

  return {
    ...theme,
    styles,
  };
}
