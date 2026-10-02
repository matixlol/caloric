import { useEffect, useRef, useState, type ReactNode } from "react";
import { Drawer } from "@base-ui/react/drawer";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { motion, useReducedMotion } from "motion/react";
import type { Nutrition, UserSettings } from "@caloric/data-model";
import { label, macroGoals } from "./model";

const paths = {
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  left: "m15 5-7 7 7 7",
  right: "m9 5 7 7-7 7",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  settings:
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  calendar: "M7 2v4M17 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  check: "m5 12 4 4L19 6",
  book: "M4 3h12a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V5a2 2 0 0 1 1-2ZM3 17h16M8 7h6M8 11h4",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
  people:
    "M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM5 21v-3a7 7 0 0 1 14 0v3M19 4a3 3 0 0 1 0 6M21 14a6 6 0 0 1 2 4",
  sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1",
  lunch: "M5 3v6a3 3 0 0 0 6 0V3M8 3v18M19 21V3c-4 2-4 9 0 10",
  moon: "M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z",
  snack: "M5 9h14l-2 12H7L5 9ZM8 9V6a4 4 0 0 1 8 0v3",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  refresh: "M20 11a8 8 0 1 0-2 7M20 4v7h-7",
  mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5ZM5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8",
  stop: "M6 6h12v12H6Z",
  copy: "M9 9h12v12H9ZM15 5V3H3v12h2",
  grip: "M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01",
  logout: "M9 3H3v18h6M9 12h12m-5-5 5 5-5 5",
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function IconButton({
  name,
  title,
  onClick,
  disabled,
  className = "",
}: {
  name: IconName;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={title}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={name} />
    </button>
  );
}
export const format = (n: number | null | undefined) =>
  Math.round(n || 0).toLocaleString();
export const decimal = (n: number) => Number(n.toFixed(2)).toLocaleString();
export function MacroBadges({ nutrition }: { nutrition?: Nutrition }) {
  if (!nutrition) return null;
  return (
    <span className="macro-badges">
      {(["calories", "protein", "carbs", "fat"] as const)
        .filter((macro) => nutrition[macro] !== undefined)
        .map((macro) => (
          <span
            key={macro}
            className={`badge ${macro}`}
            aria-label={`${label(macro)} ${format(nutrition?.[macro])} ${macro === "calories" ? "kcal" : "grams"}`}
          >
            {macro === "calories"
              ? format(nutrition.calories)
              : `${macro === "protein" ? "P" : macro === "carbs" ? "C" : "F"} ${decimal(Math.round(nutrition[macro]! * 10) / 10)}g`}
          </span>
        ))}
    </span>
  );
}
export function Summary({
  nutrition,
  settings,
  onGoals,
}: {
  nutrition: Nutrition;
  settings: UserSettings;
  onGoals?: () => void;
}) {
  const calories = nutrition.calories || 0;
  const progress = Math.min(1, Math.max(0, calories / settings.calorieGoal));
  const goals = macroGoals(settings);
  return (
    <section className="card summary" aria-label="Daily nutrition summary">
      <h2 className="summary-label">Calories</h2>
      <div className="summary-value-row">
        <strong data-testid="day-calories">{format(calories)}</strong>
        <button
          className="summary-goal"
          aria-label={onGoals ? "Edit goals" : undefined}
          onClick={onGoals}
          disabled={!onGoals}
        >
          / {format(settings.calorieGoal)}
        </button>
      </div>
      <div
        className="track calorie-track"
        role="progressbar"
        aria-label="Calories"
        aria-valuenow={Math.round(calories)}
        aria-valuemin={0}
        aria-valuemax={Math.max(settings.calorieGoal, Math.round(calories))}
      >
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="macro-goals">
        {(["protein", "carbs", "fat"] as const).map((macro) => (
          <div className={`macro-goal ${macro}`} key={macro}>
            <div>
              <span className="macro-name">{label(macro)}</span>
              <span>
                <b>{format(nutrition[macro])}</b>
                <small> / {goals[macro]}</small>
              </span>
            </div>
            <div
              className="track"
              role="progressbar"
              aria-label={label(macro)}
              aria-valuenow={Math.round(nutrition[macro] || 0)}
              aria-valuemin={0}
              aria-valuemax={Math.max(
                goals[macro],
                Math.round(nutrition[macro] || 0),
              )}
            >
              <span
                style={{
                  width: `${goals[macro] ? Math.min(100, ((nutrition[macro] || 0) / goals[macro]) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
export function Sheet({
  title,
  subtitle,
  children,
  onClose,
  busy = false,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const reducedMotion = useReducedMotion();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // A conditionally mounted, already-open root skips the entrance transition.
  useEffect(() => setOpen(true), []);
  useEffect(() => {
    const back = () => {
      if (busyRef.current) history.pushState({ caloricSheet: true }, "");
      else closeRef.current();
    };
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("popstate", back);
    };
  }, []);
  useEffect(() => {
    if (!popup) return;
    const top = popup.querySelector<HTMLElement>(".sheet-top")!;
    const content = popup.querySelector<HTMLElement>(".sheet-content-inner")!;
    const measure = () =>
      setHeight(
        Math.min(
          top.offsetHeight + content.offsetHeight,
          parseFloat(getComputedStyle(popup).maxHeight),
        ),
      );
    const observer = new ResizeObserver(measure);
    observer.observe(top);
    observer.observe(content);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [popup]);
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next, details) => {
        if (busy) details.cancel();
        else setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <Drawer.VirtualKeyboardProvider>
        <Drawer.Portal>
          <Drawer.Backdrop className="sheet-backdrop" />
          <Drawer.Viewport className="sheet-viewport">
            <Drawer.Popup
              ref={setPopup}
              render={
                <motion.div
                  initial={false}
                  animate={{ height: height ?? "auto" }}
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 420, damping: 40 }
                  }
                />
              }
              className={`sheet ${wide ? "wide-sheet" : ""}`}
              initialFocus={(interaction) =>
                interaction === "touch"
                  ? false
                  : document.querySelector<HTMLElement>(
                      '.sheet input[type="search"], .sheet input[aria-label="Message Caloric"]',
                    ) || true
              }
            >
              <div className="sheet-top">
                <div className="sheet-grabber" aria-hidden="true">
                  <span />
                </div>
                <header className="sheet-header">
                  <div>
                    <Drawer.Title>{title}</Drawer.Title>
                    {subtitle && (
                      <Drawer.Description>{subtitle}</Drawer.Description>
                    )}
                  </div>
                  <Drawer.Close
                    className="icon-button"
                    aria-label="Close"
                    disabled={busy}
                  >
                    <Icon name="close" />
                  </Drawer.Close>
                </header>
              </div>
              <Drawer.Content className="sheet-content">
                <div className="sheet-content-inner">{children}</div>
              </Drawer.Content>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.VirtualKeyboardProvider>
    </Drawer.Root>
  );
}
export function Segmented({
  value,
  options,
  onChange,
  label: accessibleLabel,
}: {
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <ToggleGroup
      className="segmented"
      aria-label={accessibleLabel}
      value={[value]}
      onValueChange={(values) => {
        if (values.length) onChange(values[0]);
      }}
    >
      {options.map(([value, title]) => (
        <Toggle key={value} value={value}>
          {title}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
export function Empty({
  icon = "search",
  title,
  text,
}: {
  icon?: IconName;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
export function ErrorNotice({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="error-notice">
      {message}
    </p>
  ) : null;
}
export function NutritionGrid({
  nutrition,
  portion = 1,
}: {
  nutrition?: Nutrition;
  portion?: number;
}) {
  return (
    <div className="nutrition-grid">
      {(["calories", "protein", "carbs", "fat"] as const).map((key) => (
        <div key={key} className={key}>
          <span>{label(key)}</span>
          <strong>
            {nutrition?.[key] === undefined
              ? "—"
              : format((nutrition[key] || 0) * portion)}
            <small>{key === "calories" ? " kcal" : " g"}</small>
          </strong>
        </div>
      ))}
    </div>
  );
}
