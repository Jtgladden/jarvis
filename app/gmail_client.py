import base64
import os.path
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from app.classifier import IMPORTANT_LABEL, LEGACY_IMPORTANT_LABELS, LEGACY_UNIMPORTANT_LABELS, UNIMPORTANT_LABEL, canonicalize_importance_label
from app.config import GMAIL_SCOPES, GMAIL_TOKEN_FILE, GMAIL_CREDENTIALS_FILE
from app.schemas import CleanupDecision, CleanupItem, CleanupResponse, CleanupSummary, EmailClassification, EmailPageResponse, EmailSummary, EmailUpdateResponse, GmailLabel, HandleEmailResponse, RuleDecision, RuleItem, RuleProcessResponse, RuleSummary

REVIEWED_LABEL = "Reviewed"
ALL_IMPORTANCE_LABEL_NAMES = {
    IMPORTANT_LABEL,
    UNIMPORTANT_LABEL,
    *LEGACY_IMPORTANT_LABELS,
    *LEGACY_UNIMPORTANT_LABELS,
}


def get_gmail_service():
    creds: Optional[Credentials] = None

    if os.path.exists(GMAIL_TOKEN_FILE):
        try:
            creds = Credentials.from_authorized_user_file(GMAIL_TOKEN_FILE, GMAIL_SCOPES)
        except Exception as exc:
            raise RuntimeError(
                f"Failed to read Gmail token file at {GMAIL_TOKEN_FILE}: {exc}"
            ) from exc

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception as exc:
                raise RuntimeError(f"Failed to refresh Gmail credentials: {exc}") from exc
        else:
            if not os.path.exists(GMAIL_CREDENTIALS_FILE):
                raise RuntimeError(
                    "Gmail credentials are not configured. "
                    f"Expected OAuth client file at {GMAIL_CREDENTIALS_FILE}."
                )

            try:
                flow = InstalledAppFlow.from_client_secrets_file(
                    GMAIL_CREDENTIALS_FILE,
                    GMAIL_SCOPES,
                )
                creds = flow.run_local_server(port=0)
            except Exception as exc:
                raise RuntimeError(
                    "Failed to complete Gmail OAuth flow. "
                    "On a server deployment, make sure /data/credentials.json and /data/token.json "
                    "exist in the container, or generate the token locally first."
                ) from exc

        try:
            with open(GMAIL_TOKEN_FILE, "w") as token:
                token.write(creds.to_json())
        except Exception as exc:
            raise RuntimeError(
                f"Authenticated with Gmail but failed to write token file at {GMAIL_TOKEN_FILE}: {exc}"
            ) from exc

    try:
        return build("gmail", "v1", credentials=creds)
    except HttpError as exc:
        raise RuntimeError(f"Failed to initialize Gmail API client: {exc}") from exc
    except Exception as exc:
        raise RuntimeError(f"Failed to initialize Gmail service: {exc}") from exc


def _get_header(headers: list[dict], name: str) -> str:
    for header in headers:
        if header.get("name", "").lower() == name.lower():
            return header.get("value", "")
    return ""


def _decode_base64url(data: str) -> str:
    if not data:
        return ""
    padding = "=" * (-len(data) % 4)
    decoded = base64.urlsafe_b64decode(data + padding)
    return decoded.decode("utf-8", errors="ignore")


def _extract_text_from_payload(payload: dict) -> str:
    mime_type = payload.get("mimeType", "")
    body = payload.get("body", {})
    data = body.get("data")

    if mime_type == "text/plain" and data:
        return _decode_base64url(data)

    if mime_type == "text/html" and data:
        return _decode_base64url(data)

    for part in payload.get("parts", []):
        text = _extract_text_from_payload(part)
        if text:
            return text

    return ""


def get_label_maps(service) -> tuple[Dict[str, str], Dict[str, str]]:
    response = service.users().labels().list(userId="me").execute()
    id_to_name: Dict[str, str] = {}
    name_to_id: Dict[str, str] = {}

    for label in response.get("labels", []):
        label_id = label["id"]
        label_name = label["name"]
        id_to_name[label_id] = label_name
        name_to_id[label_name] = label_id

    return id_to_name, name_to_id


def list_gmail_labels() -> List[GmailLabel]:
    service = get_gmail_service()
    response = service.users().labels().list(userId="me").execute()
    labels: List[GmailLabel] = []

    for label in response.get("labels", []):
        labels.append(
            GmailLabel(
                id=label["id"],
                name=label["name"],
                type=str(label.get("type", "user")).lower(),
                messages_total=int(label.get("messagesTotal", 0)),
                messages_unread=int(label.get("messagesUnread", 0)),
            )
        )

    system_order = {
        "INBOX": 0,
        "UNREAD": 1,
        "IMPORTANT": 2,
        "STARRED": 3,
        "SENT": 4,
        "DRAFT": 5,
        "TRASH": 6,
        "SPAM": 7,
    }
    return sorted(
        labels,
        key=lambda label: (
            0 if label.type == "system" else 1,
            system_order.get(label.name, 99),
            label.name.lower(),
        ),
    )


def _to_email_summary(full_msg: dict, label_id_to_name: Dict[str, str]) -> EmailSummary:
    payload = full_msg.get("payload", {})
    headers = payload.get("headers", [])

    subject = _get_header(headers, "Subject")
    sender = _get_header(headers, "From")
    date = _get_header(headers, "Date")
    snippet = full_msg.get("snippet", "")
    label_ids = full_msg.get("labelIds", [])
    labels = [label_id_to_name.get(label_id, label_id) for label_id in label_ids]
    body = _extract_text_from_payload(payload)

    return EmailSummary(
        id=full_msg["id"],
        thread_id=full_msg["threadId"],
        subject=subject,
        sender=sender,
        snippet=snippet,
        date=date,
        labels=labels,
        body=body[:5000] if body else None,
    )


def _fetch_message(service, msg_id: str, label_id_to_name: Dict[str, str]) -> EmailSummary:
    full_msg = (
        service.users()
        .messages()
        .get(userId="me", id=msg_id, format="full")
        .execute()
    )
    return _to_email_summary(full_msg, label_id_to_name)


def _list_inbox_message_ids(service, limit: Optional[int] = None, unread_only: bool = False) -> List[str]:
    message_ids: List[str] = []
    page_token: Optional[str] = None

    while True:
        remaining = None if limit is None else max(limit - len(message_ids), 0)
        if remaining == 0:
            break

        request_size = 100 if remaining is None else min(100, remaining)
        label_ids = ["INBOX"]
        if unread_only:
            label_ids.append("UNREAD")

        response = (
            service.users()
            .messages()
            .list(
                userId="me",
                labelIds=label_ids,
                maxResults=request_size,
                pageToken=page_token,
            )
            .execute()
        )

        messages = response.get("messages", [])
        if not messages:
            break

        message_ids.extend(msg["id"] for msg in messages)

        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return message_ids


def _list_message_ids(
    service,
    label_ids: Optional[List[str]] = None,
    limit: Optional[int] = None,
) -> List[str]:
    message_ids: List[str] = []
    page_token: Optional[str] = None

    while True:
        remaining = None if limit is None else max(limit - len(message_ids), 0)
        if remaining == 0:
            break

        request_size = 100 if remaining is None else min(100, remaining)
        request = service.users().messages().list(
            userId="me",
            maxResults=request_size,
            pageToken=page_token,
        )
        if label_ids:
            request = service.users().messages().list(
                userId="me",
                labelIds=label_ids,
                maxResults=request_size,
                pageToken=page_token,
            )

        response = request.execute()
        messages = response.get("messages", [])
        if not messages:
            break

        message_ids.extend(msg["id"] for msg in messages)
        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return message_ids


def _list_message_page(
    service,
    label_ids: Optional[List[str]] = None,
    limit: int = 50,
    page_token: Optional[str] = None,
) -> tuple[List[str], Optional[str]]:
    request = service.users().messages().list(
        userId="me",
        maxResults=max(1, min(limit, 100)),
        pageToken=page_token,
    )
    if label_ids:
        request = service.users().messages().list(
            userId="me",
            labelIds=label_ids,
            maxResults=max(1, min(limit, 100)),
            pageToken=page_token,
        )

    response = request.execute()
    messages = response.get("messages", [])
    message_ids = [msg["id"] for msg in messages]
    return message_ids, response.get("nextPageToken")


def get_recent_inbox_emails(max_results: int = 10) -> List[EmailSummary]:
    service = get_gmail_service()
    label_id_to_name, _ = get_label_maps(service)
    message_ids = _list_inbox_message_ids(service, limit=max_results, unread_only=False)
    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]


def get_emails_by_label(label_name: str, limit: Optional[int] = None) -> List[EmailSummary]:
    service = get_gmail_service()
    label_id_to_name, name_to_id = get_label_maps(service)
    label_id = name_to_id.get(label_name)
    if not label_id:
        return []

    message_ids: List[str] = []
    page_token: Optional[str] = None

    while True:
        remaining = None if limit is None else max(limit - len(message_ids), 0)
        if remaining == 0:
            break

        request_size = 100 if remaining is None else min(100, remaining)
        response = (
            service.users()
            .messages()
            .list(
                userId="me",
                labelIds=[label_id],
                maxResults=request_size,
                pageToken=page_token,
            )
            .execute()
        )

        messages = response.get("messages", [])
        if not messages:
            break

        message_ids.extend(msg["id"] for msg in messages)

        page_token = response.get("nextPageToken")
        if not page_token:
            break

    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]


def get_emails_by_any_label(label_names: List[str], limit: Optional[int] = None) -> List[EmailSummary]:
    service = get_gmail_service()
    label_id_to_name, name_to_id = get_label_maps(service)
    message_ids: List[str] = []
    seen_ids: set[str] = set()

    for label_name in label_names:
        label_id = name_to_id.get(label_name)
        if not label_id:
            continue

        page_token: Optional[str] = None
        while True:
            remaining = None if limit is None else max(limit - len(message_ids), 0)
            if remaining == 0:
                return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]

            request_size = 100 if remaining is None else min(100, remaining)
            response = (
                service.users()
                .messages()
                .list(
                    userId="me",
                    labelIds=[label_id],
                    maxResults=request_size,
                    pageToken=page_token,
                )
                .execute()
            )

            messages = response.get("messages", [])
            if not messages:
                break

            for msg in messages:
                msg_id = msg["id"]
                if msg_id in seen_ids:
                    continue
                seen_ids.add(msg_id)
                message_ids.append(msg_id)
                if limit is not None and len(message_ids) >= limit:
                    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]

            page_token = response.get("nextPageToken")
            if not page_token:
                break

    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]


def get_all_inbox_emails(limit: Optional[int] = None, page_size: int = 100) -> List[EmailSummary]:
    service = get_gmail_service()
    label_id_to_name, _ = get_label_maps(service)
    message_ids = _list_inbox_message_ids(service, limit=limit, unread_only=False)
    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]


def get_mailbox_emails(mailbox: str = "INBOX", limit: Optional[int] = None) -> List[EmailSummary]:
    service = get_gmail_service()
    label_id_to_name, name_to_id = get_label_maps(service)

    normalized_mailbox = (mailbox or "INBOX").strip()
    label_ids: Optional[List[str]]
    if normalized_mailbox.upper() == "ALL":
        label_ids = None
    else:
        label_id = name_to_id.get(normalized_mailbox)
        if not label_id:
            return []
        label_ids = [label_id]

    message_ids = _list_message_ids(service, label_ids=label_ids, limit=limit)
    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]


def get_mailbox_emails_page(
    mailbox: str = "INBOX",
    limit: int = 50,
    page_token: Optional[str] = None,
) -> EmailPageResponse:
    service = get_gmail_service()
    label_id_to_name, name_to_id = get_label_maps(service)

    normalized_mailbox = (mailbox or "INBOX").strip()
    label_ids: Optional[List[str]]
    if normalized_mailbox.upper() == "ALL":
        label_ids = None
    elif normalized_mailbox.upper() == "INBOX":
        label_ids = ["INBOX"]
    else:
        label_id = name_to_id.get(normalized_mailbox)
        if not label_id:
            return EmailPageResponse(items=[], next_page_token=None)
        label_ids = [label_id]

    message_ids, next_token = _list_message_page(
        service,
        label_ids=label_ids,
        limit=limit,
        page_token=page_token,
    )
    return EmailPageResponse(
        items=[_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids],
        next_page_token=next_token,
    )


def get_new_inbox_emails(limit: Optional[int] = None, unread_only: bool = True) -> List[EmailSummary]:
    service = get_gmail_service()
    label_id_to_name, _ = get_label_maps(service)
    message_ids = _list_inbox_message_ids(service, limit=limit, unread_only=unread_only)
    return [_fetch_message(service, msg_id, label_id_to_name) for msg_id in message_ids]


def _fallback_cleanup_decision(
    email: EmailSummary,
    classification: EmailClassification,
    existing_labels: List[str] | None = None,
) -> CleanupDecision:
    fallback_label = IMPORTANT_LABEL if (
        classification.needs_reply
        or classification.urgency in {"medium", "high"}
        or classification.category in {"action_required", "meeting"}
        or classification.importance_score >= 7
    ) else UNIMPORTANT_LABEL

    return CleanupDecision(
        action="archive",
        label_name=fallback_label,
        archive=True,
        reason="Archived with a simplified fallback label.",
    )


def _get_or_create_label_id(service, label_name: str, label_name_to_id: Dict[str, str]) -> str:
    sanitized = " ".join(label_name.replace("/", " ").split()).strip()[:225]
    if not sanitized:
        sanitized = UNIMPORTANT_LABEL

    existing = label_name_to_id.get(sanitized)
    if existing:
        return existing

    created = (
        service.users()
        .labels()
        .create(
            userId="me",
            body={
                "name": sanitized,
                "labelListVisibility": "labelShow",
                "messageListVisibility": "show",
            },
        )
        .execute()
    )
    label_id = created["id"]
    label_name_to_id[sanitized] = label_id
    return label_id


def _apply_decision(service, item: CleanupItem, label_name_to_id: Dict[str, str]) -> None:
    add_label_ids: List[str] = []
    remove_label_ids: List[str] = []
    target_label_name = canonicalize_importance_label(item.decision.label_name)

    if target_label_name:
        label_id = _get_or_create_label_id(service, target_label_name, label_name_to_id)
        if target_label_name not in item.email.labels:
            add_label_ids.append(label_id)
        for existing_label in item.email.labels:
            if existing_label == target_label_name or existing_label not in ALL_IMPORTANCE_LABEL_NAMES:
                continue
            existing_label_id = label_name_to_id.get(existing_label)
            if existing_label_id:
                remove_label_ids.append(existing_label_id)

    if item.decision.archive and "INBOX" in item.email.labels:
        remove_label_ids.append("INBOX")

    if not add_label_ids and not remove_label_ids:
        return

    (
        service.users()
        .messages()
        .modify(
            userId="me",
            id=item.email.id,
            body={
                "addLabelIds": add_label_ids,
                "removeLabelIds": remove_label_ids,
            },
        )
        .execute()
    )


def _apply_rule_decision(service, email: EmailSummary, decision: RuleDecision, label_name_to_id: Dict[str, str]) -> None:
    add_label_ids: List[str] = []
    remove_label_ids: List[str] = []
    target_label_name = canonicalize_importance_label(decision.label_name) or UNIMPORTANT_LABEL

    label_id = _get_or_create_label_id(service, target_label_name, label_name_to_id)
    if target_label_name not in email.labels:
        add_label_ids.append(label_id)
    for existing_label in email.labels:
        if existing_label == target_label_name or existing_label not in ALL_IMPORTANCE_LABEL_NAMES:
            continue
        existing_label_id = label_name_to_id.get(existing_label)
        if existing_label_id:
            remove_label_ids.append(existing_label_id)

    if decision.archive and "INBOX" in email.labels:
        remove_label_ids.append("INBOX")

    if not add_label_ids and not remove_label_ids:
        return

    (
        service.users()
        .messages()
        .modify(
            userId="me",
            id=email.id,
            body={
                "addLabelIds": add_label_ids,
                "removeLabelIds": remove_label_ids,
            },
        )
        .execute()
    )


def _modify_thread(
    service,
    thread_id: str,
    add_label_ids: List[str],
    remove_label_ids: List[str],
) -> None:
    deduped_add = [label_id for label_id in dict.fromkeys(add_label_ids) if label_id not in remove_label_ids]
    deduped_remove = list(dict.fromkeys(remove_label_ids))

    if not deduped_add and not deduped_remove:
        return

    (
        service.users()
        .threads()
        .modify(
            userId="me",
            id=thread_id,
            body={
                "addLabelIds": deduped_add,
                "removeLabelIds": deduped_remove,
            },
        )
        .execute()
    )


def mark_email_handled(message_id: str) -> HandleEmailResponse:
    service = get_gmail_service()
    label_id_to_name, label_name_to_id = get_label_maps(service)
    reviewed_label_id = _get_or_create_label_id(service, REVIEWED_LABEL, label_name_to_id)

    full_msg = (
        service.users()
        .messages()
        .get(userId="me", id=message_id, format="full")
        .execute()
    )
    email = _to_email_summary(full_msg, label_id_to_name)

    add_label_ids: List[str] = []
    remove_label_ids: List[str] = []

    if REVIEWED_LABEL not in email.labels:
        add_label_ids.append(reviewed_label_id)

    for label_name in {IMPORTANT_LABEL, *LEGACY_IMPORTANT_LABELS}:
        label_id = label_name_to_id.get(label_name)
        if label_id and label_name in email.labels:
            remove_label_ids.append(label_id)

    _modify_thread(
        service,
        email.thread_id,
        add_label_ids=add_label_ids,
        remove_label_ids=remove_label_ids,
    )

    return HandleEmailResponse(
        message_id=message_id,
        removed_label=IMPORTANT_LABEL,
        added_label=REVIEWED_LABEL,
        status="handled",
    )


def update_email(
    message_id: str,
    add_label_names: Optional[List[str]] = None,
    remove_label_names: Optional[List[str]] = None,
    archive: Optional[bool] = None,
    unread: Optional[bool] = None,
) -> EmailUpdateResponse:
    service = get_gmail_service()
    label_id_to_name, label_name_to_id = get_label_maps(service)

    add_label_ids: List[str] = []
    remove_label_ids: List[str] = []

    for label_name in add_label_names or []:
        cleaned = " ".join(label_name.split()).strip()
        if not cleaned:
            continue
        label_id = _get_or_create_label_id(service, cleaned, label_name_to_id)
        add_label_ids.append(label_id)

    for label_name in remove_label_names or []:
        cleaned = " ".join(label_name.split()).strip()
        if not cleaned:
            continue
        label_id = label_name_to_id.get(cleaned)
        if label_id:
            remove_label_ids.append(label_id)

    if archive is True:
        remove_label_ids.append("INBOX")
    elif archive is False:
        add_label_ids.append("INBOX")

    if unread is True:
        add_label_ids.append("UNREAD")
    elif unread is False:
        remove_label_ids.append("UNREAD")

    full_msg = (
        service.users()
        .messages()
        .get(userId="me", id=message_id, format="full")
        .execute()
    )
    email = _to_email_summary(full_msg, label_id_to_name)

    _modify_thread(
        service,
        email.thread_id,
        add_label_ids=add_label_ids,
        remove_label_ids=remove_label_ids,
    )

    updated_email = _fetch_message(service, message_id, label_id_to_name)
    return EmailUpdateResponse(email=updated_email)


def expire_stale_important_emails(days_old: int = 7, limit: int = 200) -> int:
    service = get_gmail_service()
    label_id_to_name, label_name_to_id = get_label_maps(service)
    reviewed_label_id = _get_or_create_label_id(service, REVIEWED_LABEL, label_name_to_id)
    important_label_ids = [
        label_name_to_id[label_name]
        for label_name in {IMPORTANT_LABEL, *LEGACY_IMPORTANT_LABELS}
        if label_name in label_name_to_id
    ]
    if not important_label_ids:
        return 0

    emails = get_emails_by_any_label([IMPORTANT_LABEL, *LEGACY_IMPORTANT_LABELS], limit=limit)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_old)
    updated = 0

    for email in emails:
        if "UNREAD" in email.labels:
            continue
        if REVIEWED_LABEL in email.labels:
            continue
        if not email.date:
            continue

        try:
            parsed_date = parsedate_to_datetime(email.date)
            if parsed_date.tzinfo is None:
                parsed_date = parsed_date.replace(tzinfo=timezone.utc)
            parsed_date = parsed_date.astimezone(timezone.utc)
        except Exception:
            continue

        if parsed_date > cutoff:
            continue

        (
            service.users()
            .messages()
            .modify(
                userId="me",
                id=email.id,
                body={
                    "addLabelIds": [reviewed_label_id],
                    "removeLabelIds": important_label_ids,
                },
            )
            .execute()
        )
        updated += 1

    return updated


def cleanup_inbox(
    emails: List[EmailSummary],
    classify_cleanup_email_fn,
    dry_run: bool = True,
    progress_callback=None,
) -> CleanupResponse:
    service = get_gmail_service()
    _, label_name_to_id = get_label_maps(service)
    items: List[CleanupItem] = []

    for email in emails:
        result = classify_cleanup_email_fn(email)
        classification = result.get("classification")
        decision = result.get("decision")

        if classification is None or decision is None:
            fallback_classification = EmailClassification(
                category="reference",
                importance_score=3,
                needs_reply=False,
                urgency="low",
                suggested_action="archive",
                reason="Cleanup planner returned an incomplete result.",
            )
            classification = fallback_classification
            decision = _fallback_cleanup_decision(email, fallback_classification)

        decision = decision.model_copy(update={"archive": True})
        if decision.action == "keep":
            decision = decision.model_copy(
                update={
                    "action": "archive",
                    "reason": f"{decision.reason} Archived to maintain zero inbox.",
                }
            )

        item = CleanupItem(
            email=email,
            classification=classification,
            decision=decision,
        )

        if not dry_run:
            _apply_decision(service, item, label_name_to_id)

        items.append(item)
        if progress_callback is not None:
            progress_callback(len(items), len(emails), email)

    summary = CleanupSummary(
        total_processed=len(items),
        archived=sum(1 for item in items if item.decision.archive),
        labeled_only=sum(
            1 for item in items if item.decision.action == "label" and not item.decision.archive
        ),
        kept=sum(1 for item in items if item.decision.action == "keep"),
    )

    return CleanupResponse(
        dry_run=dry_run,
        summary=summary,
        items=items,
    )


def process_new_inbox_emails(
    emails: List[EmailSummary],
    classify_rule_fn,
    ai_fallback_fn=None,
    dry_run: bool = True,
) -> RuleProcessResponse:
    service = get_gmail_service()
    _, label_name_to_id = get_label_maps(service)
    items: List[RuleItem] = []

    for email in emails:
        decision = classify_rule_fn(email)
        if decision.matched_rule == "needs_ai_review" and ai_fallback_fn is not None:
            ai_decision = ai_fallback_fn(email)
            decision = RuleDecision(
                label_name=canonicalize_importance_label(ai_decision.label_name) or UNIMPORTANT_LABEL,
                archive=ai_decision.archive,
                matched_rule="needs_ai_review",
                source="ai_fallback",
                reason=ai_decision.reason,
            )
        else:
            decision = decision.model_copy(
                update={
                    "label_name": canonicalize_importance_label(decision.label_name) or UNIMPORTANT_LABEL,
                }
            )
        item = RuleItem(email=email, decision=decision)

        if not dry_run:
            _apply_rule_decision(service, email, decision, label_name_to_id)

        items.append(item)

    by_label: dict[str, int] = {}
    for item in items:
        by_label[item.decision.label_name] = by_label.get(item.decision.label_name, 0) + 1

    summary = RuleSummary(
        total_processed=len(items),
        archived=sum(1 for item in items if item.decision.archive),
        by_label=by_label,
    )

    return RuleProcessResponse(
        dry_run=dry_run,
        unread_only=True,
        summary=summary,
        items=items,
    )
