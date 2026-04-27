from pydantic import BaseModel, Field
from typing import Any, Optional, List, Literal


class EmailLink(BaseModel):
    url: str
    label: str
    kind: Literal["link", "button"] = "link"


class EmailSummary(BaseModel):
    id: str
    thread_id: str
    subject: str
    sender: str
    snippet: str
    date: Optional[str] = None
    labels: List[str] = Field(default_factory=list)
    body: Optional[str] = None
    links: List[EmailLink] = Field(default_factory=list)


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
    source: Literal["mail", "calendar", "news", "planning", "custom"] = "mail"
    priority: Literal["high", "medium", "low"] = "medium"
    related_message_id: Optional[str] = None
    related_event_id: Optional[str] = None
    completed: bool = False
    updated_at: Optional[str] = None
    custom: bool = False


class HealthDailyEntry(BaseModel):
    date: str
    source: str = "ios_healthkit"
    steps: int = 0
    active_energy_kcal: Optional[float] = None
    sleep_hours: Optional[float] = None
    workouts: int = 0
    resting_heart_rate: Optional[float] = None
    extra_metrics: dict[str, float | int | str | None] = Field(default_factory=dict)
    synced_at: Optional[str] = None


class DashboardHealthSummary(BaseModel):
    latest_date: Optional[str] = None
    last_synced_at: Optional[str] = None
    today_entry: Optional[HealthDailyEntry] = None
    recent_entries: List[HealthDailyEntry] = Field(default_factory=list)
    seven_day_avg_steps: Optional[int] = None
    seven_day_avg_sleep_hours: Optional[float] = None
    streak_days: int = 0


class DashboardResponse(BaseModel):
    generated_at: str
    date_label: str
    overview: str = ""
    mail_summary: str = ""
    news_summary: str = ""
    tasks_summary: str = ""
    health_summary: Optional[DashboardHealthSummary] = None
    calendar_items: List[CalendarAgendaItem] = Field(default_factory=list)
    important_emails: List[DashboardMailItem] = Field(default_factory=list)
    news_items: List[DashboardNewsItem] = Field(default_factory=list)
    tasks: List[DashboardTaskItem] = Field(default_factory=list)


class TaskCreateRequest(BaseModel):
    title: str
    detail: str = ""
    due_text: Optional[str] = None
    priority: Literal["high", "medium", "low"] = "medium"
    source: Literal["mail", "calendar", "news", "planning", "custom"] = "custom"
    related_message_id: Optional[str] = None
    related_event_id: Optional[str] = None


class TaskUpdateRequest(BaseModel):
    title: Optional[str] = None
    detail: Optional[str] = None
    due_text: Optional[str] = None
    priority: Optional[Literal["high", "medium", "low"]] = None
    completed: Optional[bool] = None


class TaskListResponse(BaseModel):
    generated_at: str
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


class JournalStudyLink(BaseModel):
    label: str
    url: str
    confidence: Literal["exact", "likely"] = "exact"
    matched_text: Optional[str] = None


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
    study_links: List[JournalStudyLink] = Field(default_factory=list)
    photo_data_url: Optional[str] = None
    calendar_items: List[CalendarAgendaItem] = Field(default_factory=list)
    updated_at: Optional[str] = None


class JournalResponse(BaseModel):
    generated_at: str
    entries: List[JournalDayEntry] = Field(default_factory=list)
    total_entries: int = 0
    has_more: bool = False
    next_before: Optional[str] = None
    saved_only: bool = False
    query: str = ""


class HealthDailySyncRequest(BaseModel):
    date: Optional[str] = None
    source: str = "ios_healthkit"
    steps: int = 0
    active_energy_kcal: Optional[float] = None
    sleep_hours: Optional[float] = None
    workouts: int = 0
    resting_heart_rate: Optional[float] = None
    extra_metrics: dict[str, float | int | str | None] = Field(default_factory=dict)


class HealthDailySyncResponse(BaseModel):
    saved: bool = True
    entry: HealthDailyEntry


class HealthListResponse(BaseModel):
    entries: List[HealthDailyEntry] = Field(default_factory=list)


class WorkoutRoutePoint(BaseModel):
    timestamp: str
    latitude: float
    longitude: float
    altitude_m: Optional[float] = None
    horizontal_accuracy_m: Optional[float] = None
    vertical_accuracy_m: Optional[float] = None


class WorkoutEntry(BaseModel):
    workout_id: str
    date: str
    source: str = "ios_healthkit_workout"
    activity_type: str = "other"
    activity_label: str = "Other"
    start_date: str
    end_date: str
    duration_minutes: float = 0
    total_distance_km: Optional[float] = None
    active_energy_kcal: Optional[float] = None
    avg_heart_rate_bpm: Optional[float] = None
    max_heart_rate_bpm: Optional[float] = None
    source_name: Optional[str] = None
    route_points: List[WorkoutRoutePoint] = Field(default_factory=list)
    synced_at: Optional[str] = None


class WorkoutSyncRequest(BaseModel):
    workout_id: str
    date: str
    source: str = "ios_healthkit_workout"
    activity_type: str = "other"
    activity_label: str = "Other"
    start_date: str
    end_date: str
    duration_minutes: float = 0
    total_distance_km: Optional[float] = None
    active_energy_kcal: Optional[float] = None
    avg_heart_rate_bpm: Optional[float] = None
    max_heart_rate_bpm: Optional[float] = None
    source_name: Optional[str] = None
    route_points: List[WorkoutRoutePoint] = Field(default_factory=list)


class WorkoutBatchSyncRequest(BaseModel):
    workouts: List[WorkoutSyncRequest] = Field(default_factory=list)


class WorkoutSyncResponse(BaseModel):
    saved: bool = True
    workout: WorkoutEntry


class WorkoutBatchSyncResponse(BaseModel):
    saved: int = 0
    workouts: List[WorkoutEntry] = Field(default_factory=list)


class WorkoutListResponse(BaseModel):
    workouts: List[WorkoutEntry] = Field(default_factory=list)


class MovementVisit(BaseModel):
    arrival: Optional[str] = None
    departure: Optional[str] = None
    latitude: float
    longitude: float
    horizontal_accuracy_m: Optional[float] = None
    label: Optional[str] = None


class MovementRoutePoint(BaseModel):
    timestamp: str
    latitude: float
    longitude: float
    horizontal_accuracy_m: Optional[float] = None


class MovementDailyEntry(BaseModel):
    date: str
    source: str = "ios_core_location"
    total_distance_km: float = 0
    time_away_minutes: Optional[int] = None
    visited_places_count: int = 0
    movement_story: str = ""
    home_label: Optional[str] = None
    commute_start: Optional[str] = None
    commute_end: Optional[str] = None
    visits: List[MovementVisit] = Field(default_factory=list)
    route_points: List[MovementRoutePoint] = Field(default_factory=list)
    place_labels: List[str] = Field(default_factory=list)
    synced_at: Optional[str] = None


class MovementDailySyncRequest(BaseModel):
    date: str
    source: str = "ios_core_location"
    total_distance_km: float = 0
    time_away_minutes: Optional[int] = None
    visited_places_count: int = 0
    movement_story: str = ""
    home_label: Optional[str] = None
    commute_start: Optional[str] = None
    commute_end: Optional[str] = None
    visits: List[MovementVisit] = Field(default_factory=list)
    route_points: List[MovementRoutePoint] = Field(default_factory=list)
    place_labels: List[str] = Field(default_factory=list)


class MovementDailySyncResponse(BaseModel):
    saved: bool = True
    entry: MovementDailyEntry


class MovementListResponse(BaseModel):
    entries: List[MovementDailyEntry] = Field(default_factory=list)


class TrailPoint(BaseModel):
    latitude: float
    longitude: float


class TrailSearchItem(BaseModel):
    id: str
    name: str
    source: Literal["usgs", "nps", "osm_relation", "osm_way"] = "usgs"
    trail_type: str = "hiking"
    ref: Optional[str] = None
    operator: Optional[str] = None
    network: Optional[str] = None
    distance_from_center_m: Optional[float] = None
    length_m: Optional[float] = None
    points: List[TrailPoint] = Field(default_factory=list)
    osm_url: Optional[str] = None


class TrailSearchResponse(BaseModel):
    provider: str = "openstreetmap_overpass"
    count: int = 0
    source_counts: dict[str, int] = Field(default_factory=dict)
    debug: dict[str, Any] = Field(default_factory=dict)
    items: List[TrailSearchItem] = Field(default_factory=list)


class AssistantChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = ""


class AssistantStoredMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str = ""
    bullets: List[str] = Field(default_factory=list)
    follow_ups: List[str] = Field(default_factory=list)
    sources: List["AssistantSource"] = Field(default_factory=list)
    created_at: Optional[str] = None


class AssistantAskRequest(BaseModel):
    question: str = ""
    chat_id: Optional[str] = None
    history: List[AssistantChatMessage] = Field(default_factory=list)


class AssistantSource(BaseModel):
    id: str
    label: str
    kind: Literal["dashboard", "mail", "tasks", "calendar", "health", "movement", "workout", "journal", "news", "web", "system"] = "system"
    detail: Optional[str] = None
    url: Optional[str] = None


class AssistantAskResponse(BaseModel):
    chat_id: str
    answer: str = ""
    bullets: List[str] = Field(default_factory=list)
    follow_ups: List[str] = Field(default_factory=list)
    sources: List[AssistantSource] = Field(default_factory=list)
    context_summary: str = ""
    model: Optional[str] = None


class AssistantChatSummary(BaseModel):
    id: str
    title: str = ""
    preview: str = ""
    message_count: int = 0
    archived: bool = False
    updated_at: Optional[str] = None


class AssistantChatListResponse(BaseModel):
    chats: List[AssistantChatSummary] = Field(default_factory=list)


class AssistantChatThread(BaseModel):
    id: str
    title: str = ""
    archived: bool = False
    messages: List[AssistantStoredMessage] = Field(default_factory=list)
    updated_at: Optional[str] = None


LanguageCode = Literal["tagalog", "hiligaynon", "japanese", "spanish"]
LanguageLevel = Literal["beginner", "elementary", "intermediate", "advanced"]


class LanguageMetadata(BaseModel):
    code: LanguageCode
    name: str
    local_name: str
    script_hint: str = ""
    greeting: str = ""
    focus_topics: List[str] = Field(default_factory=list)


class LanguageProfile(BaseModel):
    target_languages: List[LanguageCode] = Field(default_factory=list)
    active_language: LanguageCode = "tagalog"
    level: LanguageLevel = "beginner"
    daily_goal_minutes: int = 15
    correction_style: Literal["gentle", "strict", "immersion"] = "gentle"
    romanization: bool = True
    updated_at: Optional[str] = None


class LanguageProfileUpdateRequest(BaseModel):
    target_languages: List[LanguageCode] = Field(default_factory=list)
    active_language: LanguageCode = "tagalog"
    level: LanguageLevel = "beginner"
    daily_goal_minutes: int = Field(default=15, ge=1, le=240)
    correction_style: Literal["gentle", "strict", "immersion"] = "gentle"
    romanization: bool = True


class LanguagePracticePrompt(BaseModel):
    id: str
    mode: Literal["vocabulary", "conversation", "writing", "grammar", "listening"]
    title: str
    prompt: str
    target_phrase: str = ""
    romanization: str = ""
    translation: str = ""
    notes: str = ""
    expected_answer: str = ""


class LanguageVocabItem(BaseModel):
    id: str
    language: LanguageCode
    phrase: str
    translation: str = ""
    notes: str = ""
    tags: List[str] = Field(default_factory=list)
    review_count: int = 0
    last_reviewed_at: Optional[str] = None
    next_review_at: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class LanguageVocabCreateRequest(BaseModel):
    language: LanguageCode
    phrase: str
    translation: str = ""
    notes: str = ""
    tags: List[str] = Field(default_factory=list)


class LanguageVocabReviewRequest(BaseModel):
    remembered: bool = True


class LanguageVocabUpdateRequest(BaseModel):
    phrase: str = ""
    translation: str = ""
    notes: str = ""
    tags: List[str] = Field(default_factory=list)


class LanguageVocabNormalizeResponse(BaseModel):
    normalized_count: int = 0
    skipped_count: int = 0
    items: List[LanguageVocabItem] = Field(default_factory=list)


class LanguagePracticeSession(BaseModel):
    id: str
    language: LanguageCode
    mode: Literal["daily", "conversation", "vocabulary", "writing", "grammar", "listening"]
    minutes: int = 0
    notes: str = ""
    created_at: Optional[str] = None


class LanguagePracticeSessionCreateRequest(BaseModel):
    language: LanguageCode
    mode: Literal["daily", "conversation", "vocabulary", "writing", "grammar", "listening"] = "daily"
    minutes: int = Field(default=10, ge=0, le=240)
    notes: str = ""


class LanguageProgressSummary(BaseModel):
    sessions_count: int = 0
    minutes_practiced: int = 0
    vocab_count: int = 0
    due_reviews: int = 0
    today_minutes: int = 0
    language_minutes: int = 0
    language_sessions_count: int = 0


class LanguageDashboardResponse(BaseModel):
    profile: LanguageProfile
    supported_languages: List[LanguageMetadata] = Field(default_factory=list)
    daily_prompts: List[LanguagePracticePrompt] = Field(default_factory=list)
    daily_focus_words: List[LanguageVocabItem] = Field(default_factory=list)
    vocab: List[LanguageVocabItem] = Field(default_factory=list)
    recent_sessions: List[LanguagePracticeSession] = Field(default_factory=list)
    progress: LanguageProgressSummary = Field(default_factory=LanguageProgressSummary)


class LanguagePracticeGenerateRequest(BaseModel):
    language: LanguageCode
    level: LanguageLevel = "beginner"
    mode: Literal["daily", "conversation", "vocabulary", "writing", "grammar", "listening"] = "daily"
    focus: str = ""
    include_saved_vocab: bool = True


class LanguagePracticeGenerateResponse(BaseModel):
    language: LanguageCode
    level: LanguageLevel
    title: str = ""
    overview: str = ""
    prompts: List[LanguagePracticePrompt] = Field(default_factory=list)
    suggested_minutes: int = 15


class LanguageWritingFeedbackRequest(BaseModel):
    language: LanguageCode
    level: LanguageLevel = "beginner"
    prompt: str = ""
    response: str = ""
    correction_style: Literal["gentle", "strict", "immersion"] = "gentle"


class LanguageFeedbackResponse(BaseModel):
    transcript: str = ""
    target_text: str = ""
    score: int = 0
    corrected_text: str = ""
    feedback: str = ""
    strengths: List[str] = Field(default_factory=list)
    fixes: List[str] = Field(default_factory=list)
    drills: List[str] = Field(default_factory=list)


class LanguageSpeechRequest(BaseModel):
    language: LanguageCode
    text: str
    speed: Literal["slow", "normal"] = "normal"


class LanguageConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = ""


class LanguageConversationRequest(BaseModel):
    language: LanguageCode
    level: LanguageLevel = "beginner"
    correction_style: Literal["gentle", "strict", "immersion"] = "gentle"
    message: str
    scenario: str = ""
    history: List[LanguageConversationMessage] = Field(default_factory=list)


class LanguageConversationResponse(BaseModel):
    reply: str = ""
    reply_romanization: str = ""
    translation: str = ""
    correction: str = ""
    suggested_user_reply: str = ""
    suggested_user_reply_romanization: str = ""
    vocab: List[LanguageVocabItem] = Field(default_factory=list)


class LanguageWordExplainRequest(BaseModel):
    language: LanguageCode
    level: LanguageLevel = "beginner"
    word: str
    translation: str = ""
    notes: str = ""


class LanguageWordExample(BaseModel):
    target: str = ""
    romanization: str = ""
    translation: str = ""
    note: str = ""


class LanguageWordExplainResponse(BaseModel):
    word: str = ""
    translation: str = ""
    romanization: str = ""
    part_of_speech: str = ""
    explanation: str = ""
    usage_notes: List[str] = Field(default_factory=list)
    examples: List[LanguageWordExample] = Field(default_factory=list)
    common_mistakes: List[str] = Field(default_factory=list)
    quick_drill: str = ""
