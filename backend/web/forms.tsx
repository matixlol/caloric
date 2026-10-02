import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { motion, useDragControls, useReducedMotion } from "motion/react";
import { formatMixedQuarter } from "../../mobile/src/portion";
import {
  UserSettingsSchema,
  type Meal,
  type Nutrition,
  type RecipeItem,
  type UserSettings,
} from "@caloric/data-model";
import {
  api,
  dateKey,
  label,
  makeEntry,
  meals,
  portionFromDrag,
  portionValues,
  recipeFood,
  totals,
  type Entry,
  type Food,
  type SavedRecipe,
  type Snapshot,
} from "./model";
import {
  decimal,
  Empty,
  ErrorNotice,
  format,
  Icon,
  IconButton,
  MacroBadges,
  NutritionGrid,
  Segmented,
  Sheet,
} from "./ui";

export function useOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
function mealOptions() {
  return meals.map((meal) => (
    <option key={meal} value={meal}>
      {label(meal)}
    </option>
  ));
}
function Portion({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const n = Number(value);
  return (
    <div className="portion-control">
      <IconButton
        name="left"
        title="Decrease portion"
        onClick={() =>
          onChange(String(Math.max(0.25, Math.round((n - 0.25) * 100) / 100)))
        }
        disabled={!Number.isFinite(n) || n <= 0.25}
      />
      <label>
        Servings
        <input
          aria-label="Servings"
          type="number"
          inputMode="decimal"
          min="0.01"
          max="1000"
          step="any"
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <IconButton
        name="plus"
        title="Increase portion"
        onClick={() =>
          onChange(String(Math.round(((n || 0) + 0.25) * 100) / 100))
        }
      />
    </div>
  );
}
function recentFoods(snapshot: Snapshot): Food[] {
  return [
    ...new Map(
      [...snapshot.entries]
        .sort((a, b) => b.data.createdAt - a.data.createdAt)
        .map((row) => [
          `${row.data.foodName}|${row.data.brand || ""}|${row.data.serving || ""}`,
          {
            id: row.id,
            name: row.data.foodName,
            brand: row.data.brand,
            serving: row.data.serving,
            nutrition: row.data.nutrition,
          },
        ]),
    ).values(),
  ].slice(0, 30);
}

function PortionAddButton({
  title,
  busy,
  onAdd,
}: {
  title: string;
  busy: boolean;
  onAdd: (portion: number) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const controls = useDragControls();
  const reducedMotion = useReducedMotion();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const active = useRef(false);
  const suppressClick = useRef(false);
  const selected = useRef<number | null>(null);
  const [rail, setRail] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  const [value, setValue] = useState<number | null>(null);
  function clearTimer() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }
  function cancel() {
    clearTimer();
    controls.cancel();
    active.current = false;
    selected.current = null;
    setRail(null);
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    return () => {
      clearTimer();
      controls.cancel();
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
    };
  }, [controls]);
  return (
    <>
      <motion.button
        ref={button}
        type="button"
        className="primary-button portion-add"
        aria-label={title}
        disabled={busy}
        data-base-ui-swipe-ignore
        drag="y"
        dragControls={controls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={0}
        dragMomentum={false}
        onPointerDown={(event) => {
          if (event.button !== 0 || busy) return;
          clearTimer();
          suppressClick.current = false;
          selected.current = null;
          setValue(null);
          start.current = { x: event.clientX, y: event.clientY };
          const pointer = event.nativeEvent;
          timer.current = setTimeout(() => {
            timer.current = null;
            active.current = true;
            suppressClick.current = true;
            const rect = button.current!.getBoundingClientRect();
            setRail({ left: rect.left, bottom: innerHeight - rect.top + 12 });
            controls.start(pointer, { distanceThreshold: 0 });
          }, 260);
        }}
        onPointerMove={(event) => {
          if (
            timer.current &&
            Math.hypot(
              event.clientX - start.current.x,
              event.clientY - start.current.y,
            ) > 16
          ) {
            clearTimer();
            suppressClick.current = true;
          }
        }}
        onPointerLeave={() => {
          if (timer.current) {
            clearTimer();
            suppressClick.current = true;
          }
        }}
        onPointerUp={() => {
          clearTimer();
          if (active.current && selected.current === null) cancel();
        }}
        onPointerCancel={cancel}
        onDrag={(_event, info) => {
          selected.current = portionFromDrag(info.offset.y);
          setValue(selected.current);
        }}
        onDragEnd={() => {
          active.current = false;
          setRail(null);
          if (selected.current !== null) onAdd(selected.current);
        }}
        onClick={(event) => {
          if (suppressClick.current && event.detail !== 0) return;
          button.current?.form?.requestSubmit();
        }}
      >
        {busy
          ? "Adding…"
          : rail && value !== null
            ? `Add ${formatMixedQuarter(value)}`
            : title}
        <Icon name="plus" size={18} />
      </motion.button>
      {rail &&
        createPortal(
          <motion.div
            className="portion-popover"
            style={rail}
            role="status"
            aria-label="Portion size"
            initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: reducedMotion ? 0 : 0.12 }}
          >
            <div className="portion-rail-card">
              <small>Hold &amp; slide</small>
              <strong>
                {value === null ? "Slide up" : `${formatMixedQuarter(value)}×`}
              </strong>
              <div className="portion-rail" aria-hidden="true">
                {[...portionValues].reverse().map((portion) => (
                  <div
                    key={portion}
                    className={`portion-step ${Number.isInteger(portion) ? "whole" : ""} ${portion === value ? "selected" : ""} ${value !== null && portion <= value ? "passed" : ""}`}
                  >
                    <span>{formatMixedQuarter(portion)}</span>
                    <i />
                  </div>
                ))}
              </div>
            </div>
            <div className="portion-rail-stem" />
          </motion.div>,
          button.current!.closest(".sheet-viewport")!,
        )}
    </>
  );
}

export function FoodPicker({
  meal: initialMeal,
  day,
  snapshot,
  onSave,
  onClose,
}: {
  meal: Meal;
  day: string;
  snapshot: Snapshot;
  onSave: (entry: Entry) => Promise<void>;
  onClose: () => void;
}) {
  const [meal, setMeal] = useState(initialMeal);
  const [tab, setTab] = useState("foods");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("openfoodfacts");
  const [results, setResults] = useState<Food[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Food | null>(null);
  const [portion, setPortion] = useState("1");
  const operation = useOperation();
  useEffect(() => {
    if (query.trim().length < 2 || tab !== "foods") {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      setHasMore(false);
      return;
    }
    const abort = new AbortController();
    setSearching(true);
    setSearchError(null);
    if (page === 1) setResults([]);
    const timer = setTimeout(async () => {
      try {
        const result = await api<{ foods: Food[]; hasMore: boolean }>(
          `/search?query=${encodeURIComponent(query.trim())}&provider=${provider}&page=${page}&maxItems=20&includeDetails=true`,
          undefined,
          abort.signal,
        );
        if (!abort.signal.aborted) {
          setResults((current) =>
            page === 1 ? result.foods : [...current, ...result.foods],
          );
          setHasMore(result.hasMore);
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setSearchError(e instanceof Error ? e.message : "Search failed.");
      } finally {
        if (!abort.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, provider, page, tab]);
  const recipe =
    selected && snapshot.recipes.find((recipe) => recipe.id === selected.id);
  const foods =
    tab === "recipes"
      ? snapshot.recipes.map(recipeFood)
      : query.trim()
        ? results
        : recentFoods(snapshot);
  const filtered =
    tab === "recipes"
      ? foods.filter((food) =>
          food.name.toLowerCase().includes(query.toLowerCase()),
        )
      : foods;
  const choose = (food: Food) => {
    setSelected(food);
    setPortion("1");
    operation.setError(null);
  };
  async function save(quantity = Number(portion)) {
    if (!selected) return;
    await operation.run(async () => {
      const entry = makeEntry(selected, meal, day, quantity, snapshot);
      if (recipe) {
        entry.data.recipeId = recipe.id;
        entry.data.recipeItems = structuredClone(recipe.data.items);
      }
      await onSave(entry);
      onClose();
    });
  }
  return (
    <Sheet
      title={selected ? selected.name : "Foods"}
      subtitle={`${label(meal)} · ${day === dateKey() ? "Today" : day}`}
      onClose={onClose}
      busy={operation.busy}
    >
      {selected ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="stack"
        >
          <button
            type="button"
            className="text-button back-link"
            onClick={() => setSelected(null)}
          >
            <Icon name="left" size={16} />
            Back to search
          </button>
          <div className="food-detail-title">
            <p>
              {[selected.brand, selected.serving].filter(Boolean).join(" · ") ||
                "1 serving"}
            </p>
          </div>
          <NutritionGrid
            nutrition={selected.nutrition}
            portion={Number(portion) || 0}
          />
          {!selected.nutrition && (
            <p className="hint">
              This source has no nutrition data. You can log it, but it won’t
              count toward your totals.
            </p>
          )}
          <Portion value={portion} onChange={setPortion} />
          <label className="field">
            Add to
            <select
              value={meal}
              onChange={(e) => setMeal(e.target.value as Meal)}
            >
              {mealOptions()}
            </select>
          </label>
          <ErrorNotice message={operation.error} />
          <PortionAddButton
            title={`Add to ${label(meal)}`}
            busy={operation.busy}
            onAdd={(quantity) => {
              setPortion(String(quantity));
              void save(quantity);
            }}
          />
        </form>
      ) : (
        <>
          <Segmented
            label="Food logging method"
            value={tab}
            options={[
              ["foods", "Foods"],
              ["recipes", "Recipes"],
              ["quick", "Quick add"],
            ]}
            onChange={(value) => {
              setTab(value);
              operation.setError(null);
            }}
          />
          {tab === "quick" ? (
            <QuickAdd
              onSave={onSave}
              meal={meal}
              day={day}
              snapshot={snapshot}
              onClose={onClose}
              operation={operation}
            />
          ) : (
            <>
              <label className="search-input">
                <Icon name="search" />
                <input
                  autoFocus
                  type="search"
                  aria-label="Search foods"
                  placeholder={
                    tab === "recipes"
                      ? "Search your recipes"
                      : "Search foods, brands, or meals"
                  }
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
                {query && (
                  <IconButton
                    name="close"
                    title="Clear search"
                    onClick={() => {
                      setQuery("");
                      setPage(1);
                    }}
                  />
                )}
              </label>
              {tab === "foods" && query.trim() && (
                <label className="field provider-field">
                  Food source
                  <select
                    value={provider}
                    onChange={(e) => {
                      setProvider(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="openfoodfacts">Open Food Facts</option>
                    <option value="mfp">MyFitnessPal</option>
                  </select>
                </label>
              )}
              {tab === "foods" &&
                !query.trim() &&
                snapshot.recipes.length > 0 && (
                  <>
                    <div className="result-heading">
                      <h3>Recipes</h3>
                    </div>
                    <div className="food-results">
                      {snapshot.recipes.map((recipe) => (
                        <button
                          className="food-result"
                          key={recipe.id}
                          onClick={() => choose(recipeFood(recipe))}
                        >
                          <span className="row-main">
                            <strong>{recipe.data.name}</strong>
                            <small>
                              {recipe.data.items.length} ingredients
                            </small>
                            <MacroBadges
                              nutrition={totals(recipe.data.items)}
                            />
                          </span>
                          <Icon name="right" size={17} />
                        </button>
                      ))}
                    </div>
                  </>
                )}
              <div className="result-heading">
                <h3>
                  {tab === "recipes"
                    ? "Recipes"
                    : query
                      ? "Results"
                      : "Recents"}
                </h3>
                <span>
                  {searching ? "Searching…" : `${filtered.length} foods`}
                </span>
              </div>
              <ErrorNotice message={searchError} />
              <div className="food-results">
                {filtered.map((food, index) => (
                  <button
                    className="food-result"
                    key={`${food.id}_${index}`}
                    onClick={() => choose(food)}
                  >
                    <span className="result-icon">
                      <Icon
                        name={tab === "recipes" ? "book" : "lunch"}
                        size={18}
                      />
                    </span>
                    <span className="row-main">
                      <strong>{food.name}</strong>
                      <small>
                        {[food.brand, food.serving]
                          .filter(Boolean)
                          .join(" · ") || "1 serving"}
                      </small>
                      <MacroBadges nutrition={food.nutrition} />
                    </span>
                    <span className="result-calories">
                      {food.nutrition?.calories === undefined
                        ? "—"
                        : format(food.nutrition.calories)}
                      <small>kcal</small>
                    </span>
                    <Icon name="right" size={17} />
                  </button>
                ))}
              </div>
              {searching && (
                <p role="status" className="loading-text">
                  Searching food sources…
                </p>
              )}
              {!filtered.length && !searching && !searchError && (
                <Empty
                  icon={tab === "recipes" ? "book" : "search"}
                  title={
                    query
                      ? "No foods found"
                      : tab === "recipes"
                        ? "No recipes"
                        : "No recent foods"
                  }
                  text=""
                />
              )}
              {hasMore && (
                <button
                  className="secondary-button"
                  onClick={() => setPage((page) => page + 1)}
                  disabled={searching}
                >
                  Load more foods
                </button>
              )}
            </>
          )}
        </>
      )}
    </Sheet>
  );
}
function QuickAdd({
  onSave,
  meal,
  day,
  snapshot,
  onClose,
  operation,
}: {
  onSave: (entry: Entry) => Promise<void>;
  meal: Meal;
  day: string;
  snapshot: Snapshot;
  onClose: () => void;
  operation: ReturnType<typeof useOperation>;
}) {
  const [name, setName] = useState("");
  const [values, setValues] = useState({
    calories: "",
    protein: "",
    carbs: "",
    fat: "",
  });
  return (
    <form
      className="stack quick-form"
      onSubmit={(e) => {
        e.preventDefault();
        void operation.run(async () => {
          const nutrition: Nutrition = {};
          for (const key of Object.keys(values) as (keyof typeof values)[])
            if (values[key] !== "") nutrition[key] = Number(values[key]);
          await onSave(
            makeEntry(
              {
                id: "quick",
                name: name.trim() || "Quick add",
                serving: "1 serving",
                nutrition,
              },
              meal,
              day,
              1,
              snapshot,
            ),
          );
          onClose();
        });
      }}
    >
      <label className="field">
        Food or meal name
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Homemade sandwich"
          maxLength={200}
        />
      </label>
      <div className="form-grid">
        {(Object.keys(values) as (keyof typeof values)[]).map((key) => (
          <label className="field" key={key}>
            {label(key)} {key === "calories" ? "(kcal)" : "(g)"}
            <input
              type="number"
              min="0"
              max="10000"
              step="any"
              inputMode="decimal"
              required={key === "calories"}
              value={values[key]}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
              placeholder="0"
            />
          </label>
        ))}
      </div>
      <ErrorNotice message={operation.error} />
      <button className="primary-button" disabled={operation.busy}>
        {operation.busy ? "Adding…" : `Add to ${label(meal)}`}
      </button>
    </form>
  );
}

export function EntryEditor({
  entry,
  onSave,
  onDelete,
  onCopy,
  onClose,
}: {
  entry: Entry;
  onSave: (entry: Entry) => Promise<void>;
  onDelete: (entry: Entry) => Promise<void>;
  onCopy: (entry: Entry) => Promise<void>;
  onClose: () => void;
}) {
  const [portion, setPortion] = useState(String(entry.data.portion));
  const [meal, setMeal] = useState(entry.data.meal);
  const [day, setDay] = useState(entry.data.dateKey);
  const [confirm, setConfirm] = useState(false);
  const operation = useOperation();
  return (
    <Sheet
      title={entry.data.foodName}
      subtitle={label(entry.data.meal)}
      onClose={onClose}
      busy={operation.busy}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void operation.run(async () => {
            await onSave({
              ...entry,
              updatedAt: Date.now(),
              data: {
                ...entry.data,
                portion: Number(portion),
                meal,
                dateKey: day,
              },
            });
            onClose();
          });
        }}
      >
        <div className="food-detail-title">
          <p>
            {[entry.data.brand, entry.data.serving]
              .filter(Boolean)
              .join(" · ") || "1 serving"}
          </p>
        </div>
        <NutritionGrid
          nutrition={entry.data.nutrition}
          portion={Number(portion) || 0}
        />
        <Portion value={portion} onChange={setPortion} />
        <div className="form-grid">
          <label className="field">
            Meal
            <select
              aria-label="Meal"
              value={meal}
              onChange={(e) => setMeal(e.target.value as Meal)}
            >
              {mealOptions()}
            </select>
          </label>
          <label className="field">
            Date
            <input
              type="date"
              required
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </label>
        </div>
        {entry.data.recipeItems && (
          <details className="ingredient-details">
            <summary>
              Recipe ingredients · {entry.data.recipeItems.length}
            </summary>
            {entry.data.recipeItems.map((item) => (
              <div className="ingredient-row" key={item.id}>
                <span>
                  {item.foodName}
                  <small>
                    {decimal(item.portion * (Number(portion) || 0))} ×{" "}
                    {item.serving || "1 serving"}
                  </small>
                </span>
                <b>
                  {format(
                    (item.nutrition?.calories || 0) *
                      item.portion *
                      (Number(portion) || 0),
                  )}{" "}
                  kcal
                </b>
              </div>
            ))}
          </details>
        )}
        <ErrorNotice message={operation.error} />
        <button className="primary-button" disabled={operation.busy}>
          {operation.busy ? "Saving…" : "Save changes"}
          <Icon name="check" size={18} />
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={operation.busy}
          onClick={() =>
            void operation.run(async () => {
              await onCopy(entry);
              onClose();
            })
          }
        >
          <Icon name="copy" size={17} />
          Duplicate
        </button>
        {confirm ? (
          <div className="inline-confirm">
            <p>Remove {entry.data.foodName} from your journal?</p>
            <div>
              <button
                type="button"
                className="text-button"
                onClick={() => setConfirm(false)}
              >
                Keep food
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={operation.busy}
                onClick={() =>
                  void operation.run(async () => {
                    await onDelete(entry);
                    onClose();
                  })
                }
              >
                Remove food
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="text-button danger"
            disabled={operation.busy}
            onClick={() => setConfirm(true)}
          >
            <Icon name="trash" size={17} />
            Remove from journal
          </button>
        )}
      </form>
    </Sheet>
  );
}

export function Settings({
  settings,
  onSave,
  onRecipes,
  onFriends,
  onSignOut,
  onClose,
}: {
  settings: UserSettings;
  onSave: (settings: UserSettings) => Promise<void>;
  onRecipes: () => void;
  onFriends: () => void;
  onSignOut: () => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState(
    Object.fromEntries(
      Object.entries(settings).map(([key, value]) => [key, String(value)]),
    ),
  );
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme || "system",
  );
  const operation = useOperation();
  const sum =
    Number(values.macroProteinPct) +
    Number(values.macroCarbsPct) +
    Number(values.macroFatPct);
  return (
    <Sheet title="Settings" onClose={onClose} busy={operation.busy}>
      <div className="stack">
        <div className="settings-links card">
          <button type="button" onClick={onRecipes}>
            <Icon name="book" /> Recipes <Icon name="right" size={16} />
          </button>
          <button type="button" onClick={onFriends}>
            <Icon name="people" /> Friends <Icon name="right" size={16} />
          </button>
        </div>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void operation.run(async () => {
              const next = UserSettingsSchema.parse(
                Object.fromEntries(
                  Object.entries(values).map(([key, value]) => [
                    key,
                    Number(value),
                  ]),
                ),
              );
              await onSave(next);
              onClose();
            });
          }}
        >
          <span className="eyebrow">DAILY GOALS</span>
          <label className="field">
            Calorie goal <span className="field-unit">kcal / day</span>
            <input
              type="number"
              inputMode="numeric"
              min="100"
              max="10000"
              step="1"
              required
              value={values.calorieGoal}
              onChange={(e) =>
                setValues({ ...values, calorieGoal: e.target.value })
              }
            />
          </label>
          <div className="macro-settings">
            {(
              [
                ["macroProteinPct", "Protein", "protein", 4],
                ["macroCarbsPct", "Carbs", "carbs", 4],
                ["macroFatPct", "Fat", "fat", 9],
              ] as const
            ).map(([key, title, color, divisor]) => (
              <label className={`field ${color}`} key={key}>
                <span>{title} %</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="100"
                  required
                  value={values[key]}
                  onChange={(e) =>
                    setValues({ ...values, [key]: e.target.value })
                  }
                />
                <small>
                  {format(
                    (Number(values.calorieGoal) * Number(values[key])) /
                      100 /
                      divisor,
                  )}{" "}
                  g / day
                </small>
              </label>
            ))}
          </div>
          <p className={`hint ${sum !== 100 ? "danger" : ""}`}>
            {sum === 100
              ? null
              : `Macros must add up to 100% (currently ${sum}%).`}
          </p>
          <ErrorNotice message={operation.error} />
          <button
            className="primary-button"
            disabled={operation.busy || sum !== 100}
          >
            {operation.busy ? "Saving…" : "Save goals"}
          </button>
        </form>
        <div className="settings-divider" />
        <span className="eyebrow">APPEARANCE</span>
        <Segmented
          label="Appearance"
          value={theme}
          options={["system", "light", "dark"].map((value) => [
            value,
            label(value),
          ])}
          onChange={(value) => {
            setTheme(value);
            document.documentElement.dataset.theme = value;
            try {
              localStorage.setItem("caloric.web.theme", value);
            } catch {
              operation.setError(
                "Theme changed, but your browser could not save it for next time.",
              );
            }
          }}
        />
        <div className="settings-divider" />
        <span className="eyebrow">ACCOUNT</span>
        <button
          className="secondary-button"
          disabled={operation.busy}
          onClick={() => void operation.run(onSignOut)}
        >
          <Icon name="logout" size={17} />
          Sign out
        </button>
      </div>
    </Sheet>
  );
}

export function Recipes({
  snapshot,
  onSave,
  onDelete,
  onClose,
}: {
  snapshot: Snapshot;
  onSave: (recipe: SavedRecipe) => Promise<void>;
  onDelete: (recipe: SavedRecipe) => Promise<void>;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<SavedRecipe | null>(null);
  const [name, setName] = useState("");
  const [items, setItems] = useState<RecipeItem[]>([]);
  const [confirm, setConfirm] = useState(false);
  const operation = useOperation();
  const foods = recentFoods(snapshot);
  function edit(recipe?: SavedRecipe) {
    setEditing(
      recipe || {
        id: `recipe_${crypto.randomUUID()}`,
        updatedAt: Date.now(),
        data: { name: "", items: [], createdAt: Date.now() },
      },
    );
    setName(recipe?.data.name || "");
    setItems(structuredClone(recipe?.data.items || []));
    setConfirm(false);
    operation.setError(null);
  }
  return (
    <Sheet
      title={editing ? "Recipe editor" : "Recipes"}
      onClose={onClose}
      busy={operation.busy}
    >
      {editing ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void operation.run(async () => {
              await onSave({
                ...editing,
                updatedAt: Date.now(),
                data: { ...editing.data, name: name.trim(), items },
              });
              setEditing(null);
            });
          }}
        >
          <button
            type="button"
            className="text-button back-link"
            onClick={() => setEditing(null)}
          >
            <Icon name="left" size={16} />
            All recipes
          </button>
          <label className="field">
            Recipe name
            <input
              autoFocus
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My breakfast bowl"
            />
          </label>
          <NutritionGrid nutrition={totals(items)} />
          <span className="eyebrow">INGREDIENTS</span>
          {items.map((item) => (
            <div className="recipe-ingredient" key={item.id}>
              <span className="row-main">
                <strong>{item.foodName}</strong>
                <small>{item.serving || "1 serving"}</small>
              </span>
              <input
                aria-label={`Servings of ${item.foodName}`}
                type="number"
                min="0.01"
                max="1000"
                step="any"
                required
                value={item.portion}
                onChange={(e) =>
                  setItems(
                    items.map((current) =>
                      current.id === item.id
                        ? { ...current, portion: Number(e.target.value) }
                        : current,
                    ),
                  )
                }
              />
              <IconButton
                name="close"
                title={`Remove ${item.foodName}`}
                onClick={() =>
                  setItems(items.filter((current) => current.id !== item.id))
                }
              />
            </div>
          ))}
          <label className="field">
            Add ingredient from recent foods
            <select
              value=""
              onChange={(e) => {
                const food = foods.find((food) => food.id === e.target.value);
                if (food)
                  setItems([
                    ...items,
                    {
                      id: `ingredient_${crypto.randomUUID()}`,
                      foodName: food.name,
                      brand: food.brand,
                      serving: food.serving,
                      nutrition: food.nutrition,
                      portion: 1,
                    },
                  ]);
              }}
            >
              <option value="">Choose a food…</option>
              {foods.map((food) => (
                <option key={food.id} value={food.id}>
                  {food.name}
                </option>
              ))}
            </select>
          </label>
          {!foods.length && (
            <p className="hint">
              Log a food first to use it as a recipe ingredient.
            </p>
          )}
          <ErrorNotice message={operation.error} />
          <button
            className="primary-button"
            disabled={operation.busy || !items.length || !name.trim()}
          >
            {operation.busy ? "Saving…" : "Save recipe"}
          </button>
          {snapshot.recipes.some((recipe) => recipe.id === editing.id) &&
            (confirm ? (
              <div className="inline-confirm">
                <p>
                  Delete this recipe? Previously logged meals will stay in your
                  journal.
                </p>
                <div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setConfirm(false)}
                  >
                    Keep recipe
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={operation.busy}
                    onClick={() =>
                      void operation.run(async () => {
                        await onDelete(editing);
                        setEditing(null);
                      })
                    }
                  >
                    Delete recipe
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="text-button danger"
                onClick={() => setConfirm(true)}
              >
                Delete recipe
              </button>
            ))}
        </form>
      ) : (
        <div className="stack">
          <button className="primary-button" onClick={() => edit()}>
            <Icon name="plus" size={18} />
            Create recipe
          </button>
          <div className="food-results">
            {snapshot.recipes.map((recipe) => (
              <button
                className="food-result"
                key={recipe.id}
                onClick={() => edit(recipe)}
              >
                <span className="result-icon">
                  <Icon name="book" />
                </span>
                <span className="row-main">
                  <strong>{recipe.data.name}</strong>
                  <small>
                    {recipe.data.items.length} ingredients · 1 recipe
                  </small>
                  <MacroBadges nutrition={totals(recipe.data.items)} />
                </span>
                <span className="result-calories">
                  {format(totals(recipe.data.items).calories)}
                  <small>kcal</small>
                </span>
                <Icon name="right" size={17} />
              </button>
            ))}
          </div>
          {!snapshot.recipes.length && (
            <Empty icon="book" title="No recipes" text="" />
          )}
        </div>
      )}
    </Sheet>
  );
}

export function SignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [method, setMethod] = useState("code");
  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState("");
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const operation = useOperation();
  return (
    <main className="auth-page">
      <div className="auth-card card">
        <h1>Caloric</h1>
        <p>Sign in or create an account to continue.</p>
        <Segmented
          label="Sign-in method"
          value={method}
          options={[
            ["code", "Email code"],
            ["password", "Password"],
          ]}
          onChange={(value) => {
            setMethod(value);
            setSent(false);
            operation.setError(null);
          }}
        />
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void operation.run(async () => {
              const normalizedEmail = email.trim().toLowerCase();
              if (method === "code" && !sent) {
                await api("/api/auth/email-otp/send-verification-otp", {
                  email: normalizedEmail,
                  type: "sign-in",
                });
                setSent(true);
              } else {
                await api(
                  method === "code"
                    ? "/api/auth/sign-in/email-otp"
                    : isSignUp
                      ? "/api/auth/sign-up/email"
                      : "/api/auth/sign-in/email",
                  method === "code"
                    ? { email: normalizedEmail, otp }
                    : {
                        email: normalizedEmail,
                        password,
                        ...(isSignUp ? { name: name.trim() } : {}),
                      },
                );
                await onSignedIn();
              }
            });
          }}
        >
          <label className="field">
            Email
            <input
              autoFocus
              required
              type="email"
              autoComplete="email"
              value={email}
              readOnly={sent}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          {method === "password" && isSignUp && (
            <label className="field">
              Name
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                placeholder="Your name"
              />
            </label>
          )}
          {method === "password" && (
            <label className="field">
              Password
              <input
                type="password"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
          {sent && (
            <>
              <p className="hint">Enter the six-digit code sent to {email}.</p>
              <label className="field">
                Verification code
                <input
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSent(false);
                  setOtp("");
                }}
              >
                Use a different email or resend code
              </button>
            </>
          )}
          <ErrorNotice message={operation.error} />
          <button className="primary-button" disabled={operation.busy}>
            {operation.busy
              ? "Please wait…"
              : method === "code" && !sent
                ? "Send code"
                : method === "code"
                  ? "Verify code"
                  : isSignUp
                    ? "Create account"
                    : "Sign in"}
            <Icon name="right" size={18} />
          </button>
        </form>
        {method === "password" && (
          <button
            className="text-button"
            disabled={operation.busy}
            onClick={() => {
              setIsSignUp(!isSignUp);
              operation.setError(null);
            }}
          >
            {isSignUp
              ? "Have an account? Sign in"
              : "New here? Create an account"}
          </button>
        )}
      </div>
    </main>
  );
}
