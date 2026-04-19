import json
import os
import sqlite3
from contextlib import closing
from threading import Lock

from app.config import APP_DEFAULT_USER_ID
from app.schemas import MovementDailyEntry, MovementRoutePoint, MovementVisit

_db_lock = Lock()


def _db_path() -> str:
    path = os.getenv("MOVEMENT_DB", "data/movement.db")
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(_db_path())
    connection.row_factory = sqlite3.Row
    return connection


def init_movement_store() -> None:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS movement_daily_records (
                user_id TEXT NOT NULL,
                entry_date TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'ios_core_location',
                total_distance_km REAL NOT NULL DEFAULT 0,
                time_away_minutes INTEGER,
                visited_places_count INTEGER NOT NULL DEFAULT 0,
                movement_story TEXT NOT NULL DEFAULT '',
                home_label TEXT,
                commute_start TEXT,
                commute_end TEXT,
                visits_json TEXT NOT NULL DEFAULT '[]',
                route_points_json TEXT NOT NULL DEFAULT '[]',
                place_labels_json TEXT NOT NULL DEFAULT '[]',
                synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, entry_date)
            )
            """
        )
        connection.commit()


def _decode_json_list(value: str, model):
    try:
        payload = json.loads(value or "[]")
    except json.JSONDecodeError:
        payload = []
    return [model.model_validate(item) for item in payload]


def _row_to_entry(row: sqlite3.Row) -> MovementDailyEntry:
    return MovementDailyEntry(
        date=row["entry_date"],
        source=row["source"],
        total_distance_km=float(row["total_distance_km"] or 0),
        time_away_minutes=row["time_away_minutes"],
        visited_places_count=int(row["visited_places_count"] or 0),
        movement_story=row["movement_story"] or "",
        home_label=row["home_label"],
        commute_start=row["commute_start"],
        commute_end=row["commute_end"],
        visits=_decode_json_list(row["visits_json"], MovementVisit),
        route_points=_decode_json_list(row["route_points_json"], MovementRoutePoint),
        place_labels=json.loads(row["place_labels_json"] or "[]"),
        synced_at=row["synced_at"],
    )


def upsert_movement_daily_entry(
    entry: MovementDailyEntry,
    *,
    user_id: str = APP_DEFAULT_USER_ID,
) -> MovementDailyEntry:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO movement_daily_records (
                user_id, entry_date, source, total_distance_km, time_away_minutes,
                visited_places_count, movement_story, home_label, commute_start,
                commute_end, visits_json, route_points_json, place_labels_json, synced_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, entry_date) DO UPDATE SET
                source = excluded.source,
                total_distance_km = excluded.total_distance_km,
                time_away_minutes = excluded.time_away_minutes,
                visited_places_count = excluded.visited_places_count,
                movement_story = excluded.movement_story,
                home_label = excluded.home_label,
                commute_start = excluded.commute_start,
                commute_end = excluded.commute_end,
                visits_json = excluded.visits_json,
                route_points_json = excluded.route_points_json,
                place_labels_json = excluded.place_labels_json,
                synced_at = CURRENT_TIMESTAMP
            """,
            (
                user_id,
                entry.date,
                entry.source,
                entry.total_distance_km,
                entry.time_away_minutes,
                entry.visited_places_count,
                entry.movement_story,
                entry.home_label,
                entry.commute_start,
                entry.commute_end,
                json.dumps([item.model_dump() for item in entry.visits], ensure_ascii=True),
                json.dumps([item.model_dump() for item in entry.route_points], ensure_ascii=True),
                json.dumps(entry.place_labels, ensure_ascii=True),
            ),
        )
        row = connection.execute(
            """
            SELECT entry_date, source, total_distance_km, time_away_minutes, visited_places_count,
                   movement_story, home_label, commute_start, commute_end, visits_json,
                   route_points_json, place_labels_json, synced_at
            FROM movement_daily_records
            WHERE user_id = ? AND entry_date = ?
            """,
            (user_id, entry.date),
        ).fetchone()
        connection.commit()
    return _row_to_entry(row)


def list_movement_daily_entries(
    *,
    days: int = 14,
    user_id: str = APP_DEFAULT_USER_ID,
) -> list[MovementDailyEntry]:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT entry_date, source, total_distance_km, time_away_minutes, visited_places_count,
                   movement_story, home_label, commute_start, commute_end, visits_json,
                   route_points_json, place_labels_json, synced_at
            FROM movement_daily_records
            WHERE user_id = ?
            ORDER BY entry_date DESC
            LIMIT ?
            """,
            (user_id, days),
        ).fetchall()
    return [_row_to_entry(row) for row in rows]
