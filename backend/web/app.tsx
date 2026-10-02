import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FriendDailySummariesResponseSchema,
  type FriendDailySummary,
  type Meal,
} from "@caloric/data-model";
import {
  applyChanges,
  api,
  bootstrap,
  calendarDate,
  dateKey,
  label,
  makeEntry,
  orderedDay,
  pushChanges,
  reorderEntries,
  shiftDate,
  totals,
  type Changes,
  type Entry,
  type Snapshot,
} from "./model";
import { EntryEditor, FoodPicker, Recipes, Settings, SignIn } from "./forms";
import { Assistant } from "./chat";
import { FriendDay, Friends } from "./friends";
import { Journal } from "./journal";
import { ErrorNotice, format, Icon, IconButton, Summary } from "./ui";
import "./style.css";

type Modal =
  | { type: "food"; meal: Meal }
  | { type: "entry"; entry: Entry }
  | { type: "friend"; friend: FriendDailySummary }
  | { type: "settings" | "recipes" | "friends" | "chat" }
  | null;
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("caloric.web.theme") || "system";
} catch {
  /* System theme works without storage. */
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [today, setToday] = useState(dateKey());
  const [day, setDay] = useState(dateKey());
  const [modal, setModal] = useState<Modal>(null);
  const [addedId, setAddedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: Entry } | null>(
    null,
  );
  const [offline, setOffline] = useState(!navigator.onLine);
  const [saving, setSaving] = useState(false);
  const writeLock = useRef(false);
  const writeRevision = useRef(0);
  const [friends, setFriends] = useState<FriendDailySummary[]>([]);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [friendsRevision, setFriendsRevision] = useState(0);
  const dragging = useRef(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!modal) return;
    // One history entry for the whole sheet flow, including Settings → Recipes.
    history.pushState({ caloricSheet: true }, "");
    return () => {
      if (history.state?.caloricSheet) history.back();
    };
  }, [Boolean(modal)]);
  useEffect(() => {
    if (modal || !addedId) return;
    // History traversal can restore the old scroll position (notably in Safari).
    // Reveal only after that and drawer scroll/focus restoration have finished.
    let frame = 0;
    const reveal = () => {
      frame = requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            `[data-entry-id="${CSS.escape(addedId)}"]`,
          )
          ?.scrollIntoView({
            block: "center",
            behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "instant"
              : "smooth",
          });
        setAddedId(null);
      });
    };
    if (history.state?.caloricSheet)
      window.addEventListener("popstate", reveal, { once: true });
    else reveal();
    return () => {
      window.removeEventListener("popstate", reveal);
      cancelAnimationFrame(frame);
    };
  }, [modal, addedId]);
  function replace(next: Snapshot) {
    snapshotRef.current = next;
    setSnapshot(next);
  }
  async function openAccount() {
    setLoadError(null);
    const session = await api<{ user?: { id: string } } | null>(
      "/api/auth/get-session",
    );
    setSignedIn(Boolean(session?.user));
    if (session?.user) replace(await bootstrap());
  }
  useEffect(() => {
    void openAccount().catch((e) => setLoadError(e.message));
    const online = () => setOffline(!navigator.onLine);
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    const timer = setInterval(() => {
      const next = dateKey();
      setToday((previous) => {
        if (previous !== next) setDay((day) => (day === previous ? next : day));
        return next;
      });
    }, 30000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
    };
  }, []);
  useEffect(() => {
    if (toast) {
      const timeout = setTimeout(
        () => setToast(null),
        toast.undo ? 15000 : 7000,
      );
      return () => clearTimeout(timeout);
    }
  }, [toast]);
  useEffect(() => {
    if (!snapshot) return;
    setFriendsError(null);
    const abort = new AbortController();
    setFriends([]);
    api(`/social/daily-summaries?dateKey=${day}`, undefined, abort.signal)
      .then((result) =>
        setFriends(FriendDailySummariesResponseSchema.parse(result).summaries),
      )
      .catch((e) => {
        if (!abort.signal.aborted) setFriendsError(e.message);
      });
    return () => abort.abort();
  }, [day, today, Boolean(snapshot), friendsRevision]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        modal ||
        dragging.current ||
        !snapshot ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.target as HTMLElement).closest(
          "input, textarea, select, [contenteditable], .entry-button",
        )
      )
        return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setDay((day) => shiftDate(day, -1));
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setDay((day) => shiftDate(day, 1));
      }
      if (e.key.toLowerCase() === "t") setDay(dateKey());
      if (e.key.toLowerCase() === "n" || e.key === "/") {
        e.preventDefault();
        setModal({ type: "food", meal: "lunch" });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [modal, Boolean(snapshot)]);
  useEffect(() => {
    if (!signedIn || modal) return;
    let cancelled = false;
    const refresh = async () => {
      if (
        document.visibilityState !== "visible" ||
        writeLock.current ||
        dragging.current
      )
        return;
      const revision = writeRevision.current;
      try {
        const next = await bootstrap();
        if (
          !cancelled &&
          !writeLock.current &&
          !dragging.current &&
          revision === writeRevision.current
        ) {
          replace(next);
          setLoadError(null);
          setFriendsRevision((revision) => revision + 1);
        }
      } catch {
        if (!cancelled)
          setLoadError(
            "Could not refresh your journal. Your displayed data may be out of date.",
          );
      }
    };
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [signedIn, modal]);

  async function mutate(changes: Changes, text: string | null = "Saved") {
    if (!snapshotRef.current) throw new Error("Your journal is still loading.");
    if (writeLock.current)
      throw new Error(
        "A change is still saving. Please try again in a moment.",
      );
    if (!navigator.onLine)
      throw new Error(
        "You’re offline. Reconnect before saving to your account.",
      );
    writeLock.current = true;
    writeRevision.current++;
    setSaving(true);
    try {
      const next = applyChanges(snapshotRef.current, changes);
      await pushChanges(changes);
      replace(next);
      if (text) setToast({ text });
    } finally {
      writeLock.current = false;
      setSaving(false);
    }
  }
  async function addEntry(entry: Entry) {
    await mutate({ entries: [entry] }, null);
    setAddedId(entry.id);
  }
  async function deleteEntry(entry: Entry) {
    const now = Date.now();
    await mutate(
      { entries: [{ ...entry, updatedAt: now, deletedAt: now }] },
      "Food removed",
    );
    setToast({ text: `${entry.data.foodName} removed`, undo: entry });
  }
  async function duplicate(entry: Entry) {
    const current = snapshotRef.current!;
    const copy = makeEntry(
      {
        id: entry.id,
        name: entry.data.foodName,
        brand: entry.data.brand,
        serving: entry.data.serving,
        nutrition: entry.data.nutrition,
      },
      entry.data.meal,
      entry.data.dateKey,
      entry.data.portion,
      current,
    );
    copy.data.recipeId = entry.data.recipeId;
    copy.data.recipeItems = entry.data.recipeItems;
    await addEntry(copy);
  }
  async function reorder(id: string, meal: Meal, index: number) {
    const entries = orderedDay(snapshotRef.current!, day);
    const changed = reorderEntries(entries, id, meal, index);
    if (changed.length) await mutate({ entries: changed }, null);
  }
  const close = () => setModal(null);
  if (signedIn === false) return <SignIn onSignedIn={openAccount} />;
  if (!snapshot)
    return (
      <main className="startup-screen">
        {loadError ? (
          <>
            <ErrorNotice message={loadError} />
            <button
              className="secondary-button"
              onClick={() =>
                void openAccount().catch((e) => setLoadError(e.message))
              }
            >
              Try again
            </button>
          </>
        ) : (
          <p role="status">Opening your journal…</p>
        )}
      </main>
    );
  const entries = orderedDay(snapshot, day);
  const nutrition = totals(entries.map((row) => row.data));
  const title =
    day === today
      ? "Today"
      : day === shiftDate(today, -1)
        ? "Yesterday"
        : calendarDate(day).toLocaleDateString(undefined, {
            month: "long",
            day: "numeric",
          });
  const subtitle = calendarDate(day).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return (
    <>
      <a className="skip-link" href="#journal">
        Skip to journal
      </a>
      <main className="app-main">
        <div
          className="day-header"
          onPointerDown={(e) => {
            if (e.pointerType === "touch")
              touch.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerUp={(e) => {
            if (touch.current) {
              const dx = e.clientX - touch.current.x,
                dy = e.clientY - touch.current.y;
              if (Math.abs(dx) > 75 && Math.abs(dy) < 40)
                setDay(shiftDate(day, dx > 0 ? -1 : 1));
              touch.current = null;
            }
          }}
        >
          <div>
            <div className="day-title-line">
              <h1>{title}</h1>
              {day !== today && (
                <button className="today-button" onClick={() => setDay(today)}>
                  Back to today
                </button>
              )}
            </div>
            <p>{subtitle}</p>
          </div>
          <div className="day-actions">
            <IconButton
              name="settings"
              title="Settings"
              onClick={() => setModal({ type: "settings" })}
            />
          </div>
        </div>
        {offline && (
          <p className="connection-notice" role="status">
            You’re offline. Reconnect to search or save changes.
          </p>
        )}
        <ErrorNotice message={loadError} />
        <div className="day-layout">
          <aside className="daily-sidebar">
            <Summary
              nutrition={nutrition}
              settings={snapshot.settings}
              onGoals={() => setModal({ type: "settings" })}
            />
            <section className="card friends-card">
              <div className="section-heading">
                <h2>Friends{day === today ? " Today" : ""}</h2>
                <button
                  className="text-button"
                  onClick={() => setModal({ type: "friends" })}
                >
                  {friends.length}
                </button>
              </div>
              {friendsError ? (
                <p className="hint">
                  Couldn’t load friends.{" "}
                  <button
                    className="text-button"
                    onClick={() =>
                      setFriendsRevision((revision) => revision + 1)
                    }
                  >
                    Retry
                  </button>
                </p>
              ) : !friends.length ? (
                <p className="hint">Add friends in Settings.</p>
              ) : (
                friends.map((friend) => (
                  <button
                    className="friend-summary"
                    aria-label={`Open ${friend.displayName}'s day`}
                    key={friend.userId}
                    onClick={() => setModal({ type: "friend", friend })}
                  >
                    <span className="row-main">
                      <span className="friend-top-row">
                        <strong>{friend.displayName}</strong>
                        <b>
                          {format(friend.calories)}{" "}
                          <Icon name="right" size={16} />
                        </b>
                      </span>
                      <span className="track">
                        <span
                          style={{
                            width: `${Math.min(100, (friend.calories / (friend.calorieGoal || 2500)) * 100)}%`,
                          }}
                        />
                      </span>
                      <small>
                        {friend.lastUpdatedAt
                          ? `Updated ${new Date(friend.lastUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                          : "No logs yet"}
                      </small>
                    </span>
                  </button>
                ))
              )}
            </section>
          </aside>
          <Journal
            key={day}
            entries={entries}
            saving={saving}
            onOpen={(entry) => setModal({ type: "entry", entry })}
            onAdd={(meal) => setModal({ type: "food", meal })}
            onReorder={reorder}
            onError={(text) => setToast({ text })}
            onDraggingChange={(active) => {
              dragging.current = active;
            }}
          />
        </div>
        <nav className="journal-navigation" aria-label="Day navigation">
          <IconButton
            name="left"
            title="Previous day"
            onClick={() => setDay(shiftDate(day, -1))}
          />
          <label className="calendar-picker" title="Choose date">
            <Icon name="calendar" />
            <input
              aria-label="Choose date"
              type="date"
              value={day}
              onChange={(e) => {
                if (e.target.value) setDay(e.target.value);
              }}
            />
          </label>
          <IconButton
            name="right"
            title="Next day"
            onClick={() => setDay(shiftDate(day, 1))}
          />
        </nav>
      </main>
      <div className="composer-dock">
        <button
          className="floating-composer"
          onClick={() => setModal({ type: "chat" })}
        >
          <span>Message the food assistant</span>
        </button>
        <IconButton
          name="mic"
          title="Ask Caloric with voice"
          onClick={() => setModal({ type: "chat" })}
        />
      </div>
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={17} />
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              onClick={() => {
                const entry = toast.undo!;
                void mutate(
                  { entries: [{ ...entry, updatedAt: Date.now() }] },
                  "Food restored",
                ).catch((e) => setToast({ text: e.message }));
              }}
              disabled={saving}
            >
              Undo
            </button>
          )}
          <IconButton
            name="close"
            title="Dismiss notification"
            onClick={() => setToast(null)}
          />
        </div>
      )}
      {modal?.type === "food" && (
        <FoodPicker
          meal={modal.meal}
          day={day}
          snapshot={snapshot}
          onSave={addEntry}
          onClose={close}
        />
      )}
      {modal?.type === "entry" && (
        <EntryEditor
          entry={modal.entry}
          onSave={(entry) => mutate({ entries: [entry] }, "Food updated")}
          onDelete={deleteEntry}
          onCopy={duplicate}
          onClose={close}
        />
      )}
      {modal?.type === "settings" && (
        <Settings
          settings={snapshot.settings}
          onRecipes={() => setModal({ type: "recipes" })}
          onFriends={() => setModal({ type: "friends" })}
          onSave={(settings) => mutate({ settings }, "Daily goals updated")}
          onSignOut={async () => {
            await api("/api/auth/sign-out", {});
            replace({ ...snapshot, entries: [], recipes: [] });
            setSnapshot(null);
            snapshotRef.current = null;
            setSignedIn(false);
            close();
          }}
          onClose={close}
        />
      )}
      {modal?.type === "recipes" && (
        <Recipes
          snapshot={snapshot}
          onSave={(recipe) => mutate({ recipes: [recipe] }, "Recipe saved")}
          onDelete={(recipe) => {
            const now = Date.now();
            return mutate(
              { recipes: [{ ...recipe, updatedAt: now, deletedAt: now }] },
              "Recipe deleted",
            );
          }}
          onClose={close}
        />
      )}
      {modal?.type === "friend" && (
        <FriendDay friend={modal.friend} day={day} onClose={close} />
      )}
      {modal?.type === "friends" && (
        <Friends
          onChanged={() => setFriendsRevision((revision) => revision + 1)}
          onClose={close}
        />
      )}
      <Assistant
        open={modal?.type === "chat"}
        snapshot={snapshot}
        day={day}
        onSave={addEntry}
        onClose={close}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
