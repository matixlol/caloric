import { Stack } from "expo-router";
import { JazzExpoProvider } from "jazz-tools/expo";
import "../global.css";
import { PasskeyAuthGate } from "../src/auth/PasskeyAuthGate";
import { CaloricAccount } from "../src/jazz/schema";

const jazzApiKey = process.env.EXPO_PUBLIC_JAZZ_API_KEY?.trim() || "you@example.com";
const jazzRpId = process.env.EXPO_PUBLIC_JAZZ_RP_ID?.trim() || "";

export default function RootLayout() {
  return (
    <JazzExpoProvider
      sync={{ peer: `wss://cloud.jazz.tools/?key=${encodeURIComponent(jazzApiKey)}`, when: "always" }}
      AccountSchema={CaloricAccount}
    >
      <PasskeyAuthGate appName="Caloric" rpId={jazzRpId}>
        <Stack screenOptions={{ headerShown: false }} />
      </PasskeyAuthGate>
    </JazzExpoProvider>
  );
}
