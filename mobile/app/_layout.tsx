import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { DarkTheme, DefaultTheme, ThemeProvider, type Theme } from "@react-navigation/native";
import { Stack } from "expo-router";
import { useMemo } from "react";
import { Platform, PlatformColor, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "../global.css";
import { ClerkAuthGate } from "../src/auth/ClerkAuthGate";
import { AutoBackupCoordinator } from "../src/backup/AutoBackupCoordinator";
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

const clerkPublishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() || "";
const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

function MissingClerkKeyScreen() {
  return (
    <View style={styles.missingKeyContainer}>
      <Text style={styles.missingKeyText}>
        Missing authentication configuration. Set your publishable key to enable login.
      </Text>
    </View>
  );
}

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
        background: palette.background,
        card: palette.card,
        text: palette.label,
        border: palette.separator,
        notification: palette.error,
      },
    };
  }, [colorScheme, palette]);

  if (!clerkPublishableKey) {
    return <MissingClerkKeyScreen />;
  }

  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <ClerkProvider publishableKey={clerkPublishableKey} tokenCache={tokenCache}>
        <DataProvider>
          <ThemeProvider value={navigationTheme}>
            <ClerkAuthGate>
              <AutoBackupCoordinator />
              <AppNavigator />
            </ClerkAuthGate>
          </ThemeProvider>
        </DataProvider>
      </ClerkProvider>
    </GestureHandlerRootView>
  );
});

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  missingKeyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    backgroundColor: iosColor("systemGroupedBackground", "#F3F4F6"),
  },
  missingKeyText: {
    textAlign: "center",
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "600",
    color: iosColor("label", "#111827"),
  },
});
