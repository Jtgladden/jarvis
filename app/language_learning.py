import json
import logging
from datetime import datetime
from hashlib import sha1
from pathlib import Path
from typing import Any
from fastapi import UploadFile
from openai import OpenAI

from app.config import (
    OPENAI_API_KEY,
    OPENAI_LANGUAGE_MAX_TOKENS,
    OPENAI_LANGUAGE_MODEL,
    OPENAI_TRANSCRIPTION_MODEL,
    OPENAI_TTS_MODEL,
    OPENAI_TTS_VOICE,
)
from app.schemas import (
    LanguageCode,
    LanguageConversationRequest,
    LanguageConversationResponse,
    LanguageDashboardResponse,
    LanguageFeedbackResponse,
    LanguageMetadata,
    LanguagePracticeGenerateRequest,
    LanguagePracticeGenerateResponse,
    LanguagePracticePrompt,
    LanguagePracticeSession,
    LanguagePracticeSessionCreateRequest,
    LanguageProfile,
    LanguageProfileUpdateRequest,
    LanguageProgressByLanguage,
    LanguageSpeechRequest,
    LanguageProgressSummary,
    LanguageWritingFeedbackRequest,
    LanguageVocabCreateRequest,
    LanguageVocabItem,
    LanguageVocabNormalizeResponse,
    LanguageVocabUpdateRequest,
    LanguageWordExample,
    LanguageWordExplainRequest,
    LanguageWordExplainResponse,
)
from app.language_store import (
    delete_vocab_record,
    get_all_language_session_stats,
    get_language_stats,
    get_profile_record,
    get_word_explanation_record,
    list_session_records,
    list_vocab_records,
    review_vocab_record,
    seed_common_word_records,
    save_word_explanation_record,
    save_profile_record,
    save_session_record,
    save_vocab_record,
    update_vocab_record,
)
from app.user_context import get_default_user_context

logger = logging.getLogger(__name__)
client = OpenAI(api_key=OPENAI_API_KEY)

SUPPORTED_LANGUAGES: list[LanguageMetadata] = [
    LanguageMetadata(
        code="tagalog",
        name="Tagalog",
        local_name="Tagalog",
        script_hint="Latin script",
        greeting="Kumusta?",
        focus_topics=["daily life", "family", "food", "travel", "feelings"],
    ),
    LanguageMetadata(
        code="hiligaynon",
        name="Hiligaynon",
        local_name="Ilonggo",
        script_hint="Latin script",
        greeting="Kamusta?",
        focus_topics=["greetings", "family", "market phrases", "directions", "home"],
    ),
    LanguageMetadata(
        code="japanese",
        name="Japanese",
        local_name="日本語",
        script_hint="Kana, kanji, and romaji support",
        greeting="こんにちは",
        focus_topics=["kana", "polite forms", "travel", "food", "daily routines"],
    ),
    LanguageMetadata(
        code="spanish",
        name="Spanish",
        local_name="Español",
        script_hint="Latin script",
        greeting="Hola",
        focus_topics=["conversation", "verbs", "travel", "work", "daily routines"],
    ),
]

DEFAULT_TARGET_LANGUAGES: list[LanguageCode] = ["tagalog", "hiligaynon", "japanese", "spanish"]
COMMON_WORDS_PATH = Path(__file__).with_name("language_common_words.json")
_common_words_seeded_users: set[str] = set()
DAILY_FOCUS_WORD_COUNT = 12

STARTER_PROMPTS: dict[LanguageCode, list[LanguagePracticePrompt]] = {
    "tagalog": [
        LanguagePracticePrompt(id="tagalog-greeting", mode="conversation", title="Warm greeting", prompt="Greet someone, ask how they are, and say you are doing well.", target_phrase="Kumusta ka?", translation="How are you?", notes="Use po/opo when you want to sound more respectful."),
        LanguagePracticePrompt(id="tagalog-want", mode="grammar", title="I want to...", prompt="Make three sentences with 'Gusto kong...' about food, movement, and study.", target_phrase="Gusto kong matuto ng Tagalog.", translation="I want to learn Tagalog.", notes="Kong is ko + ng."),
        LanguagePracticePrompt(id="tagalog-journal", mode="writing", title="Three-sentence journal", prompt="Write three simple sentences about your day in Tagalog.", target_phrase="Maganda ang araw ko.", translation="My day is good.", notes="Keep it simple and reusable."),
    ],
    "hiligaynon": [
        LanguagePracticePrompt(id="hiligaynon-greeting", mode="conversation", title="Start a chat", prompt="Greet someone, ask how they are, and answer politely.", target_phrase="Kamusta ka?", translation="How are you?", notes="Hiligaynon is also commonly called Ilonggo."),
        LanguagePracticePrompt(id="hiligaynon-want", mode="grammar", title="I want to...", prompt="Make three sentences with 'Gusto ko...' about eating, going, and learning.", target_phrase="Gusto ko magtuon sang Hiligaynon.", translation="I want to study Hiligaynon.", notes="Sang can mark an object or relation depending on the phrase."),
        LanguagePracticePrompt(id="hiligaynon-home", mode="vocabulary", title="Home phrases", prompt="Save five words or phrases you would use at home or with family.", target_phrase="Salamat gid.", translation="Thank you very much.", notes="Gid adds emphasis."),
    ],
    "japanese": [
        LanguagePracticePrompt(id="japanese-greeting", mode="conversation", title="Polite greeting", prompt="Greet someone, introduce yourself, and say nice to meet you.", target_phrase="はじめまして。", romanization="Hajimemashite.", translation="Nice to meet you.", notes="Keep beginner practice in polite style first."),
        LanguagePracticePrompt(id="japanese-want", mode="grammar", title="I want to do...", prompt="Make three sentences using verb stem + たいです.", target_phrase="日本語を勉強したいです。", romanization="Nihongo o benkyou shitai desu.", translation="I want to study Japanese.", notes="したいです is the polite form of wanting to do something."),
        LanguagePracticePrompt(id="japanese-shadow", mode="listening", title="Shadowing line", prompt="Read this line aloud five times, then say it without looking.", target_phrase="今日はいい天気ですね。", romanization="Kyou wa ii tenki desu ne.", translation="The weather is nice today.", notes="Use romaji only as a bridge, then phase it out."),
    ],
    "spanish": [
        LanguagePracticePrompt(id="spanish-greeting", mode="conversation", title="Quick check-in", prompt="Greet someone, ask how they are, and say what you are doing today.", target_phrase="¿Cómo estás?", translation="How are you?", notes="Use estoy for temporary states."),
        LanguagePracticePrompt(id="spanish-want", mode="grammar", title="Quiero...", prompt="Make three sentences with 'Quiero...' about food, travel, and practice.", target_phrase="Quiero practicar español.", translation="I want to practice Spanish.", notes="Infinitive verbs follow quiero."),
        LanguagePracticePrompt(id="spanish-journal", mode="writing", title="Mini journal", prompt="Write four short sentences about yesterday and today.", target_phrase="Ayer caminé. Hoy estudio.", translation="Yesterday I walked. Today I study.", notes="Mix one past-tense sentence with present-tense sentences."),
    ],
}

LANGUAGE_NAMES: dict[LanguageCode, str] = {
    language.code: language.name for language in SUPPORTED_LANGUAGES
}


def _coerce_json_object(content: str) -> dict[str, Any]:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    start = content.find("{")
    end = content.rfind("}")
    if start != -1 and end != -1 and end > start:
        return json.loads(content[start : end + 1])
    return {}


def _json_chat_completion(system_prompt: str, user_payload: dict[str, Any]) -> dict[str, Any]:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is required for AI language practice.")

    response = client.chat.completions.create(
        model=OPENAI_LANGUAGE_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
        temperature=0.4,
        max_tokens=OPENAI_LANGUAGE_MAX_TOKENS,
        response_format={"type": "json_object"},
    )
    return _coerce_json_object(response.choices[0].message.content or "{}")


def _profile_from_record(row) -> LanguageProfile:
    if row is None:
        return LanguageProfile(
            target_languages=DEFAULT_TARGET_LANGUAGES,
            active_language="tagalog",
            level="beginner",
            daily_goal_minutes=15,
            correction_style="gentle",
            romanization=True,
        )

    try:
        targets = json.loads(row["target_languages"])
    except (TypeError, json.JSONDecodeError):
        targets = DEFAULT_TARGET_LANGUAGES

    return LanguageProfile(
        target_languages=targets or DEFAULT_TARGET_LANGUAGES,
        active_language=row["active_language"],
        level=row["level"],
        daily_goal_minutes=row["daily_goal_minutes"],
        correction_style=row["correction_style"],
        romanization=bool(row["romanization"]),
        updated_at=row["updated_at"],
    )


def _vocab_from_record(row) -> LanguageVocabItem:
    try:
        tags = json.loads(row["tags"] or "[]")
    except json.JSONDecodeError:
        tags = []

    return LanguageVocabItem(
        id=row["vocab_id"],
        language=row["language"],
        phrase=row["phrase"],
        translation=row["translation"],
        pronunciation=row["pronunciation"] or "",
        notes=row["notes"],
        tags=tags,
        review_count=row["review_count"],
        last_reviewed_at=row["last_reviewed_at"],
        next_review_at=row["next_review_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _session_from_record(row) -> LanguagePracticeSession:
    return LanguagePracticeSession(
        id=row["session_id"],
        language=row["language"],
        mode=row["mode"],
        minutes=row["minutes"],
        notes=row["notes"],
        created_at=row["created_at"],
    )


def _load_common_words() -> dict[str, list[dict]]:
    if not COMMON_WORDS_PATH.exists():
        return {}
    return json.loads(COMMON_WORDS_PATH.read_text(encoding="utf-8"))


def _ensure_common_words_seeded(user_id: str) -> None:
    if user_id in _common_words_seeded_users:
        return
    common_words = _load_common_words()
    if common_words:
        seed_common_word_records(common_words, user_id=user_id)
    _common_words_seeded_users.add(user_id)


def _rank_from_tags(tags: list[str]) -> int:
    for tag in tags:
        if tag.startswith("rank-"):
            try:
                return int(tag.removeprefix("rank-"))
            except ValueError:
                return 9999
    return 9999


def _daily_focus_words(
    vocab: list[LanguageVocabItem],
    language: LanguageCode,
    count: int = DAILY_FOCUS_WORD_COUNT,
) -> list[LanguageVocabItem]:
    today = datetime.utcnow().date().isoformat()
    language_words = [
        item
        for item in vocab
        if item.language == language and "word" in item.tags
    ]
    due_words = [
        item
        for item in language_words
        if not item.next_review_at or item.next_review_at <= f"{today}T23:59:59Z"
    ]
    due_words.sort(key=lambda item: (_rank_from_tags(item.tags), item.phrase.lower()))

    selected: list[LanguageVocabItem] = []
    seen: set[str] = set()
    for item in due_words:
        key = item.phrase.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        selected.append(item)
        if len(selected) >= count:
            return selected

    remaining = [
        item
        for item in language_words
        if item.phrase.strip().lower() not in seen
    ]
    remaining.sort(
        key=lambda item: sha1(
            f"{today}:{language}:{item.id}:{item.phrase}".encode("utf-8")
        ).hexdigest()
    )
    for item in remaining:
        key = item.phrase.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        selected.append(item)
        if len(selected) >= count:
            break
    return selected


def _language_progress_summary(
    vocab: list[LanguageVocabItem],
    user_id: str,
    now: str,
) -> list[LanguageProgressByLanguage]:
    session_stats = get_all_language_session_stats(user_id=user_id)
    progress: list[LanguageProgressByLanguage] = []
    for language in DEFAULT_TARGET_LANGUAGES:
        language_vocab = [item for item in vocab if item.language == language]
        stats = session_stats.get(language, {})
        progress.append(
            LanguageProgressByLanguage(
                language=language,
                today_minutes=int(stats.get("today_minutes") or 0),
                total_minutes=int(stats.get("minutes_practiced") or 0),
                sessions_count=int(stats.get("sessions_count") or 0),
                words_count=sum(1 for item in language_vocab if "word" in item.tags),
                phrases_count=sum(1 for item in language_vocab if "word" not in item.tags),
                due_reviews=sum(
                    1
                    for item in language_vocab
                    if not item.next_review_at or item.next_review_at <= now
                ),
            )
        )
    return progress


def get_language_dashboard() -> LanguageDashboardResponse:
    user_id = get_default_user_context().user_id
    _ensure_common_words_seeded(user_id)
    profile = _profile_from_record(get_profile_record(user_id=user_id))
    vocab = [_vocab_from_record(row) for row in list_vocab_records(user_id=user_id)]
    sessions = [_session_from_record(row) for row in list_session_records(user_id=user_id)]
    now = datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    due_reviews = sum(
        1
        for item in vocab
        if item.language == profile.active_language
        and (not item.next_review_at or item.next_review_at <= now)
    )
    lang_stats = get_language_stats(language=profile.active_language, user_id=user_id)
    return LanguageDashboardResponse(
        profile=profile,
        supported_languages=SUPPORTED_LANGUAGES,
        daily_prompts=STARTER_PROMPTS[profile.active_language],
        daily_focus_words=_daily_focus_words(vocab, profile.active_language),
        vocab=vocab,
        recent_sessions=sessions,
        progress=LanguageProgressSummary(
            sessions_count=len(sessions),
            minutes_practiced=sum(session.minutes for session in sessions),
            vocab_count=len(vocab),
            due_reviews=due_reviews,
            today_minutes=lang_stats["today_minutes"],
            language_minutes=lang_stats["language_minutes"],
            language_sessions_count=lang_stats["language_sessions_count"],
        ),
        language_progress=_language_progress_summary(vocab, user_id, now),
    )


def delete_language_vocab(vocab_id: str) -> None:
    user_id = get_default_user_context().user_id
    delete_vocab_record(vocab_id=vocab_id, user_id=user_id)


def update_language_vocab(vocab_id: str, payload: LanguageVocabUpdateRequest) -> LanguageVocabItem:
    user_id = get_default_user_context().user_id
    phrase = payload.phrase.strip()
    if not phrase:
        raise ValueError("Vocabulary phrase is required.")
    row = update_vocab_record(
        vocab_id=vocab_id,
        phrase=phrase,
        translation=payload.translation.strip(),
        pronunciation=payload.pronunciation.strip(),
        notes=payload.notes.strip(),
        tags=[tag.strip() for tag in payload.tags if tag.strip()],
        user_id=user_id,
    )
    return _vocab_from_record(row)


def update_language_profile(payload: LanguageProfileUpdateRequest) -> LanguageProfile:
    user_id = get_default_user_context().user_id
    targets = payload.target_languages or DEFAULT_TARGET_LANGUAGES
    active_language = payload.active_language if payload.active_language in targets else targets[0]
    row = save_profile_record(
        target_languages=targets,
        active_language=active_language,
        level=payload.level,
        daily_goal_minutes=payload.daily_goal_minutes,
        correction_style=payload.correction_style,
        romanization=payload.romanization,
        user_id=user_id,
    )
    return _profile_from_record(row)


def _normalize_vocab_with_ai(payload: LanguageVocabCreateRequest) -> dict[str, Any]:
    tags = [tag.strip() for tag in payload.tags if tag.strip()]
    is_word = "word" in tags
    card_kind = "word" if is_word else "phrase"

    try:
        result = _json_chat_completion(
            (
                "You normalize learner-created vocabulary cards. Return only JSON. "
                "Do not add unrelated meanings. Keep the card beginner-friendly and concise. "
                "Preserve whether the card is a single word or a phrase. For phrases, keep the phrase natural "
                "and useful for conversation; do not reduce it to a single dictionary word. "
                "For Japanese, if the learner enters romaji, convert the headword or phrase to the most natural "
                "Japanese writing for the card, preferring kana for beginner words unless kanji is essential. "
                "Always put romaji in the pronunciation field for Japanese — not in notes. "
                "For Spanish, preserve accents and punctuation. "
                "For Tagalog and Hiligaynon, normalize spelling and keep learner-friendly notes. "
                "If the input is ambiguous, choose the most common beginner meaning and mention ambiguity in notes."
            ),
            {
                "language": payload.language,
                "card_kind": card_kind,
                "input_text": payload.phrase,
                "input_translation": payload.translation,
                "input_notes": payload.notes,
                "input_tags": tags,
                "schema": {
                    "phrase": "normalized word or phrase in the target language",
                    "translation": "short English gloss",
                    "pronunciation": "reading aid — romaji for Japanese, empty string for Latin-script languages",
                    "notes": "short learner note about meaning, usage, or nuance; do not repeat the pronunciation here",
                    "tags": [card_kind, "part-of-speech, phrase type, or helpful category"],
                },
            },
        )
    except Exception as exc:
        logger.warning("Vocabulary normalization failed; saving raw entry: %s", exc)
        return {
            "phrase": payload.phrase.strip(),
            "translation": payload.translation.strip(),
            "pronunciation": payload.pronunciation.strip(),
            "notes": payload.notes.strip(),
            "tags": tags,
        }

    normalized_tags = [str(tag).strip() for tag in result.get("tags") or [] if str(tag).strip()]
    normalized_tags = [tag for tag in normalized_tags if tag not in {"word", "phrase"}]
    normalized_tags.insert(0, card_kind)
    if "ai-normalized" not in normalized_tags:
        normalized_tags.append("ai-normalized")

    phrase = str(result.get("phrase") or payload.phrase).strip()
    translation = str(result.get("translation") or payload.translation).strip()
    pronunciation = str(result.get("pronunciation") or payload.pronunciation or "").strip()
    notes = str(result.get("notes") or payload.notes).strip()
    if payload.notes.strip() and payload.notes.strip() not in notes:
        notes = f"{notes}\nUser note: {payload.notes.strip()}" if notes else payload.notes.strip()

    return {
        "phrase": phrase,
        "translation": translation,
        "pronunciation": pronunciation,
        "notes": notes,
        "tags": normalized_tags,
    }


def create_language_vocab(payload: LanguageVocabCreateRequest) -> LanguageVocabItem:
    user_id = get_default_user_context().user_id
    phrase = payload.phrase.strip()
    if not phrase:
        raise ValueError("Vocabulary phrase is required.")
    normalized = _normalize_vocab_with_ai(payload)
    row = save_vocab_record(
        language=payload.language,
        phrase=normalized["phrase"],
        translation=normalized["translation"],
        pronunciation=normalized["pronunciation"],
        notes=normalized["notes"],
        tags=normalized["tags"],
        user_id=user_id,
    )
    return _vocab_from_record(row)


def normalize_existing_language_vocab(max_items: int = 30) -> LanguageVocabNormalizeResponse:
    user_id = get_default_user_context().user_id
    profile = _profile_from_record(get_profile_record(user_id=user_id))
    vocab = [_vocab_from_record(row) for row in list_vocab_records(user_id=user_id)]
    candidates = [
        item
        for item in vocab
        if item.language == profile.active_language
        and "ai-normalized" not in item.tags
        and "common-600" not in item.tags
    ][:max_items]

    normalized_items: list[LanguageVocabItem] = []
    skipped_count = 0
    for item in candidates:
        normalized = _normalize_vocab_with_ai(
            LanguageVocabCreateRequest(
                language=item.language,
                phrase=item.phrase,
                translation=item.translation,
                pronunciation=item.pronunciation,
                notes=item.notes,
                tags=item.tags,
            )
        )
        changed = (
            normalized["phrase"] != item.phrase
            or normalized["translation"] != item.translation
            or normalized["pronunciation"] != item.pronunciation
            or normalized["notes"] != item.notes
            or normalized["tags"] != item.tags
        )
        if not changed or "ai-normalized" not in normalized["tags"]:
            skipped_count += 1
            continue
        row = update_vocab_record(
            vocab_id=item.id,
            phrase=normalized["phrase"],
            translation=normalized["translation"],
            pronunciation=normalized["pronunciation"],
            notes=normalized["notes"],
            tags=normalized["tags"],
            user_id=user_id,
        )
        normalized_items.append(_vocab_from_record(row))

    return LanguageVocabNormalizeResponse(
        normalized_count=len(normalized_items),
        skipped_count=skipped_count,
        items=normalized_items,
    )


def review_language_vocab(vocab_id: str, remembered: bool) -> LanguageVocabItem:
    return _vocab_from_record(
        review_vocab_record(
            vocab_id=vocab_id,
            remembered=remembered,
            user_id=get_default_user_context().user_id,
        )
    )


def create_language_session(payload: LanguagePracticeSessionCreateRequest) -> LanguagePracticeSession:
    user_id = get_default_user_context().user_id
    row = save_session_record(
        language=payload.language,
        mode=payload.mode,
        minutes=payload.minutes,
        notes=payload.notes.strip(),
        user_id=user_id,
    )
    session = _session_from_record(row)
    return session


def generate_language_practice(payload: LanguagePracticeGenerateRequest) -> LanguagePracticeGenerateResponse:
    user_id = get_default_user_context().user_id
    saved_vocab = [_vocab_from_record(row) for row in list_vocab_records(user_id=user_id, limit=30)]
    language_vocab = [
        {
            "phrase": item.phrase,
            "translation": item.translation,
            "tags": item.tags,
            "review_count": item.review_count,
        }
        for item in saved_vocab
        if item.language == payload.language
    ][:12]
    language_name = LANGUAGE_NAMES[payload.language]
    result = _json_chat_completion(
        system_prompt=(
            "You create compact, practical foreign-language study sessions. "
            "Return strict JSON with title, overview, suggested_minutes, and prompts. "
            "Prompts must be useful for self-study and may include conversation, vocabulary, "
            "writing, grammar, and listening. Keep explanations concise. For Japanese, include "
            "kana/kanji when appropriate and always include romaji in the romanization field. "
            "For Hiligaynon, avoid pretending certainty about rare forms; use common Ilonggo phrases."
        ),
        user_payload={
            "language": language_name,
            "language_code": payload.language,
            "level": payload.level,
            "mode": payload.mode,
            "focus": payload.focus,
            "saved_vocab": language_vocab if payload.include_saved_vocab else [],
            "starter_examples": [prompt.model_dump() for prompt in STARTER_PROMPTS[payload.language]],
            "json_shape": {
                "title": "string",
                "overview": "string",
                "suggested_minutes": 15,
                "prompts": [
                    {
                        "id": "string",
                        "mode": "conversation|vocabulary|writing|grammar|listening",
                        "title": "string",
                        "prompt": "string",
                        "target_phrase": "string",
                        "romanization": "romaji for Japanese target phrase, otherwise empty string",
                        "translation": "string",
                        "notes": "string",
                        "expected_answer": "string",
                    }
                ],
            },
        },
    )

    prompts = []
    for index, item in enumerate(result.get("prompts") or []):
        if not isinstance(item, dict):
            continue
        mode = item.get("mode") if item.get("mode") in {"conversation", "vocabulary", "writing", "grammar", "listening"} else "conversation"
        prompts.append(
            LanguagePracticePrompt(
                id=str(item.get("id") or f"ai-{payload.language}-{index}"),
                mode=mode,
                title=str(item.get("title") or "Practice prompt"),
                prompt=str(item.get("prompt") or ""),
                target_phrase=str(item.get("target_phrase") or ""),
                romanization=str(item.get("romanization") or ""),
                translation=str(item.get("translation") or ""),
                notes=str(item.get("notes") or ""),
                expected_answer=str(item.get("expected_answer") or ""),
            )
        )

    if not prompts:
        prompts = STARTER_PROMPTS[payload.language]

    return LanguagePracticeGenerateResponse(
        language=payload.language,
        level=payload.level,
        title=str(result.get("title") or f"{language_name} practice"),
        overview=str(result.get("overview") or "A focused language practice session."),
        prompts=prompts[:6],
        suggested_minutes=int(result.get("suggested_minutes") or 15),
    )


def get_language_writing_feedback(payload: LanguageWritingFeedbackRequest) -> LanguageFeedbackResponse:
    language_name = LANGUAGE_NAMES[payload.language]
    result = _json_chat_completion(
        system_prompt=(
            "You are a careful language tutor. Return strict JSON. Correct the learner's text, "
            "explain the most important issues, and give short drills. Be encouraging but precise. "
            "Score should be 0-100 and reflect clarity, grammar, vocabulary, and naturalness."
        ),
        user_payload={
            "language": language_name,
            "level": payload.level,
            "correction_style": payload.correction_style,
            "prompt": payload.prompt,
            "learner_response": payload.response,
            "json_shape": {
                "score": 75,
                "corrected_text": "string",
                "feedback": "string",
                "strengths": ["string"],
                "fixes": ["string"],
                "drills": ["string"],
            },
        },
    )
    return LanguageFeedbackResponse(
        score=int(result.get("score") or 0),
        corrected_text=str(result.get("corrected_text") or ""),
        feedback=str(result.get("feedback") or ""),
        strengths=[str(item) for item in result.get("strengths") or []][:5],
        fixes=[str(item) for item in result.get("fixes") or []][:5],
        drills=[str(item) for item in result.get("drills") or []][:5],
    )


async def get_language_pronunciation_feedback(
    *,
    language: LanguageCode,
    level: str,
    target_text: str,
    audio: UploadFile,
) -> LanguageFeedbackResponse:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is required for pronunciation feedback.")

    contents = await audio.read()
    if not contents:
        raise ValueError("Audio recording is required.")
    if len(contents) > 25 * 1024 * 1024:
        raise ValueError("Audio recording must be smaller than 25 MB.")

    filename = audio.filename or "recording.webm"
    transcription = client.audio.transcriptions.create(
        model=OPENAI_TRANSCRIPTION_MODEL,
        file=(filename, contents, audio.content_type or "audio/webm"),
        language=None,
    )
    transcript = getattr(transcription, "text", "") or ""
    language_name = LANGUAGE_NAMES[language]
    result = _json_chat_completion(
        system_prompt=(
            "You evaluate pronunciation practice from a transcript. You cannot hear phonemes directly, "
            "so be explicit that feedback is based on speech recognition and target-text comparison. "
            "Return strict JSON with score, feedback, strengths, fixes, and drills. Focus on likely "
            "pronunciation, rhythm, missing syllables, and phrase-level repetition."
        ),
        user_payload={
            "language": language_name,
            "level": level,
            "target_text": target_text,
            "transcript": transcript,
            "json_shape": {
                "score": 70,
                "feedback": "string",
                "strengths": ["string"],
                "fixes": ["string"],
                "drills": ["string"],
            },
        },
    )
    return LanguageFeedbackResponse(
        transcript=transcript,
        target_text=target_text,
        score=int(result.get("score") or 0),
        feedback=str(result.get("feedback") or ""),
        strengths=[str(item) for item in result.get("strengths") or []][:5],
        fixes=[str(item) for item in result.get("fixes") or []][:5],
        drills=[str(item) for item in result.get("drills") or []][:5],
    )


def synthesize_language_speech(payload: LanguageSpeechRequest) -> bytes:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is required for language audio.")
    if not payload.text.strip():
        raise ValueError("Text is required for speech.")

    language_name = LANGUAGE_NAMES[payload.language]
    instructions = (
        f"Speak clearly in {language_name} for a language learner. "
        f"Use {'a slow, careful pace' if payload.speed == 'slow' else 'a natural but clear pace'}."
    )
    response = client.audio.speech.create(
        model=OPENAI_TTS_MODEL,
        voice=OPENAI_TTS_VOICE,
        input=payload.text.strip(),
        instructions=instructions,
        response_format="mp3",
    )
    return response.read()


def create_language_conversation_reply(payload: LanguageConversationRequest) -> LanguageConversationResponse:
    language_name = LANGUAGE_NAMES[payload.language]
    result = _json_chat_completion(
        system_prompt=(
            "You are a conversational foreign-language tutor. Keep the conversation moving in the "
            "target language while giving compact corrections. Return strict JSON. The reply should "
            "be in the target language. The translation should be in English. Correction should be "
            "short and can be empty if the user's message was fine. Suggested user reply should be "
            "a natural next response the learner can say. For Japanese, always include romaji for "
            "the assistant reply and suggested user reply."
        ),
        user_payload={
            "language": language_name,
            "level": payload.level,
            "correction_style": payload.correction_style,
            "scenario": payload.scenario or "friendly everyday conversation",
            "message": payload.message,
            "history": [message.model_dump() for message in payload.history[-8:]],
            "json_shape": {
                "reply": "string in target language",
                "reply_romanization": "romaji for Japanese reply, otherwise empty string",
                "translation": "English translation",
                "correction": "brief correction",
                "suggested_user_reply": "string in target language",
                "suggested_user_reply_romanization": "romaji for Japanese suggested reply, otherwise empty string",
                "vocab": [
                    {
                        "phrase": "string",
                        "translation": "string",
                        "notes": "string",
                        "tags": ["conversation"],
                    }
                ],
            },
        },
    )
    vocab_items = []
    for item in result.get("vocab") or []:
        if not isinstance(item, dict) or not str(item.get("phrase") or "").strip():
            continue
        vocab_items.append(
            LanguageVocabItem(
                id="suggested",
                language=payload.language,
                phrase=str(item.get("phrase") or ""),
                translation=str(item.get("translation") or ""),
                notes=str(item.get("notes") or ""),
                tags=[str(tag) for tag in item.get("tags") or ["conversation"]],
            )
        )
    return LanguageConversationResponse(
        reply=str(result.get("reply") or ""),
        reply_romanization=str(result.get("reply_romanization") or ""),
        translation=str(result.get("translation") or ""),
        correction=str(result.get("correction") or ""),
        suggested_user_reply=str(result.get("suggested_user_reply") or ""),
        suggested_user_reply_romanization=str(result.get("suggested_user_reply_romanization") or ""),
        vocab=vocab_items[:5],
    )


def explain_language_word(payload: LanguageWordExplainRequest) -> LanguageWordExplainResponse:
    user_id = get_default_user_context().user_id
    cached = get_word_explanation_record(
        language=payload.language,
        level=payload.level,
        word=payload.word,
        translation=payload.translation,
        user_id=user_id,
    )
    if cached is not None:
        return LanguageWordExplainResponse.model_validate_json(cached["payload"])

    language_name = LANGUAGE_NAMES[payload.language]
    result = _json_chat_completion(
        system_prompt=(
            "You explain individual vocabulary words for a language learner. Return strict JSON. "
            "Be practical and concrete: meaning, how to use it, example sentences, and common mistakes. "
            "For Japanese, always include romanization for the headword and every example, because the learner "
            "may not read kana or kanji yet. Keep examples beginner-friendly."
        ),
        user_payload={
            "language": language_name,
            "language_code": payload.language,
            "level": payload.level,
            "word": payload.word,
            "known_translation": payload.translation,
            "existing_notes": payload.notes,
            "json_shape": {
                "word": "string",
                "translation": "string",
                "romanization": "string",
                "part_of_speech": "string",
                "explanation": "string",
                "usage_notes": ["string"],
                "examples": [
                    {
                        "target": "sentence in target language",
                        "romanization": "romanization, required for Japanese",
                        "translation": "English translation",
                        "note": "short usage note",
                    }
                ],
                "common_mistakes": ["string"],
                "quick_drill": "short exercise prompt",
            },
        },
    )
    examples = []
    for item in result.get("examples") or []:
        if not isinstance(item, dict):
            continue
        examples.append(
            LanguageWordExample(
                target=str(item.get("target") or ""),
                romanization=str(item.get("romanization") or ""),
                translation=str(item.get("translation") or ""),
                note=str(item.get("note") or ""),
            )
        )
    response = LanguageWordExplainResponse(
        word=str(result.get("word") or payload.word),
        translation=str(result.get("translation") or payload.translation),
        romanization=str(result.get("romanization") or ""),
        part_of_speech=str(result.get("part_of_speech") or ""),
        explanation=str(result.get("explanation") or ""),
        usage_notes=[str(item) for item in result.get("usage_notes") or []][:5],
        examples=examples[:5],
        common_mistakes=[str(item) for item in result.get("common_mistakes") or []][:5],
        quick_drill=str(result.get("quick_drill") or ""),
    )
    save_word_explanation_record(
        language=payload.language,
        level=payload.level,
        word=payload.word,
        translation=payload.translation,
        payload=response.model_dump(),
        user_id=user_id,
    )
    return response
