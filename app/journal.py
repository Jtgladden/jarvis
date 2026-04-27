import json
import logging
import re
from html import unescape
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
import xml.etree.ElementTree as ET
from datetime import date, datetime, time, timedelta
from email.utils import parsedate_to_datetime
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo
from typing import Any

from openai import OpenAI

from app.calendar_client import list_events_between
from app.config import DEFAULT_TIMEZONE, OPENAI_API_KEY, OPENAI_PLANNING_MAX_TOKENS, OPENAI_PLANNING_MODEL, OPENAI_PLANNING_TIMEOUT_SECONDS
from app.journal_store import (
    count_journal_entries,
    get_oldest_journal_entry_date,
    list_journal_entries,
    list_journal_entry_dates,
    upsert_journal_calendar,
    upsert_journal_entry,
    upsert_journal_news,
)
from app.language_store import list_sessions_for_date_range
from app.schemas import CalendarAgendaItem, JournalDayEntry, JournalNewsArticle, JournalResponse, JournalStudyLink, LanguagePracticeSession
from app.user_context import get_default_user_context

logger = logging.getLogger(__name__)
client = OpenAI(api_key=OPENAI_API_KEY)
LOCAL_TIMEZONE = ZoneInfo(DEFAULT_TIMEZONE)
NEWS_FEEDS = [
    ("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("New York Times", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"),
    ("Wall Street Journal", "https://feeds.a.dj.com/rss/RSSWorldNews.xml"),
]
NEWS_CACHE_TTL_SECONDS = 900
_recent_news_cache: list[dict[str, Any]] = []
_recent_news_cache_loaded_at = 0.0
_SCRIPTURE_ALIASES: dict[str, tuple[str, str]] = {
    "gen": ("ot", "gen"),
    "genesis": ("ot", "gen"),
    "ex": ("ot", "ex"),
    "exodus": ("ot", "ex"),
    "ps": ("ot", "ps"),
    "psalm": ("ot", "ps"),
    "psalms": ("ot", "ps"),
    "prov": ("ot", "prov"),
    "proverbs": ("ot", "prov"),
    "isa": ("ot", "isa"),
    "isaiah": ("ot", "isa"),
    "matt": ("nt", "matt"),
    "matthew": ("nt", "matt"),
    "mark": ("nt", "mark"),
    "luke": ("nt", "luke"),
    "john": ("nt", "john"),
    "rom": ("nt", "rom"),
    "romans": ("nt", "rom"),
    "1 cor": ("nt", "1-cor"),
    "1 corinthians": ("nt", "1-cor"),
    "2 cor": ("nt", "2-cor"),
    "2 corinthians": ("nt", "2-cor"),
    "eph": ("nt", "eph"),
    "ephesians": ("nt", "eph"),
    "phil": ("nt", "philip"),
    "philippians": ("nt", "philip"),
    "heb": ("nt", "heb"),
    "hebrews": ("nt", "heb"),
    "james": ("nt", "james"),
    "1 pet": ("nt", "1-pet"),
    "1 peter": ("nt", "1-pet"),
    "2 pet": ("nt", "2-pet"),
    "2 peter": ("nt", "2-pet"),
    "1 john": ("nt", "1-jn"),
    "2 john": ("nt", "2-jn"),
    "3 john": ("nt", "3-jn"),
    "rev": ("nt", "rev"),
    "revelation": ("nt", "rev"),
    "1 ne": ("bofm", "1-ne"),
    "1 nephi": ("bofm", "1-ne"),
    "2 ne": ("bofm", "2-ne"),
    "2 nephi": ("bofm", "2-ne"),
    "jacob": ("bofm", "jacob"),
    "enos": ("bofm", "enos"),
    "jarom": ("bofm", "jarom"),
    "omni": ("bofm", "omni"),
    "w of m": ("bofm", "w-of-m"),
    "words of mormon": ("bofm", "w-of-m"),
    "mosiah": ("bofm", "mosiah"),
    "alma": ("bofm", "alma"),
    "hel": ("bofm", "hel"),
    "helaman": ("bofm", "hel"),
    "3 ne": ("bofm", "3-ne"),
    "3 nephi": ("bofm", "3-ne"),
    "4 ne": ("bofm", "4-ne"),
    "4 nephi": ("bofm", "4-ne"),
    "morm": ("bofm", "morm"),
    "mormon": ("bofm", "morm"),
    "ether": ("bofm", "ether"),
    "moro": ("bofm", "moro"),
    "moroni": ("bofm", "moro"),
    "dc": ("dc-testament", "dc"),
    "d&c": ("dc-testament", "dc"),
    "doctrine and covenants": ("dc-testament", "dc"),
    "moses": ("pgp", "moses"),
    "abr": ("pgp", "abr"),
    "abraham": ("pgp", "abr"),
    "js h": ("pgp", "js-h"),
    "js-h": ("pgp", "js-h"),
    "joseph smith history": ("pgp", "js-h"),
    "js m": ("pgp", "js-m"),
    "js-m": ("pgp", "js-m"),
    "joseph smith matthew": ("pgp", "js-m"),
    "a of f": ("pgp", "a-of-f"),
    "articles of faith": ("pgp", "a-of-f"),
}
_SCRIPTURE_REFERENCE_RE = re.compile(
    r"\b(?P<book>(?:[1-4]\s*)?[A-Za-z][A-Za-z .&'\-]{1,40}?)\s+(?P<chapter>\d+)(?::(?P<start>\d+)(?:\s*[-–]\s*(?P<end>\d+))?)?",
    re.IGNORECASE,
)
_STUDY_URL_RE = re.compile(
    r"(?P<url>(?:https?://(?:www\.)?(?:churchofjesuschrist\.org|lds\.org)/study/[^\s)\]]+)|(?:gospellibrary://[^\s)\]]+))",
    re.IGNORECASE,
)
_ANY_URL_RE = re.compile(r"(?P<url>https?://[^\s)\]]+)", re.IGNORECASE)
_GENERAL_CONFERENCE_CITATION_RE = re.compile(
    r"(?P<speaker>(?:Elder|President|Sister|Bishop|Brother)\s+[A-Z][A-Za-z.\-']+(?:\s+[A-Z][A-Za-z.\-']+){0,4})\s*,?\s*[\"“](?P<title>[^\"”]{3,120})[\"”]\s*,?\s*(?P<month>April|October)\s+(?P<year>20\d{2})",
    re.IGNORECASE,
)
_PARENTHETICAL_CITATION_RE = re.compile(r"\((?P<citation>[^()]{4,220})\)")
_STUDY_LIKELY_MAX_RESULTS = 6
_LIKELY_CHURCH_KEYWORDS = (
    "elder ",
    "president ",
    "first presidency",
    "declaration",
    "christofferson",
    "kearon",
    "oaks",
    "maxwell",
    "conference",
    "general conference",
    "churchofjesuschrist",
)
_HTTP_URL_RE = re.compile(r"^https?://[^\s]+$", re.IGNORECASE)
_MONTH_PATTERN = r"january|february|march|april|may|june|july|august|september|october|november|december"
_STUDY_RESULT_LINK_RE = re.compile(
    r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_STUDY_FALLBACK_LINK_RE = re.compile(
    r'<a[^>]+href="(?P<href>(?:https?:)?//[^"]+|/l/\?[^"]+)"[^>]*>(?P<title>.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_STUDY_RESULT_SNIPPET_RE = re.compile(
    r'<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>(?P<snippet>.*?)</a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>(?P<snippet_div>.*?)</div>',
    re.IGNORECASE | re.DOTALL,
)
_TRACKING_QUERY_KEYS = {
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "gclid",
    "fbclid",
    "mc_cid",
    "mc_eid",
}
_STUDY_WEB_SEARCH_MAX_CANDIDATES = 4
_STUDY_WEB_SEARCH_MAX_RESULTS = 5
_general_conference_link_cache: dict[str, dict[str, str]] = {}
_LOW_SIGNAL_STUDY_DOMAINS = (
    "amazon.",
    "abebooks.",
    "ebay.",
    "barnesandnoble.com",
    "goodreads.com",
    "openlibrary.org",
)


def _fetch_recent_news() -> list[dict[str, Any]]:
    global _recent_news_cache, _recent_news_cache_loaded_at

    if _recent_news_cache and (monotonic() - _recent_news_cache_loaded_at) < NEWS_CACHE_TTL_SECONDS:
        return list(_recent_news_cache)

    items: list[dict[str, Any]] = []
    for source_name, rss_url in NEWS_FEEDS:
        items.extend(_fetch_feed_items(source_name, rss_url))
    items.sort(key=lambda item: item["published_at"], reverse=True)
    _recent_news_cache = items
    _recent_news_cache_loaded_at = monotonic()
    return list(items)


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


def _normalize_scripture_book(value: str) -> str:
    normalized = value.lower().replace("—", "-")
    normalized = normalized.replace(".", " ")
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def _slugify_study_text(value: str) -> str:
    lowered = value.lower().replace("&", " and ")
    lowered = re.sub(r"[^a-z0-9]+", "-", lowered)
    return lowered.strip("-")


def _normalize_study_title(value: str) -> str:
    normalized = unescape(value).lower()
    normalized = normalized.replace("’", "'").replace("“", '"').replace("”", '"')
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def _fetch_general_conference_talk_links(year: str, month_slug: str) -> dict[str, str]:
    cache_key = f"{year}-{month_slug}"
    cached = _general_conference_link_cache.get(cache_key)
    if cached is not None:
        return dict(cached)

    contents_url = f"https://www.churchofjesuschrist.org/study/general-conference/{year}/{month_slug}?lang=eng"
    try:
        request = Request(
            contents_url,
            headers={
                "User-Agent": "JarvisJournal/1.0",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        )
        with urlopen(request, timeout=6) as response:
            html = response.read().decode("utf-8", "ignore")
    except Exception as exc:
        logger.warning("General conference contents fetch failed for %s: %s", cache_key, exc)
        _general_conference_link_cache[cache_key] = {}
        return {}

    links: dict[str, str] = {}
    pattern = re.compile(
        rf'<a[^>]+href="(?P<href>/study/general-conference/{year}/{month_slug}/[^"?#]+(?:\?[^"]*)?)"[^>]*>(?P<title>.*?)</a>',
        re.IGNORECASE | re.DOTALL,
    )
    for match in pattern.finditer(html):
        raw_title = match.group("title") or ""
        span_match = re.search(r"<span>(?P<title>.*?)</span>", raw_title, re.IGNORECASE | re.DOTALL)
        title = _strip_html_tags(span_match.group("title") if span_match else raw_title)
        href = unescape(match.group("href") or "").strip()
        if not title or not href:
            continue
        normalized_title = _normalize_study_title(title)
        if len(normalized_title) < 3:
            continue
        links[normalized_title] = _normalize_study_link_url(f"https://www.churchofjesuschrist.org{href}")

    _general_conference_link_cache[cache_key] = dict(links)
    return links


def _general_conference_talk_url(title: str, year: str, month_slug: str) -> str:
    links = _fetch_general_conference_talk_links(year, month_slug)
    normalized_title = _normalize_study_title(title)
    if normalized_title in links:
        return links[normalized_title]
    for candidate_title, candidate_url in links.items():
        if candidate_title.startswith(normalized_title) or normalized_title.startswith(candidate_title):
            return candidate_url

    fallback_slug = _slugify_study_text(title)
    return f"https://www.churchofjesuschrist.org/study/general-conference/{year}/{month_slug}/{fallback_slug}?lang=eng"


def _scripture_reference_url(book: str, chapter: str, start: str | None, end: str | None) -> str | None:
    alias = _SCRIPTURE_ALIASES.get(_normalize_scripture_book(book))
    if alias is None:
        return None

    collection_slug, book_slug = alias
    base = f"https://www.churchofjesuschrist.org/study/scriptures/{collection_slug}/{book_slug}/{int(chapter)}?lang=eng"
    if not start:
        return base

    start_verse = int(start)
    if end:
        end_verse = int(end)
        return f"{base}&id=p{start_verse}-p{end_verse}#p{start_verse}"
    return f"{base}&id=p{start_verse}#p{start_verse}"


def _append_study_link(
    links: list[JournalStudyLink],
    seen_urls: set[str],
    seen_matches: set[str],
    link: JournalStudyLink,
) -> None:
    normalized_url = _normalize_study_link_url(link.url)
    normalized_match = " ".join((link.matched_text or "").split()).strip().lower()
    if not normalized_url or normalized_url in seen_urls:
        return
    if normalized_match and normalized_match in seen_matches:
        return

    seen_urls.add(normalized_url)
    if normalized_match:
        seen_matches.add(normalized_match)
    links.append(link.model_copy(update={"url": normalized_url}))


def _normalize_study_link_url(url: str) -> str:
    cleaned = url.strip().rstrip(".,;:")
    if not cleaned:
        return ""

    try:
        parsed = urlparse(cleaned)
    except Exception:
        return cleaned

    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = parsed.path or ""
    if scheme in {"http", "https"}:
        query_pairs = [
            (key, value)
            for key, value in parse_qsl(parsed.query, keep_blank_values=True)
            if key.lower() not in _TRACKING_QUERY_KEYS
        ]
        normalized_query = urlencode(query_pairs, doseq=True)
        normalized_path = path.rstrip("/") or parsed.path or ""
        return urlunparse((scheme, netloc, normalized_path, "", normalized_query, ""))

    return cleaned


def _study_link_signature(link: JournalStudyLink) -> tuple[str, str, str]:
    normalized_url = _normalize_study_link_url(link.url)
    normalized_label = " ".join(link.label.split()).strip().lower()
    normalized_match = " ".join((link.matched_text or "").split()).strip().lower()
    return (normalized_url, normalized_label, normalized_match)


def _normalize_study_topic_text(value: str) -> str:
    lowered = value.lower()
    lowered = re.sub(r"\b(elder|president|sister|brother|bishop|the first presidency)\b", " ", lowered)
    lowered = re.sub(r"[\(\)\[\]\"“”,.:;!?'\-]+", " ", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    return lowered


def _study_title_tokens(value: str) -> set[str]:
    normalized = _normalize_study_topic_text(value)
    return {
        token
        for token in normalized.split()
        if len(token) >= 4 and token not in {"quote", "video", "talk", "from"}
    }


def _parse_publication_citation_parts(citation: str) -> tuple[str | None, str | None, str | None]:
    parts = [part.strip(" ,") for part in citation.split(",") if part.strip(" ,")]
    if not parts:
        return (None, None, None)

    year = None
    for part in reversed(parts):
        year_match = re.search(r"\b((?:19|20)\d{2})\b", part)
        if year_match:
            year = year_match.group(1)
            break

    author = parts[0] if len(parts) >= 2 else None
    title = None
    if len(parts) >= 2:
        title = parts[1]
    if len(parts) >= 3 and title and year and year not in parts[2]:
        title = parts[1]

    if title:
        title = title.strip('"“” ')
    if author:
        author = author.strip('"“” ')
    return (author or None, title or None, year)


def _has_strong_container_metadata(citation: str, label_hint: str = "") -> bool:
    author, title, year = _parse_publication_citation_parts(citation)
    if not title or not author:
        label_author, label_title, label_year = _parse_publication_citation_parts(label_hint.replace(" — ", ", "))
        author = author or label_author
        title = title or label_title
        year = year or label_year
    return bool(author and title and year)


def _build_container_search_query(matched_text: str, label_hint: str, fallback_query: str) -> str:
    author, title, year = _parse_publication_citation_parts(matched_text)
    if not title:
        label_author, label_title, label_year = _parse_publication_citation_parts(label_hint.replace(" — ", ", "))
        author = author or label_author
        title = title or label_title
        year = year or label_year

    if title and author:
        segments = [f'"{title}"', f'"{author}"']
        if year:
            segments.append(year)
        segments.extend(["pdf", '"full text"'])
        return " ".join(segments)

    return fallback_query


def _study_link_topic_keys(link: JournalStudyLink) -> set[str]:
    keys: set[str] = set()
    for candidate in [link.label, link.matched_text or ""]:
        normalized = _normalize_study_topic_text(candidate)
        if len(normalized) >= 8:
            keys.add(normalized)
    return keys


def _study_links_equivalent(left: JournalStudyLink, right: JournalStudyLink) -> bool:
    left_keys = _study_link_topic_keys(left)
    right_keys = _study_link_topic_keys(right)
    if not left_keys or not right_keys:
        return False
    for left_key in left_keys:
        for right_key in right_keys:
            if left_key == right_key:
                return True
            if len(left_key) >= 16 and left_key in right_key:
                return True
            if len(right_key) >= 16 and right_key in left_key:
                return True
    return False


def _is_obviously_bad_likely_url(url: str) -> bool:
    lowered = url.lower()
    return any(fragment in lowered for fragment in [
        "/404",
        "/not-found",
        "page-not-found",
        "error=",
    ])


def _citation_prefers_document_result(matched_text: str, label_hint: str) -> bool:
    combined = f"{matched_text} {label_hint}".lower()
    return bool(
        re.search(r"\b(19|20)\d{2}\b", combined)
        and (
            "," in matched_text
            or "pdf" in combined
            or "article" in combined
            or "statement" in combined
            or "scene" in combined
            or "declaration" in combined
            or "address" in combined
        )
    )


def _strip_html_tags(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value)
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _build_quote_fragment(value: str, *, max_words: int = 12) -> str:
    words = re.findall(r"[A-Za-z0-9']+", value)
    if not words:
        return ""
    return " ".join(words[:max_words]).strip()


def _nearest_quote_fragment_before(text: str, end_index: int) -> str:
    window = text[max(0, end_index - 500):end_index]
    quote_matches = re.findall(r'["“](.+?)["”]', window, re.DOTALL)
    if not quote_matches:
        return ""
    for quote in reversed(quote_matches):
        fragment = _build_quote_fragment(" ".join(quote.split()))
        if len(fragment) >= 20:
            return fragment
    return ""


def _seed_study_link_candidates(combined_text: str, exact_links: list[JournalStudyLink]) -> list[dict[str, str]]:
    exact_matches = {
        " ".join((item.matched_text or "").split()).strip().lower()
        for item in exact_links
        if (item.matched_text or "").strip()
    }
    seeded: list[dict[str, str]] = []
    seen: set[str] = set()

    def add_candidate(matched_text: str, label_hint: str | None = None, search_query: str | None = None) -> None:
        cleaned = " ".join((matched_text or "").split()).strip(" ,")
        lowered = cleaned.lower()
        if len(cleaned) < 8 or lowered in seen or lowered in exact_matches:
            return
        seen.add(lowered)
        seeded.append(
            {
                "matched_text": cleaned,
                "label_hint": (label_hint or cleaned).strip(),
                "search_query": (search_query or label_hint or cleaned).strip(),
            }
        )

    for match in _PARENTHETICAL_CITATION_RE.finditer(combined_text):
        citation = " ".join(str(match.group("citation") or "").split()).strip(" ,")
        lowered = citation.lower()
        quote_fragment = _nearest_quote_fragment_before(combined_text, match.start())
        if (
            re.search(r"\b(19|20)\d{2}\b", citation)
            or re.search(rf"\b({_MONTH_PATTERN})\s+(19|20)\d{{2}}\b", lowered)
            or any(keyword in lowered for keyword in [
                "elder ",
                "president ",
                "first presidency",
                "c.s. lewis",
                "cs lewis",
                "maxwell",
                "christofferson",
                "video",
                "declaration",
            ])
        ):
            container_query = _build_container_search_query(citation, citation, citation)
            if (
                quote_fragment
                and not _has_strong_container_metadata(citation, citation)
                and any(keyword in lowered for keyword in [
                "maxwell",
                "c.s. lewis",
                "cs lewis",
                "christofferson",
                ])
            ):
                add_candidate(
                    citation,
                    search_query=f'"{quote_fragment}" {container_query}',
                )
            else:
                add_candidate(citation, search_query=container_query)

    for raw_line in combined_text.splitlines():
        line = " ".join(raw_line.split()).strip(" -\t")
        lowered = line.lower()
        if not line:
            continue
        if any(keyword in lowered for keyword in [
            "c.s. lewis",
            "cs lewis",
            "first presidency",
            "christofferson",
            "maxwell",
            "video",
        ]):
            add_candidate(line)

    lowered_text = combined_text.lower()
    if ("c.s. lewis" in lowered_text or "cs lewis" in lowered_text) and (
        "mere mortal" in lowered_text or "ordinary people" in lowered_text or "weight of glory" in lowered_text
    ):
        add_candidate(
            "C.S. Lewis quote about nobody being a mere mortal",
            label_hint="C.S. Lewis — The Weight of Glory",
            search_query='C.S. Lewis "The Weight of Glory" pdf "full text"',
        )

    if "neal a. maxwell" in lowered_text and "the christmas scene" in lowered_text:
        add_candidate(
            "Neal A. Maxwell, The Christmas Scene, 1994",
            label_hint="Neal A. Maxwell — The Christmas Scene",
            search_query='"The Christmas Scene" "Neal A. Maxwell" 1994 pdf "full text"',
        )

    if "christofferson" in lowered_text and "video" in lowered_text:
        if "daily bread" in lowered_text:
            add_candidate(
                "Christofferson, daily bread video",
                label_hint="D. Todd Christofferson — Daily Bread video",
                search_query='"D. Todd Christofferson" "daily bread" video',
            )
        else:
            add_candidate(
                "Christofferson, video",
                label_hint="D. Todd Christofferson video",
                search_query='"D. Todd Christofferson" video',
            )

    return seeded[:12]


def _extract_search_result_url(raw_href: str) -> str | None:
    href = unescape(raw_href).strip()
    if not href:
        return None
    if href.startswith("//"):
        href = f"https:{href}"

    parsed = urlparse(href)
    if parsed.path == "/l/" and parsed.query:
        for key, value in parse_qsl(parsed.query, keep_blank_values=True):
            if key == "uddg" and value:
                return _normalize_study_link_url(value)

    normalized = _normalize_study_link_url(href)
    return normalized if _HTTP_URL_RE.match(normalized) else None


def _search_live_study_results(query: str) -> list[dict[str, str]]:
    if not query.strip():
        return []

    search_url = f"https://html.duckduckgo.com/html/?q={urlencode({'q': query})[2:]}"
    try:
        request = Request(
            search_url,
            headers={
                "User-Agent": "JarvisJournal/1.0",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        )
        with urlopen(request, timeout=6) as response:
            html = response.read().decode("utf-8", "ignore")
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        logger.warning("Study source search failed for query %r: %s", query, exc)
        return []
    except Exception as exc:
        logger.warning("Unexpected study source search failure for query %r: %s", query, exc)
        return []

    snippet_matches = [
        _strip_html_tags(match.group("snippet") or match.group("snippet_div") or "")
        for match in _STUDY_RESULT_SNIPPET_RE.finditer(html)
    ]
    results: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    result_matches = list(_STUDY_RESULT_LINK_RE.finditer(html))
    if not result_matches:
        result_matches = list(_STUDY_FALLBACK_LINK_RE.finditer(html))
    for index, match in enumerate(result_matches):
        url = _extract_search_result_url(match.group("href") or "")
        if not url or url in seen_urls or _is_obviously_bad_likely_url(url):
            continue
        seen_urls.add(url)
        title = _strip_html_tags(match.group("title") or "")
        snippet = snippet_matches[index] if index < len(snippet_matches) else ""
        results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= _STUDY_WEB_SEARCH_MAX_RESULTS:
            break

    return results


def _annotate_search_results(
    matched_text: str,
    label_hint: str,
    results: list[dict[str, str]],
) -> list[dict[str, str | bool | int]]:
    query_tokens = _study_title_tokens(f"{matched_text} {label_hint}")
    annotated: list[dict[str, str | bool | int]] = []
    for result in results:
        haystack = f"{result.get('title', '')} {result.get('snippet', '')}".lower()
        url = str(result.get("url") or "")
        domain = urlparse(url).netloc.lower()
        overlap = sum(1 for token in query_tokens if token in haystack)
        is_pdf = ".pdf" in url.lower() or "pdf" in haystack
        is_low_signal_domain = any(fragment in domain for fragment in _LOW_SIGNAL_STUDY_DOMAINS)
        annotated.append(
            {
                **result,
                "is_pdf": is_pdf,
                "domain": domain,
                "is_low_signal_domain": is_low_signal_domain,
                "token_overlap": overlap,
            }
        )

    annotated.sort(
        key=lambda item: (
            int(bool(item.get("is_pdf"))),
            int(item.get("token_overlap") or 0),
        ),
        reverse=True,
    )
    return annotated


def _study_results_need_document_retry(results: list[dict[str, str | bool | int]]) -> bool:
    if not results:
        return True
    if any(bool(result.get("is_pdf")) for result in results[:3]):
        return False
    strong_results = [
        result for result in results[:3]
        if int(result.get("token_overlap") or 0) >= 3 and not bool(result.get("is_low_signal_domain"))
    ]
    if strong_results:
        return False
    low_signal_count = sum(1 for result in results[:3] if bool(result.get("is_low_signal_domain")))
    return low_signal_count >= 2


def _document_retry_query(matched_text: str, label_hint: str, search_query: str) -> str:
    base = _build_container_search_query(matched_text, label_hint, search_query)
    if "pdf" not in base.lower():
        base = f"{base} pdf"
    if not re.search(r"\b(full text|primary source|original text|sermon text|scan)\b", base, re.IGNORECASE):
        base = f'{base} "full text"'
    return " ".join(base.split()).strip()


def _dedupe_study_links(links: list[JournalStudyLink]) -> list[JournalStudyLink]:
    deduped: list[JournalStudyLink] = []
    seen_signatures: set[tuple[str, str, str]] = set()
    seen_url_match_pairs: set[tuple[str, str]] = set()
    exact_links: list[JournalStudyLink] = []

    for link in links:
        if link.confidence == "likely" and any(_study_links_equivalent(link, exact_link) for exact_link in exact_links):
            continue
        signature = _study_link_signature(link)
        if signature in seen_signatures:
            continue
        url_match_pair = (signature[0], signature[2])
        if signature[0] and url_match_pair in seen_url_match_pairs:
            continue
        seen_signatures.add(signature)
        if signature[0]:
            seen_url_match_pairs.add(url_match_pair)
        normalized_link = link.model_copy(update={"url": signature[0] or link.url})
        deduped.append(normalized_link)
        if normalized_link.confidence == "exact":
            exact_links.append(normalized_link)

    return deduped


def _ai_extract_study_link_candidates(
    combined_text: str,
    exact_links: list[JournalStudyLink],
) -> list[dict[str, str]]:
    if not OPENAI_API_KEY or not combined_text.strip():
        return []

    exact_payload = [
        {
            "label": item.label,
            "matched_text": item.matched_text,
            "url": item.url,
        }
        for item in exact_links
    ]
    system_prompt = """
You read study notes and identify snippets that appear to cite or allude to an external source.
This stage is only about extraction, not linking.

Return one valid JSON object with this exact shape:
{
  "items": [
    {
      "matched_text": "exact source-like text copied from the notes",
      "label_hint": "short title or source name if one is apparent",
      "search_query": "best concise web search query for this citation"
    }
  ]
}

Rules:
- Copy text exactly from the notes whenever possible, with only whitespace normalization.
- Prefer source-like fragments such as quoted attributions, titles with years, talk names, scripture references, video references, publication names, or clear allusions to named works.
- `label_hint` should be brief and source-oriented.
- `search_query` should be compact and high-signal, suitable for one conservative web search.
- If the citation looks like a publication or document reference such as author + title + year, prefer a search query that includes `pdf`.
- For quote-source retrieval, search for the container work rather than the quote itself whenever the work title is known or strongly inferable.
- Prefer patterns like `[author] + [exact title] + pdf + "full text"` over quote-fragment searches.
- Do not return raw URLs.
- Do not return items already covered by the exact rule-based matches.
- Omit ordinary commentary that does not appear to reference a source.
- Return at most 12 items.
""".strip()

    try:
        response = client.with_options(timeout=OPENAI_PLANNING_TIMEOUT_SECONDS).chat.completions.create(
            model=OPENAI_PLANNING_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "notes": combined_text,
                            "exact_matches": exact_payload,
                        },
                        ensure_ascii=True,
                    ),
                },
            ],
            temperature=0.1,
            max_tokens=min(OPENAI_PLANNING_MAX_TOKENS, 700),
            response_format={"type": "json_object"},
        )
        parsed = json.loads(response.choices[0].message.content or "{}")
    except Exception as exc:
        logger.warning("Journal AI citation extraction failed: %s", exc)
        return []

    candidates: list[dict[str, str]] = []
    seen: set[str] = set()
    exact_matches = {
        " ".join((item.matched_text or "").split()).strip().lower()
        for item in exact_links
        if (item.matched_text or "").strip()
    }
    for raw_item in parsed.get("items") or []:
        matched_text = " ".join(str((raw_item or {}).get("matched_text") or "").split()).strip()
        lowered = matched_text.lower()
        if len(matched_text) < 8 or lowered in seen or lowered in exact_matches:
            continue
        seen.add(lowered)
        label_hint = " ".join(str((raw_item or {}).get("label_hint") or "").split()).strip() or matched_text
        search_query = " ".join(str((raw_item or {}).get("search_query") or "").split()).strip() or label_hint
        candidates.append(
            {
                "matched_text": matched_text,
                "label_hint": label_hint,
                "search_query": search_query,
            }
        )

    return candidates[:12]


def _is_generic_likely_study_url(url: str) -> bool:
    lowered = url.lower()
    return (
        "churchofjesuschrist.org/search?" in lowered
        or "en.wikipedia.org/w/index.php?search=" in lowered
    )


def _notes_suggest_unresolved_sources(scripture_study: str, spiritual_notes: str) -> bool:
    combined_text = "\n".join(part for part in [scripture_study, spiritual_notes] if part.strip())
    if not combined_text.strip():
        return False
    lowered = combined_text.lower()
    return bool(
        _PARENTHETICAL_CITATION_RE.search(combined_text)
        or re.search(rf"\b({_MONTH_PATTERN})\s+20\d{{2}}\b", lowered)
        or any(keyword in lowered for keyword in [
            "first presidency",
            "c.s. lewis",
            "cs lewis",
            "video",
            "quote",
            "declaration",
        ])
    )


def _study_links_need_refresh(
    study_links: list[JournalStudyLink],
    scripture_study: str,
    spiritual_notes: str,
) -> bool:
    if not (scripture_study.strip() or spiritual_notes.strip()):
        return False
    if not study_links:
        return True
    if len(_dedupe_study_links(study_links)) != len(study_links):
        return True
    if not any(link.confidence == "likely" for link in study_links) and _notes_suggest_unresolved_sources(scripture_study, spiritual_notes):
        return True
    return any(
        link.confidence == "likely" and _is_generic_likely_study_url(link.url)
        for link in study_links
    )


def _ai_infer_likely_study_links(
    combined_text: str,
    exact_links: list[JournalStudyLink],
    seen_urls: set[str],
    seen_matches: set[str],
) -> list[JournalStudyLink]:
    if not OPENAI_API_KEY or not combined_text.strip():
        return []

    exact_payload = [
        {
            "label": item.label,
            "matched_text": item.matched_text,
            "url": item.url,
        }
        for item in exact_links
    ]
    candidates = _ai_extract_study_link_candidates(combined_text, exact_links)
    seeded_candidates = _seed_study_link_candidates(combined_text, exact_links)
    merged_candidates: list[dict[str, str]] = []
    seen_candidate_matches: set[str] = set()
    for candidate in [*candidates, *seeded_candidates]:
        matched_text = " ".join(str(candidate.get("matched_text") or "").split()).strip()
        lowered = matched_text.lower()
        if not matched_text or lowered in seen_candidate_matches:
            continue
        seen_candidate_matches.add(lowered)
        merged_candidates.append(candidate)
    if not merged_candidates:
        return []
    filtered_candidates = []
    for candidate in merged_candidates:
        matched_text = " ".join(str(candidate.get("matched_text") or "").split()).strip()
        label_hint = " ".join(str(candidate.get("label_hint") or "").split()).strip() or matched_text
        if not matched_text or matched_text.lower() in seen_matches:
            continue
        candidate_link = JournalStudyLink(label=label_hint, url="", confidence="likely", matched_text=matched_text)
        if any(_study_links_equivalent(candidate_link, exact_link) for exact_link in exact_links):
            continue
        filtered_candidates.append(candidate)
    if not filtered_candidates:
        return []

    links: list[JournalStudyLink] = []
    rerank_system_prompt = """
You choose the single best source link for one study-note citation.
You are given one citation plus a small set of live web search results.

Return one valid JSON object with this exact shape:
{
  "selected_url": "https://example.com/source" | null,
  "label": "short source title",
  "reason": "brief reason"
}

Rules:
- Choose at most one result.
- Only choose from the provided search results.
- Prefer the most source-like result: official talk page, primary document, transcript, PDF, publisher page, or direct video page.
- When `prefers_document_result` is true, strongly prefer a direct PDF, scan, statement, or document page over a generic article page if the title/author/year align.
- Treat `is_pdf` and `token_overlap` as useful signals, not guarantees.
- Avoid homepages, topic pages, broad category pages, search pages, or index pages if a more specific source is present.
- If none of the results look good enough, return selected_url as null.
""".strip()

    for candidate in filtered_candidates[:_STUDY_WEB_SEARCH_MAX_CANDIDATES]:
        matched_text = " ".join(str(candidate.get("matched_text") or "").split()).strip()
        label_hint = " ".join(str(candidate.get("label_hint") or "").split()).strip() or matched_text
        search_query = " ".join(str(candidate.get("search_query") or "").split()).strip() or label_hint
        if _citation_prefers_document_result(matched_text, label_hint) and " pdf" not in search_query.lower():
            search_query = f"{search_query} pdf"
        if not matched_text or matched_text.lower() in seen_matches:
            continue
        if any(_study_links_equivalent(JournalStudyLink(label=label_hint, url="", confidence="likely", matched_text=matched_text), exact_link) for exact_link in exact_links):
            continue

        search_results = _search_live_study_results(search_query)
        if not search_results:
            continue
        annotated_results = _annotate_search_results(matched_text, label_hint, search_results)
        if _citation_prefers_document_result(matched_text, label_hint) and _study_results_need_document_retry(annotated_results):
            retry_query = _document_retry_query(matched_text, label_hint, search_query)
            if retry_query and retry_query != search_query:
                retry_results = _search_live_study_results(retry_query)
                if retry_results:
                    annotated_results = _annotate_search_results(matched_text, label_hint, retry_results)

        try:
            response = client.with_options(timeout=OPENAI_PLANNING_TIMEOUT_SECONDS).chat.completions.create(
                model=OPENAI_PLANNING_MODEL,
                messages=[
                    {"role": "system", "content": rerank_system_prompt},
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "citation": candidate,
                                "prefers_document_result": _citation_prefers_document_result(matched_text, label_hint),
                                "exact_matches": exact_payload,
                                "search_results": annotated_results[:_STUDY_WEB_SEARCH_MAX_RESULTS],
                            },
                            ensure_ascii=True,
                        ),
                    },
                ],
                temperature=0.0,
                max_tokens=min(OPENAI_PLANNING_MAX_TOKENS, 400),
                response_format={"type": "json_object"},
            )
            parsed = json.loads(response.choices[0].message.content or "{}")
        except Exception as exc:
            logger.warning("Journal AI source rerank failed for %r: %s", matched_text, exc)
            continue

        url = _normalize_study_link_url(str(parsed.get("selected_url") or "").strip())
        label = " ".join(str(parsed.get("label") or "").split()).strip() or label_hint
        if not url or not _HTTP_URL_RE.match(url) or _is_obviously_bad_likely_url(url):
            continue
        if not any(str(result.get("url") or "") == url for result in annotated_results):
            continue

        _append_study_link(
            links,
            seen_urls,
            seen_matches,
            JournalStudyLink(
                label=label,
                url=url,
                confidence="likely",
                matched_text=matched_text,
            ),
        )

        if len(links) >= _STUDY_LIKELY_MAX_RESULTS:
            break

    return links


def _extract_study_links(
    scripture_study: str,
    spiritual_notes: str,
    *,
    include_likely: bool = True,
) -> list[JournalStudyLink]:
    combined_text = "\n".join(part for part in [scripture_study, spiritual_notes] if part.strip())
    if not combined_text.strip():
        return []

    links: list[JournalStudyLink] = []
    seen_urls: set[str] = set()
    seen_matches: set[str] = set()

    for match in _ANY_URL_RE.finditer(combined_text):
        url = str(match.group("url") or "").strip().rstrip(".,;:")
        if not url:
            continue
        _append_study_link(
            links,
            seen_urls,
            seen_matches,
            JournalStudyLink(
                label="Gospel Library link" if "gospellibrary://" in url.lower() or "/study/" in url.lower() else "External link",
                url=url,
                confidence="exact",
                matched_text=url,
            )
        )

    for match in _GENERAL_CONFERENCE_CITATION_RE.finditer(combined_text):
        title = " ".join(str(match.group("title") or "").split()).strip()
        month = str(match.group("month") or "").strip().lower()
        year = str(match.group("year") or "").strip()
        if not title or not year:
            continue

        month_slug = "04" if month == "april" else "10"
        talk_slug = _slugify_study_text(title)
        if not talk_slug:
            continue

        url = _general_conference_talk_url(title, year, month_slug)
        matched_text = " ".join(match.group(0).split())
        _append_study_link(
            links,
            seen_urls,
            seen_matches,
            JournalStudyLink(
                label=f'{title} ({match.group("month")} {year})',
                url=url,
                confidence="exact",
                matched_text=matched_text,
            )
        )

    for match in _SCRIPTURE_REFERENCE_RE.finditer(combined_text):
        book = str(match.group("book") or "").strip()
        chapter = str(match.group("chapter") or "").strip()
        start = str(match.group("start") or "").strip() or None
        end = str(match.group("end") or "").strip() or None
        url = _scripture_reference_url(book, chapter, start, end)
        if not url:
            continue
        matched_text = " ".join(match.group(0).split())
        _append_study_link(
            links,
            seen_urls,
            seen_matches,
            JournalStudyLink(
                label=matched_text,
                url=url,
                confidence="exact",
                matched_text=matched_text,
            )
        )

    if include_likely:
        exact_links = [item for item in links if item.confidence == "exact"]
        links.extend(_ai_infer_likely_study_links(combined_text, exact_links, seen_urls, seen_matches))

    return _dedupe_study_links(links)[:12]


def _existing_likely_study_links(existing_links: list[JournalStudyLink]) -> list[JournalStudyLink]:
    return [link for link in existing_links if link.confidence == "likely"]


def _build_study_links_for_save(
    scripture_study: str,
    spiritual_notes: str,
    existing_links: list[JournalStudyLink],
    *,
    notes_changed: bool,
) -> list[JournalStudyLink]:
    exact_links = _extract_study_links(scripture_study, spiritual_notes, include_likely=False)
    if notes_changed:
        return exact_links
    return _dedupe_study_links([*exact_links, *_existing_likely_study_links(existing_links)])[:12]


def _parse_study_links(raw_value: Any) -> list[JournalStudyLink]:
    try:
        payload = json.loads(raw_value or "[]")
    except Exception:
        payload = []

    parsed: list[JournalStudyLink] = []
    for item in payload or []:
        try:
            parsed.append(JournalStudyLink.model_validate(item))
        except Exception:
            continue
    return parsed


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


def _date_label_from_key(day_key: str) -> str:
    return _format_date_label(date.fromisoformat(day_key))


def _build_journal_entries(
    day_keys: list[str],
    saved_entries: dict[str, dict[str, str | None]],
    user_id: str,
    today_local: date,
) -> list[JournalDayEntry]:
    if not day_keys:
        return []

    oldest_day = date.fromisoformat(day_keys[-1])
    newest_day = date.fromisoformat(day_keys[0])

    end_date = (newest_day + timedelta(days=1)).isoformat()
    raw_sessions = list_sessions_for_date_range(
        start_date=oldest_day.isoformat(),
        end_date=end_date,
        user_id=user_id,
    )
    sessions_by_day: dict[str, list[LanguagePracticeSession]] = {}
    for row in raw_sessions:
        day_key = (row["created_at"] or "")[:10]
        sessions_by_day.setdefault(day_key, []).append(
            LanguagePracticeSession(
                id=row["session_id"],
                language=row["language"],
                mode=row["mode"],
                minutes=row["minutes"],
                notes=row["notes"] or "",
                created_at=row["created_at"],
            )
        )
    agenda = list_events_between(
        datetime.combine(oldest_day, time.min, tzinfo=LOCAL_TIMEZONE),
        datetime.combine(newest_day + timedelta(days=1), time.min, tzinfo=LOCAL_TIMEZONE),
        max_results=max(500, len(day_keys) * 20),
    )

    events_by_day: dict[str, list] = {}
    for item in agenda.items:
        day_key = (item.start or "")[:10]
        events_by_day.setdefault(day_key, []).append(item)

    try:
        saved_entries = _ensure_persisted_world_news(
            saved_entries=saved_entries,
            day_keys=day_keys,
            today_local=today_local,
            user_id=user_id,
        )
    except Exception as exc:
        logger.warning("Journal news persistence failed: %s", exc)

    base_entries: list[dict[str, Any]] = []
    for day_key in day_keys:
        saved = saved_entries.get(day_key, {})
        calendar_items = _apply_calendar_overrides(
            events_by_day.get(day_key, []),
            saved.get("calendar_items_json"),
        )
        calendar_payload = [_calendar_payload_for_day(item) for item in calendar_items if not item.removed]
        calendar_items_json = json.dumps(calendar_payload, ensure_ascii=True)
        base_entries.append(
            {
                "date": day_key,
                "date_label": _date_label_from_key(day_key),
                "calendar_items": calendar_payload,
                "calendar_items_json": calendar_items_json,
                "calendar_items_full": calendar_items,
                "saved_calendar_summary": str(saved.get("calendar_summary") or "").strip(),
                "saved_calendar_items_json": str(saved.get("calendar_items_json") or "").strip() or "[]",
                "world_event_title": saved.get("world_event_title"),
                "world_event_source": saved.get("world_event_source"),
                "world_event_summary": str(saved.get("world_event_summary") or "").strip()
                or "No world headline was captured for this day.",
                "world_event_articles": _parse_news_articles(saved.get("news_articles_json")),
            }
        )

    missing_calendar_summary_entries = [
        entry
        for entry in base_entries
        if date.fromisoformat(entry["date"]) < today_local
        and (
            not entry["saved_calendar_summary"]
            or entry["saved_calendar_items_json"] != entry["calendar_items_json"]
        )
    ]

    persisted_calendar_summaries: dict[str, str] = {}
    if missing_calendar_summary_entries:
        ai_summaries = _ai_calendar_summaries(missing_calendar_summary_entries)
        for entry in missing_calendar_summary_entries:
            summary = str(
                (ai_summaries.get(entry["date"]) or {}).get("calendar_summary") or ""
            ).strip() or _fallback_calendar_summary(entry["calendar_items"])
            persisted = upsert_journal_calendar(
                entry_date=entry["date"],
                calendar_summary=summary,
                calendar_items_json=entry["calendar_items_json"],
                user_id=user_id,
            )
            persisted_summary = str(persisted.get("calendar_summary") or "").strip()
            persisted_calendar_summaries[entry["date"]] = persisted_summary
            saved_entries.setdefault(entry["date"], {}).update(persisted)

    entries: list[JournalDayEntry] = []
    for entry in base_entries:
        saved = saved_entries.get(entry["date"], {})
        calendar_summary = (
            persisted_calendar_summaries.get(entry["date"])
            or str(saved.get("calendar_summary") or "").strip()
            or _fallback_calendar_summary(entry["calendar_items"])
        )
        entries.append(
            JournalDayEntry(
                date=entry["date"],
                date_label=entry["date_label"],
                calendar_summary=calendar_summary,
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
                study_links=_parse_study_links(saved.get("study_links_json")),
                photo_data_url=saved.get("photo_data_url"),
                calendar_items=entry["calendar_items_full"],
                language_sessions=sessions_by_day.get(entry["date"], []),
                updated_at=saved.get("updated_at"),
            )
        )

    return entries


def get_journal(
    days: int = 14,
    before: str | None = None,
    saved_only: bool = False,
    query: str = "",
) -> JournalResponse:
    user_id = get_default_user_context().user_id
    clamped_days = max(1, min(days, 60))
    today_local = datetime.now(LOCAL_TIMEZONE).date()
    saved_entries = list_journal_entries(user_id=user_id)
    trimmed_query = query.strip()

    if saved_only or trimmed_query:
        date_rows = list_journal_entry_dates(
            limit=clamped_days + 1,
            before_date=before,
            query=trimmed_query,
            user_id=user_id,
        )
        has_more = len(date_rows) > clamped_days
        day_keys = date_rows[:clamped_days]
        next_before = day_keys[-1] if has_more and day_keys else None
        total_entries = count_journal_entries(query=trimmed_query, user_id=user_id)
        entries = _build_journal_entries(
            day_keys=day_keys,
            saved_entries=saved_entries,
            user_id=user_id,
            today_local=today_local,
        )
        return JournalResponse(
            generated_at=datetime.now(LOCAL_TIMEZONE).isoformat(),
            entries=entries,
            total_entries=total_entries,
            has_more=has_more,
            next_before=next_before,
            saved_only=True,
            query=trimmed_query,
        )

    page_end = date.fromisoformat(before) if before else today_local
    day_keys = [
        (page_end - timedelta(days=offset)).isoformat()
        for offset in range(clamped_days)
    ]
    entries = _build_journal_entries(
        day_keys=day_keys,
        saved_entries=saved_entries,
        user_id=user_id,
        today_local=today_local,
    )
    oldest_saved_date = get_oldest_journal_entry_date(user_id=user_id)
    next_before = (
        (date.fromisoformat(day_keys[-1]) - timedelta(days=1)).isoformat()
        if day_keys
        else None
    )
    has_more = bool(oldest_saved_date and next_before and oldest_saved_date <= next_before)

    return JournalResponse(
        generated_at=datetime.now(LOCAL_TIMEZONE).isoformat(),
        entries=entries,
        total_entries=len(entries),
        has_more=has_more,
        next_before=next_before if has_more else None,
        saved_only=False,
        query="",
    )


def get_journal_day(entry_date: str) -> JournalDayEntry:
    user_id = get_default_user_context().user_id
    day = date.fromisoformat(entry_date)
    today_local = datetime.now(LOCAL_TIMEZONE).date()
    saved_entries = list_journal_entries(user_id=user_id)
    entries = _build_journal_entries(
        day_keys=[day.isoformat()],
        saved_entries=saved_entries,
        user_id=user_id,
        today_local=today_local,
    )
    return entries[0]


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
    existing_entry = list_journal_entries(user_id=user_id).get(entry_date, {})
    existing_links = _parse_study_links(existing_entry.get("study_links_json"))
    notes_changed = (
        str(existing_entry.get("scripture_study") or "") != scripture_study
        or str(existing_entry.get("spiritual_notes") or "") != spiritual_notes
    )
    study_links = _build_study_links_for_save(
        scripture_study,
        spiritual_notes,
        existing_links,
        notes_changed=notes_changed,
    )
    saved = upsert_journal_entry(
        entry_date,
        journal_entry,
        accomplishments,
        gratitude_entry,
        scripture_study,
        spiritual_notes,
        json.dumps([item.model_dump() for item in study_links], ensure_ascii=True),
        photo_data_url,
        json.dumps([item.model_dump() for item in calendar_items], ensure_ascii=True),
        user_id=user_id,
    )
    day = date.fromisoformat(entry_date)
    return JournalDayEntry(
        date=entry_date,
        date_label=_format_date_label(day),
        calendar_summary=str(saved.get("calendar_summary") or "").strip()
        or _fallback_calendar_summary([item.model_dump() for item in calendar_items]),
        journal_entry=saved["journal_entry"],
        accomplishments=saved["accomplishments"],
        gratitude_entry=saved["gratitude_entry"],
        scripture_study=saved["scripture_study"],
        spiritual_notes=saved["spiritual_notes"],
        study_links=study_links,
        photo_data_url=saved.get("photo_data_url"),
        world_event_articles=[],
        calendar_items=[CalendarAgendaItem.model_validate(item) for item in json.loads(saved["calendar_items_json"] or "[]")],
        updated_at=saved["updated_at"],
    )


def extract_journal_day_citations(
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
    study_links = _extract_study_links(scripture_study, spiritual_notes, include_likely=True)
    saved = upsert_journal_entry(
        entry_date,
        journal_entry,
        accomplishments,
        gratitude_entry,
        scripture_study,
        spiritual_notes,
        json.dumps([item.model_dump() for item in study_links], ensure_ascii=True),
        photo_data_url,
        json.dumps([item.model_dump() for item in calendar_items], ensure_ascii=True),
        user_id=user_id,
    )
    day = date.fromisoformat(entry_date)
    return JournalDayEntry(
        date=entry_date,
        date_label=_format_date_label(day),
        calendar_summary=str(saved.get("calendar_summary") or "").strip()
        or _fallback_calendar_summary([item.model_dump() for item in calendar_items]),
        journal_entry=saved["journal_entry"],
        accomplishments=saved["accomplishments"],
        gratitude_entry=saved["gratitude_entry"],
        scripture_study=saved["scripture_study"],
        spiritual_notes=saved["spiritual_notes"],
        study_links=study_links,
        photo_data_url=saved.get("photo_data_url"),
        world_event_articles=[],
        calendar_items=[CalendarAgendaItem.model_validate(item) for item in json.loads(saved["calendar_items_json"] or "[]")],
        updated_at=saved["updated_at"],
    )
