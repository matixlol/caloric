#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "myfitnesspal>=2.0.0",
#   "browser-cookie3>=0.20.1",
# ]
# ///

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable

import browser_cookie3
import myfitnesspal


DEFAULT_MEASUREMENTS = ["Weight", "Body Fat", "Neck", "Waist", "Hips"]


def parse_date(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"Invalid date '{value}'. Expected YYYY-MM-DD."
        ) from exc


def date_range(start: dt.date, end: dt.date) -> Iterable[dt.date]:
    current = start
    while current <= end:
        yield current
        current += dt.timedelta(days=1)


def to_jsonable(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(v) for v in value]
    return str(value)


def choose_cookiejar(
    browser: str,
    cookie_file: str | None,
    domain: str,
) -> Any:
    if cookie_file:
        return browser_cookie3.chromium(cookie_file=cookie_file, domain_name=domain)

    if browser == "auto":
        return None

    loader: Callable[..., Any] | None = getattr(browser_cookie3, browser, None)
    if loader is None:
        supported = ", ".join(
            b
            for b in [
                "auto",
                "brave",
                "chrome",
                "chromium",
                "edge",
                "firefox",
                "opera",
                "safari",
                "vivaldi",
            ]
            if b == "auto" or hasattr(browser_cookie3, b)
        )
        raise ValueError(f"Unsupported browser '{browser}'. Supported: {supported}")

    return loader(domain_name=domain)


def export_day(day: Any) -> dict[str, Any]:
    meals: list[dict[str, Any]] = []
    for meal in day.meals:
        meal_entries = []
        for entry in meal.entries:
            meal_entries.append(
                {
                    "name": entry.name,
                    "short_name": entry.short_name,
                    "quantity": entry.quantity,
                    "unit": entry.unit,
                    "nutrition": to_jsonable(entry.nutrition_information),
                }
            )

        meals.append(
            {
                "name": meal.name,
                "totals": to_jsonable(meal.totals),
                "entries": meal_entries,
            }
        )

    exercises: list[dict[str, Any]] = []
    for exercise in day.exercises:
        exercise_entries = []
        for entry in exercise.entries:
            exercise_entries.append(
                {
                    "name": entry.name,
                    "short_name": entry.short_name,
                    "quantity": entry.quantity,
                    "unit": entry.unit,
                    "metrics": to_jsonable(entry.nutrition_information),
                }
            )

        exercises.append({"name": exercise.name, "entries": exercise_entries})

    has_entries = any(meal["entries"] for meal in meals)
    has_exercises = any(exercise["entries"] for exercise in exercises)
    notes = day.notes
    water = day.water

    return {
        "date": day.date.isoformat(),
        "complete": day.complete,
        "totals": to_jsonable(day.totals),
        "goals": to_jsonable(day.goals),
        "water": to_jsonable(water),
        "notes": notes,
        "meals": meals,
        "exercises": exercises,
        "has_data": bool(has_entries or has_exercises or notes or water),
    }


def export_recipes(client: myfitnesspal.Client) -> list[dict[str, Any]]:
    result = []
    recipes = client.get_recipes()
    for recipe_id, title in recipes.items():
        try:
            data = client.get_recipe(recipe_id)
            result.append({"id": recipe_id, "title": title, "data": to_jsonable(data)})
        except Exception as exc:  # pragma: no cover - defensive network parsing guard
            result.append(
                {
                    "id": recipe_id,
                    "title": title,
                    "error": str(exc),
                }
            )
    return result


def export_saved_meals(client: myfitnesspal.Client) -> list[dict[str, Any]]:
    result = []
    meals = client.get_meals()
    for meal_id, title in meals.items():
        try:
            data = client.get_meal(meal_id, title)
            result.append({"id": meal_id, "title": title, "data": to_jsonable(data)})
        except Exception as exc:  # pragma: no cover - defensive network parsing guard
            result.append(
                {
                    "id": meal_id,
                    "title": title,
                    "error": str(exc),
                }
            )
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export MyFitnessPal account data to JSON/JSONL files.",
    )
    parser.add_argument(
        "--start-date",
        type=parse_date,
        default=dt.date(2010, 1, 1),
        help="Inclusive start date in YYYY-MM-DD format (default: 2010-01-01).",
    )
    parser.add_argument(
        "--end-date",
        type=parse_date,
        default=dt.date.today(),
        help="Inclusive end date in YYYY-MM-DD format (default: today).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("exports/myfitnesspal"),
        help="Directory to write export files to.",
    )
    parser.add_argument(
        "--browser",
        default="auto",
        help=(
            "Cookie source browser (default: auto). "
            "Examples: chrome, chromium, brave, edge, firefox, safari."
        ),
    )
    parser.add_argument(
        "--cookie-file",
        default=None,
        help=(
            "Optional path to a Chromium cookie DB file. Useful for custom browsers "
            "like Helium if auto cookie discovery does not work."
        ),
    )
    parser.add_argument(
        "--cookie-domain",
        default="myfitnesspal.com",
        help="Cookie domain to read (default: myfitnesspal.com).",
    )
    parser.add_argument(
        "--measurement",
        action="append",
        default=[],
        help=(
            "Measurement name to export (repeatable). "
            "If omitted, defaults to Weight/Body Fat/Neck/Waist/Hips."
        ),
    )
    parser.add_argument(
        "--sleep-seconds",
        type=float,
        default=0.0,
        help="Optional delay between day fetches to avoid aggressive scraping.",
    )
    parser.add_argument(
        "--include-empty-days",
        action="store_true",
        help="Include days with no logged data in days.jsonl (default: skip).",
    )
    parser.add_argument(
        "--skip-recipes",
        action="store_true",
        help="Skip exporting recipes and saved meals.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.start_date > args.end_date:
        print("start-date must be earlier than or equal to end-date", file=sys.stderr)
        return 2

    measurements = args.measurement or list(DEFAULT_MEASUREMENTS)

    output_dir = args.output_dir.expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        cookiejar = choose_cookiejar(args.browser, args.cookie_file, args.cookie_domain)
        client = myfitnesspal.Client(cookiejar=cookiejar) if cookiejar else myfitnesspal.Client()
    except Exception as exc:
        print(f"Failed to initialize MyFitnessPal client: {exc}", file=sys.stderr)
        return 1

    started_at = dt.datetime.now(dt.timezone.utc)
    failures: list[dict[str, str]] = []
    exported_days = 0

    with (output_dir / "days.jsonl").open("w", encoding="utf-8") as days_file:
        for date in date_range(args.start_date, args.end_date):
            try:
                day = client.get_date(date)
                payload = export_day(day)
                if args.include_empty_days or payload["has_data"]:
                    days_file.write(json.dumps(payload, ensure_ascii=True) + "\n")
                    exported_days += 1
            except Exception as exc:  # pragma: no cover - network/data resilience
                failures.append({"date": date.isoformat(), "error": str(exc)})

            if args.sleep_seconds > 0:
                time.sleep(args.sleep_seconds)

    measurements_payload: dict[str, Any] = {}
    for measurement in measurements:
        try:
            measurement_data = client.get_measurements(
                measurement,
                lower_bound=args.start_date,
                upper_bound=args.end_date,
            )
            measurements_payload[measurement] = {
                date.isoformat(): to_jsonable(value)
                for date, value in measurement_data.items()
            }
        except Exception as exc:  # pragma: no cover - unknown measurement names
            measurements_payload[measurement] = {"error": str(exc)}

    with (output_dir / "measurements.json").open("w", encoding="utf-8") as f:
        json.dump(to_jsonable(measurements_payload), f, indent=2, sort_keys=True)
        f.write("\n")

    if not args.skip_recipes:
        recipes = export_recipes(client)
        with (output_dir / "recipes.json").open("w", encoding="utf-8") as f:
            json.dump(to_jsonable(recipes), f, indent=2)
            f.write("\n")

        saved_meals = export_saved_meals(client)
        with (output_dir / "saved_meals.json").open("w", encoding="utf-8") as f:
            json.dump(to_jsonable(saved_meals), f, indent=2)
            f.write("\n")

    account_payload = {
        "effective_username": client.effective_username,
        "user_id": client.user_id,
        "user_metadata": to_jsonable(client.user_metadata),
    }
    with (output_dir / "account.json").open("w", encoding="utf-8") as f:
        json.dump(account_payload, f, indent=2)
        f.write("\n")

    summary = {
        "started_at_utc": started_at.isoformat(),
        "finished_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "range": {
            "start_date": args.start_date.isoformat(),
            "end_date": args.end_date.isoformat(),
        },
        "exported_days": exported_days,
        "failed_days": len(failures),
        "measurements": measurements,
        "output_dir": str(output_dir),
    }
    with (output_dir / "summary.json").open("w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
        f.write("\n")

    if failures:
        with (output_dir / "failures.json").open("w", encoding="utf-8") as f:
            json.dump(failures, f, indent=2)
            f.write("\n")

    print(f"Export complete. Files written to: {output_dir}")
    print(f"Days exported: {exported_days}; failed days: {len(failures)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
