import base64
import os.path
from typing import List, Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from app.config import GMAIL_SCOPES, GMAIL_TOKEN_FILE, GMAIL_CREDENTIALS_FILE
from app.schemas import EmailSummary


def get_gmail_service():
    creds: Optional[Credentials] = None

    if os.path.exists(GMAIL_TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(GMAIL_TOKEN_FILE, GMAIL_SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(
                GMAIL_CREDENTIALS_FILE,
                GMAIL_SCOPES,
            )
            creds = flow.run_local_server(port=0)

        with open(GMAIL_TOKEN_FILE, "w") as token:
            token.write(creds.to_json())

    return build("gmail", "v1", credentials=creds)


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


def get_recent_inbox_emails(max_results: int = 10) -> List[EmailSummary]:
    service = get_gmail_service()

    results = (
        service.users()
        .messages()
        .list(userId="me", labelIds=["INBOX"], maxResults=max_results)
        .execute()
    )

    messages = results.get("messages", [])
    email_summaries: List[EmailSummary] = []

    for msg in messages:
        msg_id = msg["id"]
        full_msg = (
            service.users()
            .messages()
            .get(userId="me", id=msg_id, format="full")
            .execute()
        )

        payload = full_msg.get("payload", {})
        headers = payload.get("headers", [])

        subject = _get_header(headers, "Subject")
        sender = _get_header(headers, "From")
        date = _get_header(headers, "Date")
        snippet = full_msg.get("snippet", "")
        labels = full_msg.get("labelIds", [])
        body = _extract_text_from_payload(payload)

        email_summaries.append(
            EmailSummary(
                id=full_msg["id"],
                thread_id=full_msg["threadId"],
                subject=subject,
                sender=sender,
                snippet=snippet,
                date=date,
                labels=labels,
                body=body[:5000] if body else None,
            )
        )

    return email_summaries