import json
import logging
import xml.etree.ElementTree as ET
from datetime import date, datetime, time, timedelta
from email.utils import parsedate_to_datetime
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo
from typing import Any

from openai import OpenAI

from app.calendar_client import list_events_between
from app.config import DEFAULT_TIMEZONE, OPENAI_API_KEY, OPENAI_PLANNING_MAX_TOKENS, OPENAI_PLANNING_MODEL, OPENAI_PLANNING_TIMEOUT_SECONDS
from app.journal_store import list_journal_entries, upsert_journal_entry, upsert_journal_news
from app.schemas import CalendarAgendaItem, JournalDayEntry, JournalNewsArticle, JournalResponse
from app.user_context import get_default_user_context

logger = logging.getLogger(__name__)
client = OpenAI(api_key=OPENAI_API_KEY)
LOCAL_TIMEZONE = ZoneInfo(DEFAULT_TIMEZONE)
NEWS_FEEDS = [
    ("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("New York Times", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"),
    ("Wall Street Journal", "https://feeds.a.dj.com/rss/RSSWorldNews.xml"),
]


def _fetch_recent_news() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for source_name, rss_url in NEWS_FEEDS:
        items.extend(_fetch_feed_items(source_name, rss_url))
    items.sort(key=lambda item: item["published_at"], reverse=True)
    return items


def _fetch_feed_items(source_name: str, rss_url: str) -> list[dict[str, Any]]:
    request = Request(
        rss_url,
        headers={
            "User-Agent": "JarvisJournal/1.0",
            "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
    )

    with urlopen(request, timeout=8) as response:
        payload = response.read()

    root = ET.fromstring(payload)
    items: list[dict[str, Any]] = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        if not title:
            continue

        published_raw = (item.findtext("pubDate") or "").strip()
        if not published_raw:
            continue

        try:
            published = parsedate_to_datetime(published_raw).astimezone(LOCAL_TIMEZONE)
        except Exception:
            continue

        items.append(
            {
                "title": title,
                "source": source_name,
                "link": (item.findtext("link") or "").strip() or None,
                "published_at": published,
                "day_key": published.date().isoformat(),
            }
        )

    return items


def _format_date_label(day: date) -> str:
    return day.strftime("%A, %B %d")


def _calendar_payload_for_day(item) -> dict[str, str | bool | None]:
    return {
        "event_id": item.event_id,
        "title": item.title,
        "start": item.start,
        "end": item.end,
        "is_all_day": item.is_all_day,
        "location": item.location,
        "description": item.description,
        "html_link": item.html_link,
        "removed": getattr(item, "removed", False),
    }


def _apply_calendar_overrides(
    source_items: list[CalendarAgendaItem],
    saved_payload: str | None,
) -> list[CalendarAgendaItem]:
    if not saved_payload:
        return source_items

    try:
        parsed = json.loads(saved_payload)
    except Exception:
        return source_items

    saved_items: list[CalendarAgendaItem] = []
    for payload in parsed or []:
        try:
            saved_items.append(CalendarAgendaItem.model_validate(payload))
        except Exception:
            continue

    if not saved_items:
        return source_items

    saved_by_event_id = {
        item.event_id: item
        for item in saved_items
        if item.event_id and not item.event_id.startswith("custom-")
    }
    merged: list[CalendarAgendaItem] = []
    seen_event_ids: set[str] = set()

    for item in source_items:
        if item.event_id and item.event_id in saved_by_event_id:
            merged.append(saved_by_event_id[item.event_id])
            seen_event_ids.add(item.event_id)
            continue
        merged.append(item)
        if item.event_id:
            seen_event_ids.add(item.event_id)

    for item in saved_items:
        if item.event_id and item.event_id.startswith("custom-"):
            merged.append(item)
            continue
        if item.event_id and item.event_id not in seen_event_ids:
            merged.append(item)

    return merged


def _ai_calendar_summaries(entries: list[dict]) -> dict[str, dict[str, str]]:
    if not entries:
        return {}

    if not OPENAI_API_KEY:
        return {
            entry["date"]: {
                "calendar_summary": _fallback_calendar_summary(entry["calendar_items"]),
            }
            for entry in entries
        }

    system_prompt = """
You are writing brief journal prep notes.
Return one valid JSON object with this exact shape:
{
  "items": [
    {
      "date": "YYYY-MM-DD",
      "calendar_summary": "1-2 sentence summary of what the person did according to calendar items that day"
    }
  ]
}
Be concise, specific, and grounded only in the provided titles/headlines.
Do not invent details beyond what can reasonably be inferred from the event names.
""".strip()

    try:
      response = client.with_options(timeout=OPENAI_PLANNING_TIMEOUT_SECONDS).chat.completions.create(
          model=OPENAI_PLANNING_MODEL,
          messages=[
              {"role": "system", "content": system_prompt},
              {"role": "user", "content": json.dumps({"days": entries}, ensure_ascii=True)},
          ],
          temperature=0.2,
          max_tokens=min(OPENAI_PLANNING_MAX_TOKENS, 1200),
          response_format={"type": "json_object"},
      )
      parsed = json.loads(response.choices[0].message.content or "{}")
    except Exception as exc:
      logger.warning("Journal AI summary failed: %s", exc)
      return {
          entry["date"]: {
              "calendar_summary": _fallback_calendar_summary(entry["calendar_items"]),
          }
          for entry in entries
      }

    summaries: dict[str, dict[str, str]] = {}
    for item in parsed.get("items") or []:
      day_key = str((item or {}).get("date") or "").strip()
      if not day_key:
        continue
      summaries[day_key] = {
          "calendar_summary": str((item or {}).get("calendar_summary") or "").strip(),
      }

    for entry in entries:
      summaries.setdefault(
          entry["date"],
          {
              "calendar_summary": _fallback_calendar_summary(entry["calendar_items"]),
          },
      )

    return summaries


def _fallback_persisted_world_news(articles: list[dict[str, Any]]) -> dict[str, str | None]:
    usable_articles = [
        item
        for item in articles
        if str(item.get("title") or "").strip()
    ]
    if not usable_articles:
        return {
            "world_event_title": None,
            "world_event_summary": "No world headline was captured for this day.",
            "world_event_source": None,
        }

    top_titles = [str(item["title"]).strip() for item in usable_articles[:3]]
    unique_sources: list[str] = []
    for item in usable_articles:
        source_name = str(item.get("source") or "").strip()
        if source_name and source_name not in unique_sources:
            unique_sources.append(source_name)

    return {
        "world_event_title": top_titles[0],
        "world_event_summary": f"Major coverage centered on {', '.join(top_titles[:2])}.",
        "world_event_source": ", ".join(unique_sources[:3]) or None,
    }


def _serialize_news_articles(news_items: list[dict[str, Any]]) -> str:
    payload = [
        {
            "title": str(item.get("title") or "").strip(),
            "source": str(item.get("source") or "").strip() or None,
            "link": str(item.get("link") or "").strip() or None,
            "published_at": item.get("published_at").isoformat()
            if isinstance(item.get("published_at"), datetime)
            else item.get("published_at"),
        }
        for item in news_items
        if str(item.get("title") or "").strip()
    ]
    return json.dumps(payload, ensure_ascii=True)


def _parse_news_articles(saved_payload: str | None) -> list[dict[str, str | None]]:
    if not saved_payload:
        return []
    try:
        parsed = json.loads(saved_payload)
    except Exception:
        return []

    articles: list[dict[str, str | None]] = []
    for item in parsed or []:
        title = str((item or {}).get("title") or "").strip()
        if not title:
            continue
        articles.append(
            {
                "title": title,
                "source": str((item or {}).get("source") or "").strip() or None,
                "link": str((item or {}).get("link") or "").strip() or None,
                "published_at": str((item or {}).get("published_at") or "").strip() or None,
            }
        )
    return articles


def _merge_saved_articles_with_feed(
    saved_articles: list[dict[str, str | None]],
    feed_articles: list[dict[str, Any]],
) -> list[dict[str, str | None]]:
    if not saved_articles:
        return [
            {
                "title": str(item.get("title") or "").strip(),
                "source": str(item.get("source") or "").strip() or None,
                "link": str(item.get("link") or "").strip() or None,
                "published_at": item.get("published_at").isoformat()
                if isinstance(item.get("published_at"), datetime)
                else str(item.get("published_at") or "").strip() or None,
            }
            for item in feed_articles
            if str(item.get("title") or "").strip()
        ]

    feed_lookup = {
        (
            str(item.get("title") or "").strip().lower(),
            str(item.get("source") or "").strip().lower(),
        ): item
        for item in feed_articles
        if str(item.get("title") or "").strip()
    }
    merged: list[dict[str, str | None]] = []
    changed = False

    for article in saved_articles:
        title = str(article.get("title") or "").strip()
        source = str(article.get("source") or "").strip()
        existing_link = str(article.get("link") or "").strip() or None
        feed_match = feed_lookup.get((title.lower(), source.lower()))
        merged_link = existing_link or (
            str(feed_match.get("link") or "").strip() or None if feed_match else None
        )
        if merged_link != existing_link:
            changed = True
        merged.append(
            {
                "title": title,
                "source": source or None,
                "link": merged_link,
                "published_at": str(article.get("published_at") or "").strip() or None,
            }
        )

    return merged if changed else saved_articles


def _ai_world_news_summaries(entries: list[dict[str, Any]]) -> dict[str, dict[str, str | None]]:
    if not entries:
        return {}

    if not OPENAI_API_KEY:
        return {
            entry["date"]: _fallback_persisted_world_news(entry["articles"])
            for entry in entries
        }

    system_prompt = """
You are writing a short historical world-news summary for a personal journal.
Return one valid JSON object with this exact shape:
{
  "items": [
    {
      "date": "YYYY-MM-DD",
      "world_event_title": "short representative headline for the day's world event coverage",
      "world_event_summary": "1-3 sentence summary synthesizing the provided articles",
      "world_event_source": "comma-separated sources represented in the summary"
    }
  ]
}
Use only the provided article titles and sources. Do not invent details beyond what can be reasonably inferred.
Prefer a broad event summary rather than repeating one title word-for-word.
""".strip()

    try:
        response = client.with_options(timeout=OPENAI_PLANNING_TIMEOUT_SECONDS).chat.completions.create(
            model=OPENAI_PLANNING_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": json.dumps({"days": entries}, ensure_ascii=True),
                },
            ],
            temperature=0.2,
            max_tokens=min(OPENAI_PLANNING_MAX_TOKENS, 1400),
            response_format={"type": "json_object"},
        )
        parsed = json.loads(response.choices[0].message.content or "{}")
    except Exception as exc:
        logger.warning("Journal world news summary failed: %s", exc)
        return {
            entry["date"]: _fallback_persisted_world_news(entry["articles"])
            for entry in entries
        }

    summaries: dict[str, dict[str, str | None]] = {}
    for item in parsed.get("items") or []:
        day_key = str((item or {}).get("date") or "").strip()
        if not day_key:
            continue
        summaries[day_key] = {
            "world_event_title": str((item or {}).get("world_event_title") or "").strip() or None,
            "world_event_summary": str((item or {}).get("world_event_summary") or "").strip()
            or "No world headline was captured for this day.",
            "world_event_source": str((item or {}).get("world_event_source") or "").strip() or None,
        }

    for entry in entries:
        summaries.setdefault(
            entry["date"],
            _fallback_persisted_world_news(entry["articles"]),
        )

    return summaries


def _ensure_persisted_world_news(
    saved_entries: dict[str, dict[str, str | None]],
    day_keys: list[str],
    today_local: date,
    user_id: str,
) -> dict[str, dict[str, str | None]]:
    try:
        news_items = _fetch_recent_news()
    except Exception as exc:
        logger.warning("Journal news fetch failed: %s", exc)
        return saved_entries

    for day_key in day_keys:
        existing_articles = _parse_news_articles(
            saved_entries.get(day_key, {}).get("news_articles_json")
        )
        matching_articles = [item for item in news_items if item["day_key"] == day_key][:8]
        if not matching_articles and existing_articles:
            continue
        if not matching_articles and not existing_articles:
            continue

        merged_articles = _merge_saved_articles_with_feed(existing_articles, matching_articles)
        existing_payload = saved_entries.get(day_key, {}).get("news_articles_json") or "[]"
        merged_payload = json.dumps(merged_articles, ensure_ascii=True)
        if existing_articles and merged_payload == existing_payload:
            continue

        current_entry = saved_entries.get(day_key, {})
        persisted = upsert_journal_news(
            entry_date=day_key,
            world_event_title=current_entry.get("world_event_title"),
            world_event_summary=str(current_entry.get("world_event_summary") or "").strip(),
            world_event_source=current_entry.get("world_event_source"),
            news_articles_json=merged_payload if existing_articles else _serialize_news_articles(matching_articles),
            user_id=user_id,
        )
        saved_entries.setdefault(day_key, {}).update(persisted)

    completed_days = [
        day_key
        for day_key in day_keys
        if date.fromisoformat(day_key) < today_local
    ]
    missing_days = [
        day_key
        for day_key in completed_days
        if not str(saved_entries.get(day_key, {}).get("world_event_summary") or "").strip()
    ]
    if not missing_days:
        return saved_entries

    entries = []
    for day_key in missing_days:
        matching_articles = _parse_news_articles(
            saved_entries.get(day_key, {}).get("news_articles_json")
        )[:6]
        entries.append({"date": day_key, "articles": matching_articles})

    summaries = _ai_world_news_summaries(entries)
    for day_key in missing_days:
        summary = summaries.get(
            day_key,
            {
                "world_event_title": None,
                "world_event_summary": "No world headline was captured for this day.",
                "world_event_source": None,
            },
        )
        persisted = upsert_journal_news(
            entry_date=day_key,
            world_event_title=summary.get("world_event_title"),
            world_event_summary=str(summary.get("world_event_summary") or "").strip()
            or "No world headline was captured for this day.",
            world_event_source=summary.get("world_event_source"),
            news_articles_json=saved_entries.get(day_key, {}).get("news_articles_json") or "[]",
            user_id=user_id,
        )
        saved_entries.setdefault(day_key, {}).update(persisted)

    return saved_entries


def _fallback_calendar_summary(calendar_items: list[dict]) -> str:
    if not calendar_items:
        return "No calendar events were captured for this day."
    if len(calendar_items) == 1:
        return f"You had {calendar_items[0]['title']} on your calendar."
    return (
        f"Your day included {calendar_items[0]['title']} and {len(calendar_items) - 1} "
        f"other scheduled item{'s' if len(calendar_items) - 1 != 1 else ''}."
    )


def get_journal(days: int = 7) -> JournalResponse:
    user_id = get_default_user_context().user_id
    clamped_days = max(1, min(days, 30))
    today_local = datetime.now(LOCAL_TIMEZONE).date()
    start_day = today_local - timedelta(days=clamped_days - 1)

    agenda = list_events_between(
        datetime.combine(start_day, time.min, tzinfo=LOCAL_TIMEZONE),
        datetime.combine(today_local + timedelta(days=1), time.min, tzinfo=LOCAL_TIMEZONE),
        max_results=500,
    )

    events_by_day: dict[str, list] = {}
    for item in agenda.items:
        day_key = (item.start or "")[:10]
        events_by_day.setdefault(day_key, []).append(item)

    saved_entries = list_journal_entries(user_id=user_id)
    day_keys = [
        (today_local - timedelta(days=offset)).isoformat()
        for offset in range(clamped_days)
    ]
    try:
        saved_entries = _ensure_persisted_world_news(
            saved_entries=saved_entries,
            day_keys=day_keys,
            today_local=today_local,
            user_id=user_id,
        )
    except Exception as exc:
        logger.warning("Journal news persistence failed: %s", exc)
    base_entries: list[dict] = []
    day = today_local
    while day >= start_day:
        day_key = day.isoformat()
        saved = saved_entries.get(day_key, {})
        calendar_items = _apply_calendar_overrides(
            events_by_day.get(day_key, []),
            saved.get("calendar_items_json"),
        )
        base_entries.append(
            {
                "date": day_key,
                "date_label": _format_date_label(day),
                "calendar_items": [_calendar_payload_for_day(item) for item in calendar_items if not item.removed],
                "calendar_items_full": calendar_items,
                "world_event_title": saved.get("world_event_title"),
                "world_event_source": saved.get("world_event_source"),
                "world_event_summary": str(saved.get("world_event_summary") or "").strip()
                or "No world headline was captured for this day.",
                "world_event_articles": _parse_news_articles(saved.get("news_articles_json")),
            }
        )
        day -= timedelta(days=1)

    ai_summaries = _ai_calendar_summaries(base_entries)
    entries: list[JournalDayEntry] = []
    for entry in base_entries:
        saved = saved_entries.get(entry["date"], {})
        summaries = ai_summaries.get(entry["date"], {})
        entries.append(
            JournalDayEntry(
                date=entry["date"],
                date_label=entry["date_label"],
                calendar_summary=summaries.get("calendar_summary") or _fallback_calendar_summary(entry["calendar_items"]),
                world_event_title=entry["world_event_title"],
                world_event_source=entry["world_event_source"],
                world_event_summary=entry["world_event_summary"],
                world_event_articles=[
                    JournalNewsArticle.model_validate(article)
                    for article in entry["world_event_articles"][:6]
                ],
                journal_entry=str(saved.get("journal_entry") or ""),
                accomplishments=str(saved.get("accomplishments") or ""),
                gratitude_entry=str(saved.get("gratitude_entry") or ""),
                scripture_study=str(saved.get("scripture_study") or ""),
                spiritual_notes=str(saved.get("spiritual_notes") or ""),
                photo_data_url=saved.get("photo_data_url"),
                calendar_items=entry["calendar_items_full"],
                updated_at=saved.get("updated_at"),
            )
        )

    return JournalResponse(
        generated_at=datetime.now(LOCAL_TIMEZONE).isoformat(),
        entries=entries,
    )


def save_journal_day(
    entry_date: str,
    journal_entry: str,
    accomplishments: str,
    gratitude_entry: str,
    scripture_study: str,
    spiritual_notes: str,
    photo_data_url: str | None,
    calendar_items: list[CalendarAgendaItem],
) -> JournalDayEntry:
    user_id = get_default_user_context().user_id
    saved = upsert_journal_entry(
        entry_date,
        journal_entry,
        accomplishments,
        gratitude_entry,
        scripture_study,
        spiritual_notes,
        photo_data_url,
        json.dumps([item.model_dump() for item in calendar_items], ensure_ascii=True),
        user_id=user_id,
    )
    day = date.fromisoformat(entry_date)
    return JournalDayEntry(
        date=entry_date,
        date_label=_format_date_label(day),
        journal_entry=saved["journal_entry"],
        accomplishments=saved["accomplishments"],
        gratitude_entry=saved["gratitude_entry"],
        scripture_study=saved["scripture_study"],
        spiritual_notes=saved["spiritual_notes"],
        photo_data_url=saved.get("photo_data_url"),
        world_event_articles=[],
        calendar_items=[CalendarAgendaItem.model_validate(item) for item in json.loads(saved["calendar_items_json"] or "[]")],
        updated_at=saved["updated_at"],
    )
