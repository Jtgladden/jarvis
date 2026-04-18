import os
import json
import sqlite3
from contextlib import closing
from datetime import date, timedelta
from threading import Lock

from app.config import APP_DEFAULT_USER_ID
from app.schemas import DashboardHealthSummary, HealthDailyEntry

_db_lock = Lock()


def _db_path() -> str:
    path = os.getenv("HEALTH_DB", "data/health.db")
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(_db_path())
    connection.row_factory = sqlite3.Row
    return connection


def init_health_store() -> None:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS health_daily_records (
                user_id TEXT NOT NULL,
                entry_date TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'ios_healthkit',
                steps INTEGER NOT NULL DEFAULT 0,
                active_energy_kcal REAL,
                sleep_hours REAL,
                workouts INTEGER NOT NULL DEFAULT 0,
                resting_heart_rate REAL,
                extra_metrics_json TEXT NOT NULL DEFAULT '{}',
                synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, entry_date)
            )
            """
        )
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(health_daily_records)").fetchall()
        }
        if "extra_metrics_json" not in columns:
            connection.execute(
                "ALTER TABLE health_daily_records ADD COLUMN extra_metrics_json TEXT NOT NULL DEFAULT '{}'"
            )
        connection.commit()


def _row_to_entry(row: sqlite3.Row) -> HealthDailyEntry:
    raw_extra_metrics = row["extra_metrics_json"] if "extra_metrics_json" in row.keys() else "{}"
    try:
        extra_metrics = json.loads(raw_extra_metrics or "{}")
    except json.JSONDecodeError:
        extra_metrics = {}

    return HealthDailyEntry(
        date=row["entry_date"],
        source=row["source"],
        steps=int(row["steps"] or 0),
        active_energy_kcal=row["active_energy_kcal"],
        sleep_hours=row["sleep_hours"],
        workouts=int(row["workouts"] or 0),
        resting_heart_rate=row["resting_heart_rate"],
        extra_metrics=extra_metrics,
        synced_at=row["synced_at"],
    )


def upsert_health_daily_entry(
    entry_date: str,
    *,
    source: str,
    steps: int,
    active_energy_kcal: float | None,
    sleep_hours: float | None,
    workouts: int,
    resting_heart_rate: float | None,
    extra_metrics: dict[str, float | int | str | None] | None = None,
    user_id: str = APP_DEFAULT_USER_ID,
) -> HealthDailyEntry:
    encoded_extra_metrics = json.dumps(extra_metrics or {}, ensure_ascii=True, sort_keys=True)
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO health_daily_records (
                user_id, entry_date, source, steps, active_energy_kcal,
                sleep_hours, workouts, resting_heart_rate, extra_metrics_json, synced_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, entry_date) DO UPDATE SET
                source = excluded.source,
                steps = excluded.steps,
                active_energy_kcal = excluded.active_energy_kcal,
                sleep_hours = excluded.sleep_hours,
                workouts = excluded.workouts,
                resting_heart_rate = excluded.resting_heart_rate,
                extra_metrics_json = excluded.extra_metrics_json,
                synced_at = CURRENT_TIMESTAMP
            """,
            (
                user_id,
                entry_date,
                source,
                steps,
                active_energy_kcal,
                sleep_hours,
                workouts,
                resting_heart_rate,
                encoded_extra_metrics,
            ),
        )
        row = connection.execute(
            """
            SELECT entry_date, source, steps, active_energy_kcal, sleep_hours,
                   workouts, resting_heart_rate, extra_metrics_json, synced_at
            FROM health_daily_records
            WHERE user_id = ? AND entry_date = ?
            """,
            (user_id, entry_date),
        ).fetchone()
        connection.commit()
    return _row_to_entry(row)


def list_health_daily_entries(
    *,
    days: int = 7,
    user_id: str = APP_DEFAULT_USER_ID,
) -> list[HealthDailyEntry]:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT entry_date, source, steps, active_energy_kcal, sleep_hours,
                   workouts, resting_heart_rate, extra_metrics_json, synced_at
            FROM health_daily_records
            WHERE user_id = ?
            ORDER BY entry_date DESC
            LIMIT ?
            """,
            (user_id, days),
        ).fetchall()
    return [_row_to_entry(row) for row in rows]


def get_health_dashboard_summary(
    *,
    user_id: str = APP_DEFAULT_USER_ID,
    today: date | None = None,
) -> DashboardHealthSummary | None:
    current_day = today or date.today()
    recent_entries = list_health_daily_entries(days=7, user_id=user_id)
    if not recent_entries:
        return None

    latest_entry = recent_entries[0]
    ascending_entries = list(reversed(recent_entries))
    avg_steps = round(sum(entry.steps for entry in recent_entries) / len(recent_entries))

    sleep_values = [entry.sleep_hours for entry in recent_entries if entry.sleep_hours is not None]
    avg_sleep = round(sum(sleep_values) / len(sleep_values), 1) if sleep_values else None

    today_entry = next((entry for entry in recent_entries if entry.date == current_day.isoformat()), None)

    streak_days = 0
    expected_day = current_day
    for entry in recent_entries:
        if entry.steps <= 0 or entry.date != expected_day.isoformat():
            break
        streak_days += 1
        expected_day -= timedelta(days=1)

    return DashboardHealthSummary(
        latest_date=latest_entry.date,
        last_synced_at=latest_entry.synced_at,
        today_entry=today_entry,
        recent_entries=ascending_entries,
        seven_day_avg_steps=avg_steps,
        seven_day_avg_sleep_hours=avg_sleep,
        streak_days=streak_days,
    )
