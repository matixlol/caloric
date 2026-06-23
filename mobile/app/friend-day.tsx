import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@clerk/expo";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Platform, PlatformColor, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  buildDayViewData,
  ReadOnlyDayView,
} from "../src/components/DayReadOnlyView";
import { useDataStoreActions, useDataStoreReady } from "../src/data/DataProvider";
import { parseLocalDateKey } from "../src/date";

const iosColor = (name: string, fallback: string) =>
  Platform.OS === "ios" ? PlatformColor(name) : fallback;

const palette = {
  background: iosColor("systemGroupedBackground", "#F3F4F6"),
  card: iosColor("secondarySystemGroupedBackground", "#FFFFFF"),
  label: iosColor("label", "#111827"),
  secondaryLabel: iosColor("secondaryLabel", "#6B7280"),
  tint: "#2563EB",
};

const DATE_SUBTITLE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function closeSheet() {
  if (router.canGoBack()) {
    router.back();
  }
}

export default function FriendDayScreen() {
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const isDataReady = useDataStoreReady();
  const { getFriendDailyDay } = useDataStoreActions();
  const params = useLocalSearchParams<{
    friendUserId?: string;
    dateKey?: string;
    displayName?: string;
    sheetInstance?: string;
  }>();

  const friendUserId = firstParam(params.friendUserId);
  const dateKey = firstParam(params.dateKey);
  const displayName = firstParam(params.displayName);
  const selectedDate = dateKey ? parseLocalDateKey(dateKey) : null;
  const daySubtitle = selectedDate && dateKey
    ? DATE_SUBTITLE_FORMATTER.format(selectedDate)
    : dateKey ?? "";

  const friendDayQuery = useQuery({
    queryKey: ["friendDailyDay", userId ?? null, friendUserId ?? null, dateKey ?? null],
    queryFn: () => getFriendDailyDay(friendUserId!, dateKey!),
    enabled: isDataReady && Boolean(userId) && Boolean(friendUserId) && Boolean(dateKey),
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });

  const friendDay = friendDayQuery.data;
  const friendSettings = friendDay?.settings ?? null;
  const friendDayView = friendDay && friendSettings
    ? buildDayViewData({
        entries: friendDay.entries,
        selectedDateKey: friendDay.summary.dateKey,
        dayTitle: friendDay.summary.displayName,
        daySubtitle,
        settings: friendSettings,
      })
    : null;

  if (!friendUserId || !dateKey) {
    return (
      <View style={[styles.stateContainer, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={styles.stateText}>Could not open this friend day.</Text>
      </View>
    );
  }

  if (friendDayQuery.isLoading || (friendDayQuery.isFetching && !friendDayView)) {
    return (
      <View style={[styles.stateContainer, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={styles.stateText}>Loading...</Text>
      </View>
    );
  }

  if (friendDayQuery.isError) {
    return (
      <View style={[styles.stateContainer, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={styles.stateText}>Could not load {displayName ?? "this friend"}'s day.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading friend day"
          onPress={() => void friendDayQuery.refetch()}
          style={styles.actionButton}
        >
          <Text style={styles.actionButtonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!friendSettings) {
    return (
      <View style={[styles.stateContainer, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={styles.stateText}>Could not load {displayName ?? "this friend"}'s targets.</Text>
      </View>
    );
  }

  if (!friendDayView) {
    return (
      <View style={[styles.stateContainer, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={styles.stateText}>No day data yet.</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close friend day"
        onPress={closeSheet}
        style={styles.closeButton}
      >
        <Ionicons color={palette.secondaryLabel} name="close" size={20} />
      </Pressable>
      <ReadOnlyDayView
        view={friendDayView}
        topInset={16}
        bottomInset={insets.bottom + 18}
        listStyle={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.background,
  },
  list: {
    flex: 1,
  },
  closeButton: {
    position: "absolute",
    right: 12,
    top: 10,
    zIndex: 2,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.card,
  },
  stateContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 24,
    backgroundColor: palette.background,
  },
  stateText: {
    textAlign: "center",
    fontSize: 16,
    lineHeight: 22,
    color: palette.secondaryLabel,
  },
  actionButton: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: palette.card,
  },
  actionButtonText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
    color: palette.tint,
  },
});
