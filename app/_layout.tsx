import { ClerkProvider, useClerk } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { Stack } from "expo-router";
import { JazzExpoProviderWithClerk } from "jazz-tools/expo";
import { type ReactNode } from "react";
import { Text, View } from "react-native";
import "../global.css";
import { ClerkAuthGate } from "../src/auth/ClerkAuthGate";
import { CaloricAccount } from "../src/jazz/schema";

const jazzApiKey = process.env.EXPO_PUBLIC_JAZZ_API_KEY?.trim() || "you@example.com";
const clerkPublishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() || "";

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
    <View className="flex-1 items-center justify-center bg-cream px-6">
      <Text className="text-center text-lg font-semibold text-ink">Missing authentication configuration. Set your publishable key to enable login.</Text>
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
          <Stack screenOptions={{ headerShown: false }} />
        </ClerkAuthGate>
      </JazzProvider>
    </ClerkProvider>
  );
}
