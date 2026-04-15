"use client";

import React, { useEffect, useEffectEvent, useMemo, useState } from "react";
import {
  AlertCircle,
  Archive,
  Inbox,
  Mail,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";
const IMPORTANT_LABEL = "Important";
const LEGACY_IMPORTANT_LABELS = new Set(["AI Important", "Rules Important"]);
const ALL_MAILBOX = "ALL";

type Classification = {
  category?: string;
  importance_score?: number;
  needs_reply?: boolean;
  urgency?: string;
  suggested_action?: string;
  reason?: string;
};

type CleanupDecision = {
  action: "keep" | "archive" | "label";
  label_name?: string | null;
  archive: boolean;
  reason: string;
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
  classification?: Classification;
  cleanupDecision?: CleanupDecision;
};

type GmailLabel = {
  id: string;
  name: string;
  type: "system" | "user";
  messages_total: number;
  messages_unread: number;
};

type CleanupSummary = {
  total_processed: number;
  archived: number;
  labeled_only: number;
  kept: number;
};

type CleanupResponse = {
  dry_run: boolean;
  summary: CleanupSummary;
  items: Array<{
    email: Email;
    classification: Classification;
    decision: CleanupDecision;
  }>;
};

type CleanupJobStartResponse = {
  job_id: string;
  status: "queued" | "running";
};

type CleanupJobStatus = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  dry_run: boolean;
  processed: number;
  total: number;
  current_subject?: string | null;
  result?: CleanupResponse | null;
  error?: string | null;
};

type EmailUpdateResponse = {
  email: Email;
};

const categoryTone: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  action_required: "destructive",
  meeting: "default",
  reference: "secondary",
  newsletter: "outline",
  promotion: "outline",
  receipt: "secondary",
  spam: "destructive",
};

const decisionTone: Record<CleanupDecision["action"], "default" | "secondary" | "outline"> = {
  keep: "secondary",
  archive: "outline",
  label: "default",
};

function safeLower(value: string | undefined) {
  return (value || "").toLowerCase();
}

function decodeHtmlEntities(value: string | undefined) {
  if (!value) return "";
  if (typeof window === "undefined") return value;

  const textarea = window.document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function normalizeCleanupItems(data: CleanupResponse): Email[] {
  return data.items.map((item) => ({
    ...item.email,
    classification: item.classification,
    cleanupDecision: item.decision,
  }));
}

function hasImportantLabel(labels: string[] | undefined) {
  return (labels || []).some(
    (label) => label === IMPORTANT_LABEL || LEGACY_IMPORTANT_LABELS.has(label)
  );
}

function emailHasLabel(email: Email | null, labelName: string) {
  return (email?.labels || []).includes(labelName);
}

function emailMatchesMailbox(email: Email, mailbox: string) {
  if (mailbox === ALL_MAILBOX) return true;
  return (email.labels || []).includes(mailbox);
}

function isEditableLabel(label: GmailLabel) {
  return label.type === "user";
}

function EmailListItem({
  email,
  selected,
  onClick,
}: {
  email: Email;
  selected: boolean;
  onClick: () => void;
}) {
  const classification = email.classification || {};
  const cleanupDecision = email.cleanupDecision;

  return (
    <button
      onClick={onClick}
      className={`w-full rounded-2xl border p-4 text-left transition hover:shadow-sm ${
        selected ? "border-black bg-zinc-50" : "border-zinc-200 bg-white"
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-zinc-900">
            {decodeHtmlEntities(email.subject) || "(No subject)"}
          </div>
          <div className="truncate text-xs text-zinc-500">
            {decodeHtmlEntities(email.sender) || "Unknown sender"}
          </div>
        </div>

        {classification.importance_score ? (
          <Badge variant="secondary" className="shrink-0 rounded-xl">
            {classification.importance_score}/10
          </Badge>
        ) : null}
      </div>

      <p className="mb-3 line-clamp-2 text-sm text-zinc-600">
        {decodeHtmlEntities(email.snippet) || "No preview available."}
      </p>

      <div className="flex flex-wrap gap-2">
        {classification.category ? (
          <Badge
            variant={categoryTone[classification.category] || "secondary"}
            className="rounded-xl"
          >
            {classification.category.replaceAll("_", " ")}
          </Badge>
        ) : null}

        {classification.needs_reply ? (
          <Badge className="rounded-xl">needs reply</Badge>
        ) : null}

        {classification.urgency ? (
          <Badge variant="outline" className="rounded-xl">
            {classification.urgency}
          </Badge>
        ) : null}

        {cleanupDecision ? (
          <Badge variant={decisionTone[cleanupDecision.action]} className="rounded-xl">
            {cleanupDecision.action}
          </Badge>
        ) : null}
      </div>
    </button>
  );
}

export default function HomePage() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [labels, setLabels] = useState<GmailLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [handleLoading, setHandleLoading] = useState(false);
  const [emailActionLoading, setEmailActionLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"classified" | "raw">("raw");
  const [selectedMailbox, setSelectedMailbox] = useState<string>("INBOX");
  const [inboxLimit, setInboxLimit] = useState("");
  const [cleanupSummary, setCleanupSummary] = useState<CleanupSummary | null>(null);
  const [cleanupLimit, setCleanupLimit] = useState("");
  const [cleanupJob, setCleanupJob] = useState<CleanupJobStatus | null>(null);
  const [labelDraft, setLabelDraft] = useState<string[]>([]);
  const [newLabelName, setNewLabelName] = useState("");

  const syncSelectedId = (nextEmails: Email[]) => {
    if (nextEmails.length > 0) {
      setSelectedId((prev) =>
        prev && nextEmails.some((email) => email.id === prev) ? prev : nextEmails[0].id
      );
      return;
    }

    setSelectedId(null);
  };

  const loadLabels = async () => {
    setLabelsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/labels`);
      if (!response.ok) {
        throw new Error(`Labels request failed with status ${response.status}`);
      }

      const data: GmailLabel[] = await response.json();
      setLabels(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load folders.";
      setError(message);
    } finally {
      setLabelsLoading(false);
    }
  };

  const loadEmails = async (
    currentMode: "classified" | "raw" = mode,
    mailboxOverride?: string
  ) => {
    setLoading(true);
    setError("");

    try {
      const trimmed = inboxLimit.trim();
      const limit = trimmed ? Number(trimmed) : NaN;
      const params = new URLSearchParams();
      if (trimmed && Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(Math.floor(limit)));
      }
      if (currentMode === "raw") {
        params.set("mailbox", mailboxOverride ?? selectedMailbox);
      }
      const endpoint = currentMode === "classified" ? "/classify" : "/emails";
      const queryString = params.toString() ? `?${params.toString()}` : "";
      const response = await fetch(`${API_BASE}${endpoint}${queryString}`);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = await response.json();

      const normalized: Email[] =
        currentMode === "classified"
          ? data.map((item: { email: Email; classification: Classification }) => ({
              ...item.email,
              classification: item.classification,
            }))
          : data;

      setEmails(normalized);
      setCleanupSummary(null);
      setCleanupJob(null);
      syncSelectedId(normalized);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load emails.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const fetchEmailsEffect = useEffectEvent(
    (currentMode: "classified" | "raw", mailboxName?: string) => {
      void loadEmails(currentMode, mailboxName);
    }
  );

  const replaceOrRemoveEmail = (updatedEmail: Email) => {
    setEmails((currentEmails) => {
      const nextEmails = currentEmails
        .map((email) => (email.id === updatedEmail.id ? { ...email, ...updatedEmail } : email))
        .filter((email) => (mode === "raw" ? emailMatchesMailbox(email, selectedMailbox) : true));
      syncSelectedId(nextEmails);
      return nextEmails;
    });
  };

  const updateSelectedEmail = async (payload: {
    add_label_names?: string[];
    remove_label_names?: string[];
    archive?: boolean;
    unread?: boolean;
  }) => {
    if (!selectedEmail) return;

    setEmailActionLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/emails/${selectedEmail.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Email update failed with status ${response.status}`);
      }

      const data: EmailUpdateResponse = await response.json();
      replaceOrRemoveEmail(data.email);
      await loadLabels();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update the email.";
      setError(message);
    } finally {
      setEmailActionLoading(false);
    }
  };

  const toggleDraftLabel = (labelName: string) => {
    setLabelDraft((current) =>
      current.includes(labelName)
        ? current.filter((label) => label !== labelName)
        : [...current, labelName]
    );
  };

  const applyLabelDraft = async () => {
    if (!selectedEmail) return;

    const currentEditableLabels = (selectedEmail.labels || []).filter((labelName) =>
      editableLabelNames.includes(labelName)
    );
    const addLabelNames = labelDraft.filter((labelName) => !currentEditableLabels.includes(labelName));
    const removeLabelNames = currentEditableLabels.filter(
      (labelName) => !labelDraft.includes(labelName)
    );
    const cleanedNewLabel = newLabelName.split(/\s+/).filter(Boolean).join(" ").trim();
    if (
      cleanedNewLabel &&
      !labelDraft.includes(cleanedNewLabel) &&
      !addLabelNames.includes(cleanedNewLabel)
    ) {
      addLabelNames.push(cleanedNewLabel);
    }

    if (addLabelNames.length === 0 && removeLabelNames.length === 0) {
      setNewLabelName("");
      return;
    }

    await updateSelectedEmail({
      add_label_names: addLabelNames,
      remove_label_names: removeLabelNames,
    });
    setNewLabelName("");
  };

  const runCleanup = async () => {
    setCleanupLoading(true);
    setError("");
    setCleanupSummary(null);

    try {
      const trimmed = cleanupLimit.trim();
      const limit = trimmed ? Number(trimmed) : NaN;
      const queryString =
        trimmed && Number.isFinite(limit) && limit > 0 ? `?limit=${Math.floor(limit)}` : "";
      const endpoint = "/cleanup/apply";

      const response = await fetch(`${API_BASE}${endpoint}${queryString}`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Cleanup request failed with status ${response.status}`);
      }

      const data: CleanupJobStartResponse = await response.json();
      setCleanupJob({
        job_id: data.job_id,
        status: data.status,
        dry_run: false,
        processed: 0,
        total: 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start inbox cleanup.";
      setError(message);
      setCleanupLoading(false);
    }
  };

  const markHandled = async () => {
    if (!selectedEmail || !canMarkHandled) return;

    setHandleLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/emails/${selectedEmail.id}/handle`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Handle request failed with status ${response.status}`);
      }

      setEmails((currentEmails) => {
        const nextEmails = currentEmails.filter((email) => email.id !== selectedEmail.id);
        syncSelectedId(nextEmails);
        return nextEmails;
      });
      await loadLabels();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to mark email handled.";
      setError(message);
    } finally {
      setHandleLoading(false);
    }
  };

  useEffect(() => {
    void loadLabels();
  }, []);

  useEffect(() => {
    fetchEmailsEffect(mode, selectedMailbox);
  }, [mode, selectedMailbox]);

  useEffect(() => {
    if (!cleanupJob || (cleanupJob.status !== "queued" && cleanupJob.status !== "running")) {
      return;
    }

    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/cleanup/jobs/${cleanupJob.job_id}`);
        if (!response.ok) {
          throw new Error(`Cleanup status failed with status ${response.status}`);
        }

        const data: CleanupJobStatus = await response.json();
        setCleanupJob(data);

        if (data.status === "completed" && data.result) {
          const normalized = normalizeCleanupItems(data.result);
          setMode("classified");
          setEmails(normalized);
          setCleanupSummary(data.result.summary);
          syncSelectedId(normalized);
          setCleanupLoading(false);
          await loadLabels();
        }

        if (data.status === "failed") {
          setError(data.error || "Cleanup failed.");
          setCleanupLoading(false);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch cleanup status.";
        setError(message);
        setCleanupLoading(false);
      }
    }, 1200);

    return () => window.clearInterval(poll);
  }, [cleanupJob]);

  const filteredEmails = useMemo(() => {
    const q = safeLower(query.trim());
    if (!q) return emails;

    return emails.filter((email) => {
      const haystack = [
        email.subject,
        email.sender,
        email.snippet,
        email.body,
        ...(email.labels || []),
        email.classification?.category,
        email.classification?.reason,
        email.cleanupDecision?.action,
        email.cleanupDecision?.label_name,
        email.cleanupDecision?.reason,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(q);
    });
  }, [emails, query]);

  const selectedEmail =
    filteredEmails.find((email) => email.id === selectedId) ||
    filteredEmails[0] ||
    null;
  const canMarkHandled = mode === "classified" && hasImportantLabel(selectedEmail?.labels);
  const isUnread = emailHasLabel(selectedEmail, "UNREAD");
  const isInInbox = emailHasLabel(selectedEmail, "INBOX");

  const mailboxLabels = useMemo(
    () => [
      {
        id: ALL_MAILBOX,
        name: ALL_MAILBOX,
        type: "system" as const,
        messages_total: 0,
        messages_unread: 0,
      },
      ...labels.filter((label) => label.name !== "CHAT"),
    ],
    [labels]
  );
  const editableLabels = useMemo(
    () => labels.filter((label) => isEditableLabel(label)).sort((a, b) => a.name.localeCompare(b.name)),
    [labels]
  );
  const editableLabelNames = useMemo(() => editableLabels.map((label) => label.name), [editableLabels]);

  useEffect(() => {
    if (!selectedEmail) {
      setLabelDraft([]);
      return;
    }

    setLabelDraft(
      (selectedEmail.labels || []).filter((labelName) => editableLabelNames.includes(labelName))
    );
  }, [selectedEmail?.id, editableLabelNames.join("|")]);

  const selectedMailboxLabel =
    mailboxLabels.find((label) => label.name === selectedMailbox) ||
    mailboxLabels.find((label) => label.name === ALL_MAILBOX) ||
    null;

  const cleanupProgressPercent =
    cleanupJob && cleanupJob.total > 0
      ? Math.min(100, Math.round((cleanupJob.processed / cleanupJob.total) * 100))
      : 0;

  return (
    <div className="min-h-screen bg-zinc-100 p-6 text-zinc-900">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Jarvis Mail Dashboard</h1>
            <p className="text-sm text-zinc-600">
              Browse Gmail folders in the raw view, relabel mail, and still use the classified
              review workflow for Important mail.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={mode === "classified" ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setMode("classified")}
            >
              <Inbox className="mr-2 h-4 w-4" />
              AI view
            </Button>

            <Button
              variant={mode === "raw" ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setMode("raw")}
            >
              <Archive className="mr-2 h-4 w-4" />
              Raw mail
            </Button>

            <Button
              className="rounded-2xl"
              variant="outline"
              onClick={() => {
                void loadLabels();
                void loadEmails(mode, selectedMailbox);
              }}
              disabled={loading || cleanupLoading || emailActionLoading}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${loading || labelsLoading ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>

            <Input
              type="number"
              min="1"
              value={inboxLimit}
              onChange={(e) => setInboxLimit(e.target.value)}
              className="w-full rounded-2xl sm:w-36"
              placeholder={mode === "raw" ? "Mailbox cap" : "Summary cap"}
            />
          </div>
        </div>

        <Card className="rounded-3xl border-none shadow-sm">
          <CardHeader className="gap-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="h-5 w-5" />
              Inbox cleanup
            </CardTitle>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <p className="max-w-2xl text-sm text-zinc-600">
                Clean up the whole inbox with one click. Every processed
                message is labeled as Important or Unimportant and then archived
                so the inbox can reach zero. This version never deletes messages.
              </p>
              <div className="flex w-full flex-col gap-2 sm:flex-row md:w-auto">
                <Input
                  type="number"
                  min="1"
                  value={cleanupLimit}
                  onChange={(e) => setCleanupLimit(e.target.value)}
                  className="w-full rounded-2xl sm:w-32"
                  placeholder="All mail"
                />
                <Button
                  className="rounded-2xl"
                  onClick={() => void runCleanup()}
                  disabled={loading || cleanupLoading}
                >
                  <Archive className="mr-2 h-4 w-4" />
                  {cleanupLoading ? "Working..." : "Clean inbox"}
                </Button>
              </div>
            </div>
          </CardHeader>

          {cleanupJob ? (
            <CardContent className="space-y-4">
              <div className="rounded-2xl bg-zinc-50 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      cleanupJob.status === "completed"
                        ? "default"
                        : cleanupJob.status === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                    className="rounded-xl"
                  >
                    {cleanupJob.status}
                  </Badge>
                  <Badge variant="outline" className="rounded-xl">
                    Cleanup job
                  </Badge>
                  <Badge variant="outline" className="rounded-xl">
                    {cleanupJob.processed}/{cleanupJob.total || "?"} processed
                  </Badge>
                </div>

                <div className="h-2 overflow-hidden rounded-full bg-zinc-200">
                  <div
                    className="h-full rounded-full bg-zinc-900 transition-all"
                    style={{ width: `${cleanupProgressPercent}%` }}
                  />
                </div>

                <div className="mt-3 flex flex-col gap-1 text-sm text-zinc-600">
                  <div>
                    {cleanupJob.status === "completed"
                      ? "Cleanup finished."
                      : cleanupJob.status === "failed"
                        ? cleanupJob.error || "Cleanup failed."
                        : "Cleanup is running."}
                  </div>
                  {cleanupJob.current_subject ? (
                    <div className="truncate">Current email: {cleanupJob.current_subject}</div>
                  ) : null}
                </div>
              </div>

              {cleanupSummary ? (
                <>
                  <div className="grid gap-3 md:grid-cols-4">
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-zinc-500">
                          Processed
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.total_processed}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-zinc-500">
                          Archived
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.archived}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-zinc-500">
                          Labeled only
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.labeled_only}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-zinc-500">Kept</div>
                        <div className="mt-1 text-2xl font-semibold">{cleanupSummary.kept}</div>
                      </CardContent>
                    </Card>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="default" className="rounded-xl">
                      Changes applied
                    </Badge>
                    <Badge variant="outline" className="rounded-xl">
                      Safe mode: archive and label only
                    </Badge>
                    <Badge variant="outline" className="rounded-xl">
                      Cleanup uses only Important and Unimportant
                    </Badge>
                  </div>
                </>
              ) : null}
            </CardContent>
          ) : null}
        </Card>

        <div className="grid gap-6 lg:grid-cols-[260px_360px_1fr]">
          <Card className="rounded-3xl border-none shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Mail className="h-5 w-5" />
                Mailboxes
              </CardTitle>
              <p className="text-sm text-zinc-600">
                {mode === "raw"
                  ? "Switch folders and labels like Gmail."
                  : "The AI view only shows Important mail for review."}
              </p>
            </CardHeader>

            <CardContent>
              <ScrollArea className="h-[65vh] pr-3">
                <div className="space-y-2">
                  {mailboxLabels.map((label) => {
                    const active = selectedMailbox === label.name;
                    const disabled = mode !== "raw";
                    const count =
                      label.name === ALL_MAILBOX
                        ? undefined
                        : label.messages_unread > 0
                          ? label.messages_unread
                          : label.messages_total;

                    return (
                      <button
                        key={label.id}
                        onClick={() => setSelectedMailbox(label.name)}
                        disabled={disabled}
                        className={`flex w-full items-center justify-between rounded-2xl border px-3 py-2 text-left transition ${
                          active
                            ? "border-black bg-zinc-900 text-white"
                            : "border-zinc-200 bg-white text-zinc-700"
                        } ${disabled ? "cursor-not-allowed opacity-50" : "hover:shadow-sm"}`}
                      >
                        <span className="truncate text-sm font-medium">
                          {label.name === ALL_MAILBOX ? "All Mail" : label.name}
                        </span>
                        {count !== undefined ? (
                          <span
                            className={`ml-3 shrink-0 text-xs ${
                              active ? "text-zinc-200" : "text-zinc-500"
                            }`}
                          >
                            {count}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-none shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Mail className="h-5 w-5" />
                {mode === "raw"
                  ? selectedMailboxLabel?.name === ALL_MAILBOX
                    ? "All Mail"
                    : selectedMailboxLabel?.name || "Inbox"
                  : "Important review"}
              </CardTitle>

              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search subject, sender, category..."
                  className="rounded-2xl pl-9"
                />
              </div>
            </CardHeader>

            <CardContent>
              {error ? (
                <div className="mb-4 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4" />
                  <div>{error}</div>
                </div>
              ) : null}

              <ScrollArea className="h-[65vh] pr-3">
                <div className="space-y-3">
                  {filteredEmails.length === 0 && !loading && !cleanupLoading ? (
                    <div className="rounded-2xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-500">
                      No emails found.
                    </div>
                  ) : null}

                  {filteredEmails.map((email) => (
                    <EmailListItem
                      key={email.id}
                      email={email}
                      selected={selectedEmail?.id === email.id}
                      onClick={() => setSelectedId(email.id)}
                    />
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Email detail</CardTitle>
            </CardHeader>

            <CardContent>
              {!selectedEmail ? (
                <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-sm text-zinc-500">
                  Select an email to view details.
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold leading-tight">
                      {decodeHtmlEntities(selectedEmail.subject) || "(No subject)"}
                    </h2>
                    <div className="text-sm text-zinc-600">
                      From: {decodeHtmlEntities(selectedEmail.sender) || "Unknown sender"}
                    </div>
                    {selectedEmail.date ? (
                      <div className="text-sm text-zinc-500">{selectedEmail.date}</div>
                    ) : null}
                  </div>

                  {mode === "raw" ? (
                    <div className="rounded-2xl bg-zinc-50 p-4">
                      <div className="mb-3 text-xs uppercase tracking-wide text-zinc-500">
                        Mail actions
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          variant="outline"
                          onClick={() => void updateSelectedEmail({ archive: isInInbox })}
                          disabled={emailActionLoading}
                        >
                          <Archive className="mr-2 h-4 w-4" />
                          {isInInbox ? "Archive" : "Move to inbox"}
                        </Button>
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          variant="outline"
                          onClick={() => void updateSelectedEmail({ unread: !isUnread })}
                          disabled={emailActionLoading}
                        >
                          {isUnread ? "Mark read" : "Mark unread"}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {canMarkHandled ? (
                    <div className="pt-2">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          onClick={() => void markHandled()}
                          disabled={handleLoading}
                        >
                          {handleLoading ? "Marking..." : "Mark handled"}
                        </Button>
                        <span className="text-xs text-zinc-500">
                          Removes <span className="font-medium text-zinc-700">Important</span>{" "}
                          and adds <span className="font-medium text-zinc-700">Reviewed</span>.
                        </span>
                      </div>
                    </div>
                  ) : null}

                  {mode === "raw" ? (
                    <div className="rounded-2xl bg-zinc-50 p-4">
                      <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
                        <Tag className="h-4 w-4" />
                        Labels
                      </div>
                      <div className="mb-4 flex flex-wrap gap-2">
                        {editableLabels.map((label) => {
                          const checked = labelDraft.includes(label.name);
                          return (
                            <label
                              key={label.id}
                              className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                                checked
                                  ? "border-zinc-900 bg-zinc-900 text-white"
                                  : "border-zinc-300 bg-white text-zinc-700"
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="h-4 w-4"
                                checked={checked}
                                onChange={() => toggleDraftLabel(label.name)}
                              />
                              <span>{label.name}</span>
                            </label>
                          );
                        })}
                      </div>

                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          value={newLabelName}
                          onChange={(e) => setNewLabelName(e.target.value)}
                          placeholder="Create and add a new label"
                          className="rounded-2xl"
                        />
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          onClick={() => void applyLabelDraft()}
                          disabled={emailActionLoading}
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          Apply labels
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {selectedEmail.cleanupDecision ? (
                    <div className="rounded-2xl bg-zinc-50 p-4">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <Badge
                          variant={decisionTone[selectedEmail.cleanupDecision.action]}
                          className="rounded-xl"
                        >
                          {selectedEmail.cleanupDecision.action}
                        </Badge>
                        {selectedEmail.cleanupDecision.archive ? (
                          <Badge variant="outline" className="rounded-xl">
                            removes inbox label
                          </Badge>
                        ) : null}
                        {selectedEmail.cleanupDecision.label_name ? (
                          <Badge variant="secondary" className="rounded-xl">
                            {selectedEmail.cleanupDecision.label_name}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-sm text-zinc-700">
                        {selectedEmail.cleanupDecision.reason}
                      </p>
                    </div>
                  ) : null}

                  {selectedEmail.classification ? (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <Card className="rounded-2xl shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-zinc-500">
                            Category
                          </div>
                          <div className="mt-1 text-base font-medium">
                            {selectedEmail.classification.category || "Unknown"}
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="rounded-2xl shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-zinc-500">
                            Importance
                          </div>
                          <div className="mt-1 text-base font-medium">
                            {selectedEmail.classification.importance_score || "—"}/10
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="rounded-2xl shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-zinc-500">
                            Suggested action
                          </div>
                          <div className="mt-1 text-base font-medium">
                            {selectedEmail.classification.suggested_action || "—"}
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  ) : null}

                  {selectedEmail.classification?.reason ? (
                    <div className="rounded-2xl bg-zinc-50 p-4">
                      <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                        Why it was classified this way
                      </div>
                      <p className="text-sm text-zinc-700">
                        {selectedEmail.classification.reason}
                      </p>
                    </div>
                  ) : null}

                  {selectedEmail.labels?.length ? (
                    <div>
                      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                        Current Gmail labels
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {selectedEmail.labels.map((label) => (
                          <Badge key={label} variant="outline" className="rounded-xl">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                      Snippet
                    </div>
                    <p className="rounded-2xl bg-zinc-50 p-4 text-sm leading-6 text-zinc-700">
                      {decodeHtmlEntities(selectedEmail.snippet) || "No snippet available."}
                    </p>
                  </div>

                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                      Body preview
                    </div>
                    <div className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-2xl bg-zinc-50 p-4 text-sm leading-6 text-zinc-700">
                      {decodeHtmlEntities(selectedEmail.body) || "No body text extracted."}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
                    <div className="mb-2 flex items-center gap-2 font-medium text-zinc-700">
                      <Trash2 className="h-4 w-4" />
                      Safety boundary
                    </div>
                    This dashboard now supports folder browsing, archive state, unread state, and
                    relabeling. It still does not delete or trash messages.
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
