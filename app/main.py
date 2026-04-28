import logging
import os
from threading import Lock, Thread
from time import sleep
from uuid import uuid4

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from app.assistant import ask_jarvis_assistant
from app.assistant_chat_store import archive_chat, delete_chat, get_chat_thread, init_assistant_chat_store, list_chats
from app.calendar_client import build_calendar_preview, create_calendar_event_from_plan_item, create_calendar_events_from_plan_items, create_calendar_event_from_preview, list_upcoming_events
from app.calendar_quick_add import create_calendar_event_from_description
from app.classification_cache import get_cached_classification, init_classification_cache, save_classification, summarize_cached_classifications
from app.classification_guidance import get_classification_guidance, init_classification_guidance, update_classification_guidance
from app.classifier import IMPORTANT_LABEL, LEGACY_IMPORTANT_LABELS, LEGACY_UNIMPORTANT_LABELS, UNIMPORTANT_LABEL, classify_cleanup_email, classify_email, classify_emails_batch, classify_new_email_ai_fallback
from app.config import CORS_ALLOWED_ORIGINS, OPENAI_MAX_EMAILS_PER_RUN
from app.dashboard import generate_dashboard, invalidate_dashboard_cache
from app.gmail_client import cleanup_inbox, expire_stale_important_emails, get_all_inbox_emails, get_email_by_id, get_emails_by_any_label, get_mailbox_emails, get_mailbox_emails_page, get_new_inbox_emails, get_recent_inbox_emails, list_gmail_labels, mark_email_handled, process_new_inbox_emails, update_email
from app.google_oauth import begin_google_oauth, finish_google_oauth, get_google_oauth_instructions
from app.health import list_health_entries, sync_health_daily_entry
from app.health_store import init_health_store
from app.journal import extract_journal_day_citations, get_journal, get_journal_day, save_journal_day
from app.journal_store import init_journal_store
from app.language_learning import create_language_conversation_reply, create_language_session, create_language_vocab, delete_language_vocab, explain_language_word, generate_language_practice, get_language_dashboard, get_language_pronunciation_feedback, get_language_writing_feedback, normalize_existing_language_vocab, review_language_vocab, synthesize_language_speech, update_language_profile, update_language_vocab
from app.language_store import init_language_store, purge_kana_in_romanization_records
from app.movement import list_movement_entries, sync_movement_daily_entry
from app.movement_store import init_movement_store
from app.planner import generate_schedule_plan
from app.rules import classify_new_email_rule
from app.schemas import AssistantAskRequest, AssistantAskResponse, AssistantChatListResponse, AssistantChatThread, CalendarAgendaResponse, CalendarEventCreateResponse, CalendarEventPreview, CalendarQuickAddRequest, CalendarQuickAddResponse, ClassifiedEmailResponse, ClassificationGuidanceRequest, ClassificationGuidanceResponse, ClassificationOverviewResponse, CleanupJobStartResponse, CleanupJobStatus, CleanupResponse, DashboardResponse, DashboardTaskItem, EmailPageResponse, EmailSummary, EmailUpdateRequest, EmailUpdateResponse, GmailLabel, HandleEmailResponse, HealthDailySyncRequest, HealthDailySyncResponse, HealthListResponse, JournalDayEntry, JournalDayNoteUpdateRequest, JournalResponse, LanguageCode, LanguageConversationRequest, LanguageConversationResponse, LanguageDashboardResponse, LanguageFeedbackResponse, LanguagePracticeGenerateRequest, LanguagePracticeGenerateResponse, LanguagePracticeSession, LanguagePracticeSessionCreateRequest, LanguageProfile, LanguageProfileUpdateRequest, LanguageSpeechRequest, LanguageVocabCreateRequest, LanguageVocabItem, LanguageVocabNormalizeResponse, LanguageVocabReviewRequest, LanguageVocabUpdateRequest, LanguageWordExplainRequest, LanguageWordExplainResponse, LanguageWritingFeedbackRequest, MovementDailySyncRequest, MovementDailySyncResponse, MovementListResponse, PlanningCalendarBulkCreateRequest, PlanningCalendarBulkCreateResponse, PlanningCalendarCreateRequest, PlanningCalendarCreateResponse, PlanningJobStartResponse, PlanningJobStatus, PlanningRequest, PlanningResponse, RuleProcessResponse, TaskCreateRequest, TaskListResponse, TaskUpdateRequest, TrailSearchResponse, WorkoutBatchSyncRequest, WorkoutBatchSyncResponse, WorkoutListResponse
from app.task_service import create_task, delete_task, list_tasks, update_task
from app.task_store import init_task_store
from app.trails import search_openstreetmap_trails
from app.user_context import get_default_user_context
from app.workout import list_workout_entries, sync_workout_batch
from app.workout_store import init_workout_store

app = FastAPI(title="Mail AI", version="0.1.0")
api = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_cleanup_jobs: dict[str, CleanupJobStatus] = {}
_cleanup_jobs_lock = Lock()
_planning_jobs: dict[str, PlanningJobStatus] = {}
_planning_jobs_lock = Lock()
_new_mail_sort_lock = Lock()


@app.exception_handler(RuntimeError)
async def runtime_error_handler(_: Request, exc: RuntimeError):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


@app.exception_handler(ValueError)
async def value_error_handler(_: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def _set_cleanup_job(job_id: str, **updates) -> CleanupJobStatus:
    with _cleanup_jobs_lock:
        job = _cleanup_jobs[job_id]
        _cleanup_jobs[job_id] = job.model_copy(update=updates)
        return _cleanup_jobs[job_id]


def _run_cleanup_job(job_id: str, limit: int | None, dry_run: bool) -> None:
    try:
        emails = get_all_inbox_emails(limit=limit)
        _set_cleanup_job(job_id, status="running", total=len(emails))

        def on_progress(processed: int, total: int, email: EmailSummary) -> None:
            _set_cleanup_job(
                job_id,
                status="running",
                processed=processed,
                total=total,
                current_subject=email.subject or "(No subject)",
            )

        result = cleanup_inbox(
            emails=emails,
            classify_cleanup_email_fn=classify_cleanup_email,
            dry_run=dry_run,
            progress_callback=on_progress,
        )
        _set_cleanup_job(
            job_id,
            status="completed",
            processed=result.summary.total_processed,
            total=result.summary.total_processed,
            current_subject=None,
            result=result,
        )
    except Exception as exc:
        _set_cleanup_job(
            job_id,
            status="failed",
            current_subject=None,
            error=str(exc),
        )


def _start_cleanup_job(limit: int | None, dry_run: bool) -> CleanupJobStartResponse:
    job_id = uuid4().hex
    with _cleanup_jobs_lock:
        _cleanup_jobs[job_id] = CleanupJobStatus(
            job_id=job_id,
            status="queued",
            dry_run=dry_run,
        )

    thread = Thread(target=_run_cleanup_job, args=(job_id, limit, dry_run), daemon=True)
    thread.start()
    return CleanupJobStartResponse(job_id=job_id, status="queued")


def _set_planning_job(job_id: str, **updates) -> PlanningJobStatus:
    with _planning_jobs_lock:
        job = _planning_jobs[job_id]
        _planning_jobs[job_id] = job.model_copy(update=updates)
        return _planning_jobs[job_id]


def _run_planning_job(job_id: str, goals: str, days: int) -> None:
    try:
        _set_planning_job(job_id, status="running")
        result = generate_schedule_plan(goals=goals, days=days)
        _set_planning_job(job_id, status="completed", result=result, error=None)
    except Exception as exc:
        logger.exception("Planning job failed")
        _set_planning_job(job_id, status="failed", error=str(exc))


def _start_planning_job(goals: str, days: int) -> PlanningJobStartResponse:
    job_id = uuid4().hex
    with _planning_jobs_lock:
        _planning_jobs[job_id] = PlanningJobStatus(
            job_id=job_id,
            status="queued",
            goals=goals,
            days=days,
        )

    thread = Thread(target=_run_planning_job, args=(job_id, goals, days), daemon=True)
    thread.start()
    return PlanningJobStartResponse(job_id=job_id, status="queued")


def _run_new_mail_sort_once(limit: int = 50) -> None:
    if not _new_mail_sort_lock.acquire(blocking=False):
        return

    try:
        emails = get_new_inbox_emails(limit=limit, unread_only=True)
        if not emails:
            expire_stale_important_emails()
            return

        process_new_inbox_emails(
            emails=emails,
            classify_rule_fn=classify_new_email_rule,
            ai_fallback_fn=classify_new_email_ai_fallback,
            dry_run=False,
        )
        expire_stale_important_emails()
    finally:
        _new_mail_sort_lock.release()


def _new_mail_sort_loop() -> None:
    while True:
        try:
            _run_new_mail_sort_once()
        except Exception:
            pass
        sleep(60)


@app.on_event("startup")
def start_background_new_mail_sorter() -> None:
    init_classification_cache()
    init_classification_guidance()
    init_journal_store()
    init_task_store()
    init_health_store()
    init_movement_store()
    init_workout_store()
    init_assistant_chat_store()
    init_language_store()
    thread = Thread(target=_new_mail_sort_loop, daemon=True)
    thread.start()
    Thread(target=purge_kana_in_romanization_records, daemon=True).start()


@app.get("/")
def root():
    return {"message": "Mail AI backend is running"}


@api.get("", response_model=dict[str, str], include_in_schema=False)
@api.get("/", response_model=dict[str, str])
def api_root():
    return {"message": "Mail AI backend is running"}


@api.get("/google/oauth/status")
def google_oauth_status():
    return {
        "authorized": os.path.exists(os.getenv("GMAIL_TOKEN_FILE", "token.json")),
        "start_path": "/api/google/oauth/start",
        "instructions": get_google_oauth_instructions(),
    }


@api.get("/google/oauth/start", name="google_oauth_start")
def google_oauth_start(request: Request):
    authorization_url = begin_google_oauth(request)
    return RedirectResponse(url=authorization_url, status_code=307)


@api.get("/google/oauth/callback", name="google_oauth_callback")
def google_oauth_callback(request: Request, state: str, code: str | None = None, error: str | None = None):
    if error:
        raise HTTPException(status_code=400, detail=f"Google OAuth was cancelled or failed: {error}")
    if not code:
        raise HTTPException(status_code=400, detail="Google OAuth callback did not include an authorization code.")

    finish_google_oauth(request, state)
    return HTMLResponse(
        """
        <html>
          <head>
            <title>Jarvis Google Auth Complete</title>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                background: #0f172a;
                color: #e2e8f0;
                margin: 0;
                min-height: 100vh;
                display: grid;
                place-items: center;
                padding: 24px;
              }
              .card {
                max-width: 560px;
                background: rgba(15, 23, 42, 0.92);
                border: 1px solid rgba(148, 163, 184, 0.25);
                border-radius: 20px;
                padding: 28px;
                box-shadow: 0 20px 70px rgba(0, 0, 0, 0.35);
              }
              h1 {
                margin: 0 0 12px;
                font-size: 1.4rem;
              }
              p {
                margin: 0;
                line-height: 1.55;
                color: #cbd5e1;
              }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Google authorization complete</h1>
              <p>Jarvis saved the Google token for this container. You can close this tab and refresh the app.</p>
            </div>
          </body>
        </html>
        """
    )


@api.get("/emails", response_model=EmailPageResponse)
def list_emails(
    limit: int = Query(default=50, ge=1, le=100),
    mailbox: str = Query(default="INBOX"),
    page_token: str | None = Query(default=None),
):
    normalized_mailbox = mailbox.strip() or "INBOX"
    return get_mailbox_emails_page(
        mailbox=normalized_mailbox,
        limit=limit,
        page_token=page_token,
    )


@api.get("/emails/{message_id}/classified", response_model=ClassifiedEmailResponse)
def get_classified_email(message_id: str):
    email = get_email_by_id(message_id)
    classification = _get_or_create_classification(email)
    return ClassifiedEmailResponse(email=email, classification=classification)


@api.get("/labels", response_model=list[GmailLabel])
def list_labels():
    return list_gmail_labels()


@api.get("/classify")
def classify_emails(
    limit: int | None = Query(default=None, ge=1),
    bucket: str = Query(default="all"),
    mailbox: str = Query(default="INBOX"),
):
    user_id = get_default_user_context().user_id
    requested_limit = (
        OPENAI_MAX_EMAILS_PER_RUN if limit is None else min(limit, OPENAI_MAX_EMAILS_PER_RUN)
    )
    normalized_bucket = bucket.strip().lower()
    normalized_mailbox = mailbox.strip() or "INBOX"

    emails = get_mailbox_emails(mailbox=normalized_mailbox, limit=requested_limit)

    if normalized_bucket == "important":
        emails = [
            email
            for email in emails
            if any(label in {IMPORTANT_LABEL, *LEGACY_IMPORTANT_LABELS} for label in email.labels)
        ]
    elif normalized_bucket == "unimportant":
        emails = [
            email
            for email in emails
            if any(label in {UNIMPORTANT_LABEL, *LEGACY_UNIMPORTANT_LABELS} for label in email.labels)
        ]

    cached_results = []
    uncached_emails = []
    for email in emails:
        cached = get_cached_classification(email, user_id=user_id)
        if cached is None:
            uncached_emails.append(email)
            continue
        cached_results.append((email.id, cached.classification))

    classified_uncached = classify_emails_batch(uncached_emails)
    for email, classification in zip(uncached_emails, classified_uncached):
        save_classification(email, classification, user_id=user_id)
        cached_results.append((email.id, classification))

    classifications_by_id = {email_id: classification for email_id, classification in cached_results}
    results = [
        {
            "email": email,
            "classification": classifications_by_id[email.id],
        }
        for email in emails
        if email.id in classifications_by_id
    ]

    return results


@api.get("/overview", response_model=ClassificationOverviewResponse)
def classification_overview(
    mailbox: str = Query(default=IMPORTANT_LABEL),
    limit: int = Query(default=200, ge=1, le=1000),
):
    user_id = get_default_user_context().user_id
    return ClassificationOverviewResponse.model_validate(
        summarize_cached_classifications(mailbox=mailbox, limit=limit, user_id=user_id)
    )


@api.get("/dashboard", response_model=DashboardResponse)
def dashboard():
    return generate_dashboard()


@api.post("/assistant/ask", response_model=AssistantAskResponse)
def assistant_ask(payload: AssistantAskRequest):
    return ask_jarvis_assistant(payload)


@api.get("/assistant/chats", response_model=AssistantChatListResponse)
def assistant_chats(limit: int = Query(default=40, ge=1, le=100)):
    return list_chats(limit=limit, archived=False, user_id=get_default_user_context().user_id)


@api.get("/assistant/chats/archived", response_model=AssistantChatListResponse)
def assistant_archived_chats(limit: int = Query(default=40, ge=1, le=100)):
    return list_chats(limit=limit, archived=True, user_id=get_default_user_context().user_id)


@api.get("/assistant/chats/{chat_id}", response_model=AssistantChatThread)
def assistant_chat_thread(chat_id: str):
    return get_chat_thread(chat_id, user_id=get_default_user_context().user_id)


@api.patch("/assistant/chats/{chat_id}/archive")
def assistant_archive_chat(chat_id: str, archived: bool = Query(default=True)):
    archive_chat(chat_id, archived=archived, user_id=get_default_user_context().user_id)
    return {"ok": True, "archived": archived}


@api.delete("/assistant/chats/{chat_id}")
def assistant_delete_chat(chat_id: str):
    delete_chat(chat_id, user_id=get_default_user_context().user_id)
    return {"ok": True}


@api.get("/health", response_model=HealthListResponse)
def health(days: int = Query(default=7, ge=1, le=3650)):
    return list_health_entries(days=days)


@api.post("/health/daily", response_model=HealthDailySyncResponse)
def sync_health_daily(payload: HealthDailySyncRequest):
    response = sync_health_daily_entry(payload)
    invalidate_dashboard_cache(get_default_user_context().user_id)
    return response


@api.get("/movement", response_model=MovementListResponse)
def movement(days: int = Query(default=14, ge=1, le=60)):
    return list_movement_entries(days=days)


@api.post("/movement/daily", response_model=MovementDailySyncResponse)
def sync_movement_daily(payload: MovementDailySyncRequest):
    response = sync_movement_daily_entry(payload)
    invalidate_dashboard_cache(get_default_user_context().user_id)
    return response


@api.get("/workouts", response_model=WorkoutListResponse)
def workouts(days: int = Query(default=30, ge=1, le=365), limit: int = Query(default=100, ge=1, le=500)):
    return list_workout_entries(days=days, limit=limit)


@api.post("/workouts/sync", response_model=WorkoutBatchSyncResponse)
def sync_workouts(payload: WorkoutBatchSyncRequest):
    return sync_workout_batch(payload)


@api.get("/tasks", response_model=TaskListResponse)
def tasks(include_completed: bool = Query(default=True)):
    return list_tasks(include_completed=include_completed)


@api.get("/languages", response_model=LanguageDashboardResponse)
def language_dashboard():
    return get_language_dashboard()


@api.put("/languages/profile", response_model=LanguageProfile)
def put_language_profile(payload: LanguageProfileUpdateRequest):
    return update_language_profile(payload)


@api.post("/languages/vocab", response_model=LanguageVocabItem)
def post_language_vocab(payload: LanguageVocabCreateRequest):
    return create_language_vocab(payload)


@api.post("/languages/vocab/normalize-existing", response_model=LanguageVocabNormalizeResponse)
def post_language_vocab_normalize_existing():
    return normalize_existing_language_vocab()


@api.patch("/languages/vocab/{vocab_id}/review", response_model=LanguageVocabItem)
def patch_language_vocab_review(vocab_id: str, payload: LanguageVocabReviewRequest):
    return review_language_vocab(vocab_id, remembered=payload.remembered)


@api.patch("/languages/vocab/{vocab_id}", response_model=LanguageVocabItem)
def patch_language_vocab(vocab_id: str, payload: LanguageVocabUpdateRequest):
    return update_language_vocab(vocab_id, payload)


@api.delete("/languages/vocab/{vocab_id}", status_code=204)
def delete_language_vocab_route(vocab_id: str):
    delete_language_vocab(vocab_id)


@api.post("/languages/sessions", response_model=LanguagePracticeSession)
def post_language_session(payload: LanguagePracticeSessionCreateRequest):
    return create_language_session(payload)


@api.post("/languages/practice/generate", response_model=LanguagePracticeGenerateResponse)
def post_language_practice_generate(payload: LanguagePracticeGenerateRequest):
    return generate_language_practice(payload)


@api.post("/languages/feedback/writing", response_model=LanguageFeedbackResponse)
def post_language_writing_feedback(payload: LanguageWritingFeedbackRequest):
    return get_language_writing_feedback(payload)


@api.post("/languages/feedback/pronunciation", response_model=LanguageFeedbackResponse)
async def post_language_pronunciation_feedback(
    language: LanguageCode = Form(...),
    level: str = Form(default="beginner"),
    target_text: str = Form(default=""),
    audio: UploadFile = File(...),
):
    return await get_language_pronunciation_feedback(
        language=language,
        level=level,
        target_text=target_text,
        audio=audio,
    )


@api.post("/languages/speech")
def post_language_speech(payload: LanguageSpeechRequest):
    audio = synthesize_language_speech(payload)
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Content-Disposition": 'inline; filename="language-practice.mp3"'},
    )


@api.post("/languages/conversation", response_model=LanguageConversationResponse)
def post_language_conversation(payload: LanguageConversationRequest):
    return create_language_conversation_reply(payload)


@api.post("/languages/words/explain", response_model=LanguageWordExplainResponse)
def post_language_word_explain(payload: LanguageWordExplainRequest):
    return explain_language_word(payload)


@api.post("/tasks", response_model=DashboardTaskItem)
def create_task_route(payload: TaskCreateRequest):
    return create_task(payload)


@api.patch("/tasks/{task_id}", response_model=DashboardTaskItem)
def update_task_route(task_id: str, payload: TaskUpdateRequest):
    return update_task(task_id, payload)


@api.delete("/tasks/{task_id}")
def delete_task_route(task_id: str):
    delete_task(task_id)
    return {"deleted": True, "task_id": task_id}


@api.get("/journal", response_model=JournalResponse)
def journal(
    days: int = Query(default=14, ge=1, le=60),
    before: str | None = Query(default=None),
    saved_only: bool = Query(default=False),
    query: str = Query(default=""),
):
    return get_journal(days=days, before=before, saved_only=saved_only, query=query)


@api.get("/journal/{entry_date}", response_model=JournalDayEntry)
def journal_day(entry_date: str):
    return get_journal_day(entry_date)


@api.put("/journal/{entry_date}", response_model=JournalDayEntry)
def journal_save(entry_date: str, payload: JournalDayNoteUpdateRequest):
    return save_journal_day(
        entry_date=entry_date,
        journal_entry=payload.journal_entry,
        accomplishments=payload.accomplishments,
        gratitude_entry=payload.gratitude_entry,
        scripture_study=payload.scripture_study,
        spiritual_notes=payload.spiritual_notes,
        photo_data_url=payload.photo_data_url,
        calendar_items=payload.calendar_items,
    )


@api.post("/journal/{entry_date}/extract-citations", response_model=JournalDayEntry)
def journal_extract_citations(entry_date: str, payload: JournalDayNoteUpdateRequest):
    return extract_journal_day_citations(
        entry_date=entry_date,
        journal_entry=payload.journal_entry,
        accomplishments=payload.accomplishments,
        gratitude_entry=payload.gratitude_entry,
        scripture_study=payload.scripture_study,
        spiritual_notes=payload.spiritual_notes,
        photo_data_url=payload.photo_data_url,
        calendar_items=payload.calendar_items,
    )


@api.get("/classification-guidance", response_model=ClassificationGuidanceResponse)
def get_saved_classification_guidance():
    return get_classification_guidance()


@api.put("/classification-guidance", response_model=ClassificationGuidanceResponse)
def put_saved_classification_guidance(payload: ClassificationGuidanceRequest):
    return update_classification_guidance(payload.text)


def _get_or_create_classification(email: EmailSummary):
    user_id = get_default_user_context().user_id
    cached = get_cached_classification(email, user_id=user_id)
    if cached is not None:
        return cached.classification

    classification = classify_email(email)
    save_classification(email, classification, user_id=user_id)
    return classification


@api.get("/calendar/preview/{message_id}", response_model=CalendarEventPreview)
def calendar_preview(message_id: str):
    email = get_email_by_id(message_id)
    classification = _get_or_create_classification(email)
    return build_calendar_preview(email, classification)


@api.post("/calendar/create/{message_id}", response_model=CalendarEventCreateResponse)
def calendar_create(message_id: str):
    email = get_email_by_id(message_id)
    classification = _get_or_create_classification(email)
    preview = build_calendar_preview(email, classification)
    return create_calendar_event_from_preview(preview)


@api.get("/calendar/schedule", response_model=CalendarAgendaResponse)
def calendar_schedule(
    days: int = Query(default=7, ge=1, le=60),
    max_results: int = Query(default=25, ge=1, le=200),
):
    return list_upcoming_events(days=days, max_results=max_results)


@api.post("/calendar/quick-add", response_model=CalendarQuickAddResponse)
def calendar_quick_add(payload: CalendarQuickAddRequest):
    return create_calendar_event_from_description(payload.description)


@api.post("/planning/plan", response_model=PlanningJobStartResponse)
def planning_plan(payload: PlanningRequest):
    logger.warning("Planning route entered: days=%s goals_len=%s", payload.days, len(payload.goals or ""))
    return _start_planning_job(goals=payload.goals, days=payload.days)


@api.get("/planning/jobs/{job_id}", response_model=PlanningJobStatus)
def planning_job_status(job_id: str):
    with _planning_jobs_lock:
        job = _planning_jobs.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Planning job not found.")

    return job


@api.post("/planning/calendar", response_model=PlanningCalendarCreateResponse)
def planning_calendar_create(payload: PlanningCalendarCreateRequest):
    return create_calendar_event_from_plan_item(payload.item)


@api.post("/planning/calendar/bulk", response_model=PlanningCalendarBulkCreateResponse)
def planning_calendar_bulk_create(payload: PlanningCalendarBulkCreateRequest):
    return create_calendar_events_from_plan_items(payload.items)


@api.get("/trails/search", response_model=TrailSearchResponse)
def trails_search(
    min_lat: float = Query(..., ge=-90, le=90),
    min_lon: float = Query(..., ge=-180, le=180),
    max_lat: float = Query(..., ge=-90, le=90),
    max_lon: float = Query(..., ge=-180, le=180),
    limit: int = Query(default=12, ge=1, le=60),
):
    try:
        return search_openstreetmap_trails(
            min_lat=min_lat,
            min_lon=min_lon,
            max_lat=max_lat,
            max_lon=max_lon,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@api.post("/cleanup/preview", response_model=CleanupJobStartResponse)
def preview_inbox_cleanup(limit: int | None = Query(default=None, ge=1)):
    return _start_cleanup_job(limit=limit, dry_run=True)


@api.post("/cleanup/apply", response_model=CleanupJobStartResponse)
def apply_inbox_cleanup(limit: int | None = Query(default=None, ge=1)):
    return _start_cleanup_job(limit=limit, dry_run=False)


@api.get("/cleanup/jobs/{job_id}", response_model=CleanupJobStatus)
def get_cleanup_job(job_id: str):
    with _cleanup_jobs_lock:
        job = _cleanup_jobs.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Cleanup job not found.")

    return job


@api.post("/rules/preview-new", response_model=RuleProcessResponse)
def preview_new_email_rules(
    limit: int | None = Query(default=50, ge=1),
    unread_only: bool = Query(default=True),
):
    emails = get_new_inbox_emails(limit=limit, unread_only=unread_only)
    response = process_new_inbox_emails(
        emails=emails,
        classify_rule_fn=classify_new_email_rule,
        ai_fallback_fn=classify_new_email_ai_fallback,
        dry_run=True,
    )
    return response.model_copy(update={"unread_only": unread_only})


@api.post("/rules/apply-new", response_model=RuleProcessResponse)
def apply_new_email_rules(
    limit: int | None = Query(default=50, ge=1),
    unread_only: bool = Query(default=True),
):
    emails = get_new_inbox_emails(limit=limit, unread_only=unread_only)
    response = process_new_inbox_emails(
        emails=emails,
        classify_rule_fn=classify_new_email_rule,
        ai_fallback_fn=classify_new_email_ai_fallback,
        dry_run=False,
    )
    return response.model_copy(update={"unread_only": unread_only})


@api.post("/emails/{message_id}/handle", response_model=HandleEmailResponse)
def handle_email(message_id: str):
    response = mark_email_handled(message_id)
    invalidate_dashboard_cache(get_default_user_context().user_id)
    return response


@api.patch("/emails/{message_id}", response_model=EmailUpdateResponse)
def patch_email(message_id: str, payload: EmailUpdateRequest):
    response = update_email(
        message_id=message_id,
        add_label_names=payload.add_label_names,
        remove_label_names=payload.remove_label_names,
        archive=payload.archive,
        unread=payload.unread,
    )
    invalidate_dashboard_cache(get_default_user_context().user_id)
    return response


app.include_router(api)
