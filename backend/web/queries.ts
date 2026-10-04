import { QueryClient, queryOptions } from "@tanstack/react-query";
import {
  FriendDailySummariesResponseSchema,
  SocialOverviewSchema,
} from "@caloric/data-model";
import {
  api,
  bootstrap,
  applyChanges,
  pushChanges,
  type Changes,
} from "./model";

export const cacheMaxAge = 7 * 24 * 60 * 60 * 1000;
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    // Writes must fail visibly rather than replay when connectivity returns.
    mutations: { retry: false, networkMode: "always" },
  },
});
queryClient.setQueryDefaults(["friends"], { gcTime: cacheMaxAge });

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: ({ signal }) =>
    api<{ user: { id: string } } | null>(
      "/api/auth/get-session",
      undefined,
      signal,
    ),
  staleTime: Infinity,
});

export const journalQuery = (userId: string) =>
  queryOptions({
    queryKey: ["journal", userId],
    queryFn: ({ signal }) => bootstrap(signal),
  });

export const socialQuery = (userId: string) =>
  queryOptions({
    queryKey: ["friends", userId, "overview"],
    queryFn: async ({ signal }) =>
      SocialOverviewSchema.parse(await api("/social/me", undefined, signal)),
  });

export const friendSummariesQuery = (userId: string, day: string) =>
  queryOptions({
    queryKey: ["friends", userId, "summaries", day],
    queryFn: async ({ signal, client }) => {
      const { summaries } = FriendDailySummariesResponseSchema.parse(
        await api(`/social/daily-summaries?dateKey=${day}`, undefined, signal),
      );
      signal.throwIfAborted();
      client.setQueryData(["friends", userId, "count"], summaries.length);
      return summaries;
    },
  });

export const journalMutation = (userId: string, client: QueryClient) => ({
  mutationFn: async (changes: Changes) => {
    if (!navigator.onLine)
      throw new Error(
        "You’re offline. Reconnect before saving to your account.",
      );
    const { queryKey } = journalQuery(userId);
    // A refresh that started before this write must never replace its result.
    await client.cancelQueries({ queryKey });
    const current = client.getQueryData(queryKey);
    if (!current) throw new Error("Your journal is still loading.");
    const next = applyChanges(current, changes);
    await pushChanges(changes);
    client.setQueryData(queryKey, next);
  },
});
