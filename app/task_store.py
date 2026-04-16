import os
import sqlite3
from contextlib import closing
from threading import Lock

from app.config import APP_DEFAULT_USER_ID

_db_lock = Lock()


def _db_path() -> str:
    path = os.getenv("TASKS_DB", "data/tasks.db")
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(_db_path())
    connection.row_factory = sqlite3.Row
    return connection


def init_task_store() -> None:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS task_records (
                user_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                title TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                due_text TEXT,
                source TEXT NOT NULL,
                priority TEXT NOT NULL DEFAULT 'medium',
                related_message_id TEXT,
                related_event_id TEXT,
                completed INTEGER NOT NULL DEFAULT 0,
                custom INTEGER NOT NULL DEFAULT 0,
                deleted INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, task_id)
            )
            """
        )
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(task_records)").fetchall()
        }
        if "deleted" not in columns:
            connection.execute(
                "ALTER TABLE task_records ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0"
            )
        connection.commit()


def list_task_records(user_id: str = APP_DEFAULT_USER_ID) -> list[sqlite3.Row]:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT task_id, title, detail, due_text, source, priority, related_message_id,
                   related_event_id, completed, custom, deleted, updated_at
            FROM task_records
            WHERE user_id = ?
            ORDER BY updated_at DESC
            """,
            (user_id,),
        ).fetchall()
    return list(rows)


def save_task_record(
    task_id: str,
    title: str,
    detail: str,
    due_text: str | None,
    source: str,
    priority: str,
    related_message_id: str | None,
    related_event_id: str | None,
    completed: bool,
    custom: bool,
    deleted: bool = False,
    user_id: str = APP_DEFAULT_USER_ID,
) -> sqlite3.Row:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO task_records (
                user_id, task_id, title, detail, due_text, source, priority,
                related_message_id, related_event_id, completed, custom, deleted, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, task_id) DO UPDATE SET
                title = excluded.title,
                detail = excluded.detail,
                due_text = excluded.due_text,
                source = excluded.source,
                priority = excluded.priority,
                related_message_id = excluded.related_message_id,
                related_event_id = excluded.related_event_id,
                completed = excluded.completed,
                custom = excluded.custom,
                deleted = excluded.deleted,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                user_id,
                task_id,
                title,
                detail,
                due_text,
                source,
                priority,
                related_message_id,
                related_event_id,
                1 if completed else 0,
                1 if custom else 0,
                1 if deleted else 0,
            ),
        )
        row = connection.execute(
            """
            SELECT task_id, title, detail, due_text, source, priority, related_message_id,
                   related_event_id, completed, custom, deleted, updated_at
            FROM task_records
            WHERE user_id = ? AND task_id = ?
            """,
            (user_id, task_id),
        ).fetchone()
        connection.commit()
    return row
