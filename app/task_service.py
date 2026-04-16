from datetime import datetime
from uuid import uuid4

from app.calendar_client import list_upcoming_events
from app.dashboard import _build_mail_items, _build_tasks
from app.schemas import DashboardTaskItem, TaskCreateRequest, TaskListResponse, TaskUpdateRequest
from app.task_store import list_task_records, save_task_record
from app.user_context import get_default_user_context


def _task_from_record(row) -> DashboardTaskItem:
    return DashboardTaskItem(
        id=row["task_id"],
        title=row["title"],
        detail=row["detail"] or None,
        due_text=row["due_text"],
        source=row["source"],
        priority=row["priority"],
        related_message_id=row["related_message_id"],
        related_event_id=row["related_event_id"],
        completed=bool(row["completed"]),
        custom=bool(row["custom"]),
        updated_at=row["updated_at"],
    )


def _load_generated_tasks() -> list[DashboardTaskItem]:
    agenda = list_upcoming_events(days=14, max_results=40)
    mail_items = _build_mail_items()
    return [task for task in _build_tasks(agenda.items, mail_items) if task.source != "calendar"]


def _merge_tasks(base_tasks: list[DashboardTaskItem], stored_tasks: list[DashboardTaskItem]) -> list[DashboardTaskItem]:
    stored_by_id = {task.id: task for task in stored_tasks}
    merged: list[DashboardTaskItem] = []

    for task in base_tasks:
        override = stored_by_id.get(task.id)
        if override is None:
            merged.append(task)
            continue
        merged.append(
            task.model_copy(
                update={
                    "title": override.title,
                    "detail": override.detail,
                    "due_text": override.due_text,
                    "priority": override.priority,
                    "completed": override.completed,
                    "updated_at": override.updated_at,
                }
            )
        )

    merged.extend(task for task in stored_tasks if task.custom)
    return merged


def list_tasks(include_completed: bool = True) -> TaskListResponse:
    user_id = get_default_user_context().user_id
    base_tasks = _load_generated_tasks()
    stored_rows = list_task_records(user_id=user_id)
    deleted_task_ids = {row["task_id"] for row in stored_rows if bool(row["deleted"])}
    stored_tasks = [_task_from_record(row) for row in stored_rows if not bool(row["deleted"])]
    base_tasks = [task for task in base_tasks if task.id not in deleted_task_ids]
    merged = _merge_tasks(base_tasks, stored_tasks)
    if not include_completed:
        merged = [task for task in merged if not task.completed]

    merged.sort(
        key=lambda task: (
            task.completed,
            {"high": 0, "medium": 1, "low": 2}.get(task.priority, 1),
            task.due_text or "",
            task.title.lower(),
        )
    )
    return TaskListResponse(generated_at=datetime.utcnow().isoformat() + "Z", tasks=merged)


def create_task(payload: TaskCreateRequest) -> DashboardTaskItem:
    user_id = get_default_user_context().user_id
    source = payload.source
    related_event_id = payload.related_event_id
    related_message_id = payload.related_message_id
    task_id = (
        f"calendar:{related_event_id}"
        if source == "calendar" and related_event_id
        else f"custom:{uuid4().hex}"
    )
    row = save_task_record(
        task_id=task_id,
        title=payload.title.strip() or "Untitled task",
        detail=payload.detail.strip(),
        due_text=payload.due_text,
        source=source,
        priority=payload.priority,
        related_message_id=related_message_id,
        related_event_id=related_event_id,
        completed=False,
        custom=True,
        deleted=False,
        user_id=user_id,
    )
    return _task_from_record(row)


def update_task(task_id: str, payload: TaskUpdateRequest) -> DashboardTaskItem:
    user_id = get_default_user_context().user_id
    current = next((task for task in list_tasks(include_completed=True).tasks if task.id == task_id), None)
    if current is None:
        raise RuntimeError("Task not found.")

    row = save_task_record(
        task_id=current.id,
        title=(payload.title if payload.title is not None else current.title).strip() or current.title,
        detail=(payload.detail if payload.detail is not None else (current.detail or "")).strip(),
        due_text=payload.due_text if payload.due_text is not None else current.due_text,
        source=current.source,
        priority=payload.priority if payload.priority is not None else current.priority,
        related_message_id=current.related_message_id,
        related_event_id=current.related_event_id,
        completed=payload.completed if payload.completed is not None else current.completed,
        custom=current.custom,
        deleted=False,
        user_id=user_id,
    )
    return _task_from_record(row)


def delete_task(task_id: str) -> None:
    user_id = get_default_user_context().user_id
    current = next((task for task in list_tasks(include_completed=True).tasks if task.id == task_id), None)
    if current is None:
        raise RuntimeError("Task not found.")

    save_task_record(
        task_id=current.id,
        title=current.title,
        detail=current.detail or "",
        due_text=current.due_text,
        source=current.source,
        priority=current.priority,
        related_message_id=current.related_message_id,
        related_event_id=current.related_event_id,
        completed=current.completed,
        custom=current.custom,
        deleted=True,
        user_id=user_id,
    )
