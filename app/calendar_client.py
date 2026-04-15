from datetime import datetime, timedelta
import os.path
from typing import Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from app.config import DEFAULT_TIMEZONE, GMAIL_CREDENTIALS_FILE, GMAIL_TOKEN_FILE, GOOGLE_SCOPES
from app.schemas import CalendarAgendaItem, CalendarAgendaResponse, CalendarEventCreateResponse, CalendarEventPreview, EmailClassification, EmailSummary, PlanningCalendarBulkCreateResponse, PlanningCalendarCreateResponse, PlanningItem


def _has_required_scopes(creds: Optional[Credentials]) -> bool:
    granted_scopes = set(creds.scopes or []) if creds else set()
    return set(GOOGLE_SCOPES).issubset(granted_scopes)


def get_calendar_service():
    creds: Optional[Credentials] = None

    if os.path.exists(GMAIL_TOKEN_FILE):
        try:
            creds = Credentials.from_authorized_user_file(GMAIL_TOKEN_FILE, GOOGLE_SCOPES)
        except Exception as exc:
            raise RuntimeError(
                f"Failed to read Google token file at {GMAIL_TOKEN_FILE}: {exc}"
            ) from exc

    if creds and not _has_required_scopes(creds):
        creds = None

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token and _has_required_scopes(creds):
            try:
                creds.refresh(Request())
            except Exception as exc:
                raise RuntimeError(f"Failed to refresh Google credentials: {exc}") from exc
        else:
            raise RuntimeError(
                "Google Calendar access has not been authorized for this app yet. "
                "Delete token.json and restart the backend locally to complete Google re-authorization "
                f"with these scopes: {', '.join(GOOGLE_SCOPES)}"
            )

        with open(GMAIL_TOKEN_FILE, "w") as token:
            token.write(creds.to_json())

    try:
        return build("calendar", "v3", credentials=creds)
    except HttpError as exc:
        raise RuntimeError(f"Failed to initialize Calendar API client: {exc}") from exc
    except Exception as exc:
        raise RuntimeError(f"Failed to initialize Calendar service: {exc}") from exc


def build_calendar_preview(email: EmailSummary, classification: EmailClassification) -> CalendarEventPreview:
    return CalendarEventPreview(
        message_id=email.id,
        thread_id=email.thread_id,
        relevant=classification.calendar_relevant and bool(classification.calendar_title),
        title=classification.calendar_title or email.subject,
        start=classification.calendar_start,
        end=classification.calendar_end,
        is_all_day=classification.calendar_is_all_day,
        location=classification.calendar_location,
        notes=classification.calendar_notes or classification.short_summary or classification.why_it_matters,
        reason=classification.reason,
    )


def create_calendar_event_from_preview(preview: CalendarEventPreview) -> CalendarEventCreateResponse:
    if not preview.relevant or not preview.title or not preview.start:
        return CalendarEventCreateResponse(created=False, preview=preview)

    event: dict = {
        "summary": preview.title,
        "location": preview.location,
        "description": preview.notes,
    }

    if preview.is_all_day:
        event["start"] = {"date": preview.start}
        end_date = preview.end or preview.start
        try:
            parsed = datetime.fromisoformat(end_date)
            exclusive_end = (parsed + timedelta(days=1)).date().isoformat()
        except ValueError:
            exclusive_end = end_date
        event["end"] = {"date": exclusive_end}
    else:
        event["start"] = {"dateTime": preview.start, "timeZone": DEFAULT_TIMEZONE}
        event["end"] = {
            "dateTime": preview.end or preview.start,
            "timeZone": DEFAULT_TIMEZONE,
        }

    created = (
        get_calendar_service()
        .events()
        .insert(calendarId="primary", body=event)
        .execute()
    )
    return CalendarEventCreateResponse(
        created=True,
        event_id=created.get("id"),
        html_link=created.get("htmlLink"),
        preview=preview,
    )


def create_calendar_event_from_plan_item(item: PlanningItem) -> PlanningCalendarCreateResponse:
    if not item.title or not item.start or not item.end:
        return PlanningCalendarCreateResponse(created=False, item=item)

    event = {
        "summary": item.title,
        "description": item.rationale,
        "start": {"dateTime": item.start, "timeZone": DEFAULT_TIMEZONE},
        "end": {"dateTime": item.end, "timeZone": DEFAULT_TIMEZONE},
    }

    created = (
        get_calendar_service()
        .events()
        .insert(calendarId="primary", body=event)
        .execute()
    )

    return PlanningCalendarCreateResponse(
        created=True,
        event_id=created.get("id"),
        html_link=created.get("htmlLink"),
        item=item,
    )


def create_calendar_events_from_plan_items(items: list[PlanningItem]) -> PlanningCalendarBulkCreateResponse:
    results = [create_calendar_event_from_plan_item(item) for item in items]
    return PlanningCalendarBulkCreateResponse(
        created_count=sum(1 for result in results if result.created),
        items=results,
    )


def list_upcoming_events(days: int = 7, max_results: int = 25) -> CalendarAgendaResponse:
    now = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    time_max = (datetime.utcnow() + timedelta(days=days)).replace(microsecond=0).isoformat() + "Z"
    response = (
        get_calendar_service()
        .events()
        .list(
            calendarId="primary",
            timeMin=now,
            timeMax=time_max,
            singleEvents=True,
            orderBy="startTime",
            maxResults=max_results,
        )
        .execute()
    )

    items = []
    for item in response.get("items", []):
        start = item.get("start", {})
        end = item.get("end", {})
        is_all_day = "date" in start
        items.append(
            CalendarAgendaItem(
                event_id=item.get("id", ""),
                title=item.get("summary") or "(Untitled event)",
                start=start.get("dateTime") or start.get("date") or "",
                end=end.get("dateTime") or end.get("date"),
                is_all_day=is_all_day,
                location=item.get("location"),
                description=item.get("description"),
                html_link=item.get("htmlLink"),
            )
        )

    return CalendarAgendaResponse(
        calendar_id="primary",
        time_min=now,
        time_max=time_max,
        items=items,
    )
