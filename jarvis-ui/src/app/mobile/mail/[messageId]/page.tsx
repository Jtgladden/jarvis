"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Mail, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

type EmailDetail = {
  id: string;
  thread_id: string;
  subject: string;
  sender: string;
  snippet: string;
  date?: string;
  labels?: string[];
  body?: string;
  links?: Array<{
    url: string;
    label: string;
    kind: "link" | "button";
  }>;
  classification?: {
    short_summary?: string;
    why_it_matters?: string;
    urgency?: "low" | "medium" | "high";
    needs_reply?: boolean;
    action_items?: string[];
    deadline_hint?: string | null;
    suggested_reply?: string | null;
  };
};

export default function MobileMailDetailPage({
  params,
}: {
  params: Promise<{ messageId: string }>;
}) {
  const [messageId, setMessageId] = useState("");
  const [email, setEmail] = useState<EmailDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [handling, setHandling] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void params.then((resolved) => setMessageId(resolved.messageId));
  }, [params]);

  useEffect(() => {
    if (!messageId) return;

    const loadEmail = async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${API_BASE}/emails/${messageId}/classified`);
        if (!response.ok) {
          throw new Error(`Email lookup failed with status ${response.status}`);
        }
        const data = (await response.json()) as {
          email: EmailDetail;
          classification: EmailDetail["classification"];
        };
        setEmail({ ...data.email, classification: data.classification });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load email.");
      } finally {
        setLoading(false);
      }
    };

    void loadEmail();
  }, [messageId]);

  const handleEmail = async () => {
    if (!messageId) return;
    setHandling(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/emails/${messageId}/handle`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Handle request failed with status ${response.status}`);
      }
      window.location.href = "/mobile?tab=mail";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark email handled.");
    } finally {
      setHandling(false);
    }
  };

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#13162c_0%,#0c0e1c_100%)] px-4 pb-10 pt-4 text-slate-100">
      <div className="mx-auto max-w-md space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Button asChild variant="outline" className="rounded-2xl">
            <Link href="/mobile?tab=mail">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Link>
          </Button>
          <Button variant="outline" className="rounded-2xl" onClick={() => window.location.reload()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>

        {error ? (
          <div className="rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-100">
                  <Mail className="h-3.5 w-3.5" />
                  Important mail
                </div>
                <CardTitle className="mt-3 text-xl">{email?.subject || (loading ? "Loading..." : "(No subject)")}</CardTitle>
                <div className="mt-2 text-sm text-slate-400">{email?.sender || "Unknown sender"}</div>
              </div>
              {email?.classification?.urgency ? (
                <Badge variant="outline" className="rounded-xl">
                  {email.classification.urgency}
                </Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-200">
              {email?.snippet || (loading ? "Loading email preview..." : "No preview available.")}
            </div>

            {email?.classification?.short_summary ? (
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Summary</div>
                <div className="mt-2 text-sm leading-6 text-slate-200">{email.classification.short_summary}</div>
              </div>
            ) : null}

            {email?.classification?.why_it_matters ? (
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Why it matters</div>
                <div className="mt-2 text-sm leading-6 text-slate-200">{email.classification.why_it_matters}</div>
              </div>
            ) : null}

            {email?.classification?.action_items?.length ? (
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Action items</div>
                <div className="mt-2 space-y-2">
                  {email.classification.action_items.map((item, index) => (
                    <div key={`${messageId}-${index}`} className="rounded-xl border border-white/8 px-3 py-2 text-sm text-slate-200">
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {email?.body ? (
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Message body</div>
                <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">{email.body}</div>
                {email.links?.length ? (
                  <div className="mt-4 border-t border-white/8 pt-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Message links</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {email.links.map((link, index) => (
                        <Button
                          key={`${link.url}-${index}`}
                          asChild
                          variant={link.kind === "button" ? "default" : "outline"}
                          className="rounded-2xl"
                        >
                          <a href={link.url} target="_blank" rel="noreferrer">
                            <ExternalLink className="mr-2 h-4 w-4" />
                            {link.label || "Open link"}
                          </a>
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <Button className="w-full rounded-2xl" onClick={() => void handleEmail()} disabled={handling}>
              {handling ? "Handling..." : "Mark handled"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
