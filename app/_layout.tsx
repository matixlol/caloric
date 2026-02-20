import { ClerkProvider, useClerk } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { Stack } from "expo-router";
import { JazzExpoProviderWithClerk } from "jazz-tools/expo";
import { type ReactNode } from "react";
import { Platform, PlatformColor, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "../global.css";
import { ClerkAuthGate } from "../src/auth/ClerkAuthGate";
import { CaloricAccount } from "../src/jazz/schema";

const jazzApiKey = process.env.EXPO_PUBLIC_JAZZ_API_KEY?.trim() || "you@example.com";
const clerkPublishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() || "";
const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

function JazzProvider({ children }: { children: ReactNode }) {
  const clerk = useClerk();

  return (
    <JazzExpoProviderWithClerk
      clerk={clerk}
      sync={{ peer: `wss://cloud.jazz.tools/?key=${encodeURIComponent(jazzApiKey)}`, when: "always" }}
      AccountSchema={CaloricAccount}
    >
      {children}
    </JazzExpoProviderWithClerk>
  );
}

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

export default function RootLayout() {
  if (!clerkPublishableKey) {
    return <MissingClerkKeyScreen />;
  }

  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <ClerkProvider publishableKey={clerkPublishableKey} tokenCache={tokenCache}>
        <JazzProvider>
          <ClerkAuthGate>
            <AppNavigator />
          </ClerkAuthGate>
        </JazzProvider>
      </ClerkProvider>
    </GestureHandlerRootView>
  );
}

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
