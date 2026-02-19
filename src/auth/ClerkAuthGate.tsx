import {
  isClerkAPIResponseError,
  useAuth,
  useSSO,
  useSignIn,
  useSignUp,
  useUser,
} from "@clerk/clerk-expo";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import { useAccount } from "jazz-tools/expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CaloricAccount } from "../jazz/schema";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ClerkAuthGateProps = {
  children: ReactNode;
};

type AuthScreenProps = {
  isDark: boolean;
  title: string;
  subtitle: string;
  children: ReactNode;
};

type AuthMode = "sign-in" | "sign-up";
type VerificationMode = "none" | "sign-in" | "sign-up";
type SocialStrategy = "oauth_google";

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function sanitizeProviderMentions(value: string) {
  return value.replace(/clerk/gi, "auth");
}

function getAuthErrorMessage(error: unknown) {
  if (isClerkAPIResponseError(error) && error.errors.length > 0) {
    const firstError = error.errors[0];
    return sanitizeProviderMentions(
      firstError.longMessage || firstError.message || "Authentication failed.",
    );
  }

  if (error instanceof Error) {
    return sanitizeProviderMentions(error.message);
  }

  return "Authentication failed.";
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

export function ClerkAuthGate({ children }: ClerkAuthGateProps) {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { startSSOFlow } = useSSO();
  const { isLoaded: signInLoaded, signIn, setActive: setSignInActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp, setActive: setSignUpActive } = useSignUp();
  const me = useAccount(CaloricAccount, { resolve: { profile: true } });
  const isDark = useColorScheme() === "dark";

  const [authMode, setAuthMode] = useState<AuthMode>("sign-in");
  const [verificationMode, setVerificationMode] = useState<VerificationMode>("none");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const currentEmail = useMemo(() => {
    if (!me.$isLoaded) return "";
    return normalizeEmail(me.profile.email);
  }, [me]);

  useEffect(() => {
    if (!isSignedIn || !me.$isLoaded || currentEmail) {
      return;
    }

    const clerkEmail = normalizeEmail(user?.primaryEmailAddress?.emailAddress || "");
    if (EMAIL_REGEX.test(clerkEmail)) {
      me.profile.$jazz.set("email", clerkEmail);
    }
  }, [currentEmail, isSignedIn, me, user]);

  const emailIsValid = EMAIL_REGEX.test(normalizeEmail(emailInput));

  const resetMessages = () => {
    setError(null);
    setInfo(null);
  };

  const switchAuthMode = (nextMode: AuthMode) => {
    setAuthMode(nextMode);
    setVerificationMode("none");
    setCodeInput("");
    resetMessages();
  };

  const handleSignIn = async () => {
    if (!signInLoaded || !setSignInActive) {
      return;
    }

    const email = normalizeEmail(emailInput);
    if (!EMAIL_REGEX.test(email)) {
      setError("Enter a valid email.");
      return;
    }

    if (!passwordInput.trim()) {
      setError("Enter your password.");
      return;
    }

    resetMessages();
    setBusy(true);

    try {
      const signInAttempt = await signIn.create({
        identifier: email,
        password: passwordInput,
      });

      if (signInAttempt.status === "complete" && signInAttempt.createdSessionId) {
        await setSignInActive({ session: signInAttempt.createdSessionId });
        return;
      }

      if (signInAttempt.status === "needs_second_factor") {
        const emailCodeSupported =
          signInAttempt.supportedSecondFactors?.some(
            (factor) => factor.strategy === "email_code",
          ) ?? false;

        if (!emailCodeSupported) {
          setError("This account requires a second factor that is not supported in this screen.");
          return;
        }

        await signInAttempt.prepareSecondFactor({ strategy: "email_code" });
        setVerificationMode("sign-in");
        setInfo("Enter the email verification code to complete sign in.");
        return;
      }

      setError("Sign in could not be completed. Please try again.");
    } catch (signInError) {
      setError(getAuthErrorMessage(signInError));
    } finally {
      setBusy(false);
    }
  };

  const handleSignInVerification = async () => {
    if (!signInLoaded || !setSignInActive) {
      return;
    }

    const code = codeInput.trim();
    if (!code) {
      setError("Enter the verification code.");
      return;
    }

    resetMessages();
    setBusy(true);

    try {
      const result = await signIn.attemptSecondFactor({
        strategy: "email_code",
        code,
      });

      if (result.status === "complete" && result.createdSessionId) {
        await setSignInActive({ session: result.createdSessionId });
        return;
      }

      setError("Verification is incomplete. Request a new code and try again.");
    } catch (verificationError) {
      setError(getAuthErrorMessage(verificationError));
    } finally {
      setBusy(false);
    }
  };

  const handleSignUp = async () => {
    if (!signUpLoaded || !setSignUpActive) {
      return;
    }

    const email = normalizeEmail(emailInput);
    if (!EMAIL_REGEX.test(email)) {
      setError("Enter a valid email.");
      return;
    }

    if (!passwordInput.trim()) {
      setError("Enter a password.");
      return;
    }

    resetMessages();
    setBusy(true);

    try {
      const signUpAttempt = await signUp.create({
        emailAddress: email,
        password: passwordInput,
      });

      if (signUpAttempt.status === "complete" && signUpAttempt.createdSessionId) {
        await setSignUpActive({ session: signUpAttempt.createdSessionId });
        return;
      }

      await signUpAttempt.prepareEmailAddressVerification({ strategy: "email_code" });
      setVerificationMode("sign-up");
      setInfo("We sent a verification code to your email.");
    } catch (signUpError) {
      setError(getAuthErrorMessage(signUpError));
    } finally {
      setBusy(false);
    }
  };

  const handleSignUpVerification = async () => {
    if (!signUpLoaded || !setSignUpActive) {
      return;
    }

    const code = codeInput.trim();
    if (!code) {
      setError("Enter the verification code.");
      return;
    }

    resetMessages();
    setBusy(true);

    try {
      const verificationAttempt = await signUp.attemptEmailAddressVerification({
        code,
      });

      if (
        verificationAttempt.status === "complete" &&
        verificationAttempt.createdSessionId
      ) {
        await setSignUpActive({ session: verificationAttempt.createdSessionId });
        return;
      }

      setError("Verification is incomplete. Request a new code and try again.");
    } catch (verificationError) {
      setError(getAuthErrorMessage(verificationError));
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

  const handleSocialSignIn = async (strategy: SocialStrategy) => {
    resetMessages();
    setBusy(true);

    try {
      const { createdSessionId, setActive, authSessionResult } = await startSSOFlow({
        strategy,
      });

      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        return;
      }

      if (authSessionResult?.type === "cancel") {
        setInfo("Sign in was canceled.");
        return;
      }

      setInfo("Continue in browser to finish sign in.");
    } catch (socialError) {
      setError(getAuthErrorMessage(socialError));
    } finally {
      setBusy(false);
    }
  };

  if (!authLoaded) {
    return (
      <View className={`flex-1 items-center justify-center ${isDark ? "bg-night" : "bg-cream"}`}>
        <ActivityIndicator size="large" color={isDark ? "#D9F2E2" : "#104028"} />
      </View>
    );
  }

  if (!isSignedIn) {
    const showingVerification = verificationMode !== "none";
    const isSigningIn = authMode === "sign-in";

    return (
      <AuthScreen
        isDark={isDark}
        title={showingVerification ? "VERIFY" : isSigningIn ? "LOGIN" : "SIGN UP"}
        subtitle={
          showingVerification
            ? "Enter the one-time code sent to continue."
            : isSigningIn
              ? "Sign in to your account."
              : "Create an account to continue."
        }
      >
        <View className="w-full">
          {!showingVerification ? (
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

              <View className="gap-2">
                <Text className={`text-[11px] font-bold uppercase tracking-wide ${isDark ? "text-moss" : "text-ink/50"}`}>Password</Text>
                <TextInput
                  value={passwordInput}
                  onChangeText={setPasswordInput}
                  placeholder="••••••••"
                  placeholderTextColor={isDark ? "#93A785" : "#5D7A69"}
                  className={`h-14 rounded-none border-2 px-5 text-[17px] font-semibold ${isDark ? "border-moss/60 bg-pine/70 text-mint" : "border-ink/25 bg-white text-ink"}`}
                  secureTextEntry
                  autoCapitalize="none"
                />
              </View>
            </View>
          ) : (
            <View className="gap-2">
              <Text className={`text-[11px] font-bold uppercase tracking-wide ${isDark ? "text-moss" : "text-ink/50"}`}>Verification Code</Text>
              <TextInput
                value={codeInput}
                onChangeText={setCodeInput}
                placeholder="123456"
                placeholderTextColor={isDark ? "#93A785" : "#5D7A69"}
                className={`h-14 rounded-none border-2 px-5 text-[17px] font-semibold ${isDark ? "border-moss/60 bg-pine/70 text-mint" : "border-ink/25 bg-white text-ink"}`}
                keyboardType="number-pad"
                autoCapitalize="none"
              />
            </View>
          )}

          {error ? <Text className={`mt-3 text-sm ${isDark ? "text-red-300" : "text-red-700"}`}>{error}</Text> : null}
          {info ? <Text className={`mt-3 text-sm ${isDark ? "text-moss" : "text-ink/65"}`}>{info}</Text> : null}

          <View className="mt-6 gap-3">
            {showingVerification ? (
              <Pressable
                className={`items-center rounded-none px-5 py-5 ${busy ? "opacity-60" : ""} ${isDark ? "bg-mint" : "bg-ink"}`}
                disabled={busy || !codeInput.trim()}
                onPress={verificationMode === "sign-up" ? handleSignUpVerification : handleSignInVerification}
              >
                <Text className={`text-base font-bold ${isDark ? "text-night" : "text-cream"}`}>Verify Code</Text>
              </Pressable>
            ) : (
              <Pressable
                className={`items-center rounded-none px-5 py-5 ${busy ? "opacity-60" : ""} ${isDark ? "bg-mint" : "bg-ink"}`}
                disabled={busy || !emailIsValid || !passwordInput.trim()}
                onPress={isSigningIn ? handleSignIn : handleSignUp}
              >
                <Text className={`text-base font-bold ${isDark ? "text-night" : "text-cream"}`}>{isSigningIn ? "Sign In" : "Create Account"}</Text>
              </Pressable>
            )}

            {!showingVerification ? (
              <>
                <View className="flex-row items-center gap-3">
                  <View className={`h-px flex-1 ${isDark ? "bg-line" : "bg-ink/10"}`} />
                  <Text className={`text-[10px] font-bold uppercase ${isDark ? "text-moss" : "text-ink/40"}`}>Or continue with</Text>
                  <View className={`h-px flex-1 ${isDark ? "bg-line" : "bg-ink/10"}`} />
                </View>

                <Pressable
                  className={`items-center rounded-none border-2 px-5 py-4 ${busy ? "opacity-60" : ""} ${isDark ? "border-moss bg-night" : "border-ink/25 bg-white"}`}
                  disabled={busy}
                  onPress={() => handleSocialSignIn("oauth_google")}
                >
                  <Text className={`text-base font-semibold ${isDark ? "text-mint" : "text-ink"}`}>Continue with Google</Text>
                </Pressable>
              </>
            ) : null}

            <Pressable
              className={`items-center rounded-none border-2 px-5 py-4 ${busy ? "opacity-60" : ""} ${isDark ? "border-moss bg-night" : "border-ink/25 bg-white"}`}
              disabled={busy}
              onPress={() => {
                if (showingVerification) {
                  setVerificationMode("none");
                  setCodeInput("");
                  resetMessages();
                  return;
                }

                switchAuthMode(isSigningIn ? "sign-up" : "sign-in");
              }}
            >
              <Text className={`text-base font-semibold ${isDark ? "text-mint" : "text-ink"}`}>
                {showingVerification ? "Use Different Method" : isSigningIn ? "Need an account? Sign Up" : "Already have an account? Sign In"}
              </Text>
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
              className={`items-center rounded-none px-5 py-5 ${isDark ? "bg-mint" : "bg-ink"}`}
              onPress={handleSaveEmail}
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
