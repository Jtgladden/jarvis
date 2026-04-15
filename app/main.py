from threading import Lock, Thread
from time import sleep
from uuid import uuid4

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.classifier import IMPORTANT_LABEL, LEGACY_IMPORTANT_LABELS, classify_cleanup_email, classify_email, classify_new_email_ai_fallback
from app.config import CORS_ALLOWED_ORIGINS, OPENAI_MAX_EMAILS_PER_RUN
from app.gmail_client import cleanup_inbox, expire_stale_important_emails, get_all_inbox_emails, get_emails_by_any_label, get_mailbox_emails, get_mailbox_emails_page, get_new_inbox_emails, get_recent_inbox_emails, list_gmail_labels, mark_email_handled, process_new_inbox_emails, update_email
from app.rules import classify_new_email_rule
from app.schemas import CleanupJobStartResponse, CleanupJobStatus, CleanupResponse, EmailPageResponse, EmailSummary, EmailUpdateRequest, EmailUpdateResponse, GmailLabel, HandleEmailResponse, RuleProcessResponse

app = FastAPI(title="Mail AI", version="0.1.0")
api = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_cleanup_jobs: dict[str, CleanupJobStatus] = {}
_cleanup_jobs_lock = Lock()
_new_mail_sort_lock = Lock()


@app.exception_handler(RuntimeError)
async def runtime_error_handler(_: Request, exc: RuntimeError):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


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
    thread = Thread(target=_new_mail_sort_loop, daemon=True)
    thread.start()


@app.get("/")
def root():
    return {"message": "Mail AI backend is running"}


@api.get("", response_model=dict[str, str], include_in_schema=False)
@api.get("/", response_model=dict[str, str])
def api_root():
    return {"message": "Mail AI backend is running"}


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


@api.get("/labels", response_model=list[GmailLabel])
def list_labels():
    return list_gmail_labels()


@api.get("/classify")
def classify_emails(limit: int | None = Query(default=None, ge=1)):
    requested_limit = (
        OPENAI_MAX_EMAILS_PER_RUN if limit is None else min(limit, OPENAI_MAX_EMAILS_PER_RUN)
    )
    emails = get_emails_by_any_label([IMPORTANT_LABEL, *LEGACY_IMPORTANT_LABELS], limit=requested_limit)

    results = []
    for email in emails:
        classification = classify_email(email)
        results.append({
            "email": email,
            "classification": classification,
        })

    return results


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
    return mark_email_handled(message_id)


@api.patch("/emails/{message_id}", response_model=EmailUpdateResponse)
def patch_email(message_id: str, payload: EmailUpdateRequest):
    return update_email(
        message_id=message_id,
        add_label_names=payload.add_label_names,
        remove_label_names=payload.remove_label_names,
        archive=payload.archive,
        unread=payload.unread,
    )


app.include_router(api)
