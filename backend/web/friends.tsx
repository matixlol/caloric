import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_USER_SETTINGS,
  FriendDailyDayResponseSchema,
  SocialOverviewSchema,
  type FriendDailyDayResponse,
  type FriendDailySummary,
} from "@caloric/data-model";
import { api, calendarDate, catalogue, label, meals, totals } from "./model";
import { socialQuery } from "./queries";
import { useOperation } from "./forms";
import {
  Empty,
  ErrorNotice,
  format,
  Icon,
  MacroBadges,
  Sheet,
  Summary,
} from "./ui";

export const demoFriends = [
  {
    userId: "demo_alex",
    displayName: "Alex Rivera",
    ids: [
      "eggs",
      "toast",
      "coffee",
      "chicken",
      "rice",
      "broccoli",
      "salmon",
      "potato",
    ],
  },
  {
    userId: "demo_june",
    displayName: "June Park",
    ids: [
      "oats",
      "milk",
      "blueberries",
      "pasta",
      "avocado",
      "apple",
      "almonds",
    ],
  },
];
export function demoFriendDay(
  userId: string,
  day: string,
): FriendDailyDayResponse {
  const friend = demoFriends.find((friend) => friend.userId === userId)!;
  const entries = friend.ids.map((id, index) => {
    const food = catalogue.find((food) => food.id === id)!;
    return {
      id: `friend_${id}`,
      updatedAt: calendarDate(day).getTime(),
      foodName: food.name,
      brand: food.brand,
      serving: food.serving,
      portion: 1,
      nutrition: food.nutrition,
      meal:
        index < 3
          ? ("breakfast" as const)
          : index < 6
            ? ("lunch" as const)
            : ("dinner" as const),
      dateKey: day,
      sortIndex: index,
      createdAt: calendarDate(day).getTime(),
    };
  });
  const nutrition = totals(entries);
  return {
    entries,
    settings: DEFAULT_USER_SETTINGS,
    summary: {
      userId,
      displayName: friend.displayName,
      dateKey: day,
      calories: nutrition.calories || 0,
      protein: nutrition.protein || 0,
      carbs: nutrition.carbs || 0,
      fat: nutrition.fat || 0,
      calorieGoal: DEFAULT_USER_SETTINGS.calorieGoal,
      lastUpdatedAt: calendarDate(day).getTime(),
    },
  };
}
export function FriendDay({
  userId,
  friend,
  day,
  onClose,
}: {
  userId: string;
  friend: FriendDailySummary;
  day: string;
  onClose: () => void;
}) {
  const { data, error } = useQuery({
    queryKey: ["friends", userId, "day", friend.userId, day],
    queryFn: async ({ signal }) =>
      FriendDailyDayResponseSchema.parse(
        await api(
          `/social/friends/${encodeURIComponent(friend.userId)}/day?dateKey=${day}`,
          undefined,
          signal,
        ),
      ),
  });
  return (
    <Sheet
      title={`${friend.displayName.split(" ")[0]}’s journal`}
      subtitle={`${calendarDate(day).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} · Read only`}
      onClose={onClose}
    >
      <ErrorNotice message={error?.message ?? null} />
      {!data && !error && (
        <p className="loading-text" role="status">
          Opening journal…
        </p>
      )}
      {data && (
        <div className="stack">
          <Summary
            nutrition={data.summary}
            settings={data.settings || DEFAULT_USER_SETTINGS}
          />
          {meals.map((meal) => {
            const entries = data.entries
              .filter((entry) => entry.meal === meal)
              .sort((a, b) => a.sortIndex - b.sortIndex);
            return (
              <section className="card friend-meal" key={meal}>
                <div className="section-heading">
                  <h3>{label(meal)}</h3>
                  <span>{format(totals(entries).calories)} kcal</span>
                </div>
                {entries.length ? (
                  entries.map((entry) => (
                    <div className="ingredient-row" key={entry.id}>
                      <span>
                        {entry.foodName}
                        <small>
                          {entry.portion} × {entry.serving || "1 serving"}
                        </small>
                      </span>
                      <b>
                        {format(
                          (entry.nutrition?.calories || 0) * entry.portion,
                        )}
                      </b>
                    </div>
                  ))
                ) : (
                  <p className="hint">Nothing logged yet.</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}
export function Friends({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const operation = useOperation();
  const { data: overview, error } = useQuery({
    ...socialQuery(userId),
    refetchOnWindowFocus: () => !operation.busy,
    refetchOnReconnect: () => !operation.busy,
  });
  const [name, setName] = useState<string | null>(null);
  const displayName = name ?? overview?.profile.displayName ?? "";
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState("");
  async function update(path: string, body: unknown) {
    await client.cancelQueries({ queryKey: ["friends", userId] });
    const next = SocialOverviewSchema.parse(await api(path, body));
    client.setQueryData(socialQuery(userId).queryKey, next);
    client.setQueryData(["friends", userId, "count"], next.friends.length);
    void client.invalidateQueries({
      queryKey: ["friends", userId, "summaries"],
    });
  }
  return (
    <Sheet title="Friends" onClose={onClose} busy={operation.busy}>
      <div className="stack">
        <ErrorNotice message={operation.error || error?.message || null} />
        {overview && (
          <>
            <span className="eyebrow">YOUR PROFILE</span>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void operation.run(async () => {
                  await update("/social/profile", {
                    displayName: displayName.trim(),
                  });
                  setNotice("Profile saved.");
                });
              }}
            >
              <label className="field">
                Display name
                <input
                  required
                  value={displayName}
                  maxLength={50}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button className="secondary-button" disabled={operation.busy}>
                Save
              </button>
            </form>
            <div className="friend-code">
              <div>
                <small>Your friend code</small>
                <strong>{overview.profile.friendCode}</strong>
              </div>
              <button
                className="text-button"
                onClick={() =>
                  void operation.run(async () => {
                    await navigator.clipboard.writeText(
                      overview.profile.friendCode,
                    );
                    setNotice("Friend code copied.");
                  })
                }
              >
                <Icon name="copy" size={16} />
                Copy
              </button>
            </div>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void operation.run(async () => {
                  await update("/social/friend-requests", {
                    friendCode: code.trim(),
                  });
                  setNotice("Friend request sent.");
                  setCode("");
                });
              }}
            >
              <label className="field">
                Add a friend
                <input
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Enter their friend code"
                />
              </label>
              <button className="secondary-button" disabled={operation.busy}>
                Send
              </button>
            </form>
            {notice && (
              <p role="status" className="hint">
                {notice}
              </p>
            )}
            {overview.incomingRequests.length > 0 && (
              <>
                <span className="eyebrow">FRIEND REQUESTS</span>
                {overview.incomingRequests.map((request) => (
                  <div className="ingredient-row" key={request.id}>
                    <span>{request.requester.displayName}</span>
                    <button
                      className="text-button"
                      disabled={operation.busy}
                      onClick={() =>
                        void operation.run(() =>
                          update("/social/friend-requests/ignore", {
                            requestId: request.id,
                          }),
                        )
                      }
                    >
                      Ignore
                    </button>
                    <button
                      className="secondary-button"
                      disabled={operation.busy}
                      onClick={() =>
                        void operation.run(() =>
                          update("/social/friend-requests/accept", {
                            requestId: request.id,
                          }),
                        )
                      }
                    >
                      Accept
                    </button>
                  </div>
                ))}
              </>
            )}
            <span className="eyebrow">
              CONNECTED · {overview.friends.length}
            </span>
            {overview.friends.map((friend, index) => (
              <div className="connected-friend" key={friend.userId}>
                <span className={`avatar avatar-${index % 2}`}>
                  {friend.displayName
                    .split(" ")
                    .map((part) => part[0])
                    .slice(0, 2)
                    .join("")}
                </span>
                <span>{friend.displayName}</span>
                <Icon name="check" size={18} />
              </div>
            ))}
            {overview.outgoingRequests.map((request) => (
              <p className="hint" key={request.id}>
                Request pending: {request.recipient.displayName}
              </p>
            ))}
            {!overview.friends.length && (
              <Empty icon="people" title="No friends yet" text="" />
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
