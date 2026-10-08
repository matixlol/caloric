import { useMemo } from "react";
import { Platform, PlatformColor, useColorScheme } from "react-native";
import { getBrandPalette } from "./brandPalette";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

function createAppPalette(isDark: boolean) {
  return {
    ...getBrandPalette(isDark),
    background: iosColor("systemGroupedBackground", getBrandPalette(isDark).background),
    card: iosColor("secondarySystemGroupedBackground", getBrandPalette(isDark).card),
    cardElevated: iosColor("tertiarySystemGroupedBackground", getBrandPalette(isDark).cardElevated),
    inputBackground: iosColor("tertiarySystemGroupedBackground", getBrandPalette(isDark).inputBackground),
    success: iosColor("systemGreen", isDark ? "#22C55E" : "#16A34A"),
    error: iosColor("systemRed", isDark ? "#F87171" : "#DC2626"),
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
