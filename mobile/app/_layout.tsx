import { DarkTheme, DefaultTheme, ThemeProvider, type Theme } from "expo-router/react-navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useMemo } from "react";
import { Platform, PlatformColor, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AIChatProvider } from "../src/ai/AIChatProvider";
import { AuthGate } from "../src/auth/AuthGate";
import { AutoBackupCoordinator } from "../src/backup/AutoBackupCoordinator";
import { WidgetSyncCoordinator } from "../src/widget/WidgetSyncCoordinator";
import { DataProvider } from "../src/data/DataProvider";
import * as Sentry from "@sentry/react-native";
import { useAppTheme } from "../src/theme/useAppTheme";

Sentry.init({
  dsn: 'https://b717a9ae29012fc29268ccc8b531ea67@o4510397347987456.ingest.us.sentry.io/4511171255009280',

  // Adds more context data to events (IP address, cookies, user, etc.)
  // For more information, visit: https://docs.sentry.io/platforms/react-native/data-management/data-collected/
  sendDefaultPii: true,

  // Enable Logs
  enableLogs: true,

  // uncomment the line below to enable Spotlight (https://spotlightjs.com)
  // spotlight: __DEV__,
});

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;
const navigationColor = (value: unknown, fallback: unknown) =>
  typeof value === "string" ? value : typeof fallback === "string" ? fallback : "#000000";
const queryClient = new QueryClient();

function AppNavigator() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="log-food" options={{ presentation: "modal" }} />
      <Stack.Screen
        name="entry-details"
        options={{
          presentation: "pageSheet",
        }}
      />
      <Stack.Screen
        name="friend-day"
        dangerouslySingular={(_name, params) => {
          const sheetInstance = params.sheetInstance;
          return typeof sheetInstance === "string" ? sheetInstance : undefined;
        }}
        options={{
          presentation: "formSheet",
          headerShown: false,
          freezeOnBlur: false,
          contentStyle: {
            backgroundColor: iosColor("systemGroupedBackground", "#F3F4F6"),
          },
          sheetAllowedDetents: [0.9],
          sheetInitialDetentIndex: 0,
          sheetGrabberVisible: true,
          sheetCornerRadius: 18,
          sheetExpandsWhenScrolledToEdge: false,
        }}
      />
    </Stack>
  );
}

export default Sentry.wrap(function RootLayout() {
  const { colorScheme, palette } = useAppTheme();
  const navigationTheme = useMemo<Theme>(() => {
    const baseTheme = colorScheme === "dark" ? DarkTheme : DefaultTheme;

    return {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        primary: palette.tint,
        background: navigationColor(palette.background, baseTheme.colors.background),
        card: navigationColor(palette.card, baseTheme.colors.card),
        text: navigationColor(palette.label, baseTheme.colors.text),
        border: navigationColor(palette.separator, baseTheme.colors.border),
        notification: navigationColor(palette.error, baseTheme.colors.notification),
      },
    };
  }, [colorScheme, palette]);

  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <DataProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider value={navigationTheme}>
            <AuthGate>
              <AutoBackupCoordinator />
              <WidgetSyncCoordinator />
              <AIChatProvider>
                <AppNavigator />
              </AIChatProvider>
            </AuthGate>
          </ThemeProvider>
        </QueryClientProvider>
      </DataProvider>
    </GestureHandlerRootView>
  );
});

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
});
