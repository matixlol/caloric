import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import type { FriendDailySummary } from "@caloric/data-model";
import { createDemo, type Snapshot } from "./model";
import { demoFriendDay } from "./friends";
import { friendSummariesQuery, journalMutation, journalQuery } from "./queries";

const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });
});
afterEach(() => {
  client.clear();
  globalThis.fetch = originalFetch;
  if (originalNavigator)
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

test("friend queries isolate dates/accounts, retain data on refresh failure and remember the count", async () => {
  const first = demoFriendDay("demo_alex", "2026-10-02").summary;
  const second = { ...first, dateKey: "2026-10-03", calories: 321 };
  globalThis.fetch = mock(async (path) =>
    Response.json({
      summaries: String(path).endsWith("2026-10-02") ? [first] : [second],
    }),
  ) as unknown as typeof fetch;
  await client.fetchQuery(friendSummariesQuery("account-a", first.dateKey));
  await client.fetchQuery(friendSummariesQuery("account-a", second.dateKey));
  expect(
    client.getQueryData<FriendDailySummary[]>(
      friendSummariesQuery("account-a", first.dateKey).queryKey,
    )!,
  ).toEqual([first]);
  expect(
    client.getQueryData<FriendDailySummary[]>(
      friendSummariesQuery("account-a", second.dateKey).queryKey,
    )!,
  ).toEqual([second]);
  expect(
    client.getQueryData(
      friendSummariesQuery("account-b", first.dateKey).queryKey,
    ),
  ).toBeUndefined();
  expect(client.getQueryData<number>(["friends", "account-a", "count"])!).toBe(
    1,
  );
  globalThis.fetch = mock(async () =>
    Response.json({ message: "Unavailable" }, { status: 503 }),
  ) as unknown as typeof fetch;
  await expect(
    client.fetchQuery(friendSummariesQuery("account-a", first.dateKey)),
  ).rejects.toThrow("Unavailable");
  expect(
    client.getQueryData<FriendDailySummary[]>(
      friendSummariesQuery("account-a", first.dateKey).queryKey,
    )!,
  ).toEqual([first]);
});

test("a cancelled summary cannot overwrite the count even if its transport completes late", async () => {
  let finish!: (response: Response) => void;
  let signal!: AbortSignal;
  globalThis.fetch = mock((_path, options) => {
    signal = options!.signal!;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as unknown as typeof fetch;
  const options = friendSummariesQuery("account-a", "2026-10-02");
  const pending = client.fetchQuery(options).catch(() => {});
  await client.cancelQueries({ queryKey: options.queryKey });
  client.setQueryData(["friends", "account-a", "count"], 3);
  finish(Response.json({ summaries: [] }));
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(signal.aborted).toBe(true);
  expect(client.getQueryData<number>(["friends", "account-a", "count"])!).toBe(
    3,
  );
  expect(client.getQueryData(options.queryKey)).toBeUndefined();
});

test("journal writes cancel stale refreshes and only publish accepted data", async () => {
  const snapshot = createDemo("2026-10-02");
  const options = journalQuery("account-a");
  client.setQueryData(options.queryKey, snapshot);
  const entry = {
    ...snapshot.entries[0],
    data: { ...snapshot.entries[0].data, portion: 2.75 },
  };
  let finishRefresh!: (response: Response) => void;
  let finishWrite!: (response: Response) => void;
  let refreshSignal!: AbortSignal;
  globalThis.fetch = mock(
    (path, options) =>
      new Promise<Response>((resolve) => {
        if (path === "/sync/bootstrap") {
          refreshSignal = options!.signal!;
          finishRefresh = resolve;
        } else finishWrite = resolve;
      }),
  ) as unknown as typeof fetch;
  const refresh = client.fetchQuery(options).catch(() => {});
  const mutation = new MutationObserver(
    client,
    journalMutation("account-a", client),
  );
  const write = mutation.mutate({ entries: [entry] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(refreshSignal.aborted).toBe(true);
  expect(client.getQueryData(options.queryKey)?.entries[0].data.portion).toBe(
    1,
  );
  finishWrite(
    Response.json({
      acceptedFoodEntryIds: [entry.id],
      acceptedRecipeIds: [],
      acceptedSettings: false,
    }),
  );
  await write;
  finishRefresh(
    Response.json({
      foodEntries: snapshot.entries,
      recipes: snapshot.recipes,
      settings: null,
    }),
  );
  await refresh;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    client
      .getQueryData(options.queryKey)
      ?.entries.find((row) => row.id === entry.id)?.data.portion,
  ).toBe(2.75);
});

test("failed and offline mutations leave the saved journal unchanged", async () => {
  const snapshot = createDemo("2026-10-02");
  const options = journalQuery("account-a");
  client.setQueryData(options.queryKey, snapshot);
  const request = mock(async () =>
    Response.json({ message: "Write failed" }, { status: 503 }),
  );
  globalThis.fetch = request as unknown as typeof fetch;
  const mutation = new MutationObserver(
    client,
    journalMutation("account-a", client),
  );
  await expect(
    mutation.mutate({ entries: [{ ...snapshot.entries[0], deletedAt: 123 }] }),
  ).rejects.toThrow("Write failed");
  expect(client.getQueryData<Snapshot>(options.queryKey)!).toEqual(snapshot);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: false },
  });
  await expect(mutation.mutate({ entries: [] })).rejects.toThrow("offline");
  expect(request).toHaveBeenCalledTimes(1);
  expect(client.getQueryData<Snapshot>(options.queryKey)!).toEqual(snapshot);
});
