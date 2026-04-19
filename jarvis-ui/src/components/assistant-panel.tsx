"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Inbox, MessageSquare, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type AssistantSource = {
  id: string;
  label: string;
  kind: string;
  detail?: string | null;
  url?: string | null;
};

type AssistantMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  bullets?: string[];
  followUps?: string[];
  sources?: AssistantSource[];
  createdAt?: string | null;
};

type AssistantResponse = {
  chat_id: string;
  answer: string;
  bullets: string[];
  follow_ups: string[];
  sources: AssistantSource[];
  context_summary: string;
  model?: string | null;
};

type AssistantChatSummary = {
  id: string;
  title: string;
  preview: string;
  message_count: number;
  archived?: boolean;
  updated_at?: string | null;
};

type AssistantChatThread = {
  id: string;
  title: string;
  archived?: boolean;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    bullets: string[];
    follow_ups: string[];
    sources: AssistantSource[];
    created_at?: string | null;
  }>;
  updated_at?: string | null;
};

type AssistantPanelProps = {
  apiBase: string;
  compact?: boolean;
  starterPrompts?: string[];
};

const LOCAL_THREADS_KEY = "jarvis_assistant_threads_v1";
const LOCAL_ACTIVE_CHAT_KEY = "jarvis_assistant_active_chat_v1";
const LOCAL_ARCHIVED_CHAT_IDS_KEY = "jarvis_assistant_archived_chat_ids_v1";
const LOCAL_DELETED_CHAT_IDS_KEY = "jarvis_assistant_deleted_chat_ids_v1";

async function getErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json();
    if (data && typeof data.detail === "string" && data.detail.trim()) {
      return data.detail;
    }
  } catch {
    // Fall back below.
  }

  return fallback;
}

function formatUpdatedAt(value: string | null | undefined) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function TypingBubble() {
  return (
    <div className="rounded-[1.3rem] border border-white/8 bg-[rgba(255,255,255,0.04)] px-4 py-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.2em] text-slate-400">Jarvis</div>
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="h-2.5 w-2.5 rounded-full bg-cyan-200/80 animate-bounce"
            style={{ animationDelay: `${index * 0.14}s`, animationDuration: "0.9s" }}
          />
        ))}
      </div>
    </div>
  );
}

function safeLocalStorageGet(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors and keep the app functional.
  }
}

function loadLocalIdSet(key: string) {
  const raw = safeLocalStorageGet(key);
  if (!raw) return new Set<string>();
  try {
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function saveLocalIdSet(key: string, values: Set<string>) {
  safeLocalStorageSet(key, JSON.stringify(Array.from(values)));
}

function buildChatSummaryFromThread(thread: AssistantChatThread): AssistantChatSummary {
  const firstUserMessage = thread.messages.find((message) => message.role === "user");
  const lastMessage = thread.messages[thread.messages.length - 1];
  return {
    id: thread.id,
    title: thread.title || firstUserMessage?.content.slice(0, 80) || "New chat",
    preview: lastMessage?.content || "",
    message_count: thread.messages.length,
    archived: Boolean(thread.archived),
    updated_at: thread.updated_at || lastMessage?.created_at || null,
  };
}

function loadLocalThreads(): Record<string, AssistantChatThread> {
  const raw = safeLocalStorageGet(LOCAL_THREADS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, AssistantChatThread>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocalThread(thread: AssistantChatThread) {
  const threads = loadLocalThreads();
  threads[thread.id] = thread;
  safeLocalStorageSet(LOCAL_THREADS_KEY, JSON.stringify(threads));
}

function updateLocalThread(chatId: string, updater: (thread: AssistantChatThread) => AssistantChatThread) {
  const threads = loadLocalThreads();
  const existing = threads[chatId];
  if (!existing) return;
  threads[chatId] = updater(existing);
  safeLocalStorageSet(LOCAL_THREADS_KEY, JSON.stringify(threads));
}

function removeLocalThread(chatId: string) {
  const threads = loadLocalThreads();
  delete threads[chatId];
  safeLocalStorageSet(LOCAL_THREADS_KEY, JSON.stringify(threads));
}

function localThreadSummaries(archived: boolean): AssistantChatSummary[] {
  const archivedIds = loadLocalIdSet(LOCAL_ARCHIVED_CHAT_IDS_KEY);
  const deletedIds = loadLocalIdSet(LOCAL_DELETED_CHAT_IDS_KEY);
  return Object.values(loadLocalThreads())
    .filter((thread) => !deletedIds.has(thread.id))
    .filter((thread) => archivedIds.has(thread.id) === archived)
    .map(buildChatSummaryFromThread)
    .sort((left, right) => (right.updated_at || "").localeCompare(left.updated_at || ""));
}

export function AssistantPanel({
  apiBase,
  compact = false,
  starterPrompts = [
    "What should I focus on today?",
    "What in my data looks neglected or overdue?",
    "Summarize my recent health and movement trends.",
  ],
}: AssistantPanelProps) {
  const [chats, setChats] = useState<AssistantChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatTab, setChatTab] = useState<"active" | "archived">("active");
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [expandedBulletIds, setExpandedBulletIds] = useState<Record<string, boolean>>({});
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");
  const [contextSummary, setContextSummary] = useState("");

  const displayedMessages = useMemo(
    () => messages.filter((message) => message.content.trim()),
    [messages]
  );

  const loadChats = useCallback(async (tab: "active" | "archived" = chatTab) => {
    try {
      const response = await fetch(
        `${apiBase}/assistant/chats${tab === "archived" ? "/archived" : ""}`
      );
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Assistant chats request failed with status ${response.status}`)
        );
      }
      const data = (await response.json()) as { chats: AssistantChatSummary[] };
      const archivedIds = loadLocalIdSet(LOCAL_ARCHIVED_CHAT_IDS_KEY);
      const deletedIds = loadLocalIdSet(LOCAL_DELETED_CHAT_IDS_KEY);
      const serverChats = (data.chats || []).filter((chat) => {
        if (deletedIds.has(chat.id)) return false;
        const locallyArchived = archivedIds.has(chat.id);
        return locallyArchived === (tab === "archived");
      });
      const merged = [...serverChats];
      const seen = new Set(serverChats.map((chat) => chat.id));
      for (const localChat of localThreadSummaries(tab === "archived")) {
        if (!seen.has(localChat.id)) {
          merged.push(localChat);
        }
      }
      merged.sort((left, right) => (right.updated_at || "").localeCompare(left.updated_at || ""));
      setChats(merged);
    } catch (err) {
      setChats(localThreadSummaries(tab === "archived"));
      setError(err instanceof Error ? err.message : "Failed to load assistant chats.");
    }
  }, [apiBase, chatTab]);

  const loadChatThread = useCallback(async (chatId: string) => {
    setHistoryLoading(true);
    setError("");
    try {
      const response = await fetch(`${apiBase}/assistant/chats/${chatId}`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Assistant chat request failed with status ${response.status}`)
        );
      }
      const data = (await response.json()) as AssistantChatThread;
      setActiveChatId(data.id);
      safeLocalStorageSet(LOCAL_ACTIVE_CHAT_KEY, data.id);
      setMessages(
        (data.messages || []).map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          bullets: message.bullets,
          followUps: message.follow_ups,
          sources: message.sources,
          createdAt: message.created_at,
        }))
      );
      saveLocalThread(data);
    } catch (err) {
      const localThread = loadLocalThreads()[chatId];
      if (localThread) {
        setActiveChatId(localThread.id);
        safeLocalStorageSet(LOCAL_ACTIVE_CHAT_KEY, localThread.id);
        setMessages(
          localThread.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            bullets: message.bullets,
            followUps: message.follow_ups,
            sources: message.sources,
            createdAt: message.created_at,
          }))
        );
      } else {
        setError(err instanceof Error ? err.message : "Failed to load assistant chat.");
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void loadChats(chatTab);
  }, [chatTab, loadChats]);

  useEffect(() => {
    const savedActiveChatId = safeLocalStorageGet(LOCAL_ACTIVE_CHAT_KEY);
    if (!savedActiveChatId) return;
    const localThread = loadLocalThreads()[savedActiveChatId];
    if (!localThread) return;

    setActiveChatId(localThread.id);
    setMessages(
      localThread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        bullets: message.bullets,
        followUps: message.follow_ups,
        sources: message.sources,
        createdAt: message.created_at,
      }))
    );
  }, []);

  const askQuestion = async (promptOverride?: string) => {
    const nextQuestion = (promptOverride ?? question).trim();
    if (!nextQuestion || loading) return;

    const nextUserMessage: AssistantMessage = {
      role: "user",
      content: nextQuestion,
    };

    const pendingMessages = [...messages, nextUserMessage];
    const historyPayload = pendingMessages
      .slice(-10)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    setMessages(pendingMessages);
    setQuestion("");
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${apiBase}/assistant/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: nextQuestion,
          chat_id: activeChatId,
          history: historyPayload,
        }),
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Ask Jarvis failed with status ${response.status}`)
        );
      }

      const data = (await response.json()) as AssistantResponse;
      setContextSummary(data.context_summary || "");
      setActiveChatId(data.chat_id);
      safeLocalStorageSet(LOCAL_ACTIVE_CHAT_KEY, data.chat_id);
      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: data.answer,
        bullets: data.bullets,
        followUps: data.follow_ups,
        sources: data.sources,
      };
      const nextMessages: AssistantMessage[] = [
        ...pendingMessages,
        assistantMessage,
      ];
      setMessages(nextMessages);
      const localThread: AssistantChatThread = {
        id: data.chat_id,
        title: nextMessages.find((message) => message.role === "user")?.content.slice(0, 80) || "New chat",
        archived: false,
        updated_at: new Date().toISOString(),
        messages: nextMessages.map((message, index) => ({
          id: message.id || `${data.chat_id}-${index}`,
          role: message.role,
          content: message.content,
          bullets: message.bullets || [],
          follow_ups: message.followUps || [],
          sources: message.sources || [],
          created_at: message.createdAt || new Date().toISOString(),
        })),
      };
      saveLocalThread(localThread);
      await loadChats(chatTab);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ask Jarvis failed.");
    } finally {
      setLoading(false);
    }
  };

  const startNewChat = () => {
    setActiveChatId(null);
    safeLocalStorageSet(LOCAL_ACTIVE_CHAT_KEY, "");
    setMessages([]);
    setExpandedBulletIds({});
    setQuestion("");
    setError("");
    setContextSummary("");
  };

  const archiveChatById = useCallback(async (chatId: string, archived: boolean) => {
    setError("");
    const archivedIds = loadLocalIdSet(LOCAL_ARCHIVED_CHAT_IDS_KEY);
    if (archived) {
      archivedIds.add(chatId);
    } else {
      archivedIds.delete(chatId);
    }
    saveLocalIdSet(LOCAL_ARCHIVED_CHAT_IDS_KEY, archivedIds);
    updateLocalThread(chatId, (thread) => ({ ...thread, archived }));

    try {
      const response = await fetch(`${apiBase}/assistant/chats/${chatId}/archive?archived=${archived ? "true" : "false"}`, {
        method: "PATCH",
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Assistant archive request failed with status ${response.status}`)
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} Kept the archive change locally.`
          : "Unable to update archive state on the server. Kept the change locally."
      );
    }

    if (activeChatId === chatId) {
      startNewChat();
    }
    await loadChats(chatTab);
  }, [activeChatId, apiBase, chatTab, loadChats]);

  const deleteChatById = useCallback(async (chatId: string) => {
    setError("");
    try {
      const response = await fetch(`${apiBase}/assistant/chats/${chatId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Assistant delete request failed with status ${response.status}`)
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} Removed the chat locally.`
          : "Unable to delete chat on the server. Removed it locally."
      );
    }

    const deletedIds = loadLocalIdSet(LOCAL_DELETED_CHAT_IDS_KEY);
    deletedIds.add(chatId);
    saveLocalIdSet(LOCAL_DELETED_CHAT_IDS_KEY, deletedIds);
    removeLocalThread(chatId);

    if (activeChatId === chatId) {
      startNewChat();
    }
    await loadChats(chatTab);
  }, [activeChatId, apiBase, chatTab, loadChats]);

  return (
    <div className={compact ? "space-y-4" : "grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]"}>
      <div className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Chats</div>
          <Button type="button" variant="outline" className="rounded-2xl" onClick={startNewChat}>
            <Sparkles className="mr-2 h-4 w-4" />
            New
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setChatTab("active")}
            className={`rounded-full border px-3 py-2 text-xs transition ${
              chatTab === "active"
                ? "border-cyan-300/30 bg-cyan-400/10 text-cyan-100"
                : "border-white/8 bg-white/5 text-slate-300 hover:border-white/14"
            }`}
          >
            Active
          </button>
          <button
            type="button"
            onClick={() => setChatTab("archived")}
            className={`rounded-full border px-3 py-2 text-xs transition ${
              chatTab === "archived"
                ? "border-cyan-300/30 bg-cyan-400/10 text-cyan-100"
                : "border-white/8 bg-white/5 text-slate-300 hover:border-white/14"
            }`}
          >
            Archived
          </button>
        </div>
        <div className={`${compact ? "grid gap-2" : "max-h-[700px] space-y-2 overflow-y-auto pr-1"}`}>
          {chats.length ? (
            chats.map((chat) => (
              <div
                key={chat.id}
                className={`min-w-0 overflow-hidden flex items-center gap-2 rounded-[1rem] border px-2 py-2 transition ${
                  activeChatId === chat.id
                    ? "border-cyan-300/28 bg-cyan-400/10"
                    : "border-white/8 bg-[rgba(255,255,255,0.04)] hover:border-white/14 hover:bg-[rgba(255,255,255,0.06)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => void loadChatThread(chat.id)}
                  className="min-w-0 flex-1 overflow-hidden text-left"
                >
                  <div className="block truncate text-sm font-medium text-slate-100">{chat.title || "New chat"}</div>
                </button>
                <button
                  type="button"
                  onClick={() => void archiveChatById(chat.id, chatTab !== "archived")}
                  className="rounded-lg border border-white/8 p-2 text-slate-400 transition hover:border-white/14 hover:text-slate-200"
                  aria-label={chatTab === "archived" ? "Unarchive chat" : "Archive chat"}
                  title={chatTab === "archived" ? "Unarchive" : "Archive"}
                >
                  {chatTab === "archived" ? <Inbox className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteChatById(chat.id)}
                  className="rounded-lg border border-white/8 p-2 text-slate-400 transition hover:border-rose-400/30 hover:text-rose-200"
                  aria-label="Delete chat"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          ) : (
            <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-slate-400">
              {chatTab === "archived"
                ? "No archived chats yet."
                : "No saved chats yet. Start a conversation and Jarvis will keep it here."}
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-[560px] flex-col rounded-[1.6rem] border border-white/8 bg-[rgba(17,19,34,0.58)]">
        <div className="border-b border-white/8 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
                <MessageSquare className="h-4 w-4" />
                {activeChatId ? "Conversation" : "New conversation"}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Ask about mail, tasks, journal, movement, health, and what deserves attention next.
              </div>
            </div>
            <Button type="button" variant="outline" className="rounded-2xl" onClick={() => void loadChats(chatTab)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
          {contextSummary ? (
            <div className="mt-3 rounded-[1rem] border border-white/8 bg-white/5 px-3 py-2 text-xs leading-5 text-slate-400">
              Context used: {contextSummary}
            </div>
          ) : null}
        </div>

        <div className={`flex-1 space-y-3 overflow-y-auto px-4 py-4 ${compact ? "max-h-[620px]" : ""}`}>
          {historyLoading ? (
            <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-5 text-sm text-slate-400">
              Loading conversation...
            </div>
          ) : displayedMessages.length ? (
            displayedMessages.map((message, index) => (
              <div
                key={message.id || `${message.role}-${index}`}
                className={`rounded-[1.3rem] border px-4 py-3 ${
                  message.role === "user"
                    ? "ml-auto max-w-[85%] border-cyan-300/18 bg-cyan-400/8"
                    : "mr-auto max-w-[90%] border-white/8 bg-[rgba(255,255,255,0.04)]"
                }`}
              >
                <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-400">
                  {message.role === "user" ? "You" : "Jarvis"}
                  {message.createdAt ? <span className="text-slate-500">{formatUpdatedAt(message.createdAt)}</span> : null}
                </div>
                <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6 text-slate-100">
                  {message.content}
                </div>
                {message.bullets?.length ? (
                  (() => {
                    const bulletKey = message.id || `${message.role}-${index}`;
                    const expanded = Boolean(expandedBulletIds[bulletKey]);
                    return (
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedBulletIds((current) => ({
                              ...current,
                              [bulletKey]: !expanded,
                            }))
                          }
                          className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/16 hover:bg-white/8"
                        >
                          {expanded ? "Hide details" : `Show details (${message.bullets.length})`}
                        </button>
                        {expanded ? (
                          <div className="mt-3 space-y-2">
                            {message.bullets.map((bullet) => (
                              <div key={bullet} className="rounded-[1rem] border border-white/8 bg-white/5 px-3 py-2 text-xs leading-5 text-slate-300">
                                {bullet}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })()
                ) : null}
                {message.sources?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {message.sources.map((source) => (
                      source.url ? (
                        <a
                          key={`${source.id}-${source.label}`}
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex"
                        >
                          <Badge
                            variant="outline"
                            className="rounded-xl border-cyan-300/20 bg-cyan-400/8 text-cyan-100 hover:border-cyan-300/35 hover:bg-cyan-400/14"
                          >
                            {source.label}
                          </Badge>
                        </a>
                      ) : (
                        <Badge key={`${source.id}-${source.label}`} variant="outline" className="rounded-xl">
                          {source.label}
                        </Badge>
                      )
                    ))}
                  </div>
                ) : null}
                {message.followUps?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {message.followUps.map((followUp) => (
                      <button
                        key={followUp}
                        type="button"
                        className="rounded-full border border-fuchsia-300/20 bg-fuchsia-400/8 px-3 py-1.5 text-xs text-fuchsia-100 transition hover:border-fuchsia-300/35 hover:bg-fuchsia-400/14"
                        onClick={() => void askQuestion(followUp)}
                      >
                        {followUp}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <div className="rounded-[1.3rem] border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-slate-300">
              Ask a question to start a chat. Every conversation is saved so you can come back to it later.
            </div>
          )}
          {loading ? <TypingBubble /> : null}
        </div>

        {error ? (
          <div className="mx-4 mb-3 rounded-[1rem] border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <div className="border-t border-white/8 p-4">
          <div className="space-y-3">
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void askQuestion();
                }
              }}
              placeholder="Message Jarvis"
              className={`w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-fuchsia-400/50 ${
                compact ? "min-h-[110px]" : "min-h-[128px]"
              }`}
            />
            <div className="flex flex-wrap gap-2">
              {starterPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-cyan-300/30 hover:bg-cyan-400/8 hover:text-cyan-100"
                  onClick={() => void askQuestion(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-slate-400">
                Jarvis saves this conversation history so you can reopen it from the chat list.
              </div>
              <Button
                type="button"
                className="rounded-2xl"
                onClick={() => void askQuestion()}
                disabled={loading || !question.trim()}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
