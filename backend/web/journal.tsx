import { useRef, useState } from "react";
import { DragDropProvider, DragOverlay, useDroppable } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import {
  KeyboardSensor,
  PointerSensor,
  PointerActivationConstraints,
} from "@dnd-kit/dom";
import { SortableKeyboardPlugin } from "@dnd-kit/dom/sortable";
import { move } from "@dnd-kit/helpers";
import type { Meal } from "@caloric/data-model";
import { label, meals, totals, type Entry } from "./model";
import { decimal, format, Icon, IconButton, MacroBadges } from "./ui";
import { hasCalorieMacroMismatch } from "../../mobile/src/nutritionConsistency";

const sensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 170, tolerance: 8 })]
        : [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
  KeyboardSensor.configure({
    keyboardCodes: {
      ...KeyboardSensor.defaults.keyboardCodes,
      start: ["Space"],
    },
  }),
];
type Groups = Record<Meal, Entry[]>;

export function Journal({
  entries,
  saving,
  onOpen,
  onAdd,
  onReorder,
  onError,
  onDraggingChange,
}: {
  entries: Entry[];
  saving: boolean;
  onOpen: (entry: Entry) => void;
  onAdd: (meal: Meal) => void;
  onReorder: (id: string, meal: Meal, index: number) => Promise<void>;
  onError: (message: string) => void;
  onDraggingChange: (active: boolean) => void;
}) {
  const groups = Object.fromEntries(
    meals.map((meal) => [
      meal,
      entries.filter((row) => row.data.meal === meal),
    ]),
  ) as Groups;
  const [preview, setPreview] = useState<Groups | null>(null);
  const draft = useRef<Groups | null>(null);
  const active = useRef(false);
  function finish() {
    draft.current = null;
    setPreview(null);
    active.current = false;
    onDraggingChange(false);
  }
  return (
    <DragDropProvider
      sensors={sensors}
      onBeforeDragStart={(event) => {
        if (saving || active.current) event.preventDefault();
      }}
      onDragStart={() => {
        active.current = true;
        onDraggingChange(true);
        draft.current = groups;
      }}
      onDragOver={(event) => {
        if (!draft.current) return;
        draft.current = move(draft.current, event);
        setPreview(draft.current);
      }}
      onDragEnd={async (event) => {
        const { source, target } = event.operation;
        try {
          if (event.canceled || !source || !target || !draft.current) return;
          const meal = meals.find((meal) =>
            draft.current![meal].some((row) => row.id === source.id),
          );
          if (meal)
            await onReorder(
              String(source.id),
              meal,
              draft.current[meal].findIndex((row) => row.id === source.id),
            );
        } catch (error) {
          onError(
            error instanceof Error
              ? error.message
              : "Could not save the order.",
          );
        } finally {
          finish();
          // Moving between meal containers remounts the row; retain keyboard focus.
          if (source && event.nativeEvent instanceof KeyboardEvent) {
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>(
                  `[data-entry-id="${source.id}"] .entry-button`,
                )
                ?.focus(),
            );
          }
        }
      }}
    >
      <section className="journal" id="journal" aria-label="Meal journal">
        {meals.map((meal) => (
          <MealSection
            key={meal}
            meal={meal}
            rows={(preview || groups)[meal]}
            saving={saving}
            onOpen={(entry) => {
              if (!active.current) onOpen(entry);
            }}
            onAdd={() => {
              if (!active.current) onAdd(meal);
            }}
          />
        ))}
        <div className="journal-bottom">
          <Icon name="check" size={15} />
          <span>{saving ? "Saving…" : ""}</span>
          <span className="shortcut-hint">N to log · ← → days · T today</span>
        </div>
      </section>
      <DragOverlay className="entry-drag-overlay">
        {(source) =>
          source ? (
            <div className="entry-button">
              <EntryContent entry={source.data.entry as Entry} />
            </div>
          ) : null
        }
      </DragOverlay>
    </DragDropProvider>
  );
}

function MealSection({
  meal,
  rows,
  saving,
  onOpen,
  onAdd,
}: {
  meal: Meal;
  rows: Entry[];
  saving: boolean;
  onOpen: (entry: Entry) => void;
  onAdd: () => void;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: meal,
    type: "meal",
    accept: "food",
    collisionPriority: -1,
  });
  const nutrition = totals(rows.map((row) => row.data));
  return (
    <section
      ref={ref}
      className={`meal-section ${isDropTarget ? "drag-target" : ""}`}
      aria-label={label(meal)}
    >
      <h3 className="meal-side-label">{label(meal)}</h3>
      <div className="card meal-card">
        <header className="meal-header">
          <div className="meal-stats">
            <span className="meal-total">
              {format(nutrition.calories)} <small>kcal</small>
            </span>
            <MacroBadges
              nutrition={{
                protein: nutrition.protein,
                carbs: nutrition.carbs,
                fat: nutrition.fat,
              }}
            />
            <IconButton
              name="plus"
              title={`Add food to ${label(meal)}`}
              className="meal-add"
              onClick={onAdd}
            />
          </div>
        </header>
        <div className="meal-rows">
          {rows.map((entry, index) => (
            <SortableEntry
              key={entry.id}
              entry={entry}
              meal={meal}
              index={index}
              saving={saving}
              onOpen={() => onOpen(entry)}
            />
          ))}
        </div>
        {!rows.length && (
          <button className="empty-meal" onClick={onAdd}>
            No {meal} entries yet.
          </button>
        )}
      </div>
    </section>
  );
}

function SortableEntry({
  entry,
  meal,
  index,
  saving,
  onOpen,
}: {
  entry: Entry;
  meal: Meal;
  index: number;
  saving: boolean;
  onOpen: () => void;
}) {
  const { ref, handleRef, isDragSource } = useSortable({
    id: entry.id,
    group: meal,
    index,
    type: "food",
    accept: "food",
    data: { entry },
    disabled: { draggable: saving },
    // React owns the preview so cancellation and failed writes revert cleanly.
    plugins: [SortableKeyboardPlugin],
  });
  return (
    <div
      ref={ref}
      className="meal-row"
      data-entry-id={entry.id}
      data-dragging={isDragSource || undefined}
    >
      <button
        ref={handleRef}
        className="entry-button"
        aria-label={`Edit ${entry.data.foodName}`}
        onClick={onOpen}
      >
        <EntryContent entry={entry} />
      </button>
    </div>
  );
}

function EntryContent({ entry }: { entry: Entry }) {
  return (
    <>
      <span className="row-main">
        <strong>
          {entry.data.foodName}
          {hasCalorieMacroMismatch(entry.data.nutrition) && (
            <span
              className="mismatch-hint"
              title="Reported calories differ from calculated macros"
            >
              ≈
            </span>
          )}
          {entry.data.recipeId && <Icon name="book" size={13} />}
        </strong>
        <small>
          {[
            `${decimal(entry.data.portion)} × ${entry.data.serving || "1 serving"}`,
            entry.data.brand,
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </span>
      <span className="entry-calories">
        {entry.data.nutrition?.calories === undefined
          ? "—"
          : format((entry.data.nutrition.calories || 0) * entry.data.portion)}
      </span>
    </>
  );
}
