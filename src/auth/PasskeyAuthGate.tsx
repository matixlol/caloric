import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View, useColorScheme } from "react-native";
import { useAccount, usePasskeyAuth } from "jazz-tools/expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CaloricAccount } from "../jazz/schema";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type PasskeyAuthGateProps = {
  appName: string;
  rpId: string;
  children: ReactNode;
};

type AuthScreenProps = {
  isDark: boolean;
  title: string;
  subtitle: string;
  children: ReactNode;
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function AuthScreen({ isDark, title, subtitle, children }: AuthScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <View className={`flex-1 ${isDark ? "bg-night" : "bg-cream"}`} style={{ paddingTop: insets.top }}>
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-grow justify-center px-6 py-10"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="w-full self-center">
          <Text className={`text-[46px] font-extrabold leading-[48px] ${isDark ? "text-mint" : "text-ink"}`}>{title}</Text>
          <Text className={`mt-3 mb-8 text-base font-medium ${isDark ? "text-moss" : "text-ink/65"}`}>{subtitle}</Text>

          <View className={`rounded-3xl border p-6 ${isDark ? "border-line bg-night" : "border-ink/10 bg-white"}`}>{children}</View>
        </View>
      </ScrollView>
    </View>
  );
}

export function PasskeyAuthGate({ appName, rpId, children }: PasskeyAuthGateProps) {
  const configuredRpId = rpId.trim();
  const auth = usePasskeyAuth({
    appName,
    rpId: configuredRpId || "example.com",
  });
  const me = useAccount(CaloricAccount, { resolve: { profile: true } });
  const isDark = useColorScheme() === "dark";

  const [emailInput, setEmailInput] = useState("");
  const [queuedEmail, setQueuedEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me.$isLoaded || !queuedEmail) return;
    me.profile.$jazz.set("email", queuedEmail);
    setQueuedEmail(null);
  }, [me, queuedEmail]);

  const currentEmail = useMemo(() => {
    if (!me.$isLoaded) return "";
    return normalizeEmail(me.profile.email);
  }, [me]);

  const emailIsValid = EMAIL_REGEX.test(normalizeEmail(emailInput));

  const handleLogIn = async () => {
    if (!configuredRpId) {
      setError("Set EXPO_PUBLIC_JAZZ_RP_ID before using passkeys.");
      return;
    }

    setError(null);
    setBusy(true);
    try {
      await auth.logIn();
    } catch (logInError) {
      setError(logInError instanceof Error ? logInError.message : "Passkey log in failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleSignUp = async () => {
    if (!configuredRpId) {
      setError("Set EXPO_PUBLIC_JAZZ_RP_ID before creating passkeys.");
      return;
    }

    const normalizedEmail = normalizeEmail(emailInput);
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      setError("Enter a valid email.");
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const passkeyLabel = normalizedEmail.split("@")[0] || normalizedEmail;
      setQueuedEmail(normalizedEmail);
      await auth.signUp(passkeyLabel);
    } catch (signUpError) {
      setQueuedEmail(null);
      setError(signUpError instanceof Error ? signUpError.message : "Passkey sign up failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEmail = () => {
    if (!me.$isLoaded) return;

    const normalizedEmail = normalizeEmail(emailInput);
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      setError("Enter a valid email.");
      return;
    }

    setError(null);
    me.profile.$jazz.set("email", normalizedEmail);
  };

  if (auth.state === "anonymous") {
    return (
      <AuthScreen
        isDark={isDark}
        title="LOGIN"
        subtitle="Use your email and passkey to continue."
      >
        <View className="w-full">
          <View className="gap-5">
            <View className="gap-2">
              <Text className={`text-[11px] font-bold uppercase tracking-wide ${isDark ? "text-moss" : "text-ink/50"}`}>Email</Text>
              <TextInput
                value={emailInput}
                onChangeText={setEmailInput}
                placeholder="you@company.com"
                placeholderTextColor={isDark ? "#93A785" : "#5D7A69"}
                className={`h-14 rounded-none border-2 px-5 text-[17px] font-semibold ${isDark ? "border-moss/60 bg-pine/70 text-mint" : "border-ink/25 bg-white text-ink"}`}
                autoCapitalize="none"
                keyboardType="email-address"
              />
            </View>
          </View>

          {error ? <Text className={`mt-3 text-sm ${isDark ? "text-red-300" : "text-red-700"}`}>{error}</Text> : null}

          <View className="mt-6 gap-3">
            <Pressable
              className={`items-center rounded-none px-5 py-5 ${busy ? "opacity-60" : ""} ${isDark ? "bg-mint" : "bg-ink"}`}
              disabled={busy || !emailIsValid}
              onPress={handleSignUp}
            >
              <Text className={`text-base font-bold ${isDark ? "text-night" : "text-cream"}`}>Create Passkey</Text>
            </Pressable>

            <View className="flex-row items-center gap-3">
              <View className={`h-px flex-1 ${isDark ? "bg-line" : "bg-ink/10"}`} />
              <Text className={`text-[10px] font-bold uppercase ${isDark ? "text-moss" : "text-ink/40"}`}>Or</Text>
              <View className={`h-px flex-1 ${isDark ? "bg-line" : "bg-ink/10"}`} />
            </View>

            <Pressable
              className={`items-center rounded-none border-2 px-5 py-5 ${busy ? "opacity-60" : ""} ${isDark ? "border-moss bg-night" : "border-ink/25 bg-white"}`}
              disabled={busy}
              onPress={handleLogIn}
            >
              <Text className={`text-base font-semibold ${isDark ? "text-mint" : "text-ink"}`}>Log In with Existing Passkey</Text>
            </Pressable>
          </View>
        </View>
      </AuthScreen>
    );
  }

  if (!me.$isLoaded) {
    return (
      <View className={`flex-1 items-center justify-center ${isDark ? "bg-night" : "bg-cream"}`}>
        <ActivityIndicator size="large" color={isDark ? "#D9F2E2" : "#104028"} />
      </View>
    );
  }

  if (!currentEmail) {
    return (
      <AuthScreen
        isDark={isDark}
        title="ADD EMAIL"
        subtitle="Your account requires an email. This is stored on your public profile."
      >
        <View className="w-full">
          <View className="gap-2">
            <Text className={`text-[11px] font-bold uppercase tracking-wide ${isDark ? "text-moss" : "text-ink/50"}`}>Email</Text>
            <TextInput
              value={emailInput}
              onChangeText={setEmailInput}
              placeholder="you@company.com"
              placeholderTextColor={isDark ? "#93A785" : "#5D7A69"}
              className={`h-14 rounded-none border-2 px-5 text-[17px] font-semibold ${isDark ? "border-moss/60 bg-pine/70 text-mint" : "border-ink/25 bg-white text-ink"}`}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          {error ? <Text className={`mt-3 text-sm ${isDark ? "text-red-300" : "text-red-700"}`}>{error}</Text> : null}

          <View className="mt-6">
            <Pressable
              className={`items-center rounded-none px-5 py-5 ${busy ? "opacity-60" : ""} ${isDark ? "bg-mint" : "bg-ink"}`}
              onPress={handleSaveEmail}
              disabled={busy}
            >
              <Text className={`text-base font-bold ${isDark ? "text-night" : "text-cream"}`}>Save Email</Text>
            </Pressable>
          </View>
        </View>
      </AuthScreen>
    );
  }

  return <>{children}</>;
}
