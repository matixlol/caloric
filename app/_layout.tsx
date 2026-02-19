import { ClerkProvider, useClerk } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { JazzExpoProviderWithClerk } from "jazz-tools/expo";
import { type ReactNode } from "react";
import { Platform, PlatformColor, StyleSheet, Text, View } from "react-native";
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

export default function RootLayout() {
  if (!clerkPublishableKey) {
    return <MissingClerkKeyScreen />;
  }

  return (
    <ClerkProvider publishableKey={clerkPublishableKey} tokenCache={tokenCache}>
      <JazzProvider>
        <ClerkAuthGate>
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
            <NativeTabs.BottomAccessory>
              <View style={styles.bottomAccessory}>
                <Text style={styles.bottomAccessoryText}>Caloric</Text>
              </View>
            </NativeTabs.BottomAccessory>

            <NativeTabs.Trigger name="index">
              <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
              <NativeTabs.Trigger.Label>Today</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>

            <NativeTabs.Trigger name="log-food" role="search">
              <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
              <NativeTabs.Trigger.Label>Foods</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>

            <NativeTabs.Trigger name="settings">
              <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} md="settings" />
              <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>
          </NativeTabs>
        </ClerkAuthGate>
      </JazzProvider>
    </ClerkProvider>
  );
}

const styles = StyleSheet.create({
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
  bottomAccessory: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 4,
  },
  bottomAccessoryText: {
    fontSize: 12,
    fontWeight: "600",
    color: iosColor("secondaryLabel", "#6B7280"),
  },
});
