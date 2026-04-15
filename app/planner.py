import json
import logging
from datetime import datetime
from hashlib import sha1
from typing import Any
import re

from openai import OpenAI

from app.calendar_client import list_upcoming_events
from app.config import DEFAULT_TIMEZONE, OPENAI_API_KEY, OPENAI_PLANNING_MAX_TOKENS, OPENAI_PLANNING_MODEL, OPENAI_PLANNING_TIMEOUT_SECONDS
from app.schemas import CalendarAgendaItem, PlanningItem, PlanningResponse

client = OpenAI(api_key=OPENAI_API_KEY)
logger = logging.getLogger(__name__)
SPECIAL_EVENT_KEYWORDS = {
    "final",
    "exam",
    "midterm",
    "quiz",
    "interview",
    "presentation",
    "defense",
}
PREP_KEYWORDS = {
    "study",
    "review",
    "prep",
    "prepare",
    "practice",
    "final",
    "exam",
    "interview",
    "presentation",
}
PLANNING_PRIORITIES = {"high", "medium", "low"}
PLANNING_KINDS = {"focus", "meeting_prep", "admin", "personal", "buffer"}
MAX_PLANNING_CALENDAR_EVENTS = 40
MAX_PLANNING_GOALS_CHARS = 3000


def _coerce_json_object(content: str) -> dict[str, Any]:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    start = content.find("{")
    end = content.rfind("}")
    candidate = content[start : end + 1] if start != -1 and end != -1 and end > start else content

    repaired: list[str] = []
    in_string = False
    escaped = False
    brace_depth = 0
    bracket_depth = 0

    for char in candidate:
        if in_string:
            if escaped:
                repaired.append(char)
                escaped = False
                continue

            if char == "\\":
                repaired.append(char)
                escaped = True
                continue

            if char == "\n":
                repaired.append("\\n")
                continue
            if char == "\r":
                repaired.append("\\r")
                continue
            if char == "\t":
                repaired.append("\\t")
                continue

            repaired.append(char)
            if char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
            repaired.append(char)
            continue

        if char == "{":
            brace_depth += 1
        elif char == "}":
            brace_depth = max(0, brace_depth - 1)
        elif char == "[":
            bracket_depth += 1
        elif char == "]":
            bracket_depth = max(0, bracket_depth - 1)

        repaired.append(char)

    if in_string:
        repaired.append('"')

    repaired.extend("]" * bracket_depth)
    repaired.extend("}" * brace_depth)

    return json.loads("".join(repaired))


def _json_chat_completion(system_prompt: str, user_prompt: str) -> dict[str, Any]:
    response = client.with_options(timeout=OPENAI_PLANNING_TIMEOUT_SECONDS).chat.completions.create(
        model=OPENAI_PLANNING_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.2,
        max_tokens=OPENAI_PLANNING_MAX_TOKENS,
        response_format={"type": "json_object"},
    )
    content = response.choices[0].message.content or "{}"
    return _coerce_json_object(content)


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None

    try:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def _tokenize(text: str) -> set[str]:
    return {token for token in re.findall(r"[a-z0-9]+", text.lower()) if len(token) > 2}


def _event_keywords(event: CalendarAgendaItem) -> set[str]:
    return _tokenize(event.title) & SPECIAL_EVENT_KEYWORDS


def _planning_keywords(item: PlanningItem) -> set[str]:
    return _tokenize(f"{item.title} {item.rationale}") & PREP_KEYWORDS


def _items_overlap(start_a: datetime | None, end_a: datetime | None, start_b: datetime | None, end_b: datetime | None) -> bool:
    if not start_a or not end_a or not start_b or not end_b:
        return False
    return start_a < end_b and start_b < end_a


def _validate_plan(items: list[PlanningItem], calendar_items: list[CalendarAgendaItem]) -> list[str]:
    problems: list[str] = []

    for item in items:
        item_start = _parse_iso_datetime(item.start)
        item_end = _parse_iso_datetime(item.end)
        item_keywords = _planning_keywords(item)

        for event in calendar_items:
            event_start = _parse_iso_datetime(event.start)
            event_end = _parse_iso_datetime(event.end)

            if _items_overlap(item_start, item_end, event_start, event_end):
                problems.append(
                    f"'{item.title}' overlaps calendar event '{event.title}' from {event.start} to {event.end or event.start}."
                )
                continue

            event_keywords = _event_keywords(event)
            if not item_keywords or not event_keywords:
                continue

            if item_keywords & event_keywords and event_start and item_start and item_start >= event_start:
                problems.append(
                    f"'{item.title}' looks like preparation for '{event.title}' but is scheduled at or after the event start ({event.start})."
                )

    return problems


def _item_has_problem(item: PlanningItem, calendar_items: list[CalendarAgendaItem]) -> bool:
    item_start = _parse_iso_datetime(item.start)
    item_end = _parse_iso_datetime(item.end)
    item_keywords = _planning_keywords(item)

    for event in calendar_items:
        event_start = _parse_iso_datetime(event.start)
        event_end = _parse_iso_datetime(event.end)
        if _items_overlap(item_start, item_end, event_start, event_end):
            return True

        event_keywords = _event_keywords(event)
        if item_keywords and event_keywords and event_start and item_start and item_keywords & event_keywords and item_start >= event_start:
            return True

    return False


def _prune_conflicting_items(items: list[PlanningItem], calendar_items: list[CalendarAgendaItem]) -> list[PlanningItem]:
    return [item for item in items if not _item_has_problem(item, calendar_items)]


def _calendar_context_for_planning(items: list[CalendarAgendaItem]) -> list[dict[str, Any]]:
    context: list[dict[str, Any]] = []
    for item in items[:MAX_PLANNING_CALENDAR_EVENTS]:
        context.append(
            {
                "title": item.title[:160],
                "start": item.start,
                "end": item.end,
                "is_all_day": item.is_all_day,
                "location": (item.location or "")[:120] or None,
            }
        )
    return context


def _plan_response_from_parsed(parsed: dict[str, Any]) -> PlanningResponse:
    items_payload = parsed.get("items") or []
    normalized_items: list[PlanningItem] = []

    for index, item in enumerate(items_payload, start=1):
        payload = dict(item or {})
        raw_priority = str(payload.get("priority") or "").strip().lower()
        raw_kind = str(payload.get("kind") or "").strip().lower()

        if raw_priority in PLANNING_KINDS and raw_kind in PLANNING_PRIORITIES:
            payload["priority"] = raw_kind
            payload["kind"] = raw_priority
        else:
            if raw_priority not in PLANNING_PRIORITIES:
                payload["priority"] = "medium"
            else:
                payload["priority"] = raw_priority

            if raw_kind not in PLANNING_KINDS:
                payload["kind"] = "focus"
            else:
                payload["kind"] = raw_kind

        item_seed = f"{index}-{payload.get('title', '')}-{payload.get('start', '')}"
        payload["id"] = f"plan-{sha1(item_seed.encode('utf-8')).hexdigest()[:10]}"
        try:
            normalized_items.append(PlanningItem.model_validate(payload))
        except Exception:
            continue

    return PlanningResponse(
        summary=str(parsed.get("summary") or "A realistic plan was generated from your goals."),
        strategy=str(parsed.get("strategy") or "The plan balances your priorities around existing events."),
        priorities=[str(priority) for priority in (parsed.get("priorities") or []) if str(priority).strip()],
        items=normalized_items,
    )


def generate_schedule_plan(goals: str, days: int = 7) -> PlanningResponse:
    try:
        if not OPENAI_API_KEY:
            return fallback_planning_response("OPENAI_API_KEY is not configured for planning.")

        trimmed_goals = (goals or "").strip()[:MAX_PLANNING_GOALS_CHARS]
        if not trimmed_goals:
            return fallback_planning_response("Add some goals or constraints before generating a plan.")

        logger.warning("Planning request started: days=%s goals_len=%s", days, len(trimmed_goals))
        agenda = list_upcoming_events(days=days, max_results=MAX_PLANNING_CALENDAR_EVENTS)
        calendar_context = _calendar_context_for_planning(agenda.items)
        logger.warning("Planning calendar context ready: events=%s", len(calendar_context))
        target_block_range = (
            "3-5" if days <= 2 else
            "5-8" if days <= 4 else
            "8-12"
        )

        system_prompt = f"""
You are a thoughtful weekly planning assistant.
Build a realistic schedule that fits around existing calendar commitments.
Prefer concrete working blocks over vague advice.
Keep the plan achievable and leave some buffer.
Assume the user's timezone is {DEFAULT_TIMEZONE}.

Return exactly one valid JSON object with these fields:
- summary: one short paragraph, max 2 sentences
- strategy: one short paragraph, max 2 sentences
- priorities: array of 2-4 short priority strings
- items: array of {target_block_range} schedule blocks, each with:
  - title
  - start: RFC3339 datetime
  - end: RFC3339 datetime
  - day_label: friendly day label like Monday
  - priority: one of [high, medium, low]
  - kind: one of [focus, meeting_prep, admin, personal, buffer]
  - rationale: one short sentence

Rules:
- Treat every provided calendar event as a hard busy block that cannot be overlapped.
- Never schedule study, review, prep, or practice for a class/exam/interview during that event itself.
- If a calendar event is a final, exam, interview, or presentation, any preparation for it must happen before the event starts.
- Make blocks between 30 and 180 minutes.
- Spread work across the requested planning window instead of front-loading everything.
- When the planning horizon is more than 3 days, distribute blocks across multiple days unless the user's request clearly belongs on one day.
- Cover the user's major goals for the week, not just the single most urgent task.
- Prefer multiple concrete blocks over one oversized catch-all block.
- Include at least one buffer block if the week has multiple items.
- Keep titles and rationale concise.
- Use the current date as the planning anchor.
""".strip()

        user_prompt = f"""
Today: {datetime.now().isoformat()}
Planning horizon (days): {days}

What the user wants to get done:
{trimmed_goals}

        Existing calendar events:
{json.dumps(calendar_context, indent=2)}
""".strip()

        try:
            logger.warning("Planning AI request started")
            parsed = _json_chat_completion(system_prompt, user_prompt)
        except Exception as exc:
            logger.exception("Planning AI request failed")
            return fallback_planning_response(f"AI planning failed: {exc}")

        try:
            plan = _plan_response_from_parsed(parsed)
        except Exception as exc:
            logger.exception("Planning parse failed")
            return fallback_planning_response(f"AI planning returned invalid data: {exc}")

        problems = _validate_plan(plan.items, agenda.items)
        logger.warning("Planning validation: items=%s problems=%s", len(plan.items), len(problems))

        if problems:
            pruned_items = _prune_conflicting_items(plan.items, agenda.items)
            if pruned_items:
                dropped_count = len(plan.items) - len(pruned_items)
                summary_suffix = (
                    f" {dropped_count} conflicting block"
                    f"{'' if dropped_count == 1 else 's'} were removed so the plan still fits your calendar."
                )
                return plan.model_copy(
                    update={
                        "summary": f"{plan.summary}{summary_suffix}",
                        "strategy": (
                            f"{plan.strategy} Jarvis removed the blocks that still conflicted with existing calendar events."
                        ),
                        "items": pruned_items,
                    }
                )

            return PlanningResponse(
                summary="Jarvis could not build a conflict-free plan from that request.",
                strategy=(
                    "Your calendar had too many collisions with the generated schedule, so no blocks were added. "
                    "Try regenerating with a smaller scope, looser constraints, or a shorter planning horizon."
                ),
                priorities=[],
                items=[],
            )

        logger.warning("Planning request succeeded: items=%s", len(plan.items))
        return plan
    except Exception as exc:
        logger.exception("Unexpected planning error")
        return fallback_planning_response(f"Unexpected planning error: {exc}")


def fallback_planning_response(reason: str) -> PlanningResponse:
    logger.warning("Planning fallback used: %s", reason)
    return PlanningResponse(
        summary="Jarvis could not generate a complete plan this time.",
        strategy=reason,
        priorities=[],
        items=[],
    )
