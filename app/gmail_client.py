import base64
import html
import os.path
import re
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Dict, List, Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from app.classification_cache import update_cached_email
from app.classifier import IMPORTANT_LABEL, LEGACY_IMPORTANT_LABELS, LEGACY_UNIMPORTANT_LABELS, UNIMPORTANT_LABEL, canonicalize_importance_label
from app.config import GMAIL_TOKEN_FILE, GMAIL_CREDENTIALS_FILE, GOOGLE_SCOPES
from app.schemas import CleanupDecision, CleanupItem, CleanupResponse, CleanupSummary, EmailClassification, EmailLink, EmailPageResponse, EmailSummary, EmailUpdateResponse, GmailLabel, HandleEmailResponse, RuleDecision, RuleItem, RuleProcessResponse, RuleSummary

REVIEWED_LABEL = "Reviewed"
ALL_IMPORTANCE_LABEL_NAMES = {
    IMPORTANT_LABEL,
    UNIMPORTANT_LABEL,
    *LEGACY_IMPORTANT_LABELS,
    *LEGACY_UNIMPORTANT_LABELS,
}

_BLANK_LINE_RE = re.compile(r"\n{3,}")
_SPACE_BEFORE_NEWLINE_RE = re.compile(r"[ \t]+\n")
_HORIZONTAL_WHITESPACE_RE = re.compile(r"[^\S\n]+")
_INVISIBLE_SPACER_RE = re.compile(r"[\u2800\u3164\ufeff]+")
_PLAIN_TEXT_LINK_RE = re.compile(r"^<?((?:https?://|mailto:|tel:)[^>\s]+)>?$", re.IGNORECASE)
_BLOCK_TAGS = {
    "address",
    "article",
    "aside",
    "blockquote",
    "caption",
    "div",
    "dl",
    "dt",
    "dd",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "td",
    "th",
    "tr",
    "ul",
}
_SUPPORTED_LINK_SCHEMES = ("http://", "https://", "mailto:", "tel:")
_BUTTON_HINTS = ("button", "btn", "cta", "action")


@dataclass
class _ParsedHtmlContent:
    text: str = ""
    links: list[EmailLink] = field(default_factory=list)


@dataclass
class _PayloadContent:
    plain_text: str = ""
    html_text: str = ""
    links: list[EmailLink] = field(default_factory=list)


class _EmailHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._text_parts: list[str] = []
        self._links: list[EmailLink] = []
        self._active_link: dict | None = None
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_name = tag.lower()
        attr_map = {name.lower(): (value or "") for name, value in attrs}

        if tag_name in {"script", "style"}:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return

        if tag_name == "br":
            self._text_parts.append("\n")
        elif tag_name in _BLOCK_TAGS:
            self._text_parts.append("\n\n")

        if tag_name == "a":
            href = html.unescape(attr_map.get("href", "")).strip()
            if href:
                self._active_link = {
                    "url": href,
                    "label_parts": [],
                    "kind": "button" if _looks_like_button_anchor(attr_map) else "link",
                }
        elif tag_name == "button" and self._active_link is not None:
            self._active_link["kind"] = "button"

    def handle_endtag(self, tag: str) -> None:
        tag_name = tag.lower()

        if tag_name in {"script", "style"}:
            if self._skip_depth:
                self._skip_depth -= 1
            return
        if self._skip_depth:
            return

        if tag_name == "a" and self._active_link is not None:
            raw_url = self._active_link["url"]
            if _is_supported_link(raw_url):
                label = _normalize_plain_text("".join(self._active_link["label_parts"]))
                self._links.append(
                    EmailLink(
                        url=raw_url,
                        label=label or _fallback_label_for_url(raw_url),
                        kind=self._active_link["kind"],
                    )
                )
            self._active_link = None

    def handle_data(self, data: str) -> None:
        if self._skip_depth or not data:
            return
        self._text_parts.append(data)
        if self._active_link is not None:
            self._active_link["label_parts"].append(data)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def get_content(self) -> _ParsedHtmlContent:
        return _ParsedHtmlContent(
            text=_normalize_plain_text("".join(self._text_parts)),
            links=_dedupe_email_links(self._links),
        )


def get_gmail_service():
    creds: Optional[Credentials] = None

    if os.path.exists(GMAIL_TOKEN_FILE):
        try:
            creds = Credentials.from_authorized_user_file(GMAIL_TOKEN_FILE, GOOGLE_SCOPES)
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
                    GOOGLE_SCOPES,
                )
                creds = flow.run_local_server(port=0)
            except Exception as exc:
                raise RuntimeError(
                    "Failed to complete Google OAuth flow. "
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


def _normalize_plain_text(value: str) -> str:
    if not value:
        return ""
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\xa0", " ")
    value = _INVISIBLE_SPACER_RE.sub(" ", value)
    value = _SPACE_BEFORE_NEWLINE_RE.sub("\n", value)
    value = _HORIZONTAL_WHITESPACE_RE.sub(" ", value)
    value = _BLANK_LINE_RE.sub("\n\n", value)
    return value.strip()


def _looks_like_button_anchor(attrs: dict[str, str]) -> bool:
    searchable = " ".join(
        attrs.get(name, "") for name in ("class", "id", "role", "aria-label", "title", "style")
    ).lower()
    return attrs.get("role", "").lower() == "button" or any(hint in searchable for hint in _BUTTON_HINTS)


def _is_supported_link(url: str) -> bool:
    normalized = url.strip().lower()
    return normalized.startswith(_SUPPORTED_LINK_SCHEMES)


def _fallback_label_for_url(url: str) -> str:
    if url.lower().startswith("mailto:"):
        return f"Email {url[7:]}"
    if url.lower().startswith("tel:"):
        return f"Call {url[4:]}"
    return "Open link"


def _dedupe_email_links(links: list[EmailLink], max_links: int = 12) -> list[EmailLink]:
    deduped: list[EmailLink] = []
    seen: dict[str, int] = {}

    for link in links:
        key = link.url.strip()
        existing_index = seen.get(key)
        if existing_index is not None:
            existing = deduped[existing_index]
            if existing.kind != "button" and link.kind == "button":
                deduped[existing_index] = link
            elif existing.label == "Open link" and link.label != "Open link":
                deduped[existing_index] = link
            continue

        seen[key] = len(deduped)
        deduped.append(link)
        if len(deduped) >= max_links:
            break

    return deduped


def _parse_html_content(value: str) -> _ParsedHtmlContent:
    if not value:
        return _ParsedHtmlContent()

    parser = _EmailHTMLParser()
    parser.feed(value)
    parser.close()
    return parser.get_content()


def _looks_like_link_label(value: str) -> bool:
    cleaned = _normalize_plain_text(value).strip(":- ")
    if not cleaned or len(cleaned) > 40:
        return False
    if _PLAIN_TEXT_LINK_RE.match(cleaned):
        return False
    return not cleaned.endswith((".", "!", "?"))


def _extract_plain_text_content(value: str) -> _PayloadContent:
    normalized = _normalize_plain_text(value)
    if not normalized:
        return _PayloadContent()

    lines = normalized.split("\n")
    kept_lines: list[str] = []
    links: list[EmailLink] = []

    for raw_line in lines:
        line = raw_line.strip()
        match = _PLAIN_TEXT_LINK_RE.match(line)
        if not match:
            kept_lines.append(raw_line)
            continue

        url = match.group(1).strip()
        if not _is_supported_link(url):
            kept_lines.append(raw_line)
            continue

        label = _fallback_label_for_url(url)
        kind = "link"

        previous = kept_lines[-1].strip() if kept_lines else ""
        if previous and _looks_like_link_label(previous):
            label = previous
            kind = "button"
            kept_lines.pop()

        links.append(EmailLink(url=url, label=label, kind=kind))

    body = _normalize_plain_text("\n".join(kept_lines))
    return _PayloadContent(plain_text=body, links=_dedupe_email_links(links))


def _extract_content_from_payload(payload: dict) -> _PayloadContent:
    mime_type = payload.get("mimeType", "")
    body = payload.get("body", {})
    data = body.get("data")

    if mime_type == "text/plain" and data:
        return _extract_plain_text_content(_decode_base64url(data))

    if mime_type == "text/html" and data:
        parsed_html = _parse_html_content(_decode_base64url(data))
        return _PayloadContent(html_text=parsed_html.text, links=parsed_html.links)

    collected = _PayloadContent()
    for part in payload.get("parts", []):
        part_content = _extract_content_from_payload(part)
        if part_content.plain_text and not collected.plain_text:
            collected.plain_text = part_content.plain_text
        if part_content.html_text and not collected.html_text:
            collected.html_text = part_content.html_text
        if part_content.links and not collected.links:
            collected.links = part_content.links

    return collected


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
    extracted = _extract_content_from_payload(payload)
    body = extracted.plain_text or extracted.html_text

    return EmailSummary(
        id=full_msg["id"],
        thread_id=full_msg["threadId"],
        subject=subject,
        sender=sender,
        snippet=snippet,
        date=date,
        labels=labels,
        body=body[:5000] if body else None,
        links=extracted.links,
    )


def _fetch_message(service, msg_id: str, label_id_to_name: Dict[str, str]) -> EmailSummary:
    full_msg = (
        service.users()
        .messages()
        .get(userId="me", id=msg_id, format="full")
        .execute()
    )
    return _to_email_summary(full_msg, label_id_to_name)


def get_email_by_id(message_id: str) -> EmailSummary:
    service = get_gmail_service()
    label_id_to_name, _ = get_label_maps(service)
    return _fetch_message(service, message_id, label_id_to_name)


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

    if "UNREAD" in email.labels:
        remove_label_ids.append("UNREAD")

    for label_name in {
        IMPORTANT_LABEL,
        UNIMPORTANT_LABEL,
        *LEGACY_IMPORTANT_LABELS,
        *LEGACY_UNIMPORTANT_LABELS,
    }:
        label_id = label_name_to_id.get(label_name)
        if label_id and label_name in email.labels:
            remove_label_ids.append(label_id)

    _modify_thread(
        service,
        email.thread_id,
        add_label_ids=add_label_ids,
        remove_label_ids=remove_label_ids,
    )

    updated_email = _fetch_message(service, message_id, label_id_to_name)
    update_cached_email(updated_email)

    return HandleEmailResponse(
        message_id=message_id,
        removed_label="Jarvis labels",
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
        cleaned = canonicalize_importance_label(" ".join(label_name.split()).strip())
        if not cleaned:
            continue
        label_id = _get_or_create_label_id(service, cleaned, label_name_to_id)
        add_label_ids.append(label_id)

    for label_name in remove_label_names or []:
        cleaned = canonicalize_importance_label(" ".join(label_name.split()).strip())
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
    update_cached_email(updated_email)
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
