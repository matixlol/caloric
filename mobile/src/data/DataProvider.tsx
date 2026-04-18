import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { useAuth } from "@clerk/clerk-expo";
import { type Meal, type UserSettings } from "@caloric/data-model";
import { localDataStore, type FoodEntryRecord, type UserSettingsRecord } from "./store";

type DataContextValue = {
  store: typeof localDataStore;
  ready: boolean;
};

const EMPTY_ENTRIES: FoodEntryRecord[] = [];

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const [ready, setReady] = useState(false);

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
      await localDataStore.activateUser(userId, async () => getToken());
      if (cancelled) {
        return;
      }

      void localDataStore.bootstrapFromBackend().finally(() => {
        localDataStore.scheduleSync(0);
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn, userId]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        localDataStore.scheduleSync(0);
      }
    });

    const netInfoSubscription = NetInfo.addEventListener((state) => {
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
    }),
    [store],
  );
}
