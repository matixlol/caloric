import { expoClient } from "@better-auth/expo/client";
import { emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const BACKEND_BASE_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL?.trim() ?? "").replace(/\/+$/, "") ||
  "https://backend.caloric.mati.lol";

// The deep-link scheme Better Auth uses for the Expo integration. Read from the
// resolved app config so the dev build (caloric-dev) and production build
// (caloric) each use their own scheme.
const configuredScheme = Constants.expoConfig?.scheme;
const SCHEME =
  (Array.isArray(configuredScheme) ? configuredScheme[0] : configuredScheme) || "caloric";

export const authClient = createAuthClient({
  baseURL: BACKEND_BASE_URL,
  plugins: [
    emailOTPClient(),
    // The Expo client stores the session cookie in SecureStore and adds it to
    // the auth client's own requests. It is native-only (no SecureStore on web,
    // where the browser manages cookies itself).
    ...(Platform.OS === "web"
      ? []
      : [
          expoClient({
            scheme: SCHEME,
            storagePrefix: "caloric",
            storage: SecureStore,
          }),
        ]),
  ],
});

// The stored session cookie, for attaching to our own backend requests (sync,
// AI, social). Native-only; on web the browser sends cookies automatically.
export function getAuthCookie(): string | null {
  if (Platform.OS === "web" || typeof authClient.getCookie !== "function") {
    return null;
  }

  return authClient.getCookie() || null;
}

// Headers + credentials to authenticate a fetch() to our backend. On native we
// send the stored cookie explicitly and opt out of the platform cookie store;
// on web we let the browser attach cookies with credentials: "include".
export function authRequestInit(): { headers: Record<string, string>; credentials: RequestCredentials } {
  if (Platform.OS === "web") {
    return { headers: {}, credentials: "include" };
  }

  const cookie = getAuthCookie();
  return { headers: cookie ? { Cookie: cookie } : {}, credentials: "omit" };
}

type AuthState = {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  email: string | null;
};

// Clerk-shaped auth state so call sites read the same fields they used to.
export function useAuth(): AuthState {
  const { data, isPending, isRefetching } = authClient.useSession();

  return {
    // Treat a background refetch as "loaded". Better Auth flips isPending back to
    // true on every refetch while signed out (data === null), and a refetch fires
    // when the app returns to the foreground. Without the isRefetching guard the
    // auth gate would fall back to its loading spinner on resume and remount the
    // sign-in screen — wiping the entered email and the "code sent" state, so you
    // could never come back with the emailed code.
    isLoaded: !isPending || isRefetching,
    isSignedIn: Boolean(data?.user?.id),
    userId: data?.user?.id ?? null,
    email: data?.user?.email ?? null,
  };
}
