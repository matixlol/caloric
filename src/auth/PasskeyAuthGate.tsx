import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { useAccount, usePasskeyAuth } from "jazz-tools/expo";
import { CaloricAccount } from "../jazz/schema";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type PasskeyAuthGateProps = {
  appName: string;
  rpId: string;
  children: ReactNode;
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function PasskeyAuthGate({ appName, rpId, children }: PasskeyAuthGateProps) {
  const configuredRpId = rpId.trim();
  const auth = usePasskeyAuth({
    appName,
    rpId: configuredRpId || "example.com",
  });
  const me = useAccount(CaloricAccount, { resolve: { profile: true } });

  const [displayName, setDisplayName] = useState("");
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

    if (!displayName.trim()) {
      setError("Name is required.");
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
      setQueuedEmail(normalizedEmail);
      await auth.signUp(displayName.trim());
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
      <View className="flex-1 items-center justify-center bg-night px-6">
        <View className="w-full max-w-md rounded-2xl border border-line bg-night p-6">
          <Text className="mb-2 text-2xl font-bold text-mint">Secure Sign-In</Text>
          <Text className="mb-6 text-sm text-moss">
            Use a passkey to sign in. We also require an email on your profile.
          </Text>

          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Full name"
            placeholderTextColor="#93A785"
            className="mb-3 rounded-lg border border-line px-4 py-3 text-mint"
            autoCapitalize="words"
          />

          <TextInput
            value={emailInput}
            onChangeText={setEmailInput}
            placeholder="Email"
            placeholderTextColor="#93A785"
            className="mb-4 rounded-lg border border-line px-4 py-3 text-mint"
            autoCapitalize="none"
            keyboardType="email-address"
          />

          {error ? <Text className="mb-3 text-sm text-red-300">{error}</Text> : null}

          <Pressable
            className={`mb-3 items-center rounded-lg px-4 py-3 ${busy ? "bg-moss" : "bg-mint"}`}
            disabled={busy || !emailIsValid || !displayName.trim()}
            onPress={handleSignUp}
          >
            <Text className="font-semibold text-night">Create Passkey</Text>
          </Pressable>

          <Pressable
            className={`items-center rounded-lg border border-moss px-4 py-3 ${busy ? "opacity-60" : ""}`}
            disabled={busy}
            onPress={handleLogIn}
          >
            <Text className="font-semibold text-mint">Log In with Existing Passkey</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (!me.$isLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-night">
        <ActivityIndicator size="large" color="#D9F57A" />
      </View>
    );
  }

  if (!currentEmail) {
    return (
      <View className="flex-1 items-center justify-center bg-night px-6">
        <View className="w-full max-w-md rounded-2xl border border-line bg-night p-6">
          <Text className="mb-2 text-2xl font-bold text-mint">Add Your Email</Text>
          <Text className="mb-6 text-sm text-moss">
            Your account requires an email. This is stored on your public profile.
          </Text>

          <TextInput
            value={emailInput}
            onChangeText={setEmailInput}
            placeholder="Email"
            placeholderTextColor="#93A785"
            className="mb-4 rounded-lg border border-line px-4 py-3 text-mint"
            autoCapitalize="none"
            keyboardType="email-address"
          />

          {error ? <Text className="mb-3 text-sm text-red-300">{error}</Text> : null}

          <Pressable
            className="items-center rounded-lg bg-mint px-4 py-3"
            onPress={handleSaveEmail}
            disabled={busy}
          >
            <Text className="font-semibold text-night">Save Email</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return <>{children}</>;
}
