from pydantic import BaseModel, Field
from typing import Optional, List, Literal


class EmailSummary(BaseModel):
    id: str
    thread_id: str
    subject: str
    sender: str
    snippet: str
    date: Optional[str] = None
    labels: List[str] = Field(default_factory=list)
    body: Optional[str] = None


class GmailLabel(BaseModel):
    id: str
    name: str
    type: Literal["system", "user"]
    messages_total: int = 0
    messages_unread: int = 0


class EmailClassification(BaseModel):
    category: Literal[
        "action_required",
        "meeting",
        "reference",
        "newsletter",
        "promotion",
        "receipt",
        "spam",
    ] = "reference"
    importance_score: int = 3
    needs_reply: bool = False
    urgency: Literal["low", "medium", "high"] = "low"
    suggested_action: Literal["keep", "archive", "label"] = "keep"
    reason: str = ""
    raw: Optional[str] = None


class CleanupDecision(BaseModel):
    action: Literal["keep", "archive", "label"]
    label_name: Optional[str] = None
    archive: bool = False
    reason: str


class CleanupItem(BaseModel):
    email: EmailSummary
    classification: EmailClassification
    decision: CleanupDecision


class CleanupSummary(BaseModel):
    total_processed: int
    archived: int
    labeled_only: int
    kept: int


class CleanupResponse(BaseModel):
    dry_run: bool
    summary: CleanupSummary
    items: List[CleanupItem]


class CleanupJobStartResponse(BaseModel):
    job_id: str
    status: Literal["queued", "running"]


class CleanupJobStatus(BaseModel):
    job_id: str
    status: Literal["queued", "running", "completed", "failed"]
    dry_run: bool
    processed: int = 0
    total: int = 0
    current_subject: Optional[str] = None
    result: Optional[CleanupResponse] = None
    error: Optional[str] = None


class RuleDecision(BaseModel):
    label_name: str
    archive: bool = True
    matched_rule: str
    source: Literal["rule", "ai_fallback"] = "rule"
    reason: str


class RuleItem(BaseModel):
    email: EmailSummary
    decision: RuleDecision


class RuleSummary(BaseModel):
    total_processed: int
    archived: int
    by_label: dict[str, int] = Field(default_factory=dict)


class RuleProcessResponse(BaseModel):
    dry_run: bool
    unread_only: bool
    summary: RuleSummary
    items: List[RuleItem]


class HandleEmailResponse(BaseModel):
    message_id: str
    removed_label: str
    added_label: str
    status: str


class EmailUpdateRequest(BaseModel):
    add_label_names: List[str] = Field(default_factory=list)
    remove_label_names: List[str] = Field(default_factory=list)
    archive: Optional[bool] = None
    unread: Optional[bool] = None


class EmailUpdateResponse(BaseModel):
    email: EmailSummary


class EmailPageResponse(BaseModel):
    items: List[EmailSummary]
    next_page_token: Optional[str] = None
