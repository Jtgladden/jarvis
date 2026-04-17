import json
import logging
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from threading import Lock
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from openai import OpenAI

from app.calendar_client import list_upcoming_events
from app.classification_cache import get_cached_classification, save_classification
from app.classifier import IMPORTANT_LABEL, classify_email, classify_emails_batch
from app.config import DASHBOARD_CACHE_TTL_SECONDS, DEFAULT_TIMEZONE, OPENAI_API_KEY, OPENAI_PLANNING_MAX_TOKENS, OPENAI_PLANNING_MODEL, OPENAI_PLANNING_TIMEOUT_SECONDS
from app.gmail_client import get_mailbox_emails
from app.schemas import DashboardMailItem, DashboardNewsItem, DashboardResponse, DashboardTaskItem, EmailSummary
from app.user_context import get_default_user_context

logger = logging.getLogger(__name__)
client = OpenAI(api_key=OPENAI_API_KEY)
NEWS_RSS_URL = "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"
MAX_DASHBOARD_EMAILS = 6
MAX_DASHBOARD_NEWS_ITEMS = 6
MAX_DASHBOARD_TASKS = 8
LOCAL_TIMEZONE = ZoneInfo(DEFAULT_TIMEZONE)
_dashboard_cache_lock = Lock()
_dashboard_cache: dict[str, DashboardResponse] = {}
_dashboard_cache_expires_at: dict[str, datetime] = {}


def invalidate_dashboard_cache(user_id: str | None = None) -> None:
    with _dashboard_cache_lock:
        if user_id is None:
            _dashboard_cache.clear()
            _dashboard_cache_expires_at.clear()
            return

        _dashboard_cache.pop(user_id, None)
        _dashboard_cache_expires_at.pop(user_id, None)


def _parse_dashboard_date(value: str | None) -> datetime | date | None:
    if not value:
        return None

    if "T" not in value:
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(LOCAL_TIMEZONE)
    except ValueError:
        return None


def _is_same_local_day(value: str | None, target_day: date) -> bool:
    parsed = _parse_dashboard_date(value)
    if parsed is None:
        return False
    if isinstance(parsed, date) and not isinstance(parsed, datetime):
        return parsed == target_day
    return parsed.date() == target_day


def _fetch_news_items(limit: int = MAX_DASHBOARD_NEWS_ITEMS) -> list[DashboardNewsItem]:
    request = Request(
        NEWS_RSS_URL,
        headers={
            "User-Agent": "JarvisDashboard/1.0",
            "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
    )

    with urlopen(request, timeout=8) as response:
        payload = response.read()

    root = ET.fromstring(payload)
    items: list[DashboardNewsItem] = []

    for item in root.findall(".//item")[:limit]:
        title = (item.findtext("title") or "").strip()
        if not title:
            continue

        source = None
        source_node = item.find("{http://search.yahoo.com/mrss/}source")
        if source_node is not None and source_node.text:
            source = source_node.text.strip()

        published_raw = (item.findtext("pubDate") or "").strip() or None
        published_at = None
        if published_raw:
            try:
                published_at = parsedate_to_datetime(published_raw).isoformat()
            except Exception:
                published_at = published_raw

        items.append(
            DashboardNewsItem(
                title=title,
                source=source,
                link=(item.findtext("link") or "").strip() or None,
                published_at=published_at,
            )
        )

    return items


def _recent_important_mail(limit: int = MAX_DASHBOARD_EMAILS) -> list[tuple[EmailSummary, Any]]:
    user_id = get_default_user_context().user_id
    emails = get_mailbox_emails(mailbox=IMPORTANT_LABEL, limit=limit)
    matched_items: list[tuple[EmailSummary, Any]] = []
    uncached_emails: list[EmailSummary] = []

    for email in emails:
        cached = get_cached_classification(email, user_id=user_id)
        if cached is not None:
            matched_items.append((email, cached.classification))
            continue

        uncached_emails.append(email)

    if uncached_emails:
        for email, classification in zip(uncached_emails, classify_emails_batch(uncached_emails)):
            save_classification(email, classification, user_id=user_id)
            matched_items.append((email, classification))

    return matched_items[:limit]


def _build_mail_items(limit: int = MAX_DASHBOARD_EMAILS) -> list[DashboardMailItem]:
    items: list[DashboardMailItem] = []
    for email, classification in _recent_important_mail(limit):
        items.append(
            DashboardMailItem(
                message_id=email.id,
                subject=email.subject,
                sender=email.sender,
                summary=classification.short_summary or email.snippet,
                why_it_matters=classification.why_it_matters,
                urgency=classification.urgency,
                needs_reply=classification.needs_reply,
                deadline_hint=classification.deadline_hint,
                action_items=classification.action_items[:3],
            )
        )
    return items


def _task_priority_from_text(text: str) -> str:
    lowered = text.lower()
    if any(keyword in lowered for keyword in ["today", "urgent", "asap", "deadline", "due", "reply"]):
        return "high"
    if any(keyword in lowered for keyword in ["soon", "this week", "follow up", "prepare"]):
        return "medium"
    return "low"


def _build_tasks(calendar_items, mail_items: list[DashboardMailItem]) -> list[DashboardTaskItem]:
    tasks: list[DashboardTaskItem] = []
    seen: set[str] = set()

    for event in calendar_items[:4]:
        task_id = f"calendar:{event.event_id}"
        title = f"Attend {event.title}"
        tasks.append(
            DashboardTaskItem(
                id=task_id,
                title=title,
                detail=format_event_task_detail(event.location, event.start),
                due_text=event.start,
                source="calendar",
                priority="high" if not event.is_all_day else "medium",
                related_event_id=event.event_id,
            )
        )
        seen.add(title.lower())

    for mail in mail_items:
        if mail.needs_reply:
            title = f"Reply to {mail.sender}"
            if title.lower() not in seen:
                tasks.append(
                    DashboardTaskItem(
                        id=f"reply:{mail.message_id}",
                        title=title,
                        detail=mail.subject,
                        due_text=mail.deadline_hint,
                        source="mail",
                        priority="high" if mail.urgency == "high" else "medium",
                        related_message_id=mail.message_id,
                    )
                )
                seen.add(title.lower())

        for action_item in mail.action_items:
            cleaned = " ".join(action_item.split()).strip()
            if not cleaned or cleaned.lower() in seen:
                continue
            tasks.append(
                DashboardTaskItem(
                    id=f"mail:{mail.message_id}:{len(seen)}",
                    title=cleaned,
                    detail=mail.subject,
                    due_text=mail.deadline_hint,
                    source="mail",
                    priority=_task_priority_from_text(f"{cleaned} {mail.deadline_hint or ''} {mail.urgency}"),
                    related_message_id=mail.message_id,
                )
            )
            seen.add(cleaned.lower())

    return tasks[:MAX_DASHBOARD_TASKS]


def format_event_task_detail(location: str | None, start: str) -> str:
    return location or "Upcoming calendar event"


def _fallback_dashboard_summary(
    date_label: str,
    calendar_items,
    mail_items: list[DashboardMailItem],
    news_items: list[DashboardNewsItem],
    tasks: list[DashboardTaskItem],
) -> tuple[str, str, str, str]:
    next_event = calendar_items[0].title if calendar_items else "no major calendar events yet"
    top_mail = mail_items[0].subject if mail_items else "no urgent important email"
    top_news = news_items[0].title if news_items else "no news headlines available"

    overview = (
        f"{date_label} centers on {next_event}, with {len(mail_items)} important emails and "
        f"{len(tasks)} tasks surfaced for review."
    )
    mail_summary = f"Top mail focus: {top_mail}."
    news_summary = f"Top headline: {top_news}."
    tasks_summary = (
        f"Your task list combines calendar commitments and email follow-ups, with {len(tasks)} "
        "items ready to work through."
    )
    return overview, mail_summary, news_summary, tasks_summary


def _ai_dashboard_summary(
    date_label: str,
    calendar_items,
    mail_items: list[DashboardMailItem],
    news_items: list[DashboardNewsItem],
    tasks: list[DashboardTaskItem],
) -> tuple[str, str, str, str]:
    if not OPENAI_API_KEY:
        return _fallback_dashboard_summary(date_label, calendar_items, mail_items, news_items, tasks)

    system_prompt = """
You are a concise personal daily dashboard assistant.
Return one valid JSON object with no extra text.
Use exactly these fields:
- overview: 2-4 sentences that summarize the day at a glance
- mail_summary: 1-3 sentences summarizing what matters from email
- news_summary: 1-3 sentences summarizing the news items
- tasks_summary: 1-3 sentences summarizing the task list and what to prioritize
Keep it practical, specific, and calm. Do not invent facts outside the provided context.
""".strip()

    user_prompt = json.dumps(
        {
            "date_label": date_label,
            "timezone": DEFAULT_TIMEZONE,
            "calendar_items": [item.model_dump() for item in calendar_items[:6]],
            "important_emails": [item.model_dump() for item in mail_items[:6]],
            "news_items": [item.model_dump() for item in news_items[:6]],
            "tasks": [item.model_dump() for item in tasks[:8]],
        },
        ensure_ascii=True,
    )

    try:
        response = client.with_options(timeout=OPENAI_PLANNING_TIMEOUT_SECONDS).chat.completions.create(
            model=OPENAI_PLANNING_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
            max_tokens=min(OPENAI_PLANNING_MAX_TOKENS, 900),
            response_format={"type": "json_object"},
        )
        parsed = json.loads(response.choices[0].message.content or "{}")
        return (
            str(parsed.get("overview") or "").strip(),
            str(parsed.get("mail_summary") or "").strip(),
            str(parsed.get("news_summary") or "").strip(),
            str(parsed.get("tasks_summary") or "").strip(),
        )
    except Exception as exc:
        logger.warning("Dashboard AI summary failed: %s", exc)
        return _fallback_dashboard_summary(date_label, calendar_items, mail_items, news_items, tasks)


def generate_dashboard() -> DashboardResponse:
    user_id = get_default_user_context().user_id
    now_local = datetime.now(LOCAL_TIMEZONE)

    with _dashboard_cache_lock:
        if (
            user_id in _dashboard_cache and
            user_id in _dashboard_cache_expires_at and
            now_local < _dashboard_cache_expires_at[user_id]
        ):
            return _dashboard_cache[user_id]

    today_local = now_local.date()
    generated_at = now_local.isoformat()
    date_label = now_local.strftime("%A, %B %d")

    try:
        agenda = list_upcoming_events(days=2, max_results=12)
        calendar_items = [
            item for item in agenda.items if _is_same_local_day(item.start, today_local)
        ]
    except Exception as exc:
        logger.warning("Dashboard calendar fetch failed: %s", exc)
        calendar_items = []

    mail_items = _build_mail_items()

    try:
        news_items = _fetch_news_items()
    except Exception as exc:
        logger.warning("Dashboard news fetch failed: %s", exc)
        news_items = []

    tasks = _build_tasks(calendar_items, mail_items)
    overview, mail_summary, news_summary, tasks_summary = _ai_dashboard_summary(
        date_label, calendar_items, mail_items, news_items, tasks
    )

    response = DashboardResponse(
        generated_at=generated_at,
        date_label=date_label,
        overview=overview,
        mail_summary=mail_summary,
        news_summary=news_summary,
        tasks_summary=tasks_summary,
        calendar_items=calendar_items,
        important_emails=mail_items,
        news_items=news_items,
        tasks=tasks,
    )

    with _dashboard_cache_lock:
        _dashboard_cache[user_id] = response
        _dashboard_cache_expires_at[user_id] = now_local.replace(microsecond=0) + timedelta(seconds=DASHBOARD_CACHE_TTL_SECONDS)

    return response
