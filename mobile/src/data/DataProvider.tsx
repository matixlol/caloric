import { type ReactNode, createContext, useCallback, useContext, useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore } from "react";
import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { getAuthCookie, useAuth } from "../auth/auth-client";
import { type Meal, type UserSettings } from "@caloric/data-model";
import { focusManager, onlineManager } from "@tanstack/react-query";
import {
  localDataStore,
  type FoodEntryRecord,
  type SyncStatusRecord,
  type UserSettingsRecord,
} from "./store";

type DataContextValue = {
  store: typeof localDataStore;
  ready: boolean;
};

const EMPTY_ENTRIES: FoodEntryRecord[] = [];
const EMPTY_SYNC_STATUS: SyncStatusRecord = {
  updatedAt: 0,
  dirty: false,
};

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const [ready, setReady] = useState(false);
  const getTokenForStore = useEffectEvent(async () => {
    // The stored session cookie authenticates our backend requests. Returns
    // null once the session ends so background sync backs off cleanly.
    return getAuthCookie();
  });

  useEffect(() => {
    let cancelled = false;

    void localDataStore.initialize().then(() => {
      if (!cancelled) {
        setReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    if (!isSignedIn || !userId) {
      localDataStore.deactivateUser();
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        await localDataStore.activateUser(userId, async () => getTokenForStore());
        if (cancelled) {
          return;
        }

        await localDataStore.bootstrapFromBackend();
      } catch {
        // Activation and bootstrap are best-effort; a failure here (offline,
        // ended session, transient backend error) must not escape as an
        // unhandled rejection. Dirty rows are still flushed by the sync below.
      } finally {
        if (!cancelled) {
          localDataStore.scheduleSync(0);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // getTokenForStore is a stable useEffectEvent and must not be a dependency.
  }, [isLoaded, isSignedIn, userId]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      focusManager.setFocused(nextState === "active");
      if (nextState === "active") {
        localDataStore.scheduleSync(0);
      }
    });

    const netInfoSubscription = NetInfo.addEventListener((state) => {
      onlineManager.setOnline(Boolean(state.isConnected));
      if (state.isConnected) {
        localDataStore.scheduleSync(0);
      }
    });

    return () => {
      appStateSubscription.remove();
      netInfoSubscription();
    };
  }, [ready]);

  const value = useMemo<DataContextValue>(
    () => ({
      store: localDataStore,
      ready,
    }),
    [ready],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

function useDataContext(): DataContextValue {
  const value = useContext(DataContext);
  if (!value) {
    throw new Error("DataProvider is missing");
  }

  return value;
}

function useStoreRevision(): number {
  const { store } = useDataContext();
  return useSyncExternalStore(store.subscribe, store.getRevision, store.getRevision);
}

function useStoreQuery<T>(query: () => Promise<T>, fallback: T) {
  const { ready } = useDataContext();
  const revision = useStoreRevision();
  const [state, setState] = useState<{ data: T; isLoading: boolean }>({
    data: fallback,
    isLoading: true,
  });

  useEffect(() => {
    if (!ready) {
      setState({ data: fallback, isLoading: true });
      return;
    }

    let cancelled = false;

    void (async () => {
      const data = await query();
      if (!cancelled) {
        setState({ data, isLoading: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fallback, query, ready, revision]);

  return state;
}

export function useDataStoreReady(): boolean {
  return useDataContext().ready;
}

// The id of the user who was signed in last time the app ran, read synchronously
// from local SQLite. Lets the auth gate render cached data offline before the
// session finishes loading. Null until the store finishes init or if no user has
// ever signed in on this device.
export function useLastKnownUserId(): string | null {
  const { store, ready } = useDataContext();
  // Re-render when the store revision bumps (e.g. activateUser updates the id).
  useStoreRevision();
  return ready ? store.getLastKnownUserId() : null;
}

export function useFoodEntriesByDate(dateKey: string) {
  const { store } = useDataContext();
  const query = useCallback(() => store.listFoodEntriesByDate(dateKey), [dateKey, store]);

  return useStoreQuery(query, EMPTY_ENTRIES);
}

export function useFoodEntry(entryId: string | undefined) {
  const { store } = useDataContext();
  const query = useCallback(
    () => (entryId ? store.getFoodEntry(entryId) : Promise.resolve(null)),
    [entryId, store],
  );

  return useStoreQuery(query, null as FoodEntryRecord | null);
}

export function useAllFoodEntries() {
  const { store } = useDataContext();
  const query = useCallback(() => store.listAllFoodEntries(), [store]);

  return useStoreQuery(query, EMPTY_ENTRIES);
}

export function useUserSettings() {
  const { store } = useDataContext();
  const query = useCallback(() => store.getUserSettings(), [store]);

  return useStoreQuery(query, null as UserSettingsRecord | null);
}

export function useSyncStatus() {
  const { store } = useDataContext();
  const query = useCallback(() => store.getSyncStatus(), [store]);

  return useStoreQuery(query, EMPTY_SYNC_STATUS);
}

export function useDataStoreActions() {
  const { store } = useDataContext();

  return useMemo(
    () => ({
      createFoodEntry: store.createFoodEntry.bind(store),
      updateFoodEntry: store.updateFoodEntry.bind(store),
      deleteFoodEntry: store.deleteFoodEntry.bind(store),
      reorderFoodEntriesForDate: (
        dateKey: string,
        orderedEntries: { id: string; meal: Meal }[],
      ) => store.reorderFoodEntriesForDate(dateKey, orderedEntries),
      upsertUserSettings: (settings: UserSettings) => store.upsertUserSettings(settings),
      triggerSync: () => store.scheduleSync(0),
      updateSocialProfile: (displayName?: string) => store.updateSocialProfile(displayName),
      getSocialOverview: () => store.getSocialOverview(),
      sendFriendRequest: (friendCode: string) => store.sendFriendRequest(friendCode),
      acceptFriendRequest: (requestId: string) => store.acceptFriendRequest(requestId),
      ignoreFriendRequest: (requestId: string) => store.ignoreFriendRequest(requestId),
      removeFriend: (friendUserId: string) => store.removeFriend(friendUserId),
      getFriendDailySummaries: (dateKey: string) => store.getFriendDailySummaries(dateKey),
      getFriendDailyDay: (friendUserId: string, dateKey: string) => store.getFriendDailyDay(friendUserId, dateKey),
    }),
    [store],
  );
}
