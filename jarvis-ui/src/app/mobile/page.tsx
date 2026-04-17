"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import React, { Suspense, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  House,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

type MobileTab = "today" | "mail" | "tasks" | "journal" | "schedule";
type MobileMailView = "ai" | "raw";

type DashboardMailItem = {
  message_id: string;
  subject: string;
  sender: string;
  summary: string;
  why_it_matters: string;
  urgency: "low" | "medium" | "high";
  needs_reply: boolean;
  deadline_hint?: string | null;
  action_items: string[];
};

type DashboardTaskItem = {
  id: string;
  title: string;
  detail?: string | null;
  due_text?: string | null;
  source: "mail" | "calendar" | "news" | "planning" | "custom";
  priority: "high" | "medium" | "low";
  related_message_id?: string | null;
  related_event_id?: string | null;
  completed: boolean;
  updated_at?: string | null;
  custom: boolean;
};

type CalendarAgendaItem = {
  event_id: string;
  title: string;
  start: string;
  end?: string | null;
  is_all_day: boolean;
};

type DashboardResponse = {
  generated_at: string;
  date_label: string;
  overview: string;
  mail_summary: string;
  news_summary: string;
  tasks_summary: string;
  calendar_items: CalendarAgendaItem[];
  important_emails: DashboardMailItem[];
  news_items: Array<{
    title: string;
    source?: string | null;
    link?: string | null;
    published_at?: string | null;
  }>;
  tasks: DashboardTaskItem[];
};

type TaskListResponse = {
  generated_at: string;
  tasks: DashboardTaskItem[];
};

type JournalDayEntry = {
  date: string;
  date_label: string;
  calendar_summary: string;
  world_event_title?: string | null;
  world_event_summary: string;
  journal_entry: string;
  accomplishments: string;
  gratitude_entry: string;
  updated_at?: string | null;
};

type JournalResponse = {
  generated_at: string;
  entries: JournalDayEntry[];
};

type Email = {
  id: string;
  thread_id: string;
  subject: string;
  sender: string;
  snippet: string;
  date?: string;
  labels?: string[];
  body?: string;
  classification?: {
    category?: string;
    short_summary?: string;
    why_it_matters?: string;
    urgency?: "low" | "medium" | "high";
    needs_reply?: boolean;
    action_items?: string[];
    deadline_hint?: string | null;
    suggested_reply?: string | null;
  };
};

type EmailPageResponse = {
  items: Email[];
  next_page_token?: string | null;
};

type CalendarAgendaResponse = {
  calendar_id: string;
  time_min: string;
  time_max: string;
  items: CalendarAgendaItem[];
};

async function fetchMobileMail(
  mailView: MobileMailView,
  selectedMailbox: "Jarvis Important" | "Jarvis Unimportant"
): Promise<Email[]> {
  if (mailView === "ai") {
    const response = await fetch(
      `${API_BASE}/classify?limit=20&mailbox=${encodeURIComponent(selectedMailbox)}`
    );
    if (!response.ok) {
      throw new Error(`Mail request failed with status ${response.status}`);
    }
    const data = (await response.json()) as Array<{
      email: Email;
      classification: Email["classification"];
    }>;
    return data.map((item) => ({
      ...item.email,
      classification: item.classification,
    }));
  }

  const response = await fetch(
    `${API_BASE}/emails?limit=20&mailbox=${encodeURIComponent(selectedMailbox)}`
  );
  if (!response.ok) {
    throw new Error(`Mail request failed with status ${response.status}`);
  }
  const data = (await response.json()) as EmailPageResponse;
  return data.items;
}

function parseCalendarDate(value: string | null | undefined) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatScheduleDateTime(value: string | null | undefined, isAllDay = false) {
  if (!value) return "Not scheduled";
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;

  return new Intl.DateTimeFormat(undefined, isAllDay
    ? { weekday: "short", month: "short", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
  ).format(parsed);
}

function summarizeJournal(entry: JournalDayEntry) {
  return (
    entry.journal_entry.trim() ||
    entry.accomplishments.trim() ||
    entry.gratitude_entry.trim() ||
    entry.world_event_title?.trim() ||
    entry.calendar_summary
  );
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getJournalSearchPatterns(query: string) {
  const normalized = query.trim();
  if (!normalized) return [];

  return Array.from(
    new Set(
      [normalized, ...normalized.split(/\s+/)]
        .map((part) => part.trim())
        .filter((part) => part.length >= 2)
    )
  ).sort((left, right) => right.length - left.length);
}

function highlightJournalSearchText(
  text: string | null | undefined,
  query: string
): React.ReactNode {
  const value = text || "";
  const patterns = getJournalSearchPatterns(query);
  if (!value || !patterns.length) {
    return value;
  }

  const matcher = new RegExp(`(${patterns.map(escapeRegex).join("|")})`, "gi");
  const segments = value.split(matcher);

  return segments.map((segment, index) =>
    patterns.some((pattern) => segment.toLowerCase() === pattern.toLowerCase()) ? (
      <mark
        key={`${segment}-${index}`}
        className="rounded-md bg-fuchsia-400/20 px-1 py-0.5 text-fuchsia-100 ring-1 ring-fuchsia-300/25"
      >
        {segment}
      </mark>
    ) : (
      <React.Fragment key={`${segment}-${index}`}>{segment}</React.Fragment>
    )
  );
}

function MobilePageContent() {
  const [activeTab, setActiveTab] = useState<MobileTab>("today");
  const [mailView, setMailView] = useState<MobileMailView>("ai");
  const [selectedMailbox, setSelectedMailbox] = useState<"Jarvis Important" | "Jarvis Unimportant">("Jarvis Important");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [tasks, setTasks] = useState<DashboardTaskItem[]>([]);
  const [journal, setJournal] = useState<JournalDayEntry[]>([]);
  const [journalQuery, setJournalQuery] = useState("");
  const [journalSearchInput, setJournalSearchInput] = useState("");
  const [mailItems, setMailItems] = useState<Email[]>([]);
  const [schedule, setSchedule] = useState<CalendarAgendaItem[]>([]);
  const [handlingEmailId, setHandlingEmailId] = useState<string | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDetail, setNewTaskDetail] = useState("");
  const searchParams = useSearchParams();

  const loadJournal = async (query = "") => {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();
      params.set("days", query.trim() ? "20" : "10");
      if (query.trim()) {
        params.set("query", query.trim());
      }

      const response = await fetch(`${API_BASE}/journal?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Journal request failed with status ${response.status}`);
      }

      const data = (await response.json()) as JournalResponse;
      setJournal(data.entries);
      setJournalQuery(query.trim());
      setJournalSearchInput(query);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load journal.");
    } finally {
      setLoading(false);
    }
  };

  const loadAll = async () => {
    setLoading(true);
    setError("");

    try {
      const [dashboardResponse, tasksResponse, journalResponse, scheduleResponse] = await Promise.all([
        fetch(`${API_BASE}/dashboard`),
        fetch(`${API_BASE}/tasks?include_completed=true`),
        fetch(`${API_BASE}/journal?days=${journalQuery ? "20" : "10"}${journalQuery ? `&query=${encodeURIComponent(journalQuery)}` : ""}`),
        fetch(`${API_BASE}/calendar/schedule?days=7&max_results=24`),
      ]);

      for (const response of [dashboardResponse, tasksResponse, journalResponse, scheduleResponse]) {
        if (!response.ok) {
          throw new Error(`Mobile page request failed with status ${response.status}`);
        }
      }

      const [dashboardData, tasksData, journalData, scheduleData] = await Promise.all([
        dashboardResponse.json() as Promise<DashboardResponse>,
        tasksResponse.json() as Promise<TaskListResponse>,
        journalResponse.json() as Promise<JournalResponse>,
        scheduleResponse.json() as Promise<CalendarAgendaResponse>,
      ]);

      setDashboard(dashboardData);
      setTasks(tasksData.tasks);
      setJournal(journalData.entries);
      setSchedule(scheduleData.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load mobile view.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (activeTab === "mail") {
      const run = async () => {
        setLoading(true);
        setError("");
        try {
          setMailItems(await fetchMobileMail(mailView, selectedMailbox));
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load mail.");
        } finally {
          setLoading(false);
        }
      };
      void run();
    }
  }, [activeTab, mailView, selectedMailbox]);

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "today" || tab === "mail" || tab === "tasks" || tab === "journal" || tab === "schedule") {
      setActiveTab(tab);
    }
  }, [searchParams]);

  const activeTasks = useMemo(
    () => tasks.filter((task) => !task.completed),
    [tasks]
  );
  const completedTasks = useMemo(
    () => tasks.filter((task) => task.completed).slice(0, 8),
    [tasks]
  );

  const toggleTask = async (task: DashboardTaskItem) => {
    setSavingTaskId(task.id);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: !task.completed }),
      });
      if (!response.ok) {
        throw new Error(`Task update failed with status ${response.status}`);
      }
      const saved = (await response.json()) as DashboardTaskItem;
      setTasks((current) => current.map((item) => (item.id === saved.id ? saved : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update task.");
    } finally {
      setSavingTaskId(null);
    }
  };

  const handleEmail = async (messageId: string) => {
    setHandlingEmailId(messageId);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/emails/${messageId}/handle`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Handle request failed with status ${response.status}`);
      }
      setMailItems((current) => current.filter((email) => email.id !== messageId));
      const [nextMailItems] = await Promise.all([
        fetchMobileMail(mailView, selectedMailbox),
        loadAll(),
      ]);
      setMailItems(nextMailItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark email handled.");
    } finally {
      setHandlingEmailId(null);
    }
  };

  const createTask = async () => {
    const title = newTaskTitle.trim();
    const detail = newTaskDetail.trim();
    if (!title) return;

    setCreatingTask(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          detail,
          source: "custom",
        }),
      });
      if (!response.ok) {
        throw new Error(`Task create failed with status ${response.status}`);
      }
      const created = (await response.json()) as DashboardTaskItem;
      setTasks((current) => [created, ...current]);
      setNewTaskTitle("");
      setNewTaskDetail("");
      setActiveTab("tasks");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task.");
    } finally {
      setCreatingTask(false);
    }
  };

  const applyJournalSearch = async () => {
    await loadJournal(journalSearchInput);
  };

  const clearJournalSearch = async () => {
    setJournalSearchInput("");
    await loadJournal("");
  };

  const navItems: Array<{ key: MobileTab; label: string; icon: React.ReactNode }> = [
    { key: "today", label: "Today", icon: <House className="h-4 w-4" /> },
    { key: "mail", label: "Mail", icon: <Mail className="h-4 w-4" /> },
    { key: "tasks", label: "Tasks", icon: <CheckCircle2 className="h-4 w-4" /> },
    { key: "journal", label: "Journal", icon: <BookOpen className="h-4 w-4" /> },
    { key: "schedule", label: "Schedule", icon: <CalendarDays className="h-4 w-4" /> },
  ];

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#13162c_0%,#0c0e1c_100%)] px-4 pb-28 pt-safe">
      <div className="mx-auto max-w-md space-y-4 pb-6 pt-4 text-slate-100">
        <Card className="overflow-hidden rounded-[2rem] border border-white/8 bg-[linear-gradient(140deg,rgba(23,28,52,0.96),rgba(17,19,34,0.92))] shadow-[0_18px_60px_rgba(4,6,18,0.42)]">
          <CardContent className="space-y-4 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-cyan-100">
                  <Smartphone className="h-3.5 w-3.5" />
                  Jarvis Pocket
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">Phone view</h1>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  Fast thumb-friendly access to today, important mail, tasks, and recent journal entries.
                </p>
              </div>
              <Button asChild variant="outline" className="rounded-2xl">
                <Link href="/">Desktop</Link>
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[1.4rem] border border-white/8 bg-white/5 p-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Important</div>
                <div className="mt-2 text-2xl font-semibold text-white">{dashboard?.important_emails.length || 0}</div>
              </div>
              <div className="rounded-[1.4rem] border border-white/8 bg-white/5 p-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Open tasks</div>
                <div className="mt-2 text-2xl font-semibold text-white">{activeTasks.length}</div>
              </div>
              <div className="rounded-[1.4rem] border border-white/8 bg-white/5 p-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Journal days</div>
                <div className="mt-2 text-2xl font-semibold text-white">{journal.length}</div>
              </div>
              <div className="rounded-[1.4rem] border border-white/8 bg-white/5 p-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Calendar today</div>
                <div className="mt-2 text-2xl font-semibold text-white">{dashboard?.calendar_items.length || 0}</div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-slate-300">
                {dashboard?.date_label || "Today"} on one screen.
              </div>
              <Button
                variant="outline"
                className="rounded-2xl"
                onClick={() => void loadAll()}
                disabled={loading}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardContent>
        </Card>

        {error ? (
          <div className="rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-3 gap-2">
          {navItems.map((item) => (
            <Button
              key={item.key}
              variant={activeTab === item.key ? "default" : "outline"}
              className="h-12 rounded-2xl text-sm"
              onClick={() => setActiveTab(item.key)}
            >
              {item.icon}
              {item.label}
            </Button>
          ))}
        </div>

        {activeTab === "today" ? (
          <div className="space-y-4">
            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Today at a glance</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm leading-6 text-slate-200">
                  {dashboard?.overview || (loading ? "Loading your mobile overview..." : "No overview yet.")}
                </p>
                <div className="space-y-3">
                  {(dashboard?.calendar_items || []).slice(0, 4).map((item) => (
                    <div key={item.event_id} className="rounded-[1.2rem] border border-cyan-300/18 bg-cyan-400/8 px-4 py-3">
                      <div className="text-sm font-medium text-white">{item.title}</div>
                      <div className="mt-1 text-xs text-cyan-100">
                        {formatScheduleDateTime(item.start, item.is_all_day)}
                      </div>
                    </div>
                  ))}
                  {!dashboard?.calendar_items?.length && !loading ? (
                    <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                      No calendar items surfaced for today.
                    </div>
                  ) : null}
                </div>
                <Link
                  href="/mobile/news"
                  className="block rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3 transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                >
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">News pulse</div>
                  <div className="mt-2 text-sm leading-6 text-slate-200">
                    {dashboard?.news_summary || "No news summary yet."}
                  </div>
                  <div className="mt-3 flex items-center gap-2 text-xs text-cyan-100">
                    Open article list
                    <ChevronRight className="h-3.5 w-3.5" />
                  </div>
                </Link>
              </CardContent>
            </Card>

            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Next actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeTasks.slice(0, 5).map((task) => (
                  <button
                    key={task.id}
                    onClick={() => void toggleTask(task)}
                    className="flex w-full items-start gap-3 rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3 text-left"
                  >
                    <div className="mt-0.5">
                      <CheckCircle2 className="h-4 w-4 text-cyan-200" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-white">{task.title}</div>
                      {task.detail ? <div className="mt-1 text-xs text-slate-400">{task.detail}</div> : null}
                    </div>
                  </button>
                ))}
                {!activeTasks.length && !loading ? (
                  <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                    No open tasks right now.
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Important mail preview</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(dashboard?.important_emails || []).slice(0, 3).map((item) => (
                  <div key={item.message_id} className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                    <div className="text-sm font-medium text-white">{item.subject}</div>
                    <div className="mt-1 text-xs text-slate-400">{item.sender}</div>
                    <div className="mt-2 text-sm leading-6 text-slate-300">
                      {item.summary || item.why_it_matters}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        ) : null}

        {activeTab === "mail" ? (
          <div className="space-y-4">
            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardContent className="space-y-3 p-4">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={selectedMailbox === "Jarvis Important" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => setSelectedMailbox("Jarvis Important")}
                  >
                    Important
                  </Button>
                  <Button
                    variant={selectedMailbox === "Jarvis Unimportant" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => setSelectedMailbox("Jarvis Unimportant")}
                  >
                    Unimportant
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={mailView === "ai" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => setMailView("ai")}
                  >
                    AI
                  </Button>
                  <Button
                    variant={mailView === "raw" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => setMailView("raw")}
                  >
                    Raw
                  </Button>
                </div>
              </CardContent>
            </Card>

            {mailItems.map((email) => (
              <Card key={email.id} className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white">{email.subject || "(No subject)"}</div>
                      <div className="mt-1 text-xs text-slate-400">{email.sender}</div>
                    </div>
                    <Badge className="rounded-xl border border-fuchsia-300/25 bg-fuchsia-400/12 text-fuchsia-100">
                      {selectedMailbox === "Jarvis Important" ? "Important" : "Unimportant"}
                    </Badge>
                  </div>
                  {email.classification?.short_summary ? (
                    <div className="rounded-[1rem] border border-cyan-300/20 bg-cyan-400/8 px-3 py-2 text-sm leading-6 text-cyan-50">
                      {email.classification.short_summary}
                    </div>
                  ) : null}
                  <p className="text-sm leading-6 text-slate-300">{email.snippet || "No preview available."}</p>
                  <div className="flex justify-between gap-2">
                    <Button asChild variant="outline" className="rounded-2xl">
                      <Link href={`/mobile/mail/${email.id}`}>Open</Link>
                    </Button>
                    <Button
                      className="rounded-2xl"
                      onClick={() => void handleEmail(email.id)}
                      disabled={handlingEmailId === email.id}
                    >
                      {selectedMailbox === "Jarvis Unimportant"
                        ? handlingEmailId === email.id
                          ? "Handling..."
                          : "Handled"
                        : handlingEmailId === email.id
                          ? "Handling..."
                          : "Mark handled"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {!mailItems.length && !loading ? (
              <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
                <CardContent className="p-4 text-sm text-slate-400">
                  No mail in this folder right now.
                </CardContent>
              </Card>
            ) : null}
          </div>
        ) : null}

        {activeTab === "tasks" ? (
          <div className="space-y-4">
            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Quick add</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <input
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  placeholder="Task title"
                  className="h-12 w-full rounded-[1.1rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 text-sm text-slate-100 outline-none placeholder:text-slate-500"
                />
                <textarea
                  value={newTaskDetail}
                  onChange={(e) => setNewTaskDetail(e.target.value)}
                  placeholder="Optional detail"
                  className="min-h-[92px] w-full rounded-[1.1rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-500"
                />
                <Button
                  className="w-full rounded-2xl"
                  onClick={() => void createTask()}
                  disabled={creatingTask || !newTaskTitle.trim()}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {creatingTask ? "Adding..." : "Add task"}
                </Button>
              </CardContent>
            </Card>

            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Open tasks</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeTasks.map((task) => (
                  <button
                    key={task.id}
                    onClick={() => void toggleTask(task)}
                    disabled={savingTaskId === task.id}
                    className="flex w-full items-start gap-3 rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3 text-left"
                  >
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-cyan-200" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-white">{task.title}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
                        <span className="rounded-full border border-white/10 px-2 py-0.5">{task.priority}</span>
                        {task.due_text ? <span>{formatScheduleDateTime(task.due_text)}</span> : null}
                      </div>
                    </div>
                    <ChevronRight className="mt-0.5 h-4 w-4 text-slate-500" />
                  </button>
                ))}
                {!activeTasks.length && !loading ? (
                  <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                    Nothing open right now.
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Recently done</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {completedTasks.map((task) => (
                  <button
                    key={task.id}
                    onClick={() => void toggleTask(task)}
                    disabled={savingTaskId === task.id}
                    className="flex w-full items-start gap-3 rounded-[1.2rem] border border-white/8 bg-white/3 px-4 py-3 text-left opacity-80"
                  >
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-cyan-200" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-slate-200 line-through decoration-slate-500">
                        {task.title}
                      </div>
                      <div className="mt-1 text-xs text-slate-400">
                        {savingTaskId === task.id ? "Updating..." : "Tap to reopen"}
                      </div>
                    </div>
                    <ChevronRight className="mt-0.5 h-4 w-4 text-slate-500" />
                  </button>
                ))}
                {!completedTasks.length && !loading ? (
                  <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                    No completed tasks yet.
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        ) : null}

        {activeTab === "journal" ? (
          <div className="space-y-4">
            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardContent className="space-y-3 p-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <Input
                    value={journalSearchInput}
                    onChange={(e) => setJournalSearchInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void applyJournalSearch();
                      }
                    }}
                    className="h-12 rounded-[1.1rem] pl-9"
                    placeholder="Search journal days and reflections"
                  />
                </div>
                <div className="flex gap-2">
                  <Button className="flex-1 rounded-2xl" onClick={() => void applyJournalSearch()}>
                    Search
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-2xl"
                    onClick={() => void clearJournalSearch()}
                    disabled={!journalQuery && !journalSearchInput}
                  >
                    Reset
                  </Button>
                </div>
                <div className="text-xs leading-5 text-slate-400">
                  {journalQuery
                    ? `Showing ${journal.length} journal matches for "${journalQuery}".`
                    : "Search dates, journal text, gratitude, and world events."}
                </div>
              </CardContent>
            </Card>

            {journal.map((entry) => (
              <Card key={entry.date} className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
                <CardHeader className="pb-2">
                  <Link href={`/mobile/journal/${entry.date}`} className="flex w-full items-start justify-between gap-3 text-left">
                    <div className="min-w-0">
                      <CardTitle className="text-base">
                        {highlightJournalSearchText(entry.date_label, journalQuery)}
                      </CardTitle>
                      <p className="mt-2 text-sm leading-6 text-slate-300">
                        {highlightJournalSearchText(summarizeJournal(entry), journalQuery)}
                      </p>
                    </div>
                    <ChevronRight className="mt-1 h-4 w-4 text-slate-400" />
                  </Link>
                </CardHeader>
              </Card>
            ))}
            {!journal.length && !loading ? (
              <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
                <CardContent className="p-4 text-sm text-slate-400">
                  No journal days loaded yet.
                </CardContent>
              </Card>
            ) : null}
          </div>
        ) : null}

        {activeTab === "schedule" ? (
          <div className="space-y-4">
            {schedule.map((item) => (
              <Card key={item.event_id} className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-white">{item.title}</div>
                      <div className="mt-1 text-xs text-cyan-100">
                        {formatScheduleDateTime(item.start, item.is_all_day)}
                      </div>
                    </div>
                    <Badge variant="outline" className="rounded-xl">
                      {item.is_all_day ? "All day" : "Scheduled"}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
            {!schedule.length && !loading ? (
              <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
                <CardContent className="p-4 text-sm text-slate-400">
                  No schedule items loaded.
                </CardContent>
              </Card>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/8 bg-[rgba(11,13,25,0.94)] px-4 pb-4 pt-3 backdrop-blur-xl">
        <div className="mx-auto grid max-w-md grid-cols-5 gap-2">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveTab(item.key)}
              className={`flex flex-col items-center justify-center gap-1 rounded-[1.2rem] px-2 py-2.5 text-[11px] font-medium transition ${
                activeTab === item.key
                  ? "bg-fuchsia-400/18 text-fuchsia-100"
                  : "text-slate-400"
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function MobilePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[linear-gradient(180deg,#13162c_0%,#0c0e1c_100%)] px-4 pb-28 pt-safe">
          <div className="mx-auto max-w-md space-y-4 pb-6 pt-4 text-slate-100">
            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardContent className="p-5 text-sm text-slate-300">
                Loading phone view...
              </CardContent>
            </Card>
          </div>
        </div>
      }
    >
      <MobilePageContent />
    </Suspense>
  );
}
