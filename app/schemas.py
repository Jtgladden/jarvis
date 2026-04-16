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
    short_summary: str = ""
    why_it_matters: str = ""
    action_items: List[str] = Field(default_factory=list)
    deadline_hint: Optional[str] = None
    suggested_reply: Optional[str] = None
    calendar_relevant: bool = False
    calendar_title: Optional[str] = None
    calendar_start: Optional[str] = None
    calendar_end: Optional[str] = None
    calendar_is_all_day: bool = False
    calendar_location: Optional[str] = None
    calendar_notes: Optional[str] = None
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


class ClassifiedEmailResponse(BaseModel):
    email: EmailSummary
    classification: EmailClassification


class EmailPageResponse(BaseModel):
    items: List[EmailSummary]
    next_page_token: Optional[str] = None


class SenderOverview(BaseModel):
    sender: str
    count: int


class OverviewLinkedItem(BaseModel):
    message_id: str
    subject: str
    sender: str
    text: str
    count: int = 1


class ClassificationOverviewResponse(BaseModel):
    mailbox: str
    total_cached: int
    needs_reply: int
    action_item_count: int = 0
    deadlines_found: int = 0
    categories: dict[str, int] = Field(default_factory=dict)
    urgency: dict[str, int] = Field(default_factory=dict)
    top_senders: List[SenderOverview] = Field(default_factory=list)
    top_action_items: List[OverviewLinkedItem] = Field(default_factory=list)
    deadline_highlights: List[OverviewLinkedItem] = Field(default_factory=list)


class ClassificationGuidanceRequest(BaseModel):
    text: str = ""


class ClassificationGuidanceResponse(BaseModel):
    text: str = ""
    updated_at: Optional[str] = None
    version: str


class CalendarEventPreview(BaseModel):
    message_id: str
    thread_id: str
    relevant: bool = False
    title: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    is_all_day: bool = False
    location: Optional[str] = None
    notes: Optional[str] = None
    reason: Optional[str] = None


class CalendarEventCreateResponse(BaseModel):
    created: bool
    event_id: Optional[str] = None
    html_link: Optional[str] = None
    preview: CalendarEventPreview


class CalendarQuickAddRequest(BaseModel):
    description: str


class CalendarQuickAddResponse(BaseModel):
    created: bool
    event_id: Optional[str] = None
    html_link: Optional[str] = None
    title: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    is_all_day: bool = False
    location: Optional[str] = None
    notes: Optional[str] = None
    source_text: str = ""


class CalendarAgendaItem(BaseModel):
    event_id: str
    title: str
    start: str
    end: Optional[str] = None
    is_all_day: bool = False
    location: Optional[str] = None
    description: Optional[str] = None
    html_link: Optional[str] = None
    removed: bool = False


class CalendarAgendaResponse(BaseModel):
    calendar_id: str
    time_min: str
    time_max: str
    items: List[CalendarAgendaItem] = Field(default_factory=list)


class PlanningRequest(BaseModel):
    goals: str
    days: int = Field(default=7, ge=1, le=14)


class PlanningItem(BaseModel):
    id: str
    title: str
    start: str
    end: str
    day_label: str
    priority: Literal["high", "medium", "low"] = "medium"
    kind: Literal["focus", "meeting_prep", "admin", "personal", "buffer"] = "focus"
    rationale: str


class PlanningResponse(BaseModel):
    summary: str
    strategy: str
    priorities: List[str] = Field(default_factory=list)
    items: List[PlanningItem] = Field(default_factory=list)


class PlanningJobStartResponse(BaseModel):
    job_id: str
    status: Literal["queued", "running"]


class PlanningJobStatus(BaseModel):
    job_id: str
    status: Literal["queued", "running", "completed", "failed"]
    goals: str = ""
    days: int = 7
    result: Optional[PlanningResponse] = None
    error: Optional[str] = None


class PlanningCalendarCreateRequest(BaseModel):
    item: PlanningItem


class PlanningCalendarCreateResponse(BaseModel):
    created: bool
    event_id: Optional[str] = None
    html_link: Optional[str] = None
    item: PlanningItem


class PlanningCalendarBulkCreateRequest(BaseModel):
    items: List[PlanningItem] = Field(default_factory=list)


class PlanningCalendarBulkCreateResponse(BaseModel):
    created_count: int = 0
    items: List[PlanningCalendarCreateResponse] = Field(default_factory=list)


class DashboardMailItem(BaseModel):
    message_id: str
    subject: str
    sender: str
    summary: str = ""
    why_it_matters: str = ""
    urgency: Literal["low", "medium", "high"] = "low"
    needs_reply: bool = False
    deadline_hint: Optional[str] = None
    action_items: List[str] = Field(default_factory=list)


class DashboardNewsItem(BaseModel):
    title: str
    source: Optional[str] = None
    link: Optional[str] = None
    published_at: Optional[str] = None


class DashboardTaskItem(BaseModel):
    id: str
    title: str
    detail: Optional[str] = None
    due_text: Optional[str] = None
    source: Literal["mail", "calendar", "news", "planning"] = "mail"
    priority: Literal["high", "medium", "low"] = "medium"
    related_message_id: Optional[str] = None
    related_event_id: Optional[str] = None


class DashboardResponse(BaseModel):
    generated_at: str
    date_label: str
    overview: str = ""
    mail_summary: str = ""
    news_summary: str = ""
    tasks_summary: str = ""
    calendar_items: List[CalendarAgendaItem] = Field(default_factory=list)
    important_emails: List[DashboardMailItem] = Field(default_factory=list)
    news_items: List[DashboardNewsItem] = Field(default_factory=list)
    tasks: List[DashboardTaskItem] = Field(default_factory=list)


class JournalDayNoteUpdateRequest(BaseModel):
    journal_entry: str = ""
    accomplishments: str = ""
    gratitude_entry: str = ""
    scripture_study: str = ""
    spiritual_notes: str = ""
    photo_data_url: Optional[str] = None
    calendar_items: List[CalendarAgendaItem] = Field(default_factory=list)


class JournalNewsArticle(BaseModel):
    title: str
    source: Optional[str] = None
    link: Optional[str] = None
    published_at: Optional[str] = None


class JournalDayEntry(BaseModel):
    date: str
    date_label: str
    calendar_summary: str = ""
    world_event_title: Optional[str] = None
    world_event_summary: str = ""
    world_event_source: Optional[str] = None
    world_event_articles: List[JournalNewsArticle] = Field(default_factory=list)
    journal_entry: str = ""
    accomplishments: str = ""
    gratitude_entry: str = ""
    scripture_study: str = ""
    spiritual_notes: str = ""
    photo_data_url: Optional[str] = None
    calendar_items: List[CalendarAgendaItem] = Field(default_factory=list)
    updated_at: Optional[str] = None


class JournalResponse(BaseModel):
    generated_at: str
    entries: List[JournalDayEntry] = Field(default_factory=list)
