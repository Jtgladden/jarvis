"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Activity,
  Archive,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Inbox,
  Languages,
  Mail,
  Newspaper,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import { AssistantPanel } from "@/components/assistant-panel";
import { MovementMap } from "@/components/movement-map";
import { saveTerrainExplorerSession } from "@/components/terrain-explorer-session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";
const IMPORTANT_LABEL = "Jarvis Important";
const UNIMPORTANT_LABEL = "Jarvis Unimportant";
const LIVE_MOVEMENT_REFRESH_MS = 15000;
const KM_TO_MILES = 0.621371;
const KG_TO_POUNDS = 2.20462;
const ML_TO_FLUID_OUNCES = 0.033814;
const LEGACY_IMPORTANT_LABELS = new Set(["Important", "AI Important", "Rules Important"]);
const LEGACY_UNIMPORTANT_LABELS = new Set([
  "Unimportant",
  "AI Unimportant",
  "Rules Unimportant",
  "Rules Security",
  "Rules Shopping",
]);
const ALL_MAILBOX = "ALL";
const JARVIS_REVIEW_MAILBOX = "JARVIS_REVIEW";
const DEFAULT_VISIBLE_MAILBOXES = new Set([
  JARVIS_REVIEW_MAILBOX,
  IMPORTANT_LABEL,
  UNIMPORTANT_LABEL,
  "Reviewed",
]);

type Classification = {
  category?: string;
  importance_score?: number;
  needs_reply?: boolean;
  urgency?: string;
  suggested_action?: string;
  short_summary?: string;
  why_it_matters?: string;
  action_items?: string[];
  deadline_hint?: string | null;
  suggested_reply?: string | null;
  calendar_relevant?: boolean;
  calendar_title?: string | null;
  calendar_start?: string | null;
  calendar_end?: string | null;
  calendar_is_all_day?: boolean;
  calendar_location?: string | null;
  calendar_notes?: string | null;
  reason?: string;
};

type CleanupDecision = {
  action: "keep" | "archive" | "label";
  label_name?: string | null;
  archive: boolean;
  reason: string;
};

type EmailLink = {
  url: string;
  label: string;
  kind: "link" | "button";
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
  links?: EmailLink[];
  classification?: Classification;
  cleanupDecision?: CleanupDecision;
};

type EmailPageResponse = {
  items: Email[];
  next_page_token?: string | null;
};

type ClassificationOverview = {
  mailbox: string;
  total_cached: number;
  needs_reply: number;
  action_item_count: number;
  deadlines_found: number;
  categories: Record<string, number>;
  urgency: Record<string, number>;
  top_senders: Array<{
    sender: string;
    count: number;
  }>;
  top_action_items: Array<{
    message_id: string;
    subject: string;
    sender: string;
    text: string;
    count: number;
  }>;
  deadline_highlights: Array<{
    message_id: string;
    subject: string;
    sender: string;
    text: string;
    count: number;
  }>;
};

type ClassificationGuidance = {
  text: string;
  updated_at?: string | null;
  version: string;
};

type GoogleOAuthStatus = {
  authorized: boolean;
  start_path?: string;
  instructions?: string;
};

type PlannedRouteOverlay = {
  name: string;
  points: Array<{
    latitude: number;
    longitude: number;
  }>;
};

type NearbyTrailItem = {
  id: string;
  name: string;
  source: "usgs" | "nps" | "osm_relation" | "osm_way";
  trail_type: string;
  ref?: string | null;
  operator?: string | null;
  network?: string | null;
  distance_from_center_m?: number | null;
  length_m?: number | null;
  points: Array<{
    latitude: number;
    longitude: number;
  }>;
  osm_url?: string | null;
};

function normalizeOverview(data: Partial<ClassificationOverview>): ClassificationOverview {
  const legacyDeadlineExamples = (data as Partial<{ deadline_examples: ClassificationOverview["deadline_highlights"] }>).deadline_examples;
  return {
    mailbox: data.mailbox || ALL_MAILBOX,
    total_cached: data.total_cached || 0,
    needs_reply: data.needs_reply || 0,
    action_item_count: data.action_item_count || 0,
    deadlines_found: data.deadlines_found || 0,
    categories: data.categories || {},
    urgency: data.urgency || {},
    top_senders: data.top_senders || [],
    top_action_items: data.top_action_items || [],
    deadline_highlights: data.deadline_highlights || legacyDeadlineExamples || [],
  };
}

function isGoogleAuthIssue(message: string | null | undefined) {
  const normalized = (message || "").toLowerCase();
  return (
    normalized.includes("gmail credentials") ||
    normalized.includes("google access") ||
    normalized.includes("google calendar access") ||
    normalized.includes("oauth") ||
    normalized.includes("token.json") ||
    normalized.includes("authorize google")
  );
}

function parseCalendarDate(value: string | null | undefined) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(year, month - 1, day);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const parsed = new Date(value.replace(" ", "T") + "Z");
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatLocalDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftLocalDateKey(value: string, offsetDays: number) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;
  const next = new Date(parsed);
  next.setDate(next.getDate() + offsetDays);
  return formatLocalDateKey(next);
}

function formatSelectedDayLabel(value: string | null | undefined) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return "Selected day";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function isSameLocalDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatRelativeDayLabel(value: string | null | undefined) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return "Scheduled";

  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  if (isSameLocalDay(parsed, now)) {
    return "Today";
  }

  if (isSameLocalDay(parsed, tomorrow)) {
    return "Tomorrow";
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
  }).format(parsed);
}

function formatDashboardTaskDueText(task: DashboardTaskItem) {
  if (!task.due_text) return null;

  const parsed = parseCalendarDate(task.due_text);
  if (!parsed) return task.due_text;

  if (task.source === "calendar") {
    return `${formatRelativeDayLabel(task.due_text)} · ${formatScheduleTimeRange({
      start: task.due_text,
    })}`;
  }

  return formatScheduleDateTime(task.due_text);
}

function formatTaskSourceLabel(source: DashboardTaskItem["source"]) {
  switch (source) {
    case "mail":
      return "Mail";
    case "calendar":
      return "Calendar";
    case "news":
      return "News";
    case "planning":
      return "Planning";
    default:
      return "Custom";
  }
}

function formatHealthStat(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined) return "--";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDistanceMiles(valueKm: number | null | undefined, digits = 1) {
  if (valueKm === null || valueKm === undefined) return "--";
  return `${formatHealthStat(valueKm * KM_TO_MILES, digits)} mi`;
}

function formatWeightPounds(valueKg: number | null | undefined, digits = 1) {
  if (valueKg === null || valueKg === undefined) return "--";
  return `${formatHealthStat(valueKg * KG_TO_POUNDS, digits)} lb`;
}

function formatWaterFluidOunces(valueMl: number | null | undefined, digits = 0) {
  if (valueMl === null || valueMl === undefined) return "--";
  return `${formatHealthStat(valueMl * ML_TO_FLUID_OUNCES, digits)} fl oz`;
}

function formatMovementStoryText(
  story: string | null | undefined,
  { selectedDate }: { selectedDate: string | null | undefined },
) {
  const trimmed = (story || "").trim();
  if (!trimmed) return "No movement story generated yet.";

  const todayKey = formatLocalDateKey(new Date());
  const normalized = trimmed.replace(/(\d+(?:\.\d+)?)\s*km\b/gi, (_, value: string) =>
    formatDistanceMiles(Number(value), 1)
  );

  if (selectedDate && selectedDate !== todayKey) {
    return normalized.replace(/\btoday\b/gi, "that day");
  }

  return normalized;
}

function formatMinutes(value: number | null | undefined) {
  if (value === null || value === undefined) return "--";
  if (value < 60) return `${formatHealthStat(value)} min`;
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

function healthMetricLabel(key: string) {
  const labels: Record<string, string> = {
    walking_running_distance_km: "Distance",
    flights_climbed: "Flights climbed",
    exercise_minutes: "Exercise",
    stand_minutes: "Stand",
    basal_energy_kcal: "Basal energy",
    avg_heart_rate_bpm: "Avg heart rate",
    latest_heart_rate_bpm: "Latest heart rate",
    walking_heart_rate_avg_bpm: "Walking HR avg",
    respiratory_rate_bpm: "Respiratory rate",
    oxygen_saturation_percent: "Oxygen saturation",
    hrv_sdnn_ms: "HRV",
    vo2_max: "VO2 max",
    body_mass_kg: "Weight",
    body_fat_percentage: "Body fat",
    body_mass_index: "BMI",
    water_intake_ml: "Water",
  };

  return labels[key] || key.replaceAll("_", " ");
}

function formatHealthMetricValue(key: string, value: number | string | null | undefined) {
  if (value === null || value === undefined) return "--";
  if (typeof value === "string") return value;

  switch (key) {
    case "walking_running_distance_km":
      return formatDistanceMiles(value, 1);
    case "exercise_minutes":
    case "stand_minutes":
      return `${formatHealthStat(value)} min`;
    case "basal_energy_kcal":
      return `${formatHealthStat(value)} Cal`;
    case "avg_heart_rate_bpm":
    case "latest_heart_rate_bpm":
    case "walking_heart_rate_avg_bpm":
    case "respiratory_rate_bpm":
      return `${formatHealthStat(value)} bpm`;
    case "oxygen_saturation_percent":
    case "body_fat_percentage":
      return `${formatHealthStat(value)}%`;
    case "hrv_sdnn_ms":
      return `${formatHealthStat(value)} ms`;
    case "body_mass_kg":
      return formatWeightPounds(value, 1);
    case "water_intake_ml":
      return formatWaterFluidOunces(value);
    default:
      return formatHealthStat(value, key === "vo2_max" || key === "body_mass_index" ? 1 : 0);
  }
}

function formatScheduleDayLabel(value: string) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(parsed);
}

function formatScheduleDateTime(value: string | null | undefined, isAllDay = false) {
  if (!value) return "Not scheduled";
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;

  if (isAllDay) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(parsed);
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatScheduleTime(value: string | null | undefined) {
  if (!value) return "Unknown";
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatMovementWindow(start: string | null | undefined, end: string | null | undefined) {
  if (start && end) {
    return `${formatScheduleTime(start)} to ${formatScheduleTime(end)}`;
  }
  if (start) {
    return `Started ${formatScheduleTime(start)}`;
  }
  if (end) {
    return `Ended ${formatScheduleTime(end)}`;
  }
  return "No commute markers";
}

function workoutToMapEntry(workout: {
  route_points: Array<{
    timestamp: string;
    latitude: number;
    longitude: number;
  }>;
}) {
  return {
    route_points: workout.route_points.map((point) => ({
      timestamp: point.timestamp,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontal_accuracy_m: null,
    })),
    visits: [],
  };
}

function createBaseTerrainExplorerOption() {
  return {
    id: "terrain-explore",
    label: "Explore terrain",
    detail: "Free-roam 3D terrain view centered on Provo Valley.",
    entry: {
      route_points: [],
      visits: [],
    },
  };
}

function normalizePlannedRoutePoints(
  points: Array<{ latitude: number; longitude: number }>
) {
  return points.filter(
    (point) =>
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      Math.abs(point.latitude) <= 90 &&
      Math.abs(point.longitude) <= 180
  );
}

function buildTrailPlanningPrompt(trail: NearbyTrailItem) {
  const trailLength =
    trail.length_m && trail.length_m > 0
      ? `${formatDistanceMiles(trail.length_m / 1000, 1)} trail distance`
      : "unknown trail distance";
  const trailRef = trail.ref ? ` (${trail.ref})` : "";
  const operator = trail.operator ? ` Operated or maintained by ${trail.operator}.` : "";

  return `Plan a hike around ${trail.name}${trailRef}. Use it as the anchor outdoor excursion for the next few days. Consider drive time, prep time, water and gear, a realistic hiking window, and recovery afterward. Assume ${trailLength}.${operator}`;
}

function isLineStringGeometry(
  value: unknown
): value is { type: "LineString"; coordinates: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "LineString" &&
    "coordinates" in value &&
    Array.isArray((value as { coordinates?: unknown }).coordinates)
  );
}

function getFeatureRouteName(
  feature: { properties?: { name?: string; title?: string } } | unknown,
  fallbackName: string
) {
  if (
    typeof feature === "object" &&
    feature !== null &&
    "properties" in feature &&
    typeof feature.properties === "object" &&
    feature.properties !== null
  ) {
    const properties = feature.properties as { name?: string; title?: string };
    return properties.name || properties.title || fallbackName;
  }

  return fallbackName;
}

function parseGeoJsonRoute(text: string, fallbackName: string): PlannedRouteOverlay | null {
  const parsed = JSON.parse(text) as
    | {
        type?: string;
        coordinates?: unknown;
        features?: Array<{
          geometry?: {
            type?: string;
            coordinates?: unknown;
          };
          properties?: {
            name?: string;
            title?: string;
          };
        }>;
        properties?: {
          name?: string;
        };
      }
    | Array<unknown>;

  const candidateFeatures =
    Array.isArray(parsed)
      ? []
      : parsed.type === "FeatureCollection"
      ? parsed.features || []
      : parsed.type === "Feature"
      ? [parsed]
      : [parsed];

  for (const feature of candidateFeatures) {
    const geometry = "geometry" in feature ? feature.geometry : feature;
    if (!isLineStringGeometry(geometry)) {
      continue;
    }

    const points = normalizePlannedRoutePoints(
      geometry.coordinates
        .filter((coordinate): coordinate is [number, number] =>
          Array.isArray(coordinate) &&
          coordinate.length >= 2 &&
          typeof coordinate[0] === "number" &&
          typeof coordinate[1] === "number"
        )
        .map(([longitude, latitude]) => ({ latitude, longitude }))
    );

    if (points.length) {
      const featureName =
        getFeatureRouteName(feature, fallbackName) ||
        (!Array.isArray(parsed) && parsed.properties?.name) ||
        fallbackName;
      return {
        name: featureName || fallbackName,
        points,
      };
    }
  }

  return null;
}

function parseGpxRoute(text: string, fallbackName: string): PlannedRouteOverlay | null {
  if (typeof window === "undefined") {
    return null;
  }

  const xml = new window.DOMParser().parseFromString(text, "application/xml");
  const parserError = xml.querySelector("parsererror");
  if (parserError) {
    return null;
  }

  const trackPoints = Array.from(xml.querySelectorAll("trkpt"))
    .map((node) => ({
      latitude: Number(node.getAttribute("lat")),
      longitude: Number(node.getAttribute("lon")),
    }))
    .filter(
      (point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
    );

  if (!trackPoints.length) {
    return null;
  }

  const routeName =
    xml.querySelector("trk > name")?.textContent?.trim() ||
    xml.querySelector("rte > name")?.textContent?.trim() ||
    fallbackName;

  return {
    name: routeName,
    points: normalizePlannedRoutePoints(trackPoints),
  };
}

function workoutActivityLabelFromType(activityType: string | null | undefined) {
  const normalized = (activityType || "").trim();
  const rawMatch = normalized.match(/(\d+)/);
  const rawValue = rawMatch ? Number(rawMatch[1]) : Number(normalized);

  switch (rawValue) {
    case 9:
      return "Climbing";
    case 13:
      return "Cycling";
    case 16:
      return "Elliptical";
    case 20:
      return "Functional Strength";
    case 24:
      return "Hike";
    case 35:
      return "Rowing";
    case 37:
      return "Run";
    case 44:
    case 68:
    case 69:
      return "Stairs";
    case 46:
      return "Swim";
    case 50:
      return "Strength";
    case 52:
      return "Walk";
    case 57:
      return "Yoga";
    case 59:
      return "Core Training";
    case 63:
      return "HIIT";
    case 66:
      return "Pilates";
    case 73:
      return "Mixed Cardio";
    case 77:
      return "Dance";
    case 79:
      return "Pickleball";
    case 80:
      return "Cooldown";
    default:
      return null;
  }
}

function formatWorkoutLabel(label: string | null | undefined, activityType?: string | null) {
  const normalized = (label || "").trim();
  if (normalized && !/^workout$/i.test(normalized) && !/^\(RawValue:\s*\d+\)$/i.test(normalized)) {
    return normalized;
  }

  const fallback = workoutActivityLabelFromType(activityType);
  if (fallback) return fallback;
  return "Workout";
}

function formatTimeOnly(value: string | null | undefined) {
  if (!value) return null;
  const parsed = parseCalendarDate(value);
  if (!parsed) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function minutesBetween(start: string | null | undefined, end: string | null | undefined) {
  const startDate = parseCalendarDate(start);
  const endDate = parseCalendarDate(end);
  if (!startDate || !endDate) return null;
  const minutes = Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 60000));
  return Number.isFinite(minutes) ? minutes : null;
}

function formatMovementVisitTitle(
  visit: { label?: string | null; arrival?: string | null; departure?: string | null },
  index: number
) {
  if (visit.label?.trim()) return visit.label.trim();
  if (visit.arrival && !visit.departure) return `Arrival ${index + 1}`;
  if (visit.departure && !visit.arrival) return `Departure ${index + 1}`;
  if (visit.arrival && visit.departure) return `Place ${index + 1}`;
  return `Visit ${index + 1}`;
}

function buildMovementStoryboard(entry: MovementDailyEntry) {
  const items = entry.visits
    .map((visit, index) => {
      const arrivalText = formatTimeOnly(visit.arrival);
      const departureText = formatTimeOnly(visit.departure);
      const stayMinutes = minutesBetween(visit.arrival, visit.departure);
      const title = formatMovementVisitTitle(visit, index);
      let detail = "Visit detected";
      if (arrivalText && departureText) {
        detail = `${arrivalText} to ${departureText}`;
      } else if (arrivalText) {
        detail = `Arrived ${arrivalText}`;
      } else if (departureText) {
        detail = `Departed ${departureText}`;
      }

      const meta = stayMinutes ? `${formatMinutes(stayMinutes)} there` : null;
      return {
        id: `${visit.latitude}-${visit.longitude}-${visit.arrival ?? visit.departure ?? index}`,
        title,
        detail,
        meta,
      };
    });

  if (entry.commute_start || entry.commute_end) {
    items.unshift({
      id: "commute-window",
      title: "Commute window",
      detail: formatMovementWindow(entry.commute_start, entry.commute_end),
      meta: null,
    });
  }

  return items;
}

function formatScheduleTimeRange(item: {
  start: string;
  end?: string | null;
  is_all_day?: boolean;
}) {
  if (item.is_all_day) {
    return "All day";
  }

  const start = parseCalendarDate(item.start);
  if (!start) return item.start;

  const end = parseCalendarDate(item.end);
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const startLabel = timeFormatter.format(start);

  if (!end) {
    return startLabel;
  }

  return `${startLabel} - ${timeFormatter.format(end)}`;
}

function buildAgendaDayGroups(items: CalendarAgendaItem[]): AgendaDayGroup[] {
  const groups = new Map<string, AgendaDayGroup>();

  for (const item of items) {
    const parsed = parseCalendarDate(item.start);
    const key = parsed ? formatLocalDateKey(parsed) : item.start;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(key, {
      key,
      label: formatScheduleDayLabel(item.start),
      items: [item],
    });
  }

  return Array.from(groups.values());
}

function buildPlanningDayGroups(items: PlanningItem[]): Array<{
  key: string;
  label: string;
  items: PlanningItem[];
}> {
  const groups = new Map<string, { key: string; label: string; items: PlanningItem[] }>();

  for (const item of items) {
    const parsed = parseCalendarDate(item.start);
    const key = parsed ? formatLocalDateKey(parsed) : item.day_label;
    const label = parsed ? formatScheduleDayLabel(item.start) : item.day_label;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(key, {
      key,
      label,
      items: [item],
    });
  }

  return Array.from(groups.values());
}

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

type ClassifiedEmailResponse = {
  email: Email;
  classification: Classification;
};

type CalendarPreview = {
  message_id: string;
  thread_id: string;
  relevant: boolean;
  title?: string | null;
  start?: string | null;
  end?: string | null;
  is_all_day: boolean;
  location?: string | null;
  notes?: string | null;
  reason?: string | null;
};

type CalendarCreateResponse = {
  created: boolean;
  event_id?: string | null;
  html_link?: string | null;
  preview: CalendarPreview;
};

type CalendarQuickAddResponse = {
  created: boolean;
  event_id?: string | null;
  html_link?: string | null;
  title?: string | null;
  start?: string | null;
  end?: string | null;
  is_all_day: boolean;
  location?: string | null;
  notes?: string | null;
  source_text: string;
};

type CalendarAgendaItem = {
  event_id: string;
  title: string;
  start: string;
  end?: string | null;
  is_all_day: boolean;
  location?: string | null;
  description?: string | null;
  html_link?: string | null;
  removed?: boolean;
};

type CalendarAgenda = {
  calendar_id: string;
  time_min: string;
  time_max: string;
  items: CalendarAgendaItem[];
};

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

type DashboardNewsItem = {
  title: string;
  source?: string | null;
  link?: string | null;
  published_at?: string | null;
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

type HealthDailyEntry = {
  date: string;
  source: string;
  steps: number;
  active_energy_kcal?: number | null;
  sleep_hours?: number | null;
  workouts: number;
  resting_heart_rate?: number | null;
  extra_metrics: Record<string, number | string | null>;
  synced_at?: string | null;
};

type DashboardHealthSummary = {
  latest_date?: string | null;
  last_synced_at?: string | null;
  today_entry?: HealthDailyEntry | null;
  recent_entries: HealthDailyEntry[];
  seven_day_avg_steps?: number | null;
  seven_day_avg_sleep_hours?: number | null;
  streak_days: number;
};

type HealthListResponse = {
  entries: HealthDailyEntry[];
};

type MovementVisit = {
  arrival?: string | null;
  departure?: string | null;
  latitude: number;
  longitude: number;
  horizontal_accuracy_m?: number | null;
  label?: string | null;
};

type MovementRoutePoint = {
  timestamp: string;
  latitude: number;
  longitude: number;
  horizontal_accuracy_m?: number | null;
};

type MovementDailyEntry = {
  date: string;
  source: string;
  total_distance_km: number;
  time_away_minutes?: number | null;
  visited_places_count: number;
  movement_story: string;
  home_label?: string | null;
  commute_start?: string | null;
  commute_end?: string | null;
  visits: MovementVisit[];
  route_points: MovementRoutePoint[];
  place_labels: string[];
  synced_at?: string | null;
};

type MovementListResponse = {
  entries: MovementDailyEntry[];
};

type WorkoutRoutePoint = {
  timestamp: string;
  latitude: number;
  longitude: number;
  altitude_m?: number | null;
  horizontal_accuracy_m?: number | null;
  vertical_accuracy_m?: number | null;
};

type WorkoutEntry = {
  workout_id: string;
  date: string;
  source: string;
  activity_type: string;
  activity_label: string;
  start_date: string;
  end_date: string;
  duration_minutes: number;
  total_distance_km?: number | null;
  active_energy_kcal?: number | null;
  avg_heart_rate_bpm?: number | null;
  max_heart_rate_bpm?: number | null;
  source_name?: string | null;
  route_points: WorkoutRoutePoint[];
  synced_at?: string | null;
};

type WorkoutListResponse = {
  workouts: WorkoutEntry[];
};

type DashboardResponse = {
  generated_at: string;
  date_label: string;
  overview: string;
  mail_summary: string;
  news_summary: string;
  tasks_summary: string;
  health_summary?: DashboardHealthSummary | null;
  calendar_items: CalendarAgendaItem[];
  important_emails: DashboardMailItem[];
  news_items: DashboardNewsItem[];
  tasks: DashboardTaskItem[];
};

function HealthDetailPanel({
  dashboard,
  healthEntries,
  selectedHealthDate,
  onSelectedHealthDateChange,
  movementEntries,
  workoutEntries,
  movementLoading,
  loading,
  onBackToDashboard,
  onUseTrailForPlanner,
}: {
  dashboard: DashboardResponse | null;
  healthEntries: HealthDailyEntry[];
  selectedHealthDate: string | null;
  onSelectedHealthDateChange: (value: string) => void;
  movementEntries: MovementDailyEntry[];
  workoutEntries: WorkoutEntry[];
  movementLoading: boolean;
  loading: boolean;
  onBackToDashboard?: () => void;
  onUseTrailForPlanner?: (trail: NearbyTrailItem) => void;
}) {
  const healthSummary = dashboard?.health_summary ?? null;
  const [healthAtlasTab, setHealthAtlasTab] = useState<"overview" | "routes">("overview");
  const [expandedMetricsOpen, setExpandedMetricsOpen] = useState(false);
  const [plannedRouteOverlay, setPlannedRouteOverlay] = useState<PlannedRouteOverlay | null>(null);
  const [plannedRouteError, setPlannedRouteError] = useState("");
  const latestHealthDate = healthEntries[0]?.date ?? healthSummary?.today_entry?.date ?? formatLocalDateKey(new Date());
  const earliestHealthDate = healthEntries[healthEntries.length - 1]?.date ?? latestHealthDate;
  const activeHealthDate = selectedHealthDate ?? latestHealthDate;
  const selectedHealthEntry = healthEntries.find((entry) => entry.date === activeHealthDate)
    ?? (healthSummary?.today_entry?.date === activeHealthDate ? healthSummary.today_entry : null);
  const selectedMovementEntry = movementEntries.find((entry) => entry.date === activeHealthDate) ?? null;
  const selectedWorkoutEntries = workoutEntries.filter((workout) => {
    const parsed = parseCalendarDate(workout.start_date);
    return parsed ? formatLocalDateKey(parsed) === activeHealthDate : false;
  });
  const movementStoryboard = selectedMovementEntry ? buildMovementStoryboard(selectedMovementEntry) : [];
  const mappedWorkouts = selectedWorkoutEntries.filter((workout) => workout.route_points.length > 1).slice(0, 2);
  const featuredWorkout = selectedWorkoutEntries[0] ?? null;
  const hasMovementMap = Boolean(
    selectedMovementEntry && (selectedMovementEntry.route_points.length || selectedMovementEntry.visits.length)
  );
  const terrainExplorerOptions = useMemo(
    () => [
      createBaseTerrainExplorerOption(),
      ...mappedWorkouts.map((workout) => ({
        id: `workout-${workout.workout_id}`,
        label: formatWorkoutLabel(workout.activity_label, workout.activity_type),
        detail: formatScheduleDateTime(workout.start_date),
        entry: workoutToMapEntry(workout),
      })),
    ],
    [mappedWorkouts]
  );
  const [selectedTerrainExplorerId, setSelectedTerrainExplorerId] = useState<string | null>(
    () => terrainExplorerOptions[0]?.id ?? null
  );
  useEffect(() => {
    if (!terrainExplorerOptions.length) {
      setSelectedTerrainExplorerId(null);
      return;
    }

    setSelectedTerrainExplorerId((current) =>
      current && terrainExplorerOptions.some((option) => option.id === current)
        ? current
        : terrainExplorerOptions[0].id
    );
  }, [terrainExplorerOptions]);
  const selectedTerrainExplorer =
    terrainExplorerOptions.find((option) => option.id === selectedTerrainExplorerId) ??
    terrainExplorerOptions[0] ??
    null;

  const openFullscreenTerrainExplorer = () => {
    if (!terrainExplorerOptions.length) {
      return;
    }

    const sessionId = saveTerrainExplorerSession({
      terrainExplorerOptions,
      selectedTerrainExplorerId,
      plannedRouteOverlay,
      nearbyTrails: [],
      selectedNearbyTrailId: null,
      terrainViewBounds: null,
      plannerViewNonce: 0,
      sourceContext: "desktop",
    });
    window.open(`/terrain-explorer?session=${encodeURIComponent(sessionId)}`, "jarvis-terrain-explorer");
  };

  const handlePlannedRouteUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const baseName = file.name.replace(/\.[^.]+$/, "") || "Planned route";
      const lowerName = file.name.toLowerCase();
      const parsedRoute =
        lowerName.endsWith(".gpx")
          ? parseGpxRoute(text, baseName)
          : parseGeoJsonRoute(text, baseName);

      if (!parsedRoute?.points.length) {
        throw new Error("No route points were found in that GPX or GeoJSON file.");
      }

      setPlannedRouteOverlay(parsedRoute);
      setPlannedRouteError("");
    } catch (error) {
      setPlannedRouteOverlay(null);
      setPlannedRouteError(
        error instanceof Error ? error.message : "Unable to import the selected route file."
      );
    } finally {
      event.target.value = "";
    }
  };

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden rounded-[2rem] border border-white/8 bg-[linear-gradient(180deg,rgba(19,24,42,0.94),rgba(13,15,28,0.94))] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/18 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-cyan-100">
                <Activity className="h-4 w-4" />
                Health Atlas
              </div>
              <CardTitle className="mt-3 text-xl text-white">
                Daily health, workouts, and movement together
              </CardTitle>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                A calmer view of body signals, logged workouts, and your location-based movement story.
              </p>
            </div>
            {onBackToDashboard ? (
              <Button variant="outline" className="rounded-2xl" onClick={onBackToDashboard}>
                Back to dashboard
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-3 rounded-[1.4rem] border border-white/8 bg-white/5 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Selected day</div>
              <div className="mt-1 text-base font-semibold text-white">{formatSelectedDayLabel(activeHealthDate)}</div>
              <div className="mt-1 text-xs text-slate-400">
                Use the arrows for day-by-day review or jump with the calendar.
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                className="rounded-2xl"
                onClick={() => onSelectedHealthDateChange(shiftLocalDateKey(activeHealthDate, -1))}
                disabled={activeHealthDate <= earliestHealthDate}
              >
                <ChevronLeft className="mr-2 h-4 w-4" />
                Previous day
              </Button>
              <input
                type="date"
                value={activeHealthDate}
                min={earliestHealthDate}
                max={latestHealthDate}
                onChange={(event) => onSelectedHealthDateChange(event.target.value)}
                className="h-10 rounded-2xl border border-white/10 bg-[rgba(20,22,37,0.88)] px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/40"
              />
              <Button
                variant="outline"
                className="rounded-2xl"
                onClick={() => onSelectedHealthDateChange(shiftLocalDateKey(activeHealthDate, 1))}
                disabled={activeHealthDate >= latestHealthDate}
              >
                Next day
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setHealthAtlasTab("overview")}
              className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition ${
                healthAtlasTab === "overview"
                  ? "border-cyan-300/25 bg-cyan-400/12 text-cyan-100"
                  : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
              }`}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => setHealthAtlasTab("routes")}
              className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition ${
                healthAtlasTab === "routes"
                  ? "border-emerald-300/25 bg-emerald-400/12 text-emerald-100"
                  : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
              }`}
            >
              Routes
            </button>
          </div>
        </CardHeader>
        <CardContent>
          {selectedHealthEntry || selectedMovementEntry ? (
            <div className="space-y-5">
              {healthSummary ? (
                <div className="grid gap-3 xl:grid-cols-[1.35fr_0.85fr_0.85fr_0.95fr]">
                  <div className="rounded-[1.6rem] border border-cyan-300/16 bg-[linear-gradient(135deg,rgba(37,99,235,0.16),rgba(17,19,34,0.64))] p-5">
                    <div className="text-xs uppercase tracking-[0.2em] text-cyan-100/80">Day baseline</div>
                    <div className="mt-3 text-3xl font-semibold text-white">
                      {formatHealthStat(selectedHealthEntry?.steps)}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-cyan-100">
                      <span className="rounded-full border border-cyan-300/25 bg-black/10 px-3 py-1">
                        7-day avg {formatHealthStat(healthSummary.seven_day_avg_steps)}
                      </span>
                      <span className="rounded-full border border-cyan-300/25 bg-black/10 px-3 py-1">
                        {healthSummary.streak_days} day streak
                      </span>
                    </div>
                  </div>
                  <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                    <div className="text-xs uppercase tracking-wide text-slate-400">Active energy</div>
                    <div className="mt-2 text-2xl font-semibold text-white">
                      {formatHealthStat(selectedHealthEntry?.active_energy_kcal)} Cal
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      {healthSummary.streak_days} day movement streak
                    </div>
                  </div>
                  <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                    <div className="text-xs uppercase tracking-wide text-slate-400">Sleep average</div>
                    <div className="mt-2 text-2xl font-semibold text-white">
                      {formatHealthStat(healthSummary.seven_day_avg_sleep_hours, 1)} hr
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      Workouts logged {formatHealthStat(selectedHealthEntry?.workouts)}
                    </div>
                  </div>
                  <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                    <div className="text-xs uppercase tracking-wide text-slate-400">Resting heart rate</div>
                    <div className="mt-2 text-2xl font-semibold text-white">
                      {formatHealthStat(selectedHealthEntry?.resting_heart_rate)} bpm
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      Latest sync {healthSummary.last_synced_at ? formatScheduleDateTime(healthSummary.last_synced_at) : "unknown"}
                    </div>
                  </div>
                </div>
              ) : null}

              {healthSummary ? (
                <div className="rounded-[1.5rem] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(56,189,248,0.12),rgba(35,37,58,0.85))] p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-cyan-100">
                    {healthSummary.latest_date ? (
                      <span className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2.5 py-1">
                        Latest data date {healthSummary.latest_date}
                      </span>
                    ) : null}
                    <span className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2.5 py-1">
                      {healthSummary.recent_entries.length} synced day{healthSummary.recent_entries.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              ) : null}

              {selectedHealthEntry?.extra_metrics &&
              Object.keys(selectedHealthEntry.extra_metrics).length ? (
                <div className="rounded-[1.5rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                  <button
                    type="button"
                    onClick={() => setExpandedMetricsOpen((current) => !current)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                  >
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-400">Expanded metrics</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {expandedMetricsOpen ? "Hide detailed measurements" : "Show detailed measurements"}
                      </div>
                    </div>
                    <span className="text-xs text-cyan-200">
                      {expandedMetricsOpen ? "Hide" : "Show"}
                    </span>
                  </button>
                  {expandedMetricsOpen ? (
                    <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                      {Object.entries(selectedHealthEntry.extra_metrics)
                        .filter(([, value]) => value !== null && value !== undefined)
                        .map(([key, value]) => (
                          <div
                            key={key}
                            className="rounded-[1rem] border border-white/6 bg-[rgba(17,19,34,0.45)] px-3 py-2"
                          >
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              {healthMetricLabel(key)}
                            </div>
                            <div className="mt-1 text-sm font-medium text-slate-100">
                              {formatHealthMetricValue(key, value)}
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <Card className="rounded-[1.5rem] border border-white/6 bg-[rgba(35,37,58,0.72)] shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Workout spotlight</CardTitle>
                </CardHeader>
                <CardContent>
                  {featuredWorkout ? (
                    <div className="rounded-[1.2rem] border border-white/6 bg-[rgba(17,19,34,0.45)] px-4 py-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                        <div>
                          <div className="text-sm font-medium text-slate-100">
                            {formatWorkoutLabel(featuredWorkout.activity_label, featuredWorkout.activity_type)}
                          </div>
                          <div className="mt-1 text-xs text-slate-400">
                            {formatScheduleDateTime(featuredWorkout.start_date)}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs text-slate-300">
                          <span>{formatHealthStat(featuredWorkout.duration_minutes, 0)} min</span>
                          <span>{formatDistanceMiles(featuredWorkout.total_distance_km, 1)}</span>
                          <span>{formatHealthStat(featuredWorkout.active_energy_kcal)} Cal</span>
                          <span>{formatHealthStat(featuredWorkout.avg_heart_rate_bpm)} avg bpm</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-[1rem] border border-dashed border-white/10 px-4 py-3 text-sm text-slate-400">
                      No workout history has been synced yet.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="rounded-[1.5rem] border border-white/6 bg-[rgba(35,37,58,0.72)] shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Movement journal</CardTitle>
                  <p className="text-sm leading-6 text-slate-300">
                    A more narrative look at your day: where you went, how the day flowed, and the shape of your movement.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {selectedMovementEntry ? (
                    <>
                      <div className="rounded-[1.5rem] border border-emerald-300/15 bg-[linear-gradient(135deg,rgba(16,185,129,0.16),rgba(14,18,30,0.92))] p-5">
                        <div className="text-xs uppercase tracking-[0.22em] text-emerald-100/80">Movement story</div>
                        <div className="mt-3 text-lg font-semibold text-white">
                          {formatMovementStoryText(selectedMovementEntry.movement_story, {
                            selectedDate: activeHealthDate,
                          })}
                        </div>
                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                          <div className="rounded-[1.1rem] border border-white/8 bg-black/10 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-300">Distance</div>
                            <div className="mt-1 text-xl font-semibold text-white">
                              {formatDistanceMiles(selectedMovementEntry.total_distance_km, 1)}
                            </div>
                          </div>
                          <div className="rounded-[1.1rem] border border-white/8 bg-black/10 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-300">Away from home</div>
                            <div className="mt-1 text-xl font-semibold text-white">
                              {formatMinutes(selectedMovementEntry.time_away_minutes)}
                            </div>
                          </div>
                          <div className="rounded-[1.1rem] border border-white/8 bg-black/10 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-300">Visited places</div>
                            <div className="mt-1 text-xl font-semibold text-white">
                              {selectedMovementEntry.visited_places_count}
                            </div>
                          </div>
                        </div>
                      </div>

                      {healthAtlasTab === "routes" && hasMovementMap && selectedMovementEntry ? (
                        <div className="rounded-[1.3rem] border border-white/6 bg-[rgba(17,19,34,0.45)] p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Route postcard</div>
                              <div className="mt-1 text-sm text-slate-300">A quiet geographic view of today&apos;s movement path.</div>
                            </div>
                            <div className="text-xs text-slate-400">
                              {selectedMovementEntry.route_points.length || selectedMovementEntry.visits.length} points
                            </div>
                          </div>
                          <div className="mt-4 overflow-hidden rounded-[1.2rem] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.14),transparent_32%),linear-gradient(180deg,rgba(9,12,22,0.96),rgba(15,18,28,0.96))]">
                            <MovementMap entry={selectedMovementEntry} className="h-[460px] xl:h-[520px]" />
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
                            <span className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1">Start</span>
                            <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1">End</span>
                            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{selectedMovementEntry.place_labels.length} labeled places</span>
                          </div>
                        </div>
                      ) : null}

                      {healthAtlasTab === "routes" ? (
                        <div className="rounded-[1.3rem] border border-white/6 bg-[rgba(17,19,34,0.45)] p-4">
                          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div>
                              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">3D terrain explorer</div>
                              <div className="mt-1 text-sm text-slate-300">
                                Open the terrain explorer in a separate fullscreen window to freely explore the map, then layer in workout routes, planned hikes, and live trail overlays when you want them.
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="rounded-2xl"
                                onClick={openFullscreenTerrainExplorer}
                                disabled={!selectedTerrainExplorer}
                              >
                                Open fullscreen
                              </Button>
                            </div>
                          </div>
                          <div className="mt-4 flex flex-wrap gap-2">
                            {terrainExplorerOptions.map((option) => (
                              <button
                                key={option.id}
                                type="button"
                                onClick={() => setSelectedTerrainExplorerId(option.id)}
                                className={`rounded-full border px-3 py-1 text-xs transition ${
                                  selectedTerrainExplorer?.id === option.id
                                    ? "border-emerald-300/25 bg-emerald-400/12 text-emerald-100"
                                    : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
                                }`}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                          <div className="mt-4 flex flex-col gap-3 rounded-[1rem] border border-white/8 bg-black/10 p-4 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Planned route overlay</div>
                              <div className="mt-1 text-sm text-slate-300">
                                Import a `GPX` or `GeoJSON` track here, then launch fullscreen to preview it on the terrain globe.
                              </div>
                              {plannedRouteOverlay ? (
                                <div className="mt-2 text-xs text-emerald-200">
                                  Loaded {plannedRouteOverlay.name} with {plannedRouteOverlay.points.length} points.
                                </div>
                              ) : null}
                              {plannedRouteError ? (
                                <div className="mt-2 text-xs text-rose-200">{plannedRouteError}</div>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <label className="inline-flex cursor-pointer items-center rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition hover:border-white/20">
                                Import route
                                <input
                                  type="file"
                                  accept=".gpx,.geojson,.json,application/geo+json,application/json,application/gpx+xml"
                                  onChange={handlePlannedRouteUpload}
                                  className="hidden"
                                />
                              </label>
                              {plannedRouteOverlay ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPlannedRouteOverlay(null);
                                    setPlannedRouteError("");
                                  }}
                                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/20"
                                >
                                  Clear planned route
                                </button>
                              ) : null}
                            </div>
                          </div>
                          {selectedTerrainExplorer?.detail ? (
                            <div className="mt-3 text-xs text-slate-500">
                              Selected route: {selectedTerrainExplorer.detail}
                            </div>
                          ) : null}
                          <div className="mt-4 rounded-[1rem] border border-white/8 bg-black/10 p-4 text-sm text-slate-300">
                            Trail search, terrain overlays, and hike-planning controls now live only in the fullscreen explorer so the embedded dashboard view stays stable.
                          </div>
                        </div>
                      ) : null}

                      {healthAtlasTab === "overview" ? (
                        <>
                          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                            <div className="rounded-[1.2rem] border border-white/6 bg-[rgba(17,19,34,0.45)] p-4">
                              <div className="text-xs uppercase tracking-wide text-slate-400">Travel</div>
                              <div className="mt-2 text-2xl font-semibold text-white">
                                {formatDistanceMiles(selectedMovementEntry.total_distance_km, 1)}
                              </div>
                              <div className="mt-2 text-xs text-slate-400">
                                {selectedMovementEntry.route_points.length} route points
                              </div>
                            </div>
                            <div className="rounded-[1.2rem] border border-white/6 bg-[rgba(17,19,34,0.45)] p-4">
                              <div className="text-xs uppercase tracking-wide text-slate-400">Away time</div>
                              <div className="mt-2 text-2xl font-semibold text-white">
                                {formatMinutes(selectedMovementEntry.time_away_minutes)}
                              </div>
                              <div className="mt-2 text-xs text-slate-400">
                                {selectedMovementEntry.visited_places_count} visit event{selectedMovementEntry.visited_places_count === 1 ? "" : "s"}
                              </div>
                            </div>
                            <div className="rounded-[1.2rem] border border-white/6 bg-[rgba(17,19,34,0.45)] p-4">
                              <div className="text-xs uppercase tracking-wide text-slate-400">Commute window</div>
                              <div className="mt-2 text-sm font-semibold text-white">
                                {formatMovementWindow(selectedMovementEntry.commute_start, selectedMovementEntry.commute_end)}
                              </div>
                              <div className="mt-2 text-xs text-slate-400">
                                Synced {selectedMovementEntry.synced_at ? formatScheduleDateTime(selectedMovementEntry.synced_at) : "unknown"}
                              </div>
                            </div>
                            <div className="rounded-[1.2rem] border border-white/6 bg-[rgba(17,19,34,0.45)] p-4">
                              <div className="text-xs uppercase tracking-wide text-slate-400">Places</div>
                              <div className="mt-2 text-2xl font-semibold text-white">
                                {selectedMovementEntry.place_labels.length}
                              </div>
                              <div className="mt-2 text-xs text-slate-400">
                                labels captured
                              </div>
                            </div>
                          </div>

                          {selectedMovementEntry.place_labels.length ? (
                            <div className="flex flex-wrap gap-2">
                              {selectedMovementEntry.place_labels.map((label) => (
                                <span
                                  key={label}
                                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300"
                                >
                                  {label}
                                </span>
                              ))}
                            </div>
                          ) : null}

                          <div className="rounded-[1.3rem] border border-white/6 bg-[rgba(17,19,34,0.45)] p-4">
                            <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Movement storyboard</div>
                            <div className="mt-3 space-y-3">
                              {movementStoryboard.length ? movementStoryboard.map((item, index) => (
                                <div
                                  key={item.id}
                                  className="flex gap-3 rounded-[1rem] border border-white/6 bg-[rgba(255,255,255,0.03)] px-4 py-3"
                                >
                                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-xs font-semibold text-emerald-100">
                                    {index + 1}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium text-slate-100">{item.title}</div>
                                    <div className="mt-1 text-sm text-slate-300">{item.detail}</div>
                                    {item.meta ? (
                                      <div className="mt-1 text-xs text-slate-500">{item.meta}</div>
                                    ) : null}
                                  </div>
                                </div>
                              )) : (
                                <div className="rounded-[1rem] border border-dashed border-white/10 px-4 py-3 text-sm text-slate-400">
                                  No visits have been turned into a movement storyboard yet.
                                </div>
                              )}
                            </div>
                          </div>
                        </>
                      ) : null}

                      {healthAtlasTab === "routes" ? (
                        <Card className="rounded-[1.5rem] border border-white/6 bg-[rgba(35,37,58,0.72)] shadow-none">
                          <CardHeader className="pb-2">
                            <CardTitle className="text-base">Workout routes</CardTitle>
                            <p className="text-sm leading-6 text-slate-300">
                              Mapped workouts stay separate from passive movement so hikes and runs read like distinct events.
                            </p>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {mappedWorkouts.length ? (
                              <div className="grid gap-4 xl:grid-cols-2">
                                {mappedWorkouts.map((workout) => (
                                  <div
                                    key={`${workout.workout_id}-map`}
                                    className="overflow-hidden rounded-[1.2rem] border border-white/6 bg-[rgba(17,19,34,0.45)]"
                                  >
                                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                                      <div>
                                        <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Workout route</div>
                                        <div className="mt-1 text-sm font-medium text-slate-100">{formatWorkoutLabel(workout.activity_label, workout.activity_type)}</div>
                                      </div>
                                      <div className="text-xs text-slate-400">
                                        {formatDistanceMiles(workout.total_distance_km, 1)}
                                      </div>
                                    </div>
                                    <MovementMap entry={workoutToMapEntry(workout)} className="h-[320px]" />
                                    <div className="flex flex-wrap gap-2 px-4 py-3 text-xs text-slate-300">
                                      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                        {formatScheduleDateTime(workout.start_date)}
                                      </span>
                                      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                        {workout.route_points.length} route point{workout.route_points.length === 1 ? "" : "s"}
                                      </span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="rounded-[1rem] border border-dashed border-white/10 px-4 py-3 text-sm text-slate-400">
                                No mapped workout routes available yet.
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      ) : null}

                    </>
                  ) : (
                    <div className="rounded-[1.2rem] border border-dashed border-white/10 p-4 text-sm text-slate-400">
                      {movementLoading
                        ? "Loading movement journal..."
                        : "No movement journal has been synced yet. The iPhone app can send distance, visits, commute timing, and daily movement stories here."}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
              {loading
                ? "Loading health data..."
                : "No synced health data yet. Use the iPhone app to send Apple Health data into Jarvis."}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

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
  world_event_source?: string | null;
  world_event_articles: Array<{
    title: string;
    source?: string | null;
    link?: string | null;
    published_at?: string | null;
  }>;
  journal_entry: string;
  accomplishments: string;
  gratitude_entry: string;
  scripture_study: string;
  spiritual_notes: string;
  study_links: Array<{
    label: string;
    url: string;
    confidence: "exact" | "likely";
    matched_text?: string | null;
  }>;
  photo_data_url?: string | null;
  calendar_items: CalendarAgendaItem[];
  language_sessions: Array<{ id: string; language: string; mode: string; minutes: number; notes: string; created_at?: string | null }>;
  updated_at?: string | null;
};

type JournalResponse = {
  generated_at: string;
  entries: JournalDayEntry[];
  total_entries: number;
  has_more: boolean;
  next_before?: string | null;
  saved_only: boolean;
  query: string;
};

type JournalDraft = {
  journal_entry: string;
  accomplishments: string;
  gratitude_entry: string;
  scripture_study: string;
  spiritual_notes: string;
  photo_data_url?: string | null;
  calendar_items: CalendarAgendaItem[];
};

type JournalSectionState = {
  dayOpen: boolean;
  calendarOpen: boolean;
  articlesOpen: boolean;
};

type JournalLoadOptions = {
  before?: string | null;
  query?: string;
  savedOnly?: boolean;
  history?: Array<string | null>;
};

type TaskWindow = "today" | "this_week" | "next_week";

type TaskDraft = {
  title: string;
  detail: string;
  due_at: string;
  due_note: string;
  priority: "high" | "medium" | "low";
};

type AgendaDayGroup = {
  key: string;
  label: string;
  items: CalendarAgendaItem[];
};

type PlanningItem = {
  id: string;
  title: string;
  start: string;
  end: string;
  day_label: string;
  priority: "high" | "medium" | "low";
  kind: "focus" | "meeting_prep" | "admin" | "personal" | "buffer";
  rationale: string;
};

type PlanningResponse = {
  summary: string;
  strategy: string;
  priorities: string[];
  items: PlanningItem[];
};

type PlanningJobStartResponse = {
  job_id: string;
  status: "queued" | "running";
};

type PlanningJobStatus = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  goals: string;
  days: number;
  result?: PlanningResponse | null;
  error?: string | null;
};

type PlanningCalendarCreateResponse = {
  created: boolean;
  event_id?: string | null;
  html_link?: string | null;
  item: PlanningItem;
};

type PlanningCalendarBulkCreateResponse = {
  created_count: number;
  items: PlanningCalendarCreateResponse[];
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

function getStudyLinkPatterns(
  links: Array<{ matched_text?: string | null; label?: string | null }> | null | undefined
) {
  if (!links?.length) return [];

  return Array.from(
    new Set(
      links.flatMap((link) =>
        [link.matched_text, link.label]
          .map((value) => (value || "").trim())
          .filter((value) => value.length >= 2)
      )
    )
  ).sort((left, right) => right.length - left.length);
}

function textMatchesJournalQuery(text: string | null | undefined, query: string) {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return getJournalSearchPatterns(query).some((pattern) =>
    haystack.includes(pattern.toLowerCase())
  );
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

function highlightJournalTextWithReferences(
  text: string | null | undefined,
  query: string,
  links: Array<{ matched_text?: string | null; label?: string | null }> | null | undefined
): React.ReactNode {
  const value = text || "";
  const searchPatterns = getJournalSearchPatterns(query);
  const referencePatterns = getStudyLinkPatterns(links);
  const patterns = Array.from(new Set([...searchPatterns, ...referencePatterns]))
    .sort((left, right) => right.length - left.length);

  if (!value || !patterns.length) {
    return value;
  }

  const matcher = new RegExp(`(${patterns.map(escapeRegex).join("|")})`, "gi");
  const segments = value.split(matcher);

  return segments.map((segment, index) => {
    const isReferenceMatch = referencePatterns.some(
      (pattern) => segment.toLowerCase() === pattern.toLowerCase()
    );
    const isSearchMatch = searchPatterns.some(
      (pattern) => segment.toLowerCase() === pattern.toLowerCase()
    );

    if (!isReferenceMatch && !isSearchMatch) {
      return <React.Fragment key={`${segment}-${index}`}>{segment}</React.Fragment>;
    }

    const className = isReferenceMatch
      ? "rounded-md bg-cyan-400/18 px-1 py-0.5 text-cyan-50 ring-1 ring-cyan-300/25"
      : "rounded-md bg-fuchsia-400/20 px-1 py-0.5 text-fuchsia-100 ring-1 ring-fuchsia-300/25";

    return (
      <mark key={`${segment}-${index}`} className={className}>
        {segment}
      </mark>
    );
  });
}

function JournalPreviewBlock({
  label,
  value,
  query,
  placeholder,
  compact = false,
  studyLinks,
}: {
  label: string;
  value: string | null | undefined;
  query: string;
  placeholder: string;
  compact?: boolean;
  studyLinks?: Array<{ matched_text?: string | null; label?: string | null }>;
}) {
  const hasValue = Boolean((value || "").trim());

  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div
        className={`${compact ? "" : "min-h-[180px]"} rounded-[1.2rem] border px-4 py-3 text-sm leading-6 ${
          hasValue
            ? "border-white/8 bg-[rgba(20,22,37,0.72)] text-slate-100"
            : "border-dashed border-white/10 bg-[rgba(20,22,37,0.42)] text-slate-500"
        }`}
      >
        <div className="whitespace-pre-wrap break-words">
          {hasValue ? highlightJournalTextWithReferences(value, query, studyLinks) : placeholder}
        </div>
      </div>
    </div>
  );
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

async function getErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json();
    if (data && typeof data.detail === "string" && data.detail.trim()) {
      return data.detail;
    }
  } catch {
    // Ignore malformed or empty error bodies and fall back to the caller message.
  }

  return fallback;
}

function hasImportantLabel(labels: string[] | undefined) {
  return (labels || []).some(
    (label) => label === IMPORTANT_LABEL || LEGACY_IMPORTANT_LABELS.has(label)
  );
}

function hasUnimportantLabel(labels: string[] | undefined) {
  return (labels || []).some(
    (label) => label === UNIMPORTANT_LABEL || LEGACY_UNIMPORTANT_LABELS.has(label)
  );
}

function emailHasLabel(email: Email | null, labelName: string) {
  return (email?.labels || []).includes(labelName);
}

function emailMatchesMailbox(email: Email, mailbox: string) {
  if (mailbox === ALL_MAILBOX) return true;
  if (mailbox === JARVIS_REVIEW_MAILBOX) {
    return hasImportantLabel(email.labels) || hasUnimportantLabel(email.labels);
  }
  return (email.labels || []).includes(mailbox);
}

function isByuEmail(email: Email | null) {
  if (!email) return false;

  const haystack = [email.sender, email.subject, email.snippet, email.body]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes("@byu.edu");
}

function groupEmailsByThread(emails: Email[]) {
  const grouped = new Map<
    string,
    {
      email: Email;
      count: number;
    }
  >();

  for (const email of emails) {
    const existing = grouped.get(email.thread_id);
    if (existing) {
      existing.count += 1;
      continue;
    }

    grouped.set(email.thread_id, {
      email,
      count: 1,
    });
  }

  return Array.from(grouped.values());
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
  const byuEmail = isByuEmail(email);

  return (
    <button
      onClick={onClick}
      className={`block w-full max-w-full min-w-0 overflow-hidden rounded-[1.6rem] border p-4 text-left transition duration-200 ${
        selected
          ? "border-fuchsia-400/70 bg-[linear-gradient(135deg,rgba(189,147,249,0.24),rgba(40,42,54,0.98))] ring-1 ring-fuchsia-400/20"
          : "border-white/8 bg-[rgba(24,26,42,0.82)] hover:border-cyan-300/30 hover:bg-[rgba(32,35,57,0.95)] hover:ring-1 hover:ring-cyan-300/12"
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-100">
            {decodeHtmlEntities(email.subject) || "(No subject)"}
          </div>
          <div className="truncate text-xs text-slate-400">
            {decodeHtmlEntities(email.sender) || "Unknown sender"}
          </div>
        </div>

        {classification.importance_score ? (
          <Badge variant="secondary" className="shrink-0 rounded-xl">
            {classification.importance_score}/10
          </Badge>
        ) : null}
      </div>

      <p className="mb-3 line-clamp-2 break-words text-sm text-slate-300">
        {decodeHtmlEntities(email.snippet) || "No preview available."}
      </p>

      <div className="flex min-w-0 max-w-full flex-wrap gap-2 overflow-hidden">
        {byuEmail ? (
          <Badge className="max-w-full rounded-xl bg-sky-500/20 text-sky-100 hover:bg-sky-500/20">
            BYU mail
          </Badge>
        ) : null}

        {classification.category ? (
          <Badge
            variant={categoryTone[classification.category] || "secondary"}
            className="max-w-full truncate rounded-xl"
          >
            {classification.category.replaceAll("_", " ")}
          </Badge>
        ) : null}

        {classification.needs_reply ? (
          <Badge className="max-w-full rounded-xl">needs reply</Badge>
        ) : null}

        {classification.urgency ? (
          <Badge variant="outline" className="max-w-full rounded-xl">
            {classification.urgency}
          </Badge>
        ) : null}

        {cleanupDecision ? (
          <Badge variant={decisionTone[cleanupDecision.action]} className="max-w-full truncate rounded-xl">
            {cleanupDecision.action}
          </Badge>
        ) : null}
      </div>
    </button>
  );
}

function formatDateTimeLocalValue(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function buildTaskDraft(task: DashboardTaskItem): TaskDraft {
  const parsed = parseCalendarDate(task.due_text);
  return {
    title: task.title,
    detail: task.detail || "",
    due_at: parsed ? formatDateTimeLocalValue(parsed) : "",
    due_note: parsed ? "" : task.due_text || "",
    priority: task.priority,
  };
}

function getTaskDraftDueText(draft: TaskDraft) {
  return draft.due_at || draft.due_note.trim() || null;
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfLocalWeek(value: Date) {
  const start = startOfLocalDay(value);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function taskMatchesWindow(task: DashboardTaskItem, window: TaskWindow) {
  const parsed = parseCalendarDate(task.due_text);
  if (!parsed) return true;

  const taskDay = startOfLocalDay(parsed);
  const today = startOfLocalDay(new Date());

  if (window === "today") {
    return taskDay.getTime() === today.getTime();
  }

  const currentWeekStart = startOfLocalWeek(today);
  const nextWeekStart = addLocalDays(currentWeekStart, 7);
  const weekAfterNextStart = addLocalDays(nextWeekStart, 7);

  if (window === "this_week") {
    return taskDay >= currentWeekStart && taskDay < nextWeekStart;
  }

  return taskDay >= nextWeekStart && taskDay < weekAfterNextStart;
}

export default function HomePage() {
  const router = useRouter();
  const [emails, setEmails] = useState<Email[]>([]);
  const [rawNextPageToken, setRawNextPageToken] = useState<string | null>(null);
  const [rawPageToken, setRawPageToken] = useState<string | null>(null);
  const [rawPageHistory, setRawPageHistory] = useState<string[]>([]);
  const [labels, setLabels] = useState<GmailLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [handleLoading, setHandleLoading] = useState(false);
  const [emailActionLoading, setEmailActionLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"dashboard" | "assistant" | "tasks" | "journal" | "mail" | "news" | "overview" | "schedule" | "planning" | "settings" | "health">("dashboard");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [mailView, setMailView] = useState<"ai" | "raw">("ai");
  const [mailWorkspaceTab, setMailWorkspaceTab] = useState<"triage" | "insights">("triage");
  const [scheduleWorkspaceTab, setScheduleWorkspaceTab] = useState<"agenda" | "planner">("agenda");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [healthEntries, setHealthEntries] = useState<HealthDailyEntry[]>([]);
  const [selectedHealthDate, setSelectedHealthDate] = useState<string | null>(null);
  const [movementEntries, setMovementEntries] = useState<MovementDailyEntry[]>([]);
  const [workoutEntries, setWorkoutEntries] = useState<WorkoutEntry[]>([]);
  const [movementLoading, setMovementLoading] = useState(false);
  const [tasks, setTasks] = useState<DashboardTaskItem[]>([]);
  const [taskDrafts, setTaskDrafts] = useState<Record<string, TaskDraft>>({});
  const [taskSavingId, setTaskSavingId] = useState<string | null>(null);
  const [taskEditingId, setTaskEditingId] = useState<string | null>(null);
  const [taskDeletingId, setTaskDeletingId] = useState<string | null>(null);
  const [calendarTaskLoadingId, setCalendarTaskLoadingId] = useState<string | null>(null);
  const [taskCreateLoading, setTaskCreateLoading] = useState(false);
  const [taskWindow, setTaskWindow] = useState<TaskWindow>("today");
  const [dashboardQuickTaskTitle, setDashboardQuickTaskTitle] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDetail, setNewTaskDetail] = useState("");
  const [newTaskDueAt, setNewTaskDueAt] = useState("");
  const [newTaskDueNote, setNewTaskDueNote] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState<"high" | "medium" | "low">("medium");
  const [journal, setJournal] = useState<JournalResponse | null>(null);
  const [journalDrafts, setJournalDrafts] = useState<Record<string, JournalDraft>>({});
  const [journalSectionState, setJournalSectionState] = useState<Record<string, JournalSectionState>>({});
  const [journalSavingDate, setJournalSavingDate] = useState<string | null>(null);
  const [journalExtractingDate, setJournalExtractingDate] = useState<string | null>(null);
  const [journalEditingDate, setJournalEditingDate] = useState<string | null>(null);
  const [journalSearchInput, setJournalSearchInput] = useState("");
  const [journalQuery, setJournalQuery] = useState("");
  const [journalSavedOnly, setJournalSavedOnly] = useState(false);
  const [journalBefore, setJournalBefore] = useState<string | null>(null);
  const [journalHistory, setJournalHistory] = useState<Array<string | null>>([]);
  const [classifiedBucket] = useState<"all" | "important" | "unimportant">("all");
  const [overview, setOverview] = useState<ClassificationOverview | null>(null);
  const [agenda, setAgenda] = useState<CalendarAgenda | null>(null);
  const [scheduleDays, setScheduleDays] = useState("7");
  const [quickCalendarPrompt, setQuickCalendarPrompt] = useState("");
  const [quickCalendarLoading, setQuickCalendarLoading] = useState(false);
  const [quickCalendarResult, setQuickCalendarResult] = useState<CalendarQuickAddResponse | null>(null);
  const [selectedMailbox, setSelectedMailbox] = useState<string>(JARVIS_REVIEW_MAILBOX);
  const [mailSidebarOpen, setMailSidebarOpen] = useState(true);
  const [skipNextMailFetch, setSkipNextMailFetch] = useState(false);
  const [extraVisibleMailboxes, setExtraVisibleMailboxes] = useState<string[]>([]);
  const [mailboxAddOpen, setMailboxAddOpen] = useState(false);
  const [inboxLimit, setInboxLimit] = useState("");
  const [cleanupSummary, setCleanupSummary] = useState<CleanupSummary | null>(null);
  const [cleanupLimit, setCleanupLimit] = useState("");
  const [cleanupJob, setCleanupJob] = useState<CleanupJobStatus | null>(null);
  const [cleanupExpanded, setCleanupExpanded] = useState(false);
  const [calendarPreview, setCalendarPreview] = useState<CalendarPreview | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarCreateLoading, setCalendarCreateLoading] = useState(false);
  const [calendarCreateLink, setCalendarCreateLink] = useState<string | null>(null);
  const [classificationGuidance, setClassificationGuidance] = useState("");
  const [savedClassificationGuidance, setSavedClassificationGuidance] = useState("");
  const [classificationGuidanceUpdatedAt, setClassificationGuidanceUpdatedAt] = useState<string | null>(null);
  const [guidanceLoading, setGuidanceLoading] = useState(false);
  const [guidanceSaving, setGuidanceSaving] = useState(false);
  const [labelDraft, setLabelDraft] = useState<string[]>([]);
  const [labelSectionOpen, setLabelSectionOpen] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [planningPrompt, setPlanningPrompt] = useState("");
  const [planningDays, setPlanningDays] = useState("7");
  const [planningLoading, setPlanningLoading] = useState(false);
  const [planningResult, setPlanningResult] = useState<PlanningResponse | null>(null);
  const [planningJob, setPlanningJob] = useState<PlanningJobStatus | null>(null);
  const [planningCalendarLoading, setPlanningCalendarLoading] = useState(false);
  const [planningCalendarLink, setPlanningCalendarLink] = useState<string | null>(null);
  const [planningBulkCalendarLoading, setPlanningBulkCalendarLoading] = useState(false);
  const [planningBulkCalendarMessage, setPlanningBulkCalendarMessage] = useState("");
  const [googleAuthStatus, setGoogleAuthStatus] = useState<GoogleOAuthStatus | null>(null);
  const activePlanningJobIdRef = useRef<string | null>(null);
  const hasLoadedDashboardRef = useRef(false);
  const hasLoadedTasksRef = useRef(false);
  const hasLoadedJournalRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.innerWidth <= 768) {
      router.replace("/mobile");
    }
  }, [router]);

  useEffect(() => {
    void loadGoogleAuthStatus();
  }, []);

  const syncSelectedId = (nextEmails: Email[]) => {
    if (nextEmails.length > 0) {
      setSelectedId((prev) =>
        prev && nextEmails.some((email) => email.id === prev) ? prev : nextEmails[0].id
      );
      return;
    }

    setSelectedId(null);
  };

  const syncTaskDrafts = (nextTasks: DashboardTaskItem[]) => {
    setTaskDrafts(
      Object.fromEntries(
        nextTasks.map((task) => [task.id, buildTaskDraft(task)])
      )
    );
  };

  const loadGoogleAuthStatus = async () => {
    try {
      const response = await fetch(`${API_BASE}/google/oauth/status`);
      if (!response.ok) {
        return;
      }

      const data: GoogleOAuthStatus = await response.json();
      setGoogleAuthStatus(data);
    } catch {
      // Keep the dashboard usable even if the auth status probe fails.
    }
  };

  const loadLabels = async () => {
    setLabelsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/labels`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Labels request failed with status ${response.status}`)
        );
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
    currentMode: "dashboard" | "assistant" | "tasks" | "journal" | "mail" | "news" | "overview" | "schedule" | "planning" | "settings" | "health" = mode,
    mailboxOverride?: string,
    pageTokenOverride?: string | null,
    currentMailView: "ai" | "raw" = mailView
  ) => {
    if (
      currentMode === "planning" ||
      currentMode === "assistant" ||
      currentMode === "dashboard" ||
      currentMode === "tasks" ||
      currentMode === "journal" ||
      currentMode === "news"
      || currentMode === "settings" ||
      currentMode === "health"
    ) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const targetMailbox = mailboxOverride ?? selectedMailbox;
      const targetsAllMail = targetMailbox === ALL_MAILBOX;
      const targetsJarvisReview = targetMailbox === JARVIS_REVIEW_MAILBOX;
      if (currentMode === "overview" && targetsAllMail) {
        setOverview(null);
        setAgenda(null);
        setEmails([]);
        setCleanupSummary(null);
        setCleanupJob(null);
        setSelectedId(null);
        setError("All Mail is browse-only. Pick a specific mailbox for AI overview.");
        return;
      }
      if (currentMode === "mail" && currentMailView === "ai" && targetsAllMail) {
        setOverview(null);
        setAgenda(null);
        setCleanupSummary(null);
        setCleanupJob(null);
        setError("All Mail is browse-only. AI summaries are disabled for it.");
        setMailView("raw");
        return;
      }

      if (currentMode === "mail" && targetsJarvisReview) {
        const trimmed = inboxLimit.trim();
        const limit = trimmed ? Number(trimmed) : NaN;
        const requestLimit =
          trimmed && Number.isFinite(limit) && limit > 0
            ? Math.max(1, Math.floor(limit))
            : currentMailView === "raw"
              ? 50
              : 25;

        const endpoints =
          currentMailView === "ai"
            ? [
                `${API_BASE}/classify?limit=${requestLimit}&bucket=${classifiedBucket}&mailbox=${encodeURIComponent(IMPORTANT_LABEL)}`,
                `${API_BASE}/classify?limit=${requestLimit}&bucket=${classifiedBucket}&mailbox=${encodeURIComponent(UNIMPORTANT_LABEL)}`,
              ]
            : [
                `${API_BASE}/emails?limit=${requestLimit}&mailbox=${encodeURIComponent(IMPORTANT_LABEL)}`,
                `${API_BASE}/emails?limit=${requestLimit}&mailbox=${encodeURIComponent(UNIMPORTANT_LABEL)}`,
              ];

        const responses = await Promise.all(endpoints.map((endpoint) => fetch(endpoint)));
        for (const response of responses) {
          if (!response.ok) {
            throw new Error(
              await getErrorMessage(response, `Request failed with status ${response.status}`)
            );
          }
        }

        const payloads = await Promise.all(responses.map((response) => response.json()));
        const normalized =
          currentMailView === "ai"
            ? payloads
                .flatMap((items) => items as Array<{ email: Email; classification: Classification }>)
                .map((item) => ({
                  ...item.email,
                  classification: item.classification,
                }))
            : payloads.flatMap((items) => (items as EmailPageResponse).items);

        normalized.sort((a, b) => {
          const aTime = parseCalendarDate(a.date)?.getTime() ?? 0;
          const bTime = parseCalendarDate(b.date)?.getTime() ?? 0;
          return bTime - aTime;
        });

        const deduped = Array.from(
          new Map(normalized.map((email) => [email.id, email])).values()
        );

        setOverview(null);
        setAgenda(null);
        setEmails(deduped);
        setRawPageToken(null);
        setRawNextPageToken(null);
        setRawPageHistory([]);
        setCleanupSummary(null);
        setCleanupJob(null);
        syncSelectedId(deduped);
        return;
      }

      const trimmed = inboxLimit.trim();
      const limit = trimmed ? Number(trimmed) : NaN;
      const params = new URLSearchParams();
      if (currentMode === "schedule") {
        const days = Number(scheduleDays);
        params.set("days", String(Number.isFinite(days) && days > 0 ? Math.floor(days) : 7));
      } else if (currentMode === "overview") {
        params.set("mailbox", targetMailbox);
      } else if (currentMode === "mail" && currentMailView === "raw") {
        const pageSize =
          trimmed && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
        params.set("limit", String(pageSize));
        params.set("mailbox", targetMailbox);
        if (pageTokenOverride) {
          params.set("page_token", pageTokenOverride);
        }
      } else if (trimmed && Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(Math.floor(limit)));
        params.set("bucket", classifiedBucket);
        params.set("mailbox", targetMailbox);
      } else if (currentMode === "mail") {
        params.set("bucket", classifiedBucket);
        params.set("mailbox", targetMailbox);
      }
      const endpoint =
        currentMode === "mail" && currentMailView === "ai"
          ? "/classify"
          : currentMode === "overview"
            ? "/overview"
            : currentMode === "schedule"
              ? "/calendar/schedule"
            : "/emails";
      const queryString = params.toString() ? `?${params.toString()}` : "";
      const response = await fetch(`${API_BASE}${endpoint}${queryString}`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Request failed with status ${response.status}`)
        );
      }

      const data = await response.json();

      if (currentMode === "schedule") {
        const nextAgenda = data as CalendarAgenda;
        setAgenda(nextAgenda);
        setOverview(null);
        setEmails([]);
        setCleanupSummary(null);
        setCleanupJob(null);
        setSelectedId(nextAgenda.items[0]?.event_id || null);
        return;
      }

      if (currentMode === "overview") {
        setOverview(normalizeOverview(data as Partial<ClassificationOverview>));
        setAgenda(null);
        setEmails([]);
        setCleanupSummary(null);
        setCleanupJob(null);
        setSelectedId(null);
        return;
      }

      const normalized: Email[] =
        currentMode === "mail" && currentMailView === "ai"
          ? data.map((item: { email: Email; classification: Classification }) => ({
              ...item.email,
              classification: item.classification,
            }))
          : (data as EmailPageResponse).items;

      setOverview(null);
      setAgenda(null);
      setEmails(normalized);
      if (currentMode === "mail" && currentMailView === "raw") {
        setRawPageToken(pageTokenOverride ?? null);
        setRawNextPageToken((data as EmailPageResponse).next_page_token ?? null);
      } else {
        setRawPageToken(null);
        setRawNextPageToken(null);
        setRawPageHistory([]);
      }
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

  const loadDashboard = async () => {
    setLoading(true);
    setMovementLoading(true);
    setError("");

    try {
      const [dashboardResponse, healthResponse, movementResponse, workoutsResponse] = await Promise.all([
        fetch(`${API_BASE}/dashboard`),
        fetch(`${API_BASE}/health?days=3650`),
        fetch(`${API_BASE}/movement?days=14`),
        fetch(`${API_BASE}/workouts?days=90&limit=60`),
      ]);

      if (!dashboardResponse.ok) {
        throw new Error(
          await getErrorMessage(dashboardResponse, `Dashboard request failed with status ${dashboardResponse.status}`)
        );
      }

      const data: DashboardResponse = await dashboardResponse.json();
      setDashboard(data);
      hasLoadedDashboardRef.current = true;

      if (healthResponse.ok) {
        const healthData: HealthListResponse = await healthResponse.json();
        const nextHealthEntries = [...healthData.entries].sort((left, right) => right.date.localeCompare(left.date));
        setHealthEntries(nextHealthEntries);
        setSelectedHealthDate((current) => current ?? nextHealthEntries[0]?.date ?? data.health_summary?.today_entry?.date ?? null);
      } else {
        setHealthEntries([]);
      }

      if (movementResponse.ok) {
        const movementData: MovementListResponse = await movementResponse.json();
        setMovementEntries(movementData.entries);
      } else {
        setMovementEntries([]);
      }
      if (workoutsResponse.ok) {
        const workoutData: WorkoutListResponse = await workoutsResponse.json();
        setWorkoutEntries(workoutData.workouts);
      } else {
        setWorkoutEntries([]);
      }

      await loadTasks(false);
      setOverview(null);
      setAgenda(null);
      setEmails([]);
      setCleanupSummary(null);
      setCleanupJob(null);
      setSelectedId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load dashboard.";
      setError(message);
    } finally {
      setLoading(false);
      setMovementLoading(false);
    }
  };

  const loadTasks = async (includeCompleted = true, showLoading = false) => {
    if (showLoading) {
      setLoading(true);
    }
    setError("");

    try {
      const response = await fetch(
        `${API_BASE}/tasks?include_completed=${includeCompleted ? "true" : "false"}`
      );
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Tasks request failed with status ${response.status}`)
        );
      }

      const data: TaskListResponse = await response.json();
      setTasks(data.tasks);
      syncTaskDrafts(data.tasks);
      hasLoadedTasksRef.current = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load tasks.";
      setError(message);
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  };

  const loadJournal = async (options: JournalLoadOptions = {}) => {
    setLoading(true);
    setError("");

    try {
      const before = options.before ?? journalBefore;
      const nextQuery = options.query ?? journalQuery;
      const nextSavedOnly = options.savedOnly ?? journalSavedOnly;
      const params = new URLSearchParams();
      params.set("days", nextSavedOnly || nextQuery ? "20" : "14");
      if (before) {
        params.set("before", before);
      }
      if (nextSavedOnly) {
        params.set("saved_only", "true");
      }
      if (nextQuery.trim()) {
        params.set("query", nextQuery.trim());
      }

      const response = await fetch(`${API_BASE}/journal?${params.toString()}`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Journal request failed with status ${response.status}`)
        );
      }

      const data: JournalResponse = await response.json();
      setJournal(data);
      hasLoadedJournalRef.current = true;
      setJournalDrafts((current) => ({
        ...current,
        ...Object.fromEntries(
          data.entries.map((entry) => [
            entry.date,
            {
              journal_entry: entry.journal_entry || "",
              accomplishments: entry.accomplishments || "",
              gratitude_entry: entry.gratitude_entry || "",
              scripture_study: entry.scripture_study || "",
              spiritual_notes: entry.spiritual_notes || "",
              photo_data_url: entry.photo_data_url || null,
              calendar_items: entry.calendar_items || [],
            },
          ])
        ),
      }));
      setJournalBefore(before);
      setJournalQuery(nextQuery);
      setJournalSearchInput(nextQuery);
      setJournalSavedOnly(nextSavedOnly || Boolean(nextQuery.trim()));
      setJournalHistory(options.history ?? journalHistory);
      setOverview(null);
      setAgenda(null);
      setEmails([]);
      setCleanupSummary(null);
      setCleanupJob(null);
      setSelectedId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load journal.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const persistJournalDraft = async (entryDate: string, draft: JournalDraft) => {
    setJournalSavingDate(entryDate);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/journal/${entryDate}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Journal save failed with status ${response.status}`)
        );
      }

      const saved: JournalDayEntry = await response.json();
      setJournal((current) =>
        current
          ? {
              ...current,
              entries: current.entries.map((entry) =>
                entry.date === entryDate
                  ? {
                      ...entry,
                      journal_entry: saved.journal_entry,
                      accomplishments: saved.accomplishments,
                      gratitude_entry: saved.gratitude_entry,
                      scripture_study: saved.scripture_study,
                      spiritual_notes: saved.spiritual_notes,
                      study_links: saved.study_links,
                      photo_data_url: saved.photo_data_url,
                      calendar_items: saved.calendar_items,
                      updated_at: saved.updated_at,
                    }
                  : entry
              ),
            }
          : current
      );
      await loadJournal({
        before: journalBefore,
        query: journalQuery,
        savedOnly: journalSavedOnly,
        history: journalHistory,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save journal entry.";
      setError(message);
    } finally {
      setJournalSavingDate(null);
      setJournalEditingDate(null);
    }
  };

  const extractJournalCitations = async (entryDate: string, draft: JournalDraft) => {
    setJournalExtractingDate(entryDate);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/journal/${entryDate}/extract-citations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Citation extraction failed with status ${response.status}`)
        );
      }

      const saved: JournalDayEntry = await response.json();
      setJournal((current) =>
        current
          ? {
              ...current,
              entries: current.entries.map((entry) =>
                entry.date === entryDate
                  ? {
                      ...entry,
                      journal_entry: saved.journal_entry,
                      accomplishments: saved.accomplishments,
                      gratitude_entry: saved.gratitude_entry,
                      scripture_study: saved.scripture_study,
                      spiritual_notes: saved.spiritual_notes,
                      study_links: saved.study_links,
                      photo_data_url: saved.photo_data_url,
                      calendar_items: saved.calendar_items,
                      updated_at: saved.updated_at,
                    }
                  : entry
              ),
            }
          : current
      );
      await loadJournal({
        before: journalBefore,
        query: journalQuery,
        savedOnly: journalSavedOnly,
        history: journalHistory,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to extract citations.";
      setError(message);
    } finally {
      setJournalExtractingDate(null);
    }
  };

  const saveJournalEntry = async (entryDate: string) => {
    const draft = journalDrafts[entryDate];
    if (!draft) return;
    await persistJournalDraft(entryDate, draft);
  };

  const applyJournalSearch = async () => {
    const nextQuery = journalSearchInput.trim();
    await loadJournal({
      before: null,
      query: nextQuery,
      savedOnly: journalSavedOnly || Boolean(nextQuery),
      history: [],
    });
  };

  const clearJournalSearch = async () => {
    setJournalSearchInput("");
    await loadJournal({
      before: null,
      query: "",
      savedOnly: false,
      history: [],
    });
  };

  const toggleJournalArchiveMode = async (savedOnly: boolean) => {
    if (!savedOnly && journalSearchInput.trim()) {
      setJournalSearchInput("");
    }
    await loadJournal({
      before: null,
      query: savedOnly ? journalSearchInput.trim() : "",
      savedOnly,
      history: [],
    });
  };

  const loadOlderJournalEntries = async () => {
    if (!journal?.next_before) return;
    await loadJournal({
      before: journal.next_before,
      query: journalQuery,
      savedOnly: journalSavedOnly,
      history: [...journalHistory, journalBefore],
    });
  };

  const loadNewerJournalEntries = async () => {
    if (!journalHistory.length) return;
    const nextHistory = journalHistory.slice(0, -1);
    const previousBefore = journalHistory[journalHistory.length - 1] ?? null;
    await loadJournal({
      before: previousBefore,
      query: journalQuery,
      savedOnly: journalSavedOnly,
      history: nextHistory,
    });
  };

  const toggleJournalSection = (
    entryDate: string,
    key: keyof JournalSectionState
  ) => {
    setJournalSectionState((current) => ({
      ...current,
      [entryDate]: {
        dayOpen: current[entryDate]?.dayOpen ?? false,
        calendarOpen: current[entryDate]?.calendarOpen ?? false,
        articlesOpen: current[entryDate]?.articlesOpen ?? false,
        [key]: !(current[entryDate]?.[key] ?? false),
      },
    }));
  };

  const handleJournalPhotoChange = async (
    entryDate: string,
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const currentDraft = journalDrafts[entryDate];
    if (!currentDraft) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (!result) return;
      const nextDraft: JournalDraft = {
        ...currentDraft,
        photo_data_url: result,
      };
      setJournalDrafts((current) => {
        return {
          ...current,
          [entryDate]: nextDraft,
        };
      });
      await persistJournalDraft(entryDate, nextDraft);
    };
    reader.readAsDataURL(file);
  };

  const saveTask = async (
    taskId: string,
    payload: {
      title?: string;
      detail?: string;
      due_text?: string | null;
      priority?: "high" | "medium" | "low";
      completed?: boolean;
    }
  ) => {
    setTaskSavingId(taskId);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/tasks/${taskId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Task update failed with status ${response.status}`)
        );
      }

      const saved: DashboardTaskItem = await response.json();
      setTasks((current) => {
        const next = current.some((task) => task.id === saved.id)
          ? current.map((task) => (task.id === saved.id ? saved : task))
          : [...current, saved];
        return next;
      });
      setTaskDrafts((current) => ({
        ...current,
        [saved.id]: buildTaskDraft(saved),
      }));
      if (payload.completed === undefined) {
        setTaskEditingId(null);
      }
      if (mode === "dashboard") {
        await loadTasks(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update task.";
      setError(message);
    } finally {
      setTaskSavingId(null);
    }
  };

  const deleteTask = async (taskId: string) => {
    setTaskDeletingId(taskId);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/tasks/${taskId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Task delete failed with status ${response.status}`)
        );
      }

      setTasks((current) => current.filter((task) => task.id !== taskId));
      setTaskDrafts((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      if (taskEditingId === taskId) {
        setTaskEditingId(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete task.";
      setError(message);
    } finally {
      setTaskDeletingId(null);
    }
  };

  const createTaskFromCalendarItem = async (item: CalendarAgendaItem) => {
    setCalendarTaskLoadingId(item.event_id);
    setError("");
    try {
      const detailParts = [item.location, item.description].filter(Boolean);
      const response = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: item.title,
          detail: detailParts.join("\n\n"),
          due_text: item.start || null,
          priority: "medium",
          source: "calendar",
          related_event_id: item.event_id,
        }),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Task create failed with status ${response.status}`)
        );
      }

      const created: DashboardTaskItem = await response.json();
      setTasks((current) => {
        const next = current.some((task) => task.id === created.id)
          ? current.map((task) => (task.id === created.id ? created : task))
          : [created, ...current];
        return next;
      });
      setTaskDrafts((current) => ({
        ...current,
        [created.id]: buildTaskDraft(created),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create task from event.";
      setError(message);
    } finally {
      setCalendarTaskLoadingId(null);
    }
  };

  const createTaskItem = async (
    overrides?: {
      title: string;
      detail?: string;
      due_text?: string | null;
      priority?: "high" | "medium" | "low";
      onSuccess?: () => void;
    }
  ) => {
    const title = (overrides?.title ?? newTaskTitle).trim();
    if (!title) return;

    setTaskCreateLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          detail: overrides?.detail ?? newTaskDetail,
          due_text: overrides?.due_text ?? (newTaskDueAt || newTaskDueNote.trim() || null),
          priority: overrides?.priority ?? newTaskPriority,
        }),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Task create failed with status ${response.status}`)
        );
      }

      const created: DashboardTaskItem = await response.json();
      setTasks((current) => [created, ...current]);
      setTaskDrafts((current) => ({
        ...current,
        [created.id]: buildTaskDraft(created),
      }));
      if (overrides) {
        overrides.onSuccess?.();
      } else {
        setNewTaskTitle("");
        setNewTaskDetail("");
        setNewTaskDueAt("");
        setNewTaskDueNote("");
        setNewTaskPriority("medium");
      }
      if (mode === "dashboard") {
        await loadTasks(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create task.";
      setError(message);
    } finally {
      setTaskCreateLoading(false);
    }
  };

  const updateJournalCalendarItems = async (
    entryDate: string,
    updater: (items: CalendarAgendaItem[]) => CalendarAgendaItem[],
    persist = false
  ) => {
    const currentDraft = journalDrafts[entryDate];
    if (!currentDraft) return;

    const nextDraft: JournalDraft = {
      ...currentDraft,
      calendar_items: updater(currentDraft.calendar_items),
    };

    setJournalDrafts((current) => ({
      ...current,
      [entryDate]: nextDraft,
    }));

    if (persist) {
      await persistJournalDraft(entryDate, nextDraft);
    }
  };

  const fetchEmailsEffect = useEffectEvent(
    (
      currentMode: "dashboard" | "assistant" | "tasks" | "journal" | "mail" | "news" | "overview" | "schedule" | "planning" | "settings" | "health",
      mailboxName?: string,
      currentMailView: "ai" | "raw" = mailView
    ) => {
      if (currentMode === "dashboard" || currentMode === "news") {
        if (!hasLoadedDashboardRef.current) {
          void loadDashboard();
        }
        return;
      }
      if (currentMode === "settings") {
        void loadLabels();
        void loadClassificationGuidance();
        return;
      }
      if (currentMode === "health") {
        if (!hasLoadedDashboardRef.current) {
          void loadDashboard();
        }
        return;
      }
      if (currentMode === "tasks") {
        if (!hasLoadedTasksRef.current) {
          void loadTasks(true, true);
        }
        return;
      }
      if (currentMode === "journal") {
        if (!hasLoadedJournalRef.current) {
          void loadJournal();
        }
        return;
      }
      if (currentMode === "planning" || (currentMode === "schedule" && scheduleWorkspaceTab === "planner")) {
        return;
      }
      if (currentMode === "overview" || (currentMode === "mail" && mailWorkspaceTab === "insights")) {
        void loadEmails("overview", mailboxName);
        return;
      }
      if (currentMode === "mail" && skipNextMailFetch) {
        setSkipNextMailFetch(false);
        return;
      }
      if (currentMode === "schedule") {
        void loadEmails("schedule", mailboxName, undefined, currentMailView);
        return;
      }
      void loadEmails(currentMode, mailboxName, undefined, currentMailView);
    }
  );

  const refreshDashboardMovementEffect = useEffectEvent(async () => {
    try {
      const [dashboardResponse, movementResponse] = await Promise.all([
        fetch(`${API_BASE}/dashboard`, { cache: "no-store" }),
        fetch(`${API_BASE}/movement?days=14`, { cache: "no-store" }),
      ]);

      if (dashboardResponse.ok) {
        const dashboardData: DashboardResponse = await dashboardResponse.json();
        setDashboard(dashboardData);
        hasLoadedDashboardRef.current = true;
      }

      if (movementResponse.ok) {
        const movementData: MovementListResponse = await movementResponse.json();
        setMovementEntries(movementData.entries);
      }
    } catch {
      // Keep background refresh quiet so transient failures do not disrupt the dashboard.
    }
  });

  const replaceOrRemoveEmail = (updatedEmail: Email) => {
    setEmails((currentEmails) => {
      const nextEmails = currentEmails
        .map((email) => (email.id === updatedEmail.id ? { ...email, ...updatedEmail } : email))
        .filter((email) =>
          mode === "mail" && mailView === "raw" ? emailMatchesMailbox(email, selectedMailbox) : true
        );
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
        throw new Error(
          await getErrorMessage(response, `Email update failed with status ${response.status}`)
        );
      }

      const data: EmailUpdateResponse = await response.json();
      replaceOrRemoveEmail(data.email);
      await loadLabels();
      if (mode === "mail" && mailView === "ai") {
        await loadEmails("mail", selectedMailbox, undefined, "ai");
      }
      if (isMailInsightsMode) {
        await loadEmails("overview");
      }
      if (isScheduleAgendaMode) {
        await loadEmails("schedule");
      }
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
        throw new Error(
          await getErrorMessage(response, `Cleanup request failed with status ${response.status}`)
        );
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
    const handledEmailId = selectedEmail.id;

    try {
      const response = await fetch(`${API_BASE}/emails/${handledEmailId}/handle`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Handle request failed with status ${response.status}`)
        );
      }

      setEmails((currentEmails) => {
        const nextEmails = currentEmails.filter((email) => email.id !== handledEmailId);
        syncSelectedId(nextEmails);
        return nextEmails;
      });
      await loadLabels();

      if (mode === "mail") {
        await loadEmails("mail", selectedMailbox, undefined, mailView);
      } else if (dashboard) {
        await loadDashboard();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to mark email handled.";
      setError(message);
    } finally {
      setHandleLoading(false);
    }
  };

  const loadCalendarPreview = async (messageId: string) => {
    setCalendarLoading(true);
    try {
      const response = await fetch(`${API_BASE}/calendar/preview/${messageId}`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Calendar preview failed with status ${response.status}`)
        );
      }

      const data: CalendarPreview = await response.json();
      setCalendarPreview(data.relevant ? data : null);
    } catch {
      setCalendarPreview(null);
    } finally {
      setCalendarLoading(false);
    }
  };

  const createCalendarEvent = async () => {
    if (!selectedEmail) return;

    setCalendarCreateLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/calendar/create/${selectedEmail.id}`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Calendar create failed with status ${response.status}`)
        );
      }

      const data: CalendarCreateResponse = await response.json();
      setCalendarPreview(data.preview.relevant ? data.preview : null);
      setCalendarCreateLink(data.html_link || null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create calendar event.";
      setError(message);
    } finally {
      setCalendarCreateLoading(false);
    }
  };

  const createQuickCalendarEvent = async () => {
    const description = quickCalendarPrompt.trim();
    if (!description) return;

    setQuickCalendarLoading(true);
    setError("");
    setQuickCalendarResult(null);

    try {
      const response = await fetch(`${API_BASE}/calendar/quick-add`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ description }),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Quick add failed with status ${response.status}`)
        );
      }

      const data: CalendarQuickAddResponse = await response.json();
      setQuickCalendarResult(data);
      setQuickCalendarPrompt("");
      await loadEmails("schedule");
      if (data.event_id) {
        setSelectedId(data.event_id);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add the event to Calendar.";
      setError(message);
    } finally {
      setQuickCalendarLoading(false);
    }
  };

  const generatePlan = async () => {
    setPlanningLoading(true);
    setError("");
    setPlanningCalendarLink(null);
    setPlanningBulkCalendarMessage("");
    setPlanningResult(null);

    try {
      const days = Number(planningDays);
      const requestBody = JSON.stringify({
        goals: planningPrompt,
        days: Number.isFinite(days) && days > 0 ? Math.floor(days) : 7,
      });

      let response: Response | null = null;
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(`${API_BASE}/planning/plan`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: requestBody,
          });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt === 0) {
            await new Promise((resolve) => window.setTimeout(resolve, 400));
          }
        }
      }

      if (!response) {
        throw lastError instanceof Error
          ? lastError
          : new Error("Planning request could not reach the backend.");
      }

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Planning request failed with status ${response.status}`)
        );
      }

      const data: PlanningJobStartResponse = await response.json();
      activePlanningJobIdRef.current = data.job_id;
      setPlanningJob({
        job_id: data.job_id,
        status: data.status,
        goals: planningPrompt,
        days: Number.isFinite(days) && days > 0 ? Math.floor(days) : 7,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate plan.";
      setError(message);
      setPlanningLoading(false);
    }
  };

  const createPlanningCalendarEvent = async () => {
    if (!selectedPlanningItem) return;

    setPlanningCalendarLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/planning/calendar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ item: selectedPlanningItem }),
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(
            response,
            `Planning calendar create failed with status ${response.status}`
          )
        );
      }

      const data: PlanningCalendarCreateResponse = await response.json();
      setPlanningCalendarLink(data.html_link || null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add the planning block to Calendar.";
      setError(message);
    } finally {
      setPlanningCalendarLoading(false);
    }
  };

  const createPlanningCalendarEvents = async (items: PlanningItem[], successLabel: string) => {
    if (items.length === 0) return;

    setPlanningBulkCalendarLoading(true);
    setPlanningBulkCalendarMessage("");
    setError("");

    try {
      const response = await fetch(`${API_BASE}/planning/calendar/bulk`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items }),
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(
            response,
            `Planning calendar bulk create failed with status ${response.status}`
          )
        );
      }

      const data: PlanningCalendarBulkCreateResponse = await response.json();
      setPlanningBulkCalendarMessage(
        `${successLabel}: added ${data.created_count} of ${items.length} block${items.length === 1 ? "" : "s"} to Google Calendar.`
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add planning blocks to Calendar.";
      setError(message);
    } finally {
      setPlanningBulkCalendarLoading(false);
    }
  };

  const openOverviewEmail = async (messageId: string) => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/emails/${messageId}/classified`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Email lookup failed with status ${response.status}`)
        );
      }

      const data: ClassifiedEmailResponse = await response.json();
      const email: Email = {
        ...data.email,
        classification: data.classification,
      };

      setSkipNextMailFetch(true);
      setSelectedMailbox(ALL_MAILBOX);
      setMailWorkspaceTab("triage");
      setMode("mail");
      setMailView("ai");
      setOverview(null);
      setAgenda(null);
      setCleanupSummary(null);
      setCleanupJob(null);
      setEmails([email]);
      setSelectedId(email.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to open the selected email.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const loadClassificationGuidance = async () => {
    setGuidanceLoading(true);
    try {
      const response = await fetch(`${API_BASE}/classification-guidance`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(
            response,
            `Classification guidance failed with status ${response.status}`
          )
        );
      }

      const data: ClassificationGuidance = await response.json();
      setClassificationGuidance(data.text || "");
      setSavedClassificationGuidance(data.text || "");
      setClassificationGuidanceUpdatedAt(data.updated_at || null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load classification guidance.";
      setError(message);
    } finally {
      setGuidanceLoading(false);
    }
  };

  const saveClassificationGuidance = async () => {
    setGuidanceSaving(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/classification-guidance`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: classificationGuidance }),
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(
            response,
            `Classification guidance save failed with status ${response.status}`
          )
        );
      }

      const data: ClassificationGuidance = await response.json();
      setClassificationGuidance(data.text || "");
      setSavedClassificationGuidance(data.text || "");
      setClassificationGuidanceUpdatedAt(data.updated_at || null);

      if (mode === "mail" && mailView === "ai") {
        await loadEmails("mail", selectedMailbox, undefined, "ai");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save classification guidance.";
      setError(message);
    } finally {
      setGuidanceSaving(false);
    }
  };

  useEffect(() => {
    void loadLabels();
    void loadClassificationGuidance();
  }, []);

  useEffect(() => {
    fetchEmailsEffect(mode, selectedMailbox, mailView);
  }, [mode, selectedMailbox, classifiedBucket, scheduleDays, mailView, mailWorkspaceTab, scheduleWorkspaceTab]);

  useEffect(() => {
    if (mode !== "dashboard") {
      return;
    }

    const poll = window.setInterval(() => {
      void refreshDashboardMovementEffect();
    }, LIVE_MOVEMENT_REFRESH_MS);

    return () => window.clearInterval(poll);
  }, [mode]);

  useEffect(() => {
    if (mode !== "mail" || mailView !== "raw") return;
    setRawPageToken(null);
    setRawNextPageToken(null);
    setRawPageHistory([]);
  }, [mode, selectedMailbox, mailView]);

  useEffect(() => {
    if (mode === "overview") {
      setMailWorkspaceTab("insights");
      setMode("mail");
    } else if (mode === "planning") {
      setScheduleWorkspaceTab("planner");
      setMode("schedule");
    }
  }, [mode]);

  useEffect(() => {
    if (!cleanupJob || (cleanupJob.status !== "queued" && cleanupJob.status !== "running")) {
      return;
    }

    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/cleanup/jobs/${cleanupJob.job_id}`);
        if (!response.ok) {
          throw new Error(
            await getErrorMessage(
              response,
              `Cleanup status failed with status ${response.status}`
            )
          );
        }

        const data: CleanupJobStatus = await response.json();
        setCleanupJob(data);

        if (data.status === "completed" && data.result) {
          const normalized = normalizeCleanupItems(data.result);
          setMailWorkspaceTab("triage");
          setMode("mail");
          setMailView("ai");
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

  useEffect(() => {
    if (!planningJob || (planningJob.status !== "queued" && planningJob.status !== "running")) {
      return;
    }

    const poll = window.setInterval(async () => {
      try {
        const expectedJobId = planningJob.job_id;
        const response = await fetch(`${API_BASE}/planning/jobs/${expectedJobId}`);
        if (!response.ok) {
          throw new Error(
            await getErrorMessage(
              response,
              `Planning status failed with status ${response.status}`
            )
          );
        }

        const data: PlanningJobStatus = await response.json();
        if (activePlanningJobIdRef.current !== data.job_id || data.job_id !== expectedJobId) {
          return;
        }
        setPlanningJob(data);

        if (data.status === "completed" && data.result) {
          setPlanningResult(data.result);
          setSelectedId(data.result.items[0]?.id || null);
          setPlanningLoading(false);
        }

        if (data.status === "failed") {
          setError(data.error || "Planning failed.");
          setPlanningLoading(false);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch planning status.";
        setError(message);
        setPlanningLoading(false);
      }
    }, 1200);

    return () => window.clearInterval(poll);
  }, [planningJob]);

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

  const activeTasks = useMemo(
    () => tasks.filter((task) => !task.completed),
    [tasks]
  );
  const completedTasks = useMemo(
    () => tasks.filter((task) => task.completed),
    [tasks]
  );
  const filteredActiveTasks = useMemo(
    () => activeTasks.filter((task) => taskMatchesWindow(task, taskWindow)),
    [activeTasks, taskWindow]
  );
  const filteredCompletedTasks = useMemo(
    () => completedTasks.filter((task) => taskMatchesWindow(task, taskWindow)),
    [completedTasks, taskWindow]
  );

  const isMailWorkspaceMode = mode === "mail" || mode === "overview";
  const isMailInsightsMode = mode === "overview" || (mode === "mail" && mailWorkspaceTab === "insights");
  const isMailTriageMode = mode === "mail" && mailWorkspaceTab === "triage";
  const isScheduleWorkspaceMode = mode === "schedule" || mode === "planning";
  const isScheduleAgendaMode = mode === "schedule" && scheduleWorkspaceTab === "agenda";
  const isSchedulePlannerMode = mode === "planning" || (mode === "schedule" && scheduleWorkspaceTab === "planner");
  const isMailMode = mode === "mail";
  const isAiMailView = isMailTriageMode && mailView === "ai";
  const isRawMailView = isMailTriageMode && mailView === "raw";
  const groupedRawEmails = useMemo(() => groupEmailsByThread(filteredEmails), [filteredEmails]);
  const displayEmails = isRawMailView ? groupedRawEmails.map((item) => item.email) : filteredEmails;
  const threadCountByEmailId = useMemo(
    () =>
      new Map(groupedRawEmails.map((item) => [item.email.id, item.count])),
    [groupedRawEmails]
  );

  const selectedEmail =
    displayEmails.find((email) => email.id === selectedId) ||
    displayEmails[0] ||
    null;
  const canMarkHandled =
    !!selectedEmail &&
    !isMailInsightsMode &&
    !isScheduleWorkspaceMode &&
    !emailHasLabel(selectedEmail, "Reviewed");
  const canMarkImportant = !!selectedEmail && !hasImportantLabel(selectedEmail.labels);
  const canMarkUnimportant = !!selectedEmail && !hasUnimportantLabel(selectedEmail.labels);
  const isUnread = emailHasLabel(selectedEmail, "UNREAD");
  const isInInbox = emailHasLabel(selectedEmail, "INBOX");

  const mailboxLabels = useMemo(
    () => [
      {
        id: JARVIS_REVIEW_MAILBOX,
        name: JARVIS_REVIEW_MAILBOX,
        type: "system" as const,
        messages_total:
          (labels.find((label) => label.name === IMPORTANT_LABEL)?.messages_total ?? 0) +
          (labels.find((label) => label.name === UNIMPORTANT_LABEL)?.messages_total ?? 0),
        messages_unread:
          (labels.find((label) => label.name === IMPORTANT_LABEL)?.messages_unread ?? 0) +
          (labels.find((label) => label.name === UNIMPORTANT_LABEL)?.messages_unread ?? 0),
      },
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
  const visibleMailboxLabels = useMemo(
    () =>
      mailboxLabels.filter(
        (label) =>
          DEFAULT_VISIBLE_MAILBOXES.has(label.name) ||
          extraVisibleMailboxes.includes(label.name) ||
          label.name === selectedMailbox
      ),
    [extraVisibleMailboxes, mailboxLabels, selectedMailbox]
  );
  const hiddenMailboxLabels = useMemo(
    () =>
      mailboxLabels.filter(
        (label) =>
          !DEFAULT_VISIBLE_MAILBOXES.has(label.name) &&
          !extraVisibleMailboxes.includes(label.name) &&
          label.name !== selectedMailbox
      ),
    [extraVisibleMailboxes, mailboxLabels, selectedMailbox]
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
  }, [selectedEmail, editableLabelNames]);

  useEffect(() => {
    setCalendarCreateLink(null);
    if (!selectedEmail || isMailInsightsMode) {
      setCalendarPreview(null);
      return;
    }
  }, [selectedEmail, mode]);

  useEffect(() => {
    setPlanningCalendarLink(null);
  }, [selectedId, planningResult]);

  useEffect(() => {
    setPlanningBulkCalendarMessage("");
  }, [planningResult]);

  useEffect(() => {
    if (!isScheduleAgendaMode) {
      setQuickCalendarResult(null);
    }
  }, [isScheduleAgendaMode]);

  const selectedMailboxLabel =
    mailboxLabels.find((label) => label.name === selectedMailbox) ||
    visibleMailboxLabels.find((label) => label.name === ALL_MAILBOX) ||
    null;
  const agendaDayGroups = useMemo(
    () => buildAgendaDayGroups(agenda?.items || []),
    [agenda?.items]
  );
  const selectedAgendaEvent =
    agenda?.items.find((item) => item.event_id === selectedId) || agenda?.items[0] || null;
  const planningDayGroups = useMemo(
    () => buildPlanningDayGroups(planningResult?.items || []),
    [planningResult?.items]
  );
  const selectedPlanningItem =
    planningResult?.items.find((item) => item.id === selectedId) || planningResult?.items[0] || null;
  const selectedPlanningDayItems = useMemo(
    () =>
      selectedPlanningItem
        ? (planningResult?.items || []).filter(
            (item) => item.day_label === selectedPlanningItem.day_label
          )
        : [],
    [planningResult?.items, selectedPlanningItem]
  );
  const highPriorityPlanningItems = useMemo(
    () => (planningResult?.items || []).filter((item) => item.priority === "high"),
    [planningResult?.items]
  );

  const cleanupProgressPercent =
    cleanupJob && cleanupJob.total > 0
      ? Math.min(100, Math.round((cleanupJob.processed / cleanupJob.total) * 100))
      : 0;
  const rawHasPreviousPage = rawPageHistory.length > 0;
  const selectedThreadCount = selectedEmail ? threadCountByEmailId.get(selectedEmail.id) ?? 1 : 1;
  const guidanceDirty = classificationGuidance !== savedClassificationGuidance;

  const setTopLevelMode = (
    nextMode: "dashboard" | "assistant" | "tasks" | "journal" | "mail" | "news" | "overview" | "schedule" | "planning" | "settings" | "health"
  ) => {
    if (nextMode === "overview") {
      setMailWorkspaceTab("insights");
      setMode("mail");
      setError("");
      setMoreMenuOpen(false);
      if (selectedMailbox === ALL_MAILBOX || selectedMailbox === JARVIS_REVIEW_MAILBOX) {
        setSelectedMailbox(IMPORTANT_LABEL);
      }
      return;
    }

    if (nextMode === "planning") {
      setScheduleWorkspaceTab("planner");
      setMode("schedule");
      setError("");
      setMoreMenuOpen(false);
      return;
    }

    if (nextMode === "mail") {
      setMailWorkspaceTab("triage");
    }

    if (nextMode === "schedule") {
      setScheduleWorkspaceTab("agenda");
    }

    setError("");
    setMode(nextMode);
    setMoreMenuOpen(false);
  };

  const correctClassification = async (targetLabel: "important" | "unimportant") => {
    if (!selectedEmail) return;

    const addLabelName = targetLabel === "important" ? IMPORTANT_LABEL : UNIMPORTANT_LABEL;
    const removeLabelNames =
      targetLabel === "important"
        ? [UNIMPORTANT_LABEL, ...LEGACY_UNIMPORTANT_LABELS]
        : [IMPORTANT_LABEL, ...LEGACY_IMPORTANT_LABELS];

    await updateSelectedEmail({
      add_label_names: [addLabelName],
      remove_label_names: removeLabelNames,
    });
  };

  const renderTaskCard = (task: DashboardTaskItem, compact = false) => {
    const draft = taskDrafts[task.id] || buildTaskDraft(task);
    const isEditing = taskEditingId === task.id;

    return (
      <div
        key={task.id}
        className={`rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] ${
          compact ? "p-4" : "p-5"
        }`}
      >
        {isEditing ? (
          <div className="space-y-3">
            <Input
              value={draft.title}
              onChange={(e) =>
                setTaskDrafts((current) => ({
                  ...current,
                  [task.id]: { ...draft, title: e.target.value },
                }))
              }
              className="rounded-xl"
              placeholder="Task title"
            />
            <textarea
              value={draft.detail}
              onChange={(e) =>
                setTaskDrafts((current) => ({
                  ...current,
                  [task.id]: { ...draft, detail: e.target.value },
                }))
              }
              className="min-h-[96px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
              placeholder="Task details"
            />
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_120px]">
              <Input
                type="datetime-local"
                value={draft.due_at}
                onChange={(e) =>
                  setTaskDrafts((current) => ({
                    ...current,
                    [task.id]: { ...draft, due_at: e.target.value },
                  }))
                }
                className="rounded-xl"
              />
              <Input
                value={draft.due_note}
                onChange={(e) =>
                  setTaskDrafts((current) => ({
                    ...current,
                    [task.id]: { ...draft, due_note: e.target.value },
                  }))
                }
                className="rounded-xl"
                placeholder="Or a quick due note"
              />
              <select
                value={draft.priority}
                onChange={(e) =>
                  setTaskDrafts((current) => ({
                    ...current,
                    [task.id]: {
                      ...draft,
                      priority: e.target.value as "high" | "medium" | "low",
                    },
                  }))
                }
                className="rounded-xl border border-white/8 bg-[rgba(20,22,37,0.88)] px-3 text-sm text-slate-100 outline-none"
              >
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="rounded-2xl"
                onClick={() =>
                    void saveTask(task.id, {
                      title: draft.title,
                      detail: draft.detail,
                      due_text: getTaskDraftDueText(draft),
                      priority: draft.priority,
                    })
                }
                disabled={taskSavingId === task.id}
              >
                {taskSavingId === task.id ? "Saving..." : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-2xl"
                onClick={() => {
                  setTaskDrafts((current) => ({
                    ...current,
                    [task.id]: buildTaskDraft(task),
                  }));
                  setTaskEditingId(null);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-2xl border-rose-400/30 text-rose-200 hover:bg-rose-500/10"
                onClick={() => void deleteTask(task.id)}
                disabled={taskDeletingId === task.id}
              >
                {taskDeletingId === task.id ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-semibold ${task.completed ? "text-slate-400 line-through" : "text-slate-100"}`}>
                  {task.title}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                    {formatTaskSourceLabel(task.source)}
                  </span>
                  {task.due_text ? (
                    <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-2.5 py-1 text-cyan-100">
                      {formatDashboardTaskDueText(task) || task.due_text}
                    </span>
                  ) : null}
                  {task.completed ? (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-400">
                      Completed
                    </span>
                  ) : null}
                </div>
                {task.detail ? (
                  <div className={`mt-2 text-sm ${compact ? "line-clamp-2 text-slate-400" : "text-slate-300"}`}>
                    {task.detail}
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-slate-500">
                    {task.source === "calendar"
                      ? "Calendar-derived task"
                      : task.source === "mail"
                        ? "Pulled forward from mail"
                        : "Ready to work"}
                  </div>
                )}
              </div>
              <Badge
                variant={
                  task.priority === "high"
                    ? "default"
                    : task.priority === "medium"
                      ? "secondary"
                      : "outline"
                }
                className="rounded-xl"
              >
                {task.priority}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="rounded-2xl"
                variant={task.completed ? "outline" : "default"}
                onClick={() => void saveTask(task.id, { completed: !task.completed })}
                disabled={taskSavingId === task.id}
              >
                {task.completed ? "Reopen" : "Complete"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-2xl"
                onClick={() => setTaskEditingId(task.id)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-2xl border-rose-400/30 text-rose-200 hover:bg-rose-500/10"
                onClick={() => void deleteTask(task.id)}
                disabled={taskDeletingId === task.id}
              >
                {taskDeletingId === task.id ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const utilitiesPanel = (
    <Card className="rounded-[1.5rem] border border-white/8 bg-[rgba(20,22,37,0.6)] shadow-[0_12px_32px_rgba(6,7,14,0.2)] backdrop-blur-xl">
      <CardHeader className="px-5 py-4">
        <button
          type="button"
          onClick={() => setCleanupExpanded((current) => !current)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              Utilities
            </CardTitle>
            <p className="mt-1 text-xs text-slate-400">
              Inbox maintenance and cleanup tools.
            </p>
          </div>
          <div className="flex items-center gap-2 text-slate-400">
            {cleanupJob && (cleanupJob.status === "queued" || cleanupJob.status === "running") ? (
              <Badge variant="secondary" className="rounded-xl">
                Cleanup running
              </Badge>
            ) : null}
            {cleanupExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </div>
        </button>
      </CardHeader>

      {cleanupExpanded ? (
        <CardContent className="space-y-4 px-5 pb-5 pt-0">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="max-w-2xl text-sm leading-6 text-slate-300">
              Clean up the whole inbox with one click. Every processed message is labeled as Jarvis Important or Jarvis Unimportant and then archived so the inbox can reach zero. This version never deletes messages.
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

          {cleanupJob ? (
            <>
              <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
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

                <div className="h-2 overflow-hidden rounded-full bg-white/8">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,#bd93f9,#8be9fd)] transition-all"
                    style={{ width: `${cleanupProgressPercent}%` }}
                  />
                </div>

                <div className="mt-3 flex flex-col gap-1 text-sm text-slate-300">
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
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Processed
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.total_processed}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Archived
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.archived}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Labeled only
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.labeled_only}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">Kept</div>
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
                      Cleanup uses only Jarvis Important and Jarvis Unimportant
                    </Badge>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );

  return (
    <div className="min-h-screen p-4 text-slate-100 md:p-6">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <div className="relative z-20 overflow-visible rounded-[2rem] border border-white/8 bg-[linear-gradient(135deg,rgba(34,36,58,0.94),rgba(17,19,34,0.92))] px-6 py-6 shadow-[0_24px_80px_rgba(6,7,14,0.48)] backdrop-blur-xl">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(189,147,249,0.2),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(139,233,253,0.16),transparent_30%)]" />
          <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center rounded-full border border-fuchsia-400/20 bg-fuchsia-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.24em] text-fuchsia-200">
              Dracula Control Center
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white md:text-4xl">Jarvis</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              {mode === "dashboard"
                ? "Start here for a centralized briefing with your day, important mail, current headlines, and a focused task list."
                : mode === "assistant"
                ? "Ask Jarvis questions in plain English and get grounded answers using your dashboard, tasks, journal, health, movement, calendar, and important mail context."
                : mode === "tasks"
                ? "Review, edit, complete, and add tasks from one place."
                : mode === "journal"
                ? "Keep a lightweight daily journal with calendar-based summaries, a world event snapshot, and room for your own reflection."
                : mode === "news"
                ? "Review the exact headlines feeding the dashboard so you can open the source coverage directly."
                : mode === "health"
                ? "Track your synced Apple Health data with a deeper view of daily history, heart metrics, movement, and other expanded measurements."
                : mode === "settings"
                ? "Manage Jarvis classification guidance and inbox cleanup tools away from the main review workspace."
                : isSchedulePlannerMode
                ? "Turn your goals for the day or week into a realistic schedule that fits around your calendar."
                : isScheduleAgendaMode
                ? "Review what is already on your calendar, then add events or turn them into tasks."
                : isMailInsightsMode
                ? "See saved AI trends and action signals for one mailbox without rerunning triage every time."
                : "Work through your inbox from one Mail tab, then switch between AI triage, raw Gmail controls, and saved insights whenever you need them."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={mode === "dashboard" ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setTopLevelMode("dashboard")}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              Dashboard
            </Button>

            <Button
              variant={mode === "assistant" ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setTopLevelMode("assistant")}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              Ask
            </Button>

            <Button
              variant={isMailWorkspaceMode ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setTopLevelMode("mail")}
            >
              <Inbox className="mr-2 h-4 w-4" />
              Mail
            </Button>

            <Button
              variant={mode === "journal" ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setTopLevelMode("journal")}
            >
              <BookOpen className="mr-2 h-4 w-4" />
              Journal
            </Button>

            <Button
              variant={mode === "tasks" ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setTopLevelMode("tasks")}
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              Tasks
            </Button>

            <Button
              variant={mode === "health" ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setTopLevelMode("health")}
            >
              <Activity className="mr-2 h-4 w-4" />
              Health
            </Button>

            <Button
              variant={isScheduleWorkspaceMode ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setTopLevelMode("schedule")}
            >
              <CalendarDays className="mr-2 h-4 w-4" />
              Schedule
            </Button>

            <div className="relative">
              <Button
                variant={(mode === "news" || mode === "settings") ? "default" : "outline"}
                className="rounded-2xl"
                onClick={() => setMoreMenuOpen((current) => !current)}
              >
                More
                <ChevronDown className={`ml-2 h-4 w-4 transition ${moreMenuOpen ? "rotate-180" : ""}`} />
              </Button>
              {moreMenuOpen ? (
                <div className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-56 rounded-[1.4rem] border border-white/8 bg-[rgba(17,19,34,0.96)] p-2 shadow-[0_18px_48px_rgba(6,7,14,0.42)] backdrop-blur-xl">
                  <div className="grid gap-1">
                    <Button
                      asChild
                      variant="ghost"
                      className="justify-start rounded-xl"
                    >
                      <Link href="/language" onClick={() => setMoreMenuOpen(false)}>
                        <Languages className="mr-2 h-4 w-4" />
                        Language
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      className="justify-start rounded-xl"
                      onClick={() => setTopLevelMode("news")}
                    >
                      <Newspaper className="mr-2 h-4 w-4" />
                      News
                    </Button>
                    <Button
                      variant="ghost"
                      className="justify-start rounded-xl"
                      onClick={() => setTopLevelMode("settings")}
                    >
                      <SlidersHorizontal className="mr-2 h-4 w-4" />
                      Settings
                    </Button>
                    <Button
                      asChild
                      variant="ghost"
                      className="justify-start rounded-xl"
                    >
                      <Link href="/mobile" onClick={() => setMoreMenuOpen(false)}>
                        iPhone view
                      </Link>
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>

            <Button
              className="rounded-2xl px-3"
              variant="outline"
              onClick={() => {
                setRawPageToken(null);
                setRawNextPageToken(null);
                setRawPageHistory([]);
                void loadLabels();
                if (mode === "dashboard") {
                  void loadDashboard();
                  return;
                }
                if (mode === "tasks") {
                  void loadTasks(true, true);
                  return;
                }
                if (mode === "journal") {
                  void loadJournal();
                  return;
                }
                if (isSchedulePlannerMode) {
                  if (planningPrompt.trim()) {
                    void generatePlan();
                  }
                  return;
                }
                if (mode === "news") {
                  void loadDashboard();
                  return;
                }
                if (mode === "settings") {
                  void loadLabels();
                  void loadClassificationGuidance();
                  return;
                }
                if (mode === "health") {
                  void loadDashboard();
                  return;
                }
                if (mode === "assistant") {
                  return;
                }
                if (isMailInsightsMode) {
                  void loadEmails("overview", selectedMailbox);
                  return;
                }
                if (isScheduleAgendaMode) {
                  void loadEmails("schedule", selectedMailbox);
                  return;
                }
                void loadEmails(mode, selectedMailbox);
              }}
              disabled={loading || cleanupLoading || emailActionLoading || planningLoading}
              aria-label="Refresh current page"
              title="Refresh current page"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading || labelsLoading || planningLoading ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>
        </div>

        {mode === "dashboard" ? (
          <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-6">
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Sparkles className="h-5 w-5" />
                    Daily briefing
                  </CardTitle>
                  <p className="text-sm leading-6 text-slate-300">
                    {dashboard?.date_label || "Today"} at a glance, generated from your calendar, important mail, and current headlines.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {error ? (
                    <div className="flex items-start gap-3 rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
                      <AlertCircle className="mt-0.5 h-4 w-4" />
                      <div>{error}</div>
                    </div>
                  ) : null}
                  {(googleAuthStatus ? !googleAuthStatus.authorized : false) || isGoogleAuthIssue(error) ? (
                    <div className="flex flex-col gap-3 rounded-[1.4rem] border border-cyan-300/15 bg-cyan-400/10 p-4 text-sm text-cyan-50 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium text-white">
                          <ShieldCheck className="h-4 w-4 text-cyan-200" />
                          Google connection
                        </div>
                        <div className="mt-1 text-sm leading-6 text-cyan-100/85">
                          {googleAuthStatus?.authorized
                            ? "Google is connected, but the latest Gmail or Calendar request looks like it needs re-authorization."
                            : googleAuthStatus?.instructions || "Connect Google so this running container can reach Gmail and Calendar."}
                        </div>
                      </div>
                      <Button
                        asChild
                        variant="outline"
                        className="rounded-2xl border-cyan-200/30 bg-white/5 text-cyan-50 hover:bg-white/10"
                      >
                        <a href={googleAuthStatus?.start_path || `${API_BASE}/google/oauth/start`}>
                          Connect Google
                        </a>
                      </Button>
                    </div>
                  ) : null}
                  <div className="rounded-[1.6rem] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(56,189,248,0.16),rgba(35,37,58,0.92))] p-5">
                    <div className="text-xs uppercase tracking-[0.22em] text-cyan-100/80">
                      AI overview
                    </div>
                    <div className="mt-3 text-sm leading-7 text-slate-100">
                      {dashboard?.overview || (loading ? "Building your dashboard..." : "Refresh to generate your daily overview.")}
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedMailbox(IMPORTANT_LABEL);
                        setMailWorkspaceTab("triage");
                        setMailView("ai");
                        setMode("mail");
                      }}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Important</div>
                      <div className="mt-2 text-2xl font-semibold text-white">{dashboard?.important_emails.length || 0}</div>
                      <div className="mt-2 text-xs text-cyan-100">Open mail triage</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("tasks")}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Open tasks</div>
                      <div className="mt-2 text-2xl font-semibold text-white">{activeTasks.length}</div>
                      <div className="mt-2 text-xs text-cyan-100">Review task list</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("news")}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Headlines</div>
                      <div className="mt-2 text-2xl font-semibold text-white">{dashboard?.news_items.length || 0}</div>
                      <div className="mt-2 text-xs text-cyan-100">Open article list</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setScheduleWorkspaceTab("agenda");
                        setMode("schedule");
                      }}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Calendar today</div>
                      <div className="mt-2 text-2xl font-semibold text-white">{dashboard?.calendar_items.length || 0}</div>
                      <div className="mt-2 text-xs text-cyan-100">Open schedule</div>
                    </button>
                    <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left">
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Health today</div>
                      <div className="mt-2 text-2xl font-semibold text-white">
                        {formatHealthStat(dashboard?.health_summary?.today_entry?.steps)}
                      </div>
                      <div className="mt-2 text-xs text-cyan-100">Steps from Apple Health</div>
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-3">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedMailbox(IMPORTANT_LABEL);
                        setMailWorkspaceTab("triage");
                        setMailView("ai");
                        setMode("mail");
                      }}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-wide text-slate-400">Mail</div>
                      <div className="mt-2 text-sm leading-6 text-slate-200">
                        {dashboard?.mail_summary || "No mail summary yet."}
                      </div>
                      <div className="mt-3 text-xs text-cyan-100">Open important mail</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("news")}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-wide text-slate-400">News</div>
                      <div className="mt-2 text-sm leading-6 text-slate-200">
                        {dashboard?.news_summary || "No news summary yet."}
                      </div>
                      <div className="mt-3 text-xs text-cyan-100">Open article list</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("tasks")}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-wide text-slate-400">Tasks</div>
                      <div className="mt-2 text-sm leading-6 text-slate-200">
                        {dashboard?.tasks_summary || "No task summary yet."}
                      </div>
                      <div className="mt-3 text-xs text-cyan-100">Open task manager</div>
                    </button>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <Plus className="h-5 w-5" />
                        Quick task capture
                      </CardTitle>
                      <p className="mt-2 text-sm leading-6 text-slate-300">
                        Add something fast from the dashboard, then use the full task editor only when you need more detail.
                      </p>
                    </div>
                    <Button variant="outline" className="rounded-2xl" onClick={() => setMode("tasks")}>
                      Open full task editor
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-3 md:flex-row">
                    <Input
                      value={dashboardQuickTaskTitle}
                      onChange={(e) => setDashboardQuickTaskTitle(e.target.value)}
                      className="h-11 rounded-2xl"
                      placeholder="Capture a task before it slips away"
                    />
                    <Button
                      className="rounded-2xl md:px-6"
                      onClick={() =>
                        void createTaskItem({
                          title: dashboardQuickTaskTitle,
                          detail: "",
                          due_text: null,
                          priority: "medium",
                          onSuccess: () => setDashboardQuickTaskTitle(""),
                        })
                      }
                      disabled={taskCreateLoading || !dashboardQuickTaskTitle.trim()}
                    >
                      {taskCreateLoading ? "Adding..." : "Add task"}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-6 xl:grid-cols-2">
                <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <CalendarDays className="h-5 w-5" />
                      Today&apos;s schedule
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {dashboard?.calendar_items?.length ? (
                        dashboard.calendar_items.map((item) => (
                          <div
                            key={item.event_id}
                            className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold text-slate-100">{item.title}</div>
                                <div className="mt-1 text-sm text-cyan-100">
                                  {formatScheduleTimeRange(item)}
                                </div>
                                {item.location ? (
                                  <div className="mt-1 text-xs text-slate-400">{item.location}</div>
                                ) : null}
                              </div>
                              <div className="flex flex-col items-end gap-2">
                                <Badge variant="outline" className="rounded-xl">
                                  {item.is_all_day
                                    ? `${formatRelativeDayLabel(item.start)} · All day`
                                    : formatRelativeDayLabel(item.start)}
                                </Badge>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="rounded-2xl"
                                  onClick={() => void createTaskFromCalendarItem(item)}
                                  disabled={calendarTaskLoadingId === item.event_id}
                                >
                                  {calendarTaskLoadingId === item.event_id ? "Adding..." : "Add task"}
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                          {loading ? "Loading today's schedule..." : "No calendar items found for today."}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <ShieldCheck className="h-5 w-5" />
                      Task list
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {activeTasks.length ? (
                        activeTasks.map((task) => renderTaskCard(task, true))
                      ) : (
                        <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                          {loading ? "Loading tasks..." : "No tasks surfaced yet."}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            <div className="space-y-6">
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Activity className="h-5 w-5" />
                    Health snapshot
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {dashboard?.health_summary ? (
                    <div className="space-y-4">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">Steps</div>
                          <div className="mt-2 text-2xl font-semibold text-white">
                            {formatHealthStat(dashboard.health_summary.today_entry?.steps)}
                          </div>
                          <div className="mt-2 text-xs text-slate-400">
                            7-day avg {formatHealthStat(dashboard.health_summary.seven_day_avg_steps)}
                          </div>
                        </div>
                        <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">Sleep avg</div>
                          <div className="mt-2 text-2xl font-semibold text-white">
                            {formatHealthStat(dashboard.health_summary.seven_day_avg_sleep_hours, 1)} hr
                          </div>
                          <div className="mt-2 text-xs text-slate-400">
                            Resting HR {formatHealthStat(dashboard.health_summary.today_entry?.resting_heart_rate)} bpm
                          </div>
                        </div>
                        <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">Movement</div>
                          <div className="mt-2 text-2xl font-semibold text-white">
                            {movementEntries[0] ? formatDistanceMiles(movementEntries[0].total_distance_km, 1) : "--"}
                          </div>
                          <div className="mt-2 text-xs text-slate-400">
                            {movementEntries[0]
                              ? `${movementEntries[0].visited_places_count} visits · ${formatMinutes(movementEntries[0].time_away_minutes)} away`
                              : "Waiting for movement sync"}
                          </div>
                        </div>
                      </div>
                      <div className="rounded-[1.4rem] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(56,189,248,0.12),rgba(35,37,58,0.85))] p-4">
                        <div className="text-sm leading-6 text-slate-100">
                          {movementEntries[0]?.movement_story
                            ? movementEntries[0].movement_story
                            : `${dashboard.health_summary.streak_days} day movement streak, ${formatHealthStat(dashboard.health_summary.today_entry?.workouts)} workouts today, and ${dashboard.health_summary.recent_entries.length} synced health days available.`}
                        </div>
                        <Button
                          variant="outline"
                          className="mt-4 rounded-2xl"
                          onClick={() => setMode("health")}
                        >
                          Open full health view
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                      Sync from the iPhone companion app to start showing Apple Health data here.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Mail className="h-5 w-5" />
                    Important mail
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {dashboard?.important_emails?.length ? (
                      dashboard.important_emails.map((item) => (
                        <button
                          key={item.message_id}
                          type="button"
                          onClick={() => void openOverviewEmail(item.message_id)}
                          className="w-full rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-slate-100">{item.subject}</div>
                              <div className="mt-1 text-xs text-slate-400">{item.sender}</div>
                            </div>
                            <Badge
                              variant={
                                item.urgency === "high"
                                  ? "default"
                                  : item.urgency === "medium"
                                    ? "secondary"
                                    : "outline"
                              }
                              className="rounded-xl"
                            >
                              {item.urgency}
                            </Badge>
                          </div>
                          <div className="mt-3 rounded-[1rem] border border-cyan-300/16 bg-cyan-400/8 px-3 py-2 text-sm leading-6 text-slate-100">
                            {item.summary}
                          </div>
                          {item.why_it_matters ? (
                            <div className="mt-3 text-sm leading-6 text-slate-300">{item.why_it_matters}</div>
                          ) : null}
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                            {item.needs_reply ? (
                              <span className="rounded-full border border-fuchsia-300/25 bg-fuchsia-400/12 px-2.5 py-1 text-fuchsia-100">
                                Needs reply
                              </span>
                            ) : null}
                            {item.action_items.length ? (
                              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                                {item.action_items.length} action item{item.action_items.length === 1 ? "" : "s"}
                              </span>
                            ) : null}
                            {item.deadline_hint ? (
                              <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-2.5 py-1 text-cyan-100">
                                {item.deadline_hint}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-3 text-xs text-cyan-100">Open focused detail</div>
                        </button>
                      ))
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        {loading ? "Loading important mail..." : "No important mail surfaced yet."}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Inbox className="h-5 w-5" />
                    News summary
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {dashboard?.news_items?.length ? (
                      dashboard.news_items.map((item, index) => (
                        <div
                          key={`${item.title}-${index}`}
                          className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4"
                        >
                          <div className="text-sm font-semibold text-slate-100">{item.title}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            {item.source ? <span>{item.source}</span> : null}
                            {item.published_at ? (
                              <span>{formatScheduleDateTime(item.published_at)}</span>
                            ) : null}
                          </div>
                          {item.link ? (
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-3 inline-block text-sm text-cyan-200 underline decoration-cyan-300/40 underline-offset-4"
                            >
                              Open article
                            </a>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        {loading ? "Loading news..." : "No news items available right now."}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : mode === "assistant" ? (
          <div className="space-y-6">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Sparkles className="h-5 w-5" />
                      Ask Jarvis
                    </CardTitle>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      Ask questions across the data Jarvis already knows about you, including important mail, tasks, calendar, journal notes, health syncs, and movement history.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="rounded-2xl"
                    onClick={() => setMode("dashboard")}
                  >
                    Back to dashboard
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <AssistantPanel apiBase={API_BASE} />
              </CardContent>
            </Card>
          </div>
        ) : mode === "health" ? (
          <HealthDetailPanel
            dashboard={dashboard}
            healthEntries={healthEntries}
            selectedHealthDate={selectedHealthDate}
            onSelectedHealthDateChange={setSelectedHealthDate}
            movementEntries={movementEntries}
            workoutEntries={workoutEntries}
            movementLoading={movementLoading}
            loading={loading}
            onBackToDashboard={() => setMode("dashboard")}
            onUseTrailForPlanner={(trail) => {
              setPlanningPrompt(buildTrailPlanningPrompt(trail));
              setScheduleWorkspaceTab("planner");
              setMode("schedule");
            }}
          />
        ) : mode === "news" ? (
          <div className="space-y-6">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Newspaper className="h-5 w-5" />
                      News sources
                    </CardTitle>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      These are the headlines currently feeding the dashboard&apos;s news summary.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="rounded-2xl"
                    onClick={() => setMode("dashboard")}
                  >
                    Back to dashboard
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-[1.6rem] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(56,189,248,0.16),rgba(35,37,58,0.92))] p-5">
                  <div className="text-xs uppercase tracking-[0.22em] text-cyan-100/80">
                    Dashboard news summary
                  </div>
                  <div className="mt-3 text-sm leading-7 text-slate-100">
                    {dashboard?.news_summary || (loading ? "Loading news summary..." : "No news summary yet.")}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Articles used</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3 px-2 pr-4">
                  {dashboard?.news_items?.length ? (
                    dashboard.news_items.map((item, index) => (
                      <div
                        key={`${item.title}-${index}`}
                        className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4"
                      >
                        <div className="text-sm font-semibold text-slate-100">{item.title}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                          {item.source ? <span>{item.source}</span> : null}
                          {item.published_at ? (
                            <span>{formatScheduleDateTime(item.published_at)}</span>
                          ) : null}
                        </div>
                        {item.link ? (
                          <a
                            href={item.link}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-3 inline-block text-sm text-cyan-200 underline decoration-cyan-300/40 underline-offset-4"
                          >
                            Open article
                          </a>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                      {loading ? "Loading news..." : "No news items available right now."}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        ) : mode === "settings" ? (
          <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <SlidersHorizontal className="h-5 w-5" />
                      Classification guidance
                    </CardTitle>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      Teach Jarvis what should count as important, unimportant, or action-worthy without crowding the main mail workflow.
                    </p>
                  </div>
                  {guidanceDirty ? (
                    <Badge variant="outline" className="rounded-xl">
                      Unsaved
                    </Badge>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <textarea
                  value={classificationGuidance}
                  onChange={(e) => setClassificationGuidance(e.target.value)}
                  placeholder="Example: Treat messages from professors, BYU admin, job opportunities, bills, deadlines, and personal messages as important. Treat newsletters, login alerts, and generic marketing as unimportant."
                  className="min-h-[240px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-fuchsia-400/50"
                />
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                  <span>
                    Saved guidance is included in future AI classification prompts. Cached emails refresh as they are reclassified.
                  </span>
                  <span>
                    {classificationGuidanceUpdatedAt
                      ? `Updated ${new Date(classificationGuidanceUpdatedAt).toLocaleString()}`
                      : "Not customized yet"}
                  </span>
                </div>
                <div className="flex justify-end">
                  <Button
                    className="rounded-2xl"
                    onClick={() => void saveClassificationGuidance()}
                    disabled={guidanceLoading || guidanceSaving || !guidanceDirty}
                  >
                    {guidanceSaving ? "Saving..." : "Save guidance"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-6">
              {utilitiesPanel}
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Why This Is Separate</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm leading-6 text-slate-300">
                  <p>
                    Mail review stays faster when guidance-writing and inbox-wide maintenance are not competing for attention inside the same pane.
                  </p>
                  <p>
                    This page is meant for configuration and bulk actions. Day-to-day triage can stay focused on reading, handling, and correcting individual conversations.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : mode === "tasks" ? (
          <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <ShieldCheck className="h-5 w-5" />
                  Add task
                </CardTitle>
                <p className="text-sm leading-6 text-slate-300">
                  Create a task or clean up an existing one. Changes persist and also show up on the dashboard.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  className="rounded-xl"
                  placeholder="Task title"
                />
                <textarea
                  value={newTaskDetail}
                  onChange={(e) => setNewTaskDetail(e.target.value)}
                  className="min-h-[120px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
                  placeholder="Details or notes"
                />
                <div className="space-y-2">
                  <div className="grid gap-3 md:grid-cols-[1fr_1fr_150px]">
                    <Input
                      type="datetime-local"
                      value={newTaskDueAt}
                      onChange={(e) => setNewTaskDueAt(e.target.value)}
                      className="rounded-xl"
                    />
                    <Input
                      value={newTaskDueNote}
                      onChange={(e) => setNewTaskDueNote(e.target.value)}
                      className="rounded-xl"
                      placeholder="Or a quick due note"
                    />
                    <select
                      value={newTaskPriority}
                      onChange={(e) => setNewTaskPriority(e.target.value as "high" | "medium" | "low")}
                      className="h-10 w-full rounded-xl border border-white/8 bg-[rgba(20,22,37,0.88)] px-3 text-sm text-slate-100 outline-none"
                    >
                      <option value="high">high priority</option>
                      <option value="medium">medium priority</option>
                      <option value="low">low priority</option>
                    </select>
                  </div>
                  <p className="text-xs text-slate-400">
                    Pick an exact time when you have one, or leave a simple note like &quot;after class&quot;.
                  </p>
                </div>
                <Button
                  className="w-full rounded-2xl"
                  onClick={() => void createTaskItem()}
                  disabled={taskCreateLoading || !newTaskTitle.trim()}
                >
                  {taskCreateLoading ? "Creating..." : "Add task"}
                </Button>
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="flex flex-col gap-4 pb-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <ShieldCheck className="h-5 w-5" />
                      Active tasks
                    </CardTitle>
                    <p className="mt-2 text-sm text-slate-400">
                      Undated tasks stay visible in every view so they do not disappear.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={taskWindow === "today" ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => setTaskWindow("today")}
                    >
                      Today
                    </Button>
                    <Button
                      size="sm"
                      variant={taskWindow === "this_week" ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => setTaskWindow("this_week")}
                    >
                      This week
                    </Button>
                    <Button
                      size="sm"
                      variant={taskWindow === "next_week" ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => setTaskWindow("next_week")}
                    >
                      Next week
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {filteredActiveTasks.length ? (
                      filteredActiveTasks.map((task) => renderTaskCard(task))
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        {loading ? "Loading tasks..." : "No active tasks in this window."}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Completed</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {filteredCompletedTasks.length ? (
                      filteredCompletedTasks.map((task) => renderTaskCard(task, true))
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        No completed tasks in this window.
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : mode === "journal" ? (
          <div className="space-y-6">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <BookOpen className="h-5 w-5" />
                      Journal archive
                    </CardTitle>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      Browse recent days or jump into saved entries without rendering your whole history at once.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={!journalSavedOnly ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => void toggleJournalArchiveMode(false)}
                    >
                      Recent timeline
                    </Button>
                    <Button
                      size="sm"
                      variant={journalSavedOnly ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => void toggleJournalArchiveMode(true)}
                    >
                      Saved archive
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-3 lg:flex-row">
                  <div className="relative flex-1">
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
                      className="h-11 rounded-2xl pl-9"
                      placeholder="Search dates, reflections, gratitude, or world events"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      className="rounded-2xl"
                      onClick={() => void applyJournalSearch()}
                    >
                      Search
                    </Button>
                    <Button
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => void clearJournalSearch()}
                      disabled={!journalQuery && !journalSearchInput && !journalSavedOnly}
                    >
                      Reset
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-3 text-sm text-slate-300 md:flex-row md:items-center md:justify-between">
                  <div>
                    {journalQuery
                      ? `Showing ${journal?.entries.length || 0} of ${journal?.total_entries || 0} saved entries matching "${journalQuery}".`
                      : journalSavedOnly
                        ? `Showing ${journal?.entries.length || 0} saved entries from your archive.`
                        : `Showing ${journal?.entries.length || 0} recent days at a time so the journal stays fast to navigate.`}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => void loadNewerJournalEntries()}
                      disabled={!journalHistory.length || loading}
                    >
                      Newer
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => void loadOlderJournalEntries()}
                      disabled={!journal?.has_more || loading}
                    >
                      Older
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
            {error ? (
              <div className="flex items-start gap-3 rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
                <AlertCircle className="mt-0.5 h-4 w-4" />
                <div>{error}</div>
              </div>
            ) : null}
            {journal?.entries?.length ? (
              journal.entries.map((entry) => {
                const draft = journalDrafts[entry.date] || {
                  journal_entry: entry.journal_entry || "",
                  accomplishments: entry.accomplishments || "",
                  gratitude_entry: entry.gratitude_entry || "",
                  scripture_study: entry.scripture_study || "",
                  spiritual_notes: entry.spiritual_notes || "",
                  photo_data_url: entry.photo_data_url || null,
                  calendar_items: entry.calendar_items || [],
                };
                const sectionState = journalSectionState[entry.date] || {
                  dayOpen: false,
                  calendarOpen: false,
                  articlesOpen: false,
                };
                const dateLabel = highlightJournalSearchText(entry.date_label, journalQuery);
                const calendarSummary = highlightJournalSearchText(entry.calendar_summary, journalQuery);
                const worldEventTitle = highlightJournalSearchText(
                  entry.world_event_title || "No headline captured for this day",
                  journalQuery
                );
                const worldEventSource = highlightJournalSearchText(entry.world_event_source, journalQuery);
                const worldEventSummary = highlightJournalSearchText(entry.world_event_summary, journalQuery);
                const isEditingJournalEntry = journalEditingDate === entry.date;

                return (
                  <Card
                    key={entry.date}
                    className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl"
                  >
                    <CardHeader className="pb-3">
                      <button
                        type="button"
                        onClick={() => toggleJournalSection(entry.date, "dayOpen")}
                        className="flex w-full flex-col gap-3 text-left md:flex-row md:items-center md:justify-between"
                      >
                        <div>
                          <CardTitle className="flex items-center gap-2 text-lg">
                            <BookOpen className="h-5 w-5" />
                            <span>{dateLabel}</span>
                          </CardTitle>
                          <p className="mt-2 text-sm leading-6 text-slate-300">
                            {sectionState.dayOpen
                              ? "A quick memory capsule from your calendar plus one world event from the day."
                              : entry.calendar_summary}
                          </p>
                        </div>
                        <div className="flex items-center gap-3 self-start md:self-auto">
                          {entry.updated_at ? (
                            <div className="text-xs text-slate-400">
                              Saved {new Date(entry.updated_at).toLocaleString()}
                            </div>
                          ) : null}
                          {sectionState.dayOpen ? (
                            <ChevronDown className="h-4 w-4 text-slate-400" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-slate-400" />
                          )}
                        </div>
                      </button>
                    </CardHeader>
                    {sectionState.dayOpen ? (
                    <CardContent className="space-y-5">
                      <div className="grid items-start gap-4 lg:grid-cols-2">
                        <div className="space-y-4">
                        <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                          <button
                            type="button"
                            onClick={() => toggleJournalSection(entry.date, "calendarOpen")}
                            className="flex w-full items-center justify-between gap-3 text-left"
                          >
                            <div>
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                What your calendar says you did
                              </div>
                              <div
                                className={`mt-2 text-slate-200 ${
                                  sectionState.calendarOpen
                                    ? "text-sm leading-6"
                                    : "line-clamp-1 text-xs leading-5 text-slate-300"
                                }`}
                              >
                                {calendarSummary}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="rounded-xl">
                                {draft.calendar_items.filter((item) => !item.removed).length} kept
                              </Badge>
                              {sectionState.calendarOpen ? (
                                <ChevronDown className="h-4 w-4 text-slate-400" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-slate-400" />
                              )}
                            </div>
                          </button>
                          {sectionState.calendarOpen ? (
                            <div className="mt-4 space-y-3">
                              <div className="flex justify-end">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="rounded-xl"
                                  onClick={() =>
                                    void updateJournalCalendarItems(
                                      entry.date,
                                      (items) => [
                                        ...items,
                                        {
                                          event_id: `custom-${entry.date}-${items.length}`,
                                          title: "",
                                          start: entry.date,
                                          end: null,
                                          is_all_day: true,
                                          location: null,
                                          description: null,
                                          html_link: null,
                                          removed: false,
                                        },
                                      ]
                                    )
                                  }
                                >
                                  <Plus className="mr-2 h-4 w-4" />
                                  Add something
                                </Button>
                              </div>
                              {draft.calendar_items.length ? (
                                draft.calendar_items.map((item, itemIndex) => (
                                  (() => {
                                    const calendarTitleMatches = textMatchesJournalQuery(
                                      item.title,
                                      journalQuery
                                    );
                                    return (
                                  <div
                                    key={`${item.event_id}-${itemIndex}`}
                                    className={`rounded-[1rem] border px-3 py-3 text-sm transition ${
                                      item.removed
                                        ? "border-dashed border-white/10 bg-[rgba(20,22,37,0.4)] text-slate-500"
                                        : "border-cyan-300/20 bg-[linear-gradient(135deg,rgba(56,189,248,0.12),rgba(20,22,37,0.88))] text-slate-200 shadow-[0_6px_18px_rgba(8,10,20,0.14)]"
                                    } ${calendarTitleMatches ? "ring-1 ring-fuchsia-300/35 shadow-[0_0_0_1px_rgba(232,121,249,0.18)]" : ""}`}
                                  >
                                    <div className="space-y-2">
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                          <Input
                                            value={item.title}
                                            onChange={(e) =>
                                              setJournalDrafts((current) => {
                                                const currentDraft = current[entry.date] || draft;
                                                return {
                                                  ...current,
                                                  [entry.date]: {
                                                    ...currentDraft,
                                                    calendar_items: currentDraft.calendar_items.map((currentItem, currentIndex) =>
                                                    currentIndex === itemIndex
                                                      ? { ...currentItem, title: e.target.value }
                                                      : currentItem
                                                    ),
                                                  },
                                                };
                                              })
                                            }
                                            className="h-9 rounded-xl"
                                            placeholder="What you actually did"
                                          />
                                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                                            <span
                                              className={`inline-flex items-center rounded-full px-2.5 py-1 ${
                                                item.removed
                                                  ? "border border-white/10 bg-[rgba(255,255,255,0.04)] text-slate-500"
                                                  : "border border-cyan-300/20 bg-cyan-300/10 text-cyan-100"
                                              }`}
                                            >
                                              {formatScheduleTimeRange(item)}
                                            </span>
                                            {calendarTitleMatches ? (
                                              <span className="inline-flex items-center rounded-full border border-fuchsia-300/25 bg-fuchsia-400/15 px-2.5 py-1 text-fuchsia-100">
                                                Search match in title
                                              </span>
                                            ) : null}
                                            {item.removed ? (
                                              <span className="text-slate-500">Marked as not done</span>
                                            ) : null}
                                          </div>
                                        </div>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="rounded-xl"
                                          onClick={() =>
                                            void updateJournalCalendarItems(
                                              entry.date,
                                              (items) =>
                                                items.map((currentItem, currentIndex) =>
                                                  currentIndex === itemIndex
                                                    ? { ...currentItem, removed: !currentItem.removed }
                                                    : currentItem
                                                ),
                                              true
                                            )
                                          }
                                        >
                                          {item.removed ? "Restore" : "Remove"}
                                        </Button>
                                      </div>
                                    </div>
                                  </div>
                                    );
                                  })()
                                ))
                              ) : (
                                <div className="text-sm text-slate-400">
                                  No calendar events were captured for this day.
                                </div>
                              )}
                            </div>
                          ) : null}
                        </div>

                        <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Scripture / spiritual study
                            </div>
                            <div className="flex items-center gap-2">
                              {isEditingJournalEntry ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="rounded-xl"
                                  onClick={() => {
                                    const draft = journalDrafts[entry.date];
                                    if (!draft) return;
                                    void extractJournalCitations(entry.date, draft);
                                  }}
                                  disabled={journalSavingDate === entry.date || journalExtractingDate === entry.date}
                                >
                                  {journalExtractingDate === entry.date ? "Extracting..." : "Extract citations"}
                                </Button>
                              ) : null}
                              <Button
                                size="sm"
                                variant={isEditingJournalEntry ? "default" : "outline"}
                                className="rounded-xl"
                                onClick={() => {
                                  if (isEditingJournalEntry) {
                                    void saveJournalEntry(entry.date);
                                    return;
                                  }
                                  setJournalEditingDate(entry.date);
                                }}
                                disabled={journalSavingDate === entry.date || journalExtractingDate === entry.date}
                              >
                                {journalSavingDate === entry.date
                                  ? "Saving..."
                                  : isEditingJournalEntry
                                    ? "Save and close"
                                    : "Edit notes"}
                              </Button>
                            </div>
                          </div>
                          <div className="mt-3 space-y-3">
                            {isEditingJournalEntry ? (
                              <>
                                <Input
                                  value={draft.scripture_study}
                                  onChange={(e) =>
                                    setJournalDrafts((current) => ({
                                      ...current,
                                      [entry.date]: {
                                        ...draft,
                                        scripture_study: e.target.value,
                                      },
                                    }))
                                  }
                                  className="h-10 rounded-xl"
                                  placeholder="What did you study today?"
                                />
                                <textarea
                                  value={draft.spiritual_notes}
                                  onChange={(e) =>
                                    setJournalDrafts((current) => ({
                                      ...current,
                                      [entry.date]: {
                                        ...draft,
                                        spiritual_notes: e.target.value,
                                      },
                                    }))
                                  }
                                  placeholder="Spiritual notes, impressions, questions, or insights."
                                  className="min-h-[132px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
                                />
                              </>
                            ) : (
                              <>
                                <JournalPreviewBlock
                                  label="Study"
                                  value={draft.scripture_study}
                                  query={journalQuery}
                                  placeholder="No study saved for this day yet."
                                  compact
                                  studyLinks={entry.study_links}
                                />
                                {entry.study_links.length ? (
                                  <div className="space-y-2">
                                    <div className="text-xs uppercase tracking-wide text-slate-400">
                                      Study links
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      {entry.study_links.map((link) => (
                                        <div
                                          key={`${link.label}-${link.url}`}
                                          className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-100"
                                        >
                                          <a
                                            href={link.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="transition hover:text-cyan-50"
                                          >
                                            {link.label}
                                          </a>
                                          <span className="rounded-full border border-white/10 bg-white/8 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-slate-200">
                                            {link.confidence === "exact" ? "Exact match" : "Likely source"}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : null}
                                <div className="space-y-2">
                                  <div className="text-xs uppercase tracking-wide text-slate-400">
                                    Spiritual notes
                                  </div>
                                  <div className={`rounded-[1.2rem] border px-4 py-3 text-sm leading-6 ${
                                    draft.spiritual_notes.trim()
                                      ? "border-white/8 bg-[rgba(20,22,37,0.72)] text-slate-100"
                                      : "border-dashed border-white/10 bg-[rgba(20,22,37,0.42)] text-slate-500"
                                  }`}>
                                    <div className="whitespace-pre-wrap break-words">
                                      {draft.spiritual_notes.trim()
                                        ? highlightJournalTextWithReferences(
                                            draft.spiritual_notes,
                                            journalQuery,
                                            entry.study_links
                                          )
                                        : "No spiritual notes saved for this day yet."}
                                    </div>
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                        </div>

                        <div className="space-y-4">
                          <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              World event
                            </div>
                            <div className="mt-3 text-base font-medium text-slate-100">
                              {worldEventTitle}
                            </div>
                            {entry.world_event_source ? (
                              <div className="mt-1 text-xs text-cyan-100">{worldEventSource}</div>
                            ) : null}
                            <div className="mt-3 text-sm leading-6 text-slate-200">
                              {worldEventSummary}
                            </div>
                            {entry.world_event_articles?.length ? (
                              <div className="mt-4">
                                <button
                                  type="button"
                                  onClick={() => toggleJournalSection(entry.date, "articlesOpen")}
                                  className="flex w-full items-center justify-between gap-3 text-left"
                                >
                                  <div className="text-xs uppercase tracking-wide text-slate-400">
                                    Referenced articles
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Badge variant="outline" className="rounded-xl">
                                      {entry.world_event_articles.length}
                                    </Badge>
                                    {sectionState.articlesOpen ? (
                                      <ChevronDown className="h-4 w-4 text-slate-400" />
                                    ) : (
                                      <ChevronRight className="h-4 w-4 text-slate-400" />
                                    )}
                                  </div>
                                </button>
                                {sectionState.articlesOpen ? (
                                  <div className="mt-3 space-y-2">
                                    {entry.world_event_articles.map((article, index) => (
                                      article.link ? (
                                        <a
                                          key={`${article.title}-${index}`}
                                          href={article.link}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="block w-full rounded-[1rem] border border-white/6 bg-[rgba(20,22,37,0.82)] px-3 py-2 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(32,35,57,0.96)]"
                                        >
                                          <div className="text-sm text-slate-100">
                                            {highlightJournalSearchText(article.title, journalQuery)}
                                          </div>
                                          <div className="mt-1 text-xs text-slate-400">
                                            {highlightJournalSearchText(article.source || "Article", journalQuery)}
                                          </div>
                                        </a>
                                      ) : (
                                        <div
                                          key={`${article.title}-${index}`}
                                          className="rounded-[1rem] border border-white/6 bg-[rgba(20,22,37,0.82)] px-3 py-2"
                                        >
                                          <div className="text-sm text-slate-100">
                                            {highlightJournalSearchText(article.title, journalQuery)}
                                          </div>
                                          <div className="mt-1 text-xs text-slate-400">
                                            {highlightJournalSearchText(article.source || "Article", journalQuery)}
                                          </div>
                                        </div>
                                      )
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>

                          {entry.language_sessions?.length ? (
                            <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                              <div className="text-xs uppercase tracking-wide text-slate-400">Language practice</div>
                              <div className="mt-3 space-y-2">
                                {Object.entries(
                                  entry.language_sessions.reduce<Record<string, { minutes: number; sessions: number }>>((acc, s) => {
                                    if (!acc[s.language]) acc[s.language] = { minutes: 0, sessions: 0 };
                                    acc[s.language].minutes += s.minutes;
                                    acc[s.language].sessions += 1;
                                    return acc;
                                  }, {})
                                ).map(([language, stats]) => (
                                  <div key={language} className="flex items-center justify-between text-sm">
                                    <span className="capitalize text-slate-200">{language}</span>
                                    <span className="text-slate-400">{stats.minutes} min · {stats.sessions} {stats.sessions === 1 ? "session" : "sessions"}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Photo memory
                              </div>
                              <label className="cursor-pointer text-xs text-cyan-100 underline decoration-cyan-300/30 underline-offset-4">
                                Add photo
                                <input
                                  type="file"
                                  accept="image/*"
                                  className="hidden"
                                  onChange={(e) => void handleJournalPhotoChange(entry.date, e)}
                                />
                              </label>
                            </div>
                            {draft.photo_data_url ? (
                              <div className="mt-3">
                                <div className="relative h-52 w-full overflow-hidden rounded-[1.2rem]">
                                  <Image
                                    src={draft.photo_data_url}
                                    alt={`Memory from ${entry.date_label}`}
                                    fill
                                    unoptimized
                                    className="object-cover"
                                  />
                                </div>
                                <div className="mt-3 flex justify-end">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="rounded-xl"
                                    onClick={() =>
                                      setJournalDrafts((current) => ({
                                        ...current,
                                        [entry.date]: {
                                          ...(current[entry.date] || draft),
                                          photo_data_url: null,
                                        },
                                      }))
                                    }
                                  >
                                    Remove photo
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <div className="mt-3 rounded-[1.2rem] border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
                                Add one image to make the day easier to remember later.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-4 lg:grid-cols-3">
                        {isEditingJournalEntry ? (
                          <>
                            <div className="space-y-2">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Journal entry
                              </div>
                              <textarea
                                value={draft.journal_entry}
                                onChange={(e) =>
                                  setJournalDrafts((current) => ({
                                    ...current,
                                    [entry.date]: {
                                      ...draft,
                                      journal_entry: e.target.value,
                                      accomplishments: current[entry.date]?.accomplishments ?? draft.accomplishments,
                                      gratitude_entry: current[entry.date]?.gratitude_entry ?? draft.gratitude_entry,
                                      scripture_study: current[entry.date]?.scripture_study ?? draft.scripture_study,
                                      spiritual_notes: current[entry.date]?.spiritual_notes ?? draft.spiritual_notes,
                                      photo_data_url: current[entry.date]?.photo_data_url ?? draft.photo_data_url,
                                    },
                                  }))
                                }
                                placeholder="Write a quick reflection about the day."
                                className="min-h-[180px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-fuchsia-400/50"
                              />
                            </div>

                            <div className="space-y-2">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Accomplishments
                              </div>
                              <textarea
                                value={draft.accomplishments}
                                onChange={(e) =>
                                  setJournalDrafts((current) => ({
                                    ...current,
                                    [entry.date]: {
                                      ...draft,
                                      journal_entry: current[entry.date]?.journal_entry ?? draft.journal_entry,
                                      accomplishments: e.target.value,
                                      gratitude_entry: current[entry.date]?.gratitude_entry ?? draft.gratitude_entry,
                                      scripture_study: current[entry.date]?.scripture_study ?? draft.scripture_study,
                                      spiritual_notes: current[entry.date]?.spiritual_notes ?? draft.spiritual_notes,
                                      photo_data_url: current[entry.date]?.photo_data_url ?? draft.photo_data_url,
                                    },
                                  }))
                                }
                                placeholder="List wins, progress, or things you want to remember."
                                className="min-h-[180px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-fuchsia-400/50"
                              />
                            </div>

                            <div className="space-y-2">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Gratitude
                              </div>
                              <textarea
                                value={draft.gratitude_entry}
                                onChange={(e) =>
                                  setJournalDrafts((current) => ({
                                    ...current,
                                    [entry.date]: {
                                      ...draft,
                                      journal_entry: current[entry.date]?.journal_entry ?? draft.journal_entry,
                                      accomplishments: current[entry.date]?.accomplishments ?? draft.accomplishments,
                                      gratitude_entry: e.target.value,
                                      scripture_study: current[entry.date]?.scripture_study ?? draft.scripture_study,
                                      spiritual_notes: current[entry.date]?.spiritual_notes ?? draft.spiritual_notes,
                                      photo_data_url: current[entry.date]?.photo_data_url ?? draft.photo_data_url,
                                    },
                                  }))
                                }
                                placeholder="What felt good, generous, or worth appreciating today?"
                                className="min-h-[180px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-fuchsia-400/50"
                              />
                            </div>
                          </>
                        ) : (
                          <>
                            <JournalPreviewBlock
                              label="Journal entry"
                              value={draft.journal_entry}
                              query={journalQuery}
                              placeholder="No journal entry saved for this day yet."
                            />
                            <JournalPreviewBlock
                              label="Accomplishments"
                              value={draft.accomplishments}
                              query={journalQuery}
                              placeholder="No accomplishments saved for this day yet."
                            />
                            <JournalPreviewBlock
                              label="Gratitude"
                              value={draft.gratitude_entry}
                              query={journalQuery}
                              placeholder="No gratitude saved for this day yet."
                            />
                          </>
                        )}
                      </div>

                      <div className="flex justify-end">
                        {isEditingJournalEntry ? (
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              className="rounded-2xl"
                              onClick={() => {
                                const draft = journalDrafts[entry.date];
                                if (!draft) return;
                                void extractJournalCitations(entry.date, draft);
                              }}
                              disabled={journalSavingDate === entry.date || journalExtractingDate === entry.date}
                            >
                              {journalExtractingDate === entry.date ? "Extracting..." : "Extract citations"}
                            </Button>
                            <Button
                              className="rounded-2xl"
                              onClick={() => void saveJournalEntry(entry.date)}
                              disabled={journalSavingDate === entry.date || journalExtractingDate === entry.date}
                            >
                              {journalSavingDate === entry.date ? "Saving..." : "Save entry"}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </CardContent>
                    ) : null}
                  </Card>
                );
              })
            ) : (
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardContent className="p-6 text-sm text-slate-400">
                  {loading ? "Loading journal..." : "No journal entries available yet."}
                </CardContent>
              </Card>
            )}
          </div>
        ) : isSchedulePlannerMode ? (
          <div className="grid gap-6 lg:grid-cols-[320px_360px_1fr]">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={scheduleWorkspaceTab === "agenda" ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => setScheduleWorkspaceTab("agenda")}
                    >
                      Agenda
                    </Button>
                    <Button
                      size="sm"
                      variant={scheduleWorkspaceTab === "planner" ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => setScheduleWorkspaceTab("planner")}
                    >
                      Planner
                    </Button>
                  </div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Sparkles className="h-5 w-5" />
                    Planning brief
                  </CardTitle>
                </div>
                <p className="text-sm leading-6 text-slate-300">
                  Describe what you want to get done, and Jarvis will draft a realistic schedule around your existing calendar.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-wide text-slate-400">
                    Goals and constraints
                  </div>
                  <textarea
                    value={planningPrompt}
                    onChange={(e) => setPlanningPrompt(e.target.value)}
                    placeholder="Example: Finish the data structures assignment, prepare for Friday's interview, email my professor, grocery shop, and fit in gym time. I want my hardest work in the morning."
                    className="min-h-[240px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-fuchsia-400/50"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min="1"
                    max="14"
                    value={planningDays}
                    onChange={(e) => setPlanningDays(e.target.value)}
                    className="w-28 rounded-2xl"
                    placeholder="Days"
                  />
                  <div className="text-xs text-slate-400">Planning horizon</div>
                </div>
                <Button
                  className="w-full rounded-2xl"
                  onClick={() => void generatePlan()}
                  disabled={planningLoading}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  {planningLoading ? "Generating plan..." : "Generate plan"}
                </Button>
                {planningJob && (planningJob.status === "queued" || planningJob.status === "running") ? (
                  <div className="rounded-[1.2rem] border border-cyan-300/20 bg-cyan-300/10 px-4 py-3 text-sm text-cyan-100">
                    Jarvis is building your plan in the background. This can take a little longer now so it can use a stronger model.
                  </div>
                ) : null}
                {planningResult?.priorities?.length ? (
                  <div className="space-y-2">
                    <div className="text-xs uppercase tracking-wide text-slate-400">
                      Priority themes
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {planningResult.priorities.map((priority) => (
                        <Badge key={priority} variant="outline" className="rounded-xl">
                          {priority}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <CalendarDays className="h-5 w-5" />
                  Suggested schedule
                </CardTitle>
                <p className="text-sm leading-6 text-slate-300">
                  A day-by-day plan generated from your goals and current calendar commitments.
                </p>
              </CardHeader>
              <CardContent>
                {error ? (
                  <div className="mb-4 flex items-start gap-3 rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
                    <AlertCircle className="mt-0.5 h-4 w-4" />
                    <div>{error}</div>
                  </div>
                ) : null}
                <ScrollArea className="h-[65vh] pr-3">
                  {planningResult && planningDayGroups.length > 0 ? (
                    <div className="space-y-4">
                      {planningDayGroups.map((group) => (
                        <div key={group.key} className="space-y-2">
                          <div className="sticky top-0 z-10 rounded-xl border border-white/8 bg-[rgba(20,22,37,0.94)] px-3 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400 backdrop-blur">
                            {group.label}
                          </div>
                          <div className="space-y-2">
                            {group.items.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => setSelectedId(item.id)}
                                className={`w-full rounded-2xl border p-4 text-left transition hover:shadow-sm ${
                                  selectedId === item.id
                                    ? "border-fuchsia-400/60 bg-[linear-gradient(135deg,rgba(189,147,249,0.18),rgba(35,37,58,0.96))]"
                                    : "border-white/8 bg-[rgba(29,31,50,0.75)]"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-semibold text-slate-100">
                                      {item.title}
                                    </div>
                                    <div className="mt-1 text-sm text-cyan-100">
                                      {formatScheduleTimeRange(item)}
                                    </div>
                                  </div>
                                  <Badge variant="outline" className="rounded-xl">
                                    {item.priority}
                                  </Badge>
                                </div>
                                <div className="mt-2 text-xs text-slate-400">
                                  {item.kind.replaceAll("_", " ")}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                      {planningLoading
                        ? "Planning job is running. Your schedule will appear here when it is ready."
                        : "Write out your goals for the day or week, then generate a plan."}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader>
                <CardTitle className="text-lg">Plan detail</CardTitle>
              </CardHeader>
              <CardContent>
                {planningResult ? (
                  <div className="space-y-4">
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="text-xs uppercase tracking-wide text-slate-400">
                        Plan summary
                      </div>
                      <div className="mt-2 text-sm leading-6 text-slate-200">
                        {planningResult.summary}
                      </div>
                      <div className="mt-3 text-sm leading-6 text-slate-300">
                        {planningResult.strategy}
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void createPlanningCalendarEvents(
                              highPriorityPlanningItems,
                              "High-priority blocks"
                            )
                          }
                          disabled={
                            planningBulkCalendarLoading || highPriorityPlanningItems.length === 0
                          }
                        >
                          <CalendarDays className="mr-2 h-4 w-4" />
                          Add high priority
                        </Button>
                        {selectedPlanningDayItems.length > 0 ? (
                          <Button
                            className="rounded-2xl"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void createPlanningCalendarEvents(
                                selectedPlanningDayItems,
                                selectedPlanningItem?.day_label || "Selected day"
                              )
                            }
                            disabled={planningBulkCalendarLoading}
                          >
                            <CalendarDays className="mr-2 h-4 w-4" />
                            Add selected day
                          </Button>
                        ) : null}
                      </div>
                      {planningBulkCalendarMessage ? (
                        <div className="mt-3 text-sm text-cyan-100">
                          {planningBulkCalendarMessage}
                        </div>
                      ) : null}
                    </div>
                    {selectedPlanningItem ? (
                      <div className="space-y-3">
                        <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                          <div className="text-xl font-semibold text-slate-100">
                            {selectedPlanningItem.title}
                          </div>
                          <div className="mt-3 inline-flex items-center rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-cyan-100">
                            {formatScheduleTimeRange(selectedPlanningItem)}
                          </div>
                          <div className="mt-4 grid gap-3 md:grid-cols-2">
                            <div className="rounded-2xl border border-white/6 bg-[rgba(20,22,37,0.82)] p-4">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Starts
                              </div>
                              <div className="mt-1 text-sm text-slate-200">
                                {formatScheduleDateTime(selectedPlanningItem.start)}
                              </div>
                            </div>
                            <div className="rounded-2xl border border-white/6 bg-[rgba(20,22,37,0.82)] p-4">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Ends
                              </div>
                              <div className="mt-1 text-sm text-slate-200">
                                {formatScheduleDateTime(selectedPlanningItem.end)}
                              </div>
                            </div>
                          </div>
                          <div className="mt-4 flex flex-wrap gap-2">
                            <Badge variant="outline" className="rounded-xl">
                              {selectedPlanningItem.priority} priority
                            </Badge>
                            <Badge variant="outline" className="rounded-xl">
                              {selectedPlanningItem.kind.replaceAll("_", " ")}
                            </Badge>
                          </div>
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            <Button
                              className="rounded-2xl"
                              size="sm"
                              onClick={() => void createPlanningCalendarEvent()}
                              disabled={planningCalendarLoading}
                            >
                              <CalendarDays className="mr-2 h-4 w-4" />
                              {planningCalendarLoading ? "Creating..." : "Add to Calendar"}
                            </Button>
                            {planningCalendarLink ? (
                              <a
                                href={planningCalendarLink}
                                target="_blank"
                                rel="noreferrer"
                                className="text-sm text-cyan-200 underline decoration-cyan-300/40 underline-offset-4"
                              >
                                Open event
                              </a>
                            ) : null}
                          </div>
                          <div className="mt-4 text-sm leading-6 text-slate-200">
                            {selectedPlanningItem.rationale}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-8 text-sm text-slate-400">
                        Generate a plan and select a block to inspect it here.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-[1.6rem] border border-dashed border-white/10 p-8 text-sm text-slate-400">
                    Your generated plan details will appear here.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
        <div
          className={`grid gap-6 ${
            isScheduleAgendaMode
              ? "lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]"
              : mailSidebarOpen
                ? "xl:grid-cols-[240px_minmax(300px,360px)_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]"
                : "lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]"
          }`}
        >
          {!isScheduleWorkspaceMode && mailSidebarOpen ? (
            <Card className="min-w-0 rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Mail className="h-5 w-5" />
                      Mailboxes
                    </CardTitle>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      {isRawMailView
                        ? "Switch folders and labels like Gmail."
                        : isMailInsightsMode
                          ? "See saved AI insights for the selected mailbox without reclassifying everything."
                          : "Pick a folder or label, review AI summaries, then correct any mistakes."}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-2xl"
                    onClick={() => setMailSidebarOpen(false)}
                  >
                    Hide
                  </Button>
                </div>
              </CardHeader>

              <CardContent className="min-w-0 overflow-hidden">
                <ScrollArea className="h-[65vh] min-w-0">
                  <div className="space-y-2 pr-3">
                    {visibleMailboxLabels.map((label) => {
                      const active = selectedMailbox === label.name;
                      const count =
                        label.name === ALL_MAILBOX
                          ? undefined
                          : label.messages_unread > 0
                            ? label.messages_unread
                            : label.messages_total;
                      const visibleCount =
                        count !== undefined && count > 0 ? count : undefined;
                      const canRemove = !DEFAULT_VISIBLE_MAILBOXES.has(label.name);

                      return (
                        <div
                          key={label.id}
                          className={`grid min-w-0 items-center gap-2 ${
                            canRemove ? "grid-cols-[minmax(0,1fr)_2rem]" : "grid-cols-1"
                          }`}
                        >
                          <button
                            onClick={() => {
                              setSelectedMailbox(label.name);
                              if (label.name === ALL_MAILBOX) {
                              if (mode === "mail" && mailView === "ai") {
                                setMailView("raw");
                              }
                              if (isMailInsightsMode) {
                                setMailWorkspaceTab("triage");
                                setMode("mail");
                                setMailView("raw");
                              }
                              }
                            }}
                            className={`flex min-w-0 w-full items-center justify-between overflow-hidden rounded-2xl border px-3 py-2 text-left transition ${
                              active
                                ? "border-fuchsia-400/60 bg-[linear-gradient(135deg,rgba(189,147,249,0.22),rgba(40,42,54,0.95))] text-white shadow-[0_10px_28px_rgba(12,12,24,0.36)]"
                                : "border-white/8 bg-[rgba(29,31,50,0.75)] text-slate-200 hover:border-cyan-300/30 hover:bg-[rgba(37,40,63,0.92)]"
                            }`}
                          >
                            <span className="truncate text-sm font-medium">
                              {label.name === JARVIS_REVIEW_MAILBOX
                                ? "Jarvis Review"
                                : label.name === ALL_MAILBOX
                                  ? "All Mail"
                                  : label.name}
                            </span>
                            {visibleCount !== undefined ? (
                              <span
                                className={`ml-3 shrink-0 text-xs ${
                                  active ? "text-fuchsia-100" : "text-slate-400"
                                }`}
                              >
                                {visibleCount}
                              </span>
                            ) : null}
                          </button>

                          {canRemove ? (
                            <Button
                              size="icon"
                              variant="outline"
                              className="h-8 w-8 shrink-0 rounded-xl p-0"
                              onClick={() => {
                                setExtraVisibleMailboxes((current) =>
                                  current.filter((name) => name !== label.name)
                                );
                                if (selectedMailbox === label.name) {
                                  setSelectedMailbox(ALL_MAILBOX);
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>

                  {hiddenMailboxLabels.length > 0 ? (
                    <div className="mt-4 space-y-2 border-t border-white/8 pt-4 pr-3">
                      <button
                        type="button"
                        onClick={() => setMailboxAddOpen((current) => !current)}
                        className="flex w-full items-center justify-between gap-3 text-left"
                      >
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Add To Sidebar
                        </div>
                        {mailboxAddOpen ? (
                          <ChevronDown className="h-4 w-4 text-slate-400" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-slate-400" />
                        )}
                      </button>
                      {mailboxAddOpen ? (
                        <div className="grid gap-2">
                          {hiddenMailboxLabels.map((label) => (
                            <Button
                              key={label.id}
                              size="sm"
                              variant="outline"
                              className="w-full min-w-0 justify-start overflow-hidden rounded-2xl"
                              onClick={() =>
                                setExtraVisibleMailboxes((current) =>
                                  current.includes(label.name) ? current : [...current, label.name]
                                )
                              }
                            >
                              <Plus className="mr-2 h-4 w-4 shrink-0" />
                              <span className="min-w-0 truncate">
                                {label.name === JARVIS_REVIEW_MAILBOX
                                  ? "Jarvis Review"
                                  : label.name === ALL_MAILBOX
                                    ? "All Mail"
                                    : label.name}
                              </span>
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </ScrollArea>
              </CardContent>
            </Card>
          ) : null}

          <Card className="min-w-0 rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      {isScheduleWorkspaceMode ? (
                        <CalendarDays className="h-5 w-5" />
                      ) : (
                        <Mail className="h-5 w-5" />
                      )}
                      {isMailWorkspaceMode
                        ? selectedMailboxLabel?.name === JARVIS_REVIEW_MAILBOX
                          ? "Jarvis Review"
                          : selectedMailboxLabel?.name === ALL_MAILBOX
                            ? "All Mail"
                            : selectedMailboxLabel?.name || "Mailbox"
                        : isScheduleWorkspaceMode
                          ? "Schedule"
                        : classifiedBucket === "important"
                          ? "Important review"
                          : classifiedBucket === "unimportant"
                            ? "Unimportant review"
                            : "AI overview"}
                    </CardTitle>
                    {!isScheduleWorkspaceMode ? (
                      <p className="mt-2 text-sm leading-6 text-slate-300">
                        {isMailInsightsMode
                          ? "Saved AI trends and summaries for the selected mailbox."
                          : isRawMailView
                            ? "Browse loaded Gmail threads and adjust conversation state."
                            : "Review conversations on the left, then work the selected item in focused detail."}
                      </p>
                    ) : null}
                  </div>
                  {!isScheduleWorkspaceMode ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => setMailSidebarOpen((current) => !current)}
                    >
                      {mailSidebarOpen ? "Hide mailboxes" : "Show mailboxes"}
                    </Button>
                  ) : null}
                </div>

                {!isScheduleWorkspaceMode ? (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search subject, sender, category..."
                      className="rounded-2xl pl-9"
                    />
                  </div>
                ) : null}
              </div>

              {isMailWorkspaceMode ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={mailWorkspaceTab === "triage" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => setMailWorkspaceTab("triage")}
                  >
                    Triage
                  </Button>
                  <Button
                    size="sm"
                    variant={mailWorkspaceTab === "insights" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => {
                      if (selectedMailbox === ALL_MAILBOX || selectedMailbox === JARVIS_REVIEW_MAILBOX) {
                        setSelectedMailbox(IMPORTANT_LABEL);
                      }
                      setMailWorkspaceTab("insights");
                    }}
                  >
                    Insights
                  </Button>
                  {mailWorkspaceTab === "triage" ? (
                    <>
                      <Button
                        size="sm"
                        variant={mailView === "ai" ? "default" : "outline"}
                        className="rounded-2xl"
                        onClick={() => setMailView("ai")}
                      >
                        AI
                      </Button>
                      <Button
                        size="sm"
                        variant={mailView === "raw" ? "default" : "outline"}
                        className="rounded-2xl"
                        onClick={() => setMailView("raw")}
                      >
                        Raw
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}

              {isScheduleWorkspaceMode ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={scheduleWorkspaceTab === "agenda" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => setScheduleWorkspaceTab("agenda")}
                  >
                    Agenda
                  </Button>
                  <Button
                    size="sm"
                    variant={scheduleWorkspaceTab === "planner" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => setScheduleWorkspaceTab("planner")}
                  >
                    Planner
                  </Button>
                </div>
              ) : null}

              {isMailWorkspaceMode ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="1"
                    value={inboxLimit}
                    onChange={(e) => setInboxLimit(e.target.value)}
                    className="w-32 rounded-2xl"
                    placeholder={isRawMailView ? "Page size" : "Summary cap"}
                  />
                  <div className="text-xs text-slate-400">
                    {isRawMailView ? "Threads per page" : "Items to summarize"}
                  </div>
                </div>
              ) : null}

              {isScheduleAgendaMode ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="1"
                    max="60"
                    value={scheduleDays}
                    onChange={(e) => setScheduleDays(e.target.value)}
                    className="w-28 rounded-2xl"
                    placeholder="Days"
                  />
                  <div className="text-xs text-slate-400">Days ahead</div>
                </div>
              ) : null}

              {isRawMailView ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-slate-400">
                    Showing one row per loaded thread on this page.
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => {
                        const history = [...rawPageHistory];
                        const previousToken = history.pop() ?? null;
                        setRawPageHistory(history);
                        void loadEmails("mail", selectedMailbox, previousToken, "raw");
                      }}
                      disabled={loading || !rawHasPreviousPage}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => {
                        if (!rawNextPageToken) return;
                        setRawPageHistory((current) => [...current, rawPageToken ?? ""]);
                        void loadEmails("mail", selectedMailbox, rawNextPageToken, "raw");
                      }}
                      disabled={loading || !rawNextPageToken}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardHeader>

            <CardContent className="min-w-0 overflow-hidden">
              {error ? (
                <div className="mb-4 flex items-start gap-3 rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
                  <AlertCircle className="mt-0.5 h-4 w-4" />
                  <div>{error}</div>
                </div>
              ) : null}

              <ScrollArea className="h-[65vh] w-full min-w-0 overflow-hidden pr-3">
                <div className="w-full min-w-0 max-w-full space-y-3 overflow-x-hidden">
                  {isMailInsightsMode ? (
                    overview ? (
                      <div className="space-y-4">
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Cached emails
                            </div>
                            <div className="mt-1 text-2xl font-semibold">
                              {overview.total_cached}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Needs reply
                            </div>
                            <div className="mt-1 text-2xl font-semibold">
                              {overview.needs_reply}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Action items
                            </div>
                            <div className="mt-1 text-2xl font-semibold">
                              {overview.action_item_count}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Deadlines found
                            </div>
                            <div className="mt-1 text-2xl font-semibold">
                              {overview.deadlines_found}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Categories
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {Object.entries(overview.categories).map(([category, count]) => (
                                <Badge key={category} variant="outline" className="rounded-xl">
                                  {category.replaceAll("_", " ")}: {count}
                                </Badge>
                              ))}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Top senders
                            </div>
                            <div className="mt-3 space-y-2 text-sm text-slate-200">
                              {overview.top_senders.length === 0 ? (
                                <div className="text-slate-400">No cached sender data yet.</div>
                              ) : (
                                overview.top_senders.map((item) => (
                                  <div key={item.sender} className="flex items-center justify-between">
                                    <span className="truncate pr-4">{item.sender}</span>
                                    <span className="text-slate-400">{item.count}</span>
                                  </div>
                                ))
                              )}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Actionable emails
                            </div>
                            <div className="mt-3 space-y-2 text-sm text-slate-200">
                              {overview.top_action_items.length === 0 ? (
                                <div className="text-slate-400">No saved action items yet.</div>
                              ) : (
                                overview.top_action_items.map((item) => (
                                  <button
                                    key={`${item.message_id}-${item.text}`}
                                    type="button"
                                    onClick={() => void openOverviewEmail(item.message_id)}
                                    className="w-full rounded-xl border border-white/6 bg-[rgba(35,37,58,0.78)] px-3 py-2 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.92)]"
                                  >
                                    <div className="text-sm text-slate-100">{item.text}</div>
                                    <div className="mt-1 text-xs text-slate-400">
                                      {item.subject} · {item.sender}
                                      {item.count > 1 ? ` · ${item.count} emails` : ""}
                                    </div>
                                  </button>
                                ))
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      </div>
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        No cached overview yet. Open Mail in AI mode on this mailbox to build it.
                      </div>
                    )
                  ) : null}

                  {isScheduleAgendaMode ? (
                    agenda && agenda.items.length > 0 ? (
                      <div className="space-y-4">
                        {agendaDayGroups.map((group) => (
                          <div key={group.key} className="space-y-2">
                            <div className="sticky top-0 z-10 rounded-xl border border-white/8 bg-[rgba(20,22,37,0.94)] px-3 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400 backdrop-blur">
                              {group.label}
                            </div>
                            <div className="space-y-2">
                              {group.items.map((item) => (
                                <button
                                  key={item.event_id}
                                  onClick={() => setSelectedId(item.event_id)}
                                  className={`w-full rounded-2xl border p-4 text-left transition hover:shadow-sm ${
                                    selectedId === item.event_id
                                      ? "border-cyan-300/40 bg-[linear-gradient(135deg,rgba(139,233,253,0.18),rgba(35,37,58,0.96))]"
                                      : "border-white/8 bg-[rgba(29,31,50,0.75)]"
                                  }`}
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm font-semibold text-slate-100">
                                        {item.title}
                                      </div>
                                      <div className="mt-1 text-sm text-cyan-100">
                                        {formatScheduleTimeRange(item)}
                                      </div>
                                      {item.location ? (
                                        <div className="mt-1 text-xs text-slate-400">
                                          {item.location}
                                        </div>
                                      ) : null}
                                    </div>
                                    <Badge variant="outline" className="rounded-xl">
                                      {item.is_all_day ? "All day" : "Timed"}
                                    </Badge>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        No upcoming events found.
                      </div>
                    )
                  ) : null}

                  {!isMailInsightsMode &&
                  !isScheduleWorkspaceMode &&
                  displayEmails.length === 0 &&
                  !loading &&
                  !cleanupLoading ? (
                    <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                      No emails found.
                    </div>
                  ) : null}
                  {!isMailInsightsMode && !isScheduleWorkspaceMode &&
                    displayEmails.map((email) => {
                    const threadCount = threadCountByEmailId.get(email.id) ?? 1;
                    return (
                      <div key={email.id} className="space-y-2">
                        <EmailListItem
                          email={email}
                          selected={selectedEmail?.id === email.id}
                          onClick={() => setSelectedId(email.id)}
                        />
                        {isRawMailView && threadCount > 1 ? (
                          <div className="px-3 text-xs text-zinc-500">
                            {threadCount} messages loaded in this thread
                          </div>
                        ) : null}
                      </div>
                    );
                    })}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="min-w-0 rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
            <CardHeader>
              <CardTitle className="text-lg">
                {isMailInsightsMode
                  ? "Overview detail"
                  : isScheduleAgendaMode
                    ? "Event detail"
                    : "Email detail"}
              </CardTitle>
            </CardHeader>

            <CardContent>
              {isScheduleAgendaMode ? (
                <div className="space-y-4">
                  <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4 text-sm text-slate-300">
                    Upcoming events from your primary Google Calendar, organized as a day-by-day agenda.
                  </div>
                  <div className="rounded-[1.6rem] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(21,27,45,0.92),rgba(34,36,58,0.76))] p-4">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                      <Plus className="h-4 w-4" />
                      Quick add
                    </div>
                    <div className="mt-2 text-sm leading-6 text-slate-300">
                      Describe an event in plain English and add it straight to Google Calendar without a review step.
                    </div>
                    <textarea
                      value={quickCalendarPrompt}
                      onChange={(e) => setQuickCalendarPrompt(e.target.value)}
                      placeholder="Example: Lunch with Sam tomorrow at 12:30 PM at Aubergine Kitchen for 1 hour."
                      className="mt-4 min-h-[112px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
                    />
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <Button
                        className="rounded-2xl"
                        onClick={() => void createQuickCalendarEvent()}
                        disabled={quickCalendarLoading || !quickCalendarPrompt.trim()}
                      >
                        <CalendarDays className="mr-2 h-4 w-4" />
                        {quickCalendarLoading ? "Adding..." : "Add directly to Calendar"}
                      </Button>
                      <div className="text-xs text-slate-400">
                        Best with a clear day and time.
                      </div>
                    </div>
                    {quickCalendarResult ? (
                      <div className="mt-4 rounded-[1.2rem] border border-emerald-300/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
                        <div className="font-medium text-emerald-50">
                          Added {quickCalendarResult.title || "event"} to Google Calendar.
                        </div>
                        <div className="mt-1 text-emerald-100/90">
                          {quickCalendarResult.start
                            ? formatScheduleDateTime(
                                quickCalendarResult.start,
                                quickCalendarResult.is_all_day
                              )
                            : "Scheduled"}
                          {quickCalendarResult.end && !quickCalendarResult.is_all_day
                            ? ` - ${formatScheduleDateTime(quickCalendarResult.end)}`
                            : ""}
                        </div>
                        {quickCalendarResult.html_link ? (
                          <a
                            href={quickCalendarResult.html_link}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-block text-sm text-emerald-50 underline decoration-emerald-200/40 underline-offset-4"
                          >
                            Open event
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {agenda ? (
                    (() => {
                      if (!selectedAgendaEvent) {
                        return (
                          <div className="rounded-[1.6rem] border border-dashed border-white/10 p-8 text-sm text-slate-400">
                            No event selected.
                          </div>
                        );
                      }

                      return (
                        <div className="space-y-3">
                          <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                            <div className="text-xl font-semibold text-slate-100">
                              {selectedAgendaEvent.title}
                            </div>
                            <div className="mt-3 inline-flex items-center rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-cyan-100">
                              {formatScheduleTimeRange(selectedAgendaEvent)}
                            </div>
                            <div className="mt-4 grid gap-3 md:grid-cols-2">
                              <div className="rounded-2xl border border-white/6 bg-[rgba(20,22,37,0.82)] p-4">
                                <div className="text-xs uppercase tracking-wide text-slate-400">
                                  Starts
                                </div>
                                <div className="mt-1 text-sm text-slate-200">
                                  {formatScheduleDateTime(
                                    selectedAgendaEvent.start,
                                    selectedAgendaEvent.is_all_day
                                  )}
                                </div>
                              </div>
                              <div className="rounded-2xl border border-white/6 bg-[rgba(20,22,37,0.82)] p-4">
                                <div className="text-xs uppercase tracking-wide text-slate-400">
                                  Ends
                                </div>
                                <div className="mt-1 text-sm text-slate-200">
                                  {selectedAgendaEvent.end
                                    ? formatScheduleDateTime(
                                        selectedAgendaEvent.end,
                                        selectedAgendaEvent.is_all_day
                                      )
                                    : selectedAgendaEvent.is_all_day
                                      ? "End of day"
                                      : "No end time"}
                                </div>
                              </div>
                            </div>
                            <div className="mt-4">
                              <Button
                                size="sm"
                                variant="outline"
                                className="rounded-2xl"
                                onClick={() => void createTaskFromCalendarItem(selectedAgendaEvent)}
                                disabled={calendarTaskLoadingId === selectedAgendaEvent.event_id}
                              >
                                {calendarTaskLoadingId === selectedAgendaEvent.event_id
                                  ? "Adding..."
                                  : "Create task from event"}
                              </Button>
                            </div>
                            {selectedAgendaEvent.location ? (
                              <div className="mt-4 text-sm text-slate-200">
                                <span className="font-medium text-slate-100">Location:</span>{" "}
                                {selectedAgendaEvent.location}
                              </div>
                            ) : null}
                            {selectedAgendaEvent.description ? (
                              <div className="mt-3 text-sm text-slate-200">
                                {selectedAgendaEvent.description}
                              </div>
                            ) : null}
                            {selectedAgendaEvent.html_link ? (
                              <a
                                href={selectedAgendaEvent.html_link}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-3 inline-block text-sm text-cyan-200 underline decoration-cyan-300/40 underline-offset-4"
                              >
                                Open in Google Calendar
                              </a>
                            ) : null}
                          </div>
                        </div>
                      );
                    })()
                  ) : null}
                </div>
              ) : isMailInsightsMode ? (
                <div className="space-y-4">
                  <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4 text-sm text-slate-300">
                    Saved AI summaries are reused here so this tab can show trends without
                    rerunning the classifier on every message.
                  </div>
                  {overview ? (
                    <div className="space-y-3">
                      <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Urgency mix
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {Object.entries(overview.urgency).map(([level, count]) => (
                            <Badge key={level} variant="outline" className="rounded-xl">
                              {level}: {count}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Time-sensitive emails
                        </div>
                        <div className="mt-3 space-y-2 text-sm text-slate-200">
                          {overview.deadline_highlights.length === 0 ? (
                            <div className="text-slate-400">No saved deadline hints yet.</div>
                          ) : (
                            overview.deadline_highlights.map((deadline) => (
                              <button
                                key={`${deadline.message_id}-${deadline.text}`}
                                type="button"
                                onClick={() => void openOverviewEmail(deadline.message_id)}
                                className="w-full rounded-xl border border-white/6 bg-[rgba(20,22,37,0.85)] px-3 py-2 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(32,35,57,0.96)]"
                              >
                                <div className="text-sm text-slate-100">{deadline.text}</div>
                                <div className="mt-1 text-xs text-slate-400">
                                  {deadline.subject} · {deadline.sender}
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : !selectedEmail ? (
                <div className="rounded-[1.6rem] border border-dashed border-white/10 p-8 text-sm text-slate-400">
                  Select an email to view details.
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="rounded-[1.8rem] border border-cyan-300/14 bg-[linear-gradient(135deg,rgba(56,189,248,0.12),rgba(35,37,58,0.92))] p-5">
                    <div className="text-xs uppercase tracking-[0.2em] text-cyan-100/80">
                      Message focus
                    </div>
                    <h2 className="mt-3 text-2xl font-semibold leading-tight text-slate-100">
                      {decodeHtmlEntities(selectedEmail.subject) || "(No subject)"}
                    </h2>
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-200">
                        {decodeHtmlEntities(selectedEmail.sender) || "Unknown sender"}
                      </span>
                      {selectedEmail.date ? (
                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                          {selectedEmail.date}
                        </span>
                      ) : null}
                      {isByuEmail(selectedEmail) ? (
                        <span className="rounded-full border border-sky-300/25 bg-sky-500/14 px-2.5 py-1 text-sky-100">
                          BYU forwarded mail
                        </span>
                      ) : null}
                      {isRawMailView && selectedThreadCount > 1 ? (
                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                          {selectedThreadCount} messages in loaded thread
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                    <div className="mb-3 text-xs uppercase tracking-wide text-slate-400">
                      Quick actions
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {canMarkHandled ? (
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          onClick={() => void markHandled()}
                          disabled={handleLoading}
                        >
                          {handleLoading ? "Marking..." : "Mark handled"}
                        </Button>
                      ) : null}
                      {isAiMailView ? (
                        <>
                          <Button
                            className="rounded-2xl"
                            size="sm"
                            variant="outline"
                            onClick={() => void correctClassification("important")}
                            disabled={emailActionLoading || !canMarkImportant}
                          >
                            Mark Jarvis Important
                          </Button>
                          <Button
                            className="rounded-2xl"
                            size="sm"
                            variant="outline"
                            onClick={() => void correctClassification("unimportant")}
                            disabled={emailActionLoading || !canMarkUnimportant}
                          >
                            Mark Jarvis Unimportant
                          </Button>
                        </>
                      ) : null}
                      {!calendarPreview ? (
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          variant="outline"
                          onClick={() => void loadCalendarPreview(selectedEmail.id)}
                          disabled={calendarLoading}
                        >
                          <CalendarDays className="mr-2 h-4 w-4" />
                          {calendarLoading ? "Loading..." : "Generate calendar suggestion"}
                        </Button>
                      ) : (
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          onClick={() => void createCalendarEvent()}
                          disabled={calendarCreateLoading || !calendarPreview.start}
                        >
                          <CalendarDays className="mr-2 h-4 w-4" />
                          {calendarCreateLoading ? "Creating..." : "Add to Calendar"}
                        </Button>
                      )}
                    </div>
                    <div className="mt-3 text-xs text-slate-400">
                      {canMarkHandled
                        ? "Handled marks the conversation reviewed and clears Jarvis importance labels."
                        : calendarPreview
                          ? "Quick actions now include calendar follow-through once a suggestion exists."
                          : "Use quick actions to correct the Jarvis bucket or generate a calendar suggestion."}
                    </div>
                  </div>

                  {selectedEmail.classification?.short_summary ||
                  selectedEmail.classification?.why_it_matters ||
                  selectedEmail.classification?.action_items?.length ||
                  selectedEmail.classification?.deadline_hint ||
                  selectedEmail.classification?.suggested_reply ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="mb-3 text-xs uppercase tracking-wide text-slate-400">
                        AI reading
                      </div>
                      {selectedEmail.classification?.short_summary ? (
                        <div className="rounded-[1rem] border border-cyan-300/16 bg-cyan-400/8 px-4 py-3 text-sm leading-6 text-slate-100">
                          {selectedEmail.classification.short_summary}
                        </div>
                      ) : null}
                      {selectedEmail.classification?.why_it_matters ? (
                        <div className="mt-3 text-sm leading-6 text-slate-300">
                          {selectedEmail.classification.why_it_matters}
                        </div>
                      ) : null}
                      {selectedEmail.classification?.action_items?.length ? (
                        <div className="mt-4 space-y-2">
                          {selectedEmail.classification.action_items.map((item) => (
                            <div
                              key={item}
                              className="rounded-xl border border-white/6 bg-[rgba(20,22,37,0.82)] px-3 py-2 text-sm text-slate-200"
                            >
                              {item}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {(selectedEmail.classification?.deadline_hint ||
                        selectedEmail.classification?.suggested_reply) ? (
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          {selectedEmail.classification?.deadline_hint ? (
                            <div className="rounded-[1rem] border border-white/6 bg-[rgba(20,22,37,0.82)] px-3 py-3">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Deadline hint
                              </div>
                              <div className="mt-1 text-sm text-slate-100">
                                {selectedEmail.classification.deadline_hint}
                              </div>
                            </div>
                          ) : null}
                          {selectedEmail.classification?.suggested_reply ? (
                            <div className="rounded-[1rem] border border-white/6 bg-[rgba(20,22,37,0.82)] px-3 py-3">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Suggested reply
                              </div>
                              <div className="mt-1 text-sm text-slate-100">
                                {selectedEmail.classification.suggested_reply}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {isRawMailView ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="mb-3 text-xs uppercase tracking-wide text-slate-400">
                        Conversation actions
                      </div>
                      <div className="mb-3 text-sm text-slate-300">
                        These actions apply to every loaded message in this Gmail thread.
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

                  {calendarLoading ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4 text-sm text-slate-300">
                      Loading calendar suggestion...
                    </div>
                  ) : null}

                  {calendarPreview ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                        <CalendarDays className="h-4 w-4" />
                        Calendar suggestion
                      </div>
                      <div className="space-y-2 text-sm text-slate-200">
                        <div>
                          <span className="font-medium text-slate-100">Title:</span>{" "}
                          {calendarPreview.title || "Untitled event"}
                        </div>
                        {calendarPreview.start ? (
                          <div>
                            <span className="font-medium text-slate-100">Start:</span>{" "}
                            {calendarPreview.start}
                          </div>
                        ) : null}
                        {calendarPreview.end ? (
                          <div>
                            <span className="font-medium text-slate-100">End:</span>{" "}
                            {calendarPreview.end}
                          </div>
                        ) : null}
                        {calendarPreview.location ? (
                          <div>
                            <span className="font-medium text-slate-100">Location:</span>{" "}
                            {calendarPreview.location}
                          </div>
                        ) : null}
                        {calendarPreview.notes ? (
                          <div>
                            <span className="font-medium text-slate-100">Notes:</span>{" "}
                            {calendarPreview.notes}
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          onClick={() => void createCalendarEvent()}
                          disabled={calendarCreateLoading || !calendarPreview.start}
                        >
                          <CalendarDays className="mr-2 h-4 w-4" />
                          {calendarCreateLoading ? "Creating..." : "Add to Calendar"}
                        </Button>
                        {calendarCreateLink ? (
                          <a
                            href={calendarCreateLink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-cyan-200 underline decoration-cyan-300/40 underline-offset-4"
                          >
                            Open event
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {isRawMailView ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <button
                        type="button"
                        onClick={() => setLabelSectionOpen((current) => !current)}
                        className="flex w-full items-center justify-between gap-3 text-left"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                            <Tag className="h-4 w-4" />
                            Labels
                          </div>
                          <div className="mt-1 text-sm text-slate-300">
                            Review or adjust Gmail labels for this conversation.
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-slate-400">
                          <Badge variant="outline" className="rounded-xl">
                            {labelDraft.length}
                          </Badge>
                          {labelSectionOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </div>
                      </button>
                      {labelSectionOpen ? (
                        <div className="mt-4">
                          <div className="mb-4 flex flex-wrap gap-2">
                            {editableLabels.map((label) => {
                              const checked = labelDraft.includes(label.name);
                              return (
                                <label
                                  key={label.id}
                                  className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                                    checked
                                      ? "border-cyan-300/40 bg-[rgba(56,189,248,0.14)] text-slate-100"
                                      : "border-white/8 bg-[rgba(20,22,37,0.82)] text-slate-300"
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
                    </div>
                  ) : null}

                  {selectedEmail.cleanupDecision ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
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
                      <p className="text-sm text-slate-200">
                        {selectedEmail.cleanupDecision.reason}
                      </p>
                    </div>
                  ) : null}

                  {selectedEmail.classification ? (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <Card className="rounded-2xl border border-white/6 bg-[rgba(35,37,58,0.7)] shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">
                            Category
                          </div>
                          <div className="mt-1 text-base font-medium text-slate-100">
                            {selectedEmail.classification.category || "Unknown"}
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="rounded-2xl border border-white/6 bg-[rgba(35,37,58,0.7)] shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">
                            Importance
                          </div>
                          <div className="mt-1 text-base font-medium text-slate-100">
                            {selectedEmail.classification.importance_score || "—"}/10
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="rounded-2xl border border-white/6 bg-[rgba(35,37,58,0.7)] shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">
                            Suggested action
                          </div>
                          <div className="mt-1 text-base font-medium text-slate-100">
                            {selectedEmail.classification.suggested_action || "—"}
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  ) : null}

                  {selectedEmail.classification?.reason ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="mb-1 text-xs uppercase tracking-wide text-slate-400">
                        Why it was classified this way
                      </div>
                      <p className="text-sm text-slate-200">
                        {selectedEmail.classification.reason}
                      </p>
                    </div>
                  ) : null}

                  {selectedEmail.labels?.length ? (
                    <div>
                      <div className="mb-2 text-xs uppercase tracking-wide text-slate-400">
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
                    <div className="mb-2 text-xs uppercase tracking-wide text-slate-400">
                      Snippet
                    </div>
                    <p className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4 text-sm leading-6 text-slate-200">
                      {decodeHtmlEntities(selectedEmail.snippet) || "No snippet available."}
                    </p>
                  </div>

                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wide text-slate-400">
                      Body preview
                    </div>
                    <div className="max-h-[40vh] overflow-auto rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="whitespace-pre-wrap text-sm leading-6 text-slate-200">
                        {decodeHtmlEntities(selectedEmail.body) || "No body text extracted."}
                      </div>
                      {selectedEmail.links?.length ? (
                        <div className="mt-4 border-t border-white/8 pt-4">
                          <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
                            Message links
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {selectedEmail.links.map((link, index) => (
                              <Button
                                key={`${link.url}-${index}`}
                                asChild
                                variant={link.kind === "button" ? "default" : "outline"}
                                size="sm"
                                className="rounded-2xl"
                              >
                                <a href={link.url} target="_blank" rel="noreferrer">
                                  <ExternalLink className="mr-2 h-4 w-4" />
                                  {decodeHtmlEntities(link.label) || "Open link"}
                                </a>
                              </Button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="rounded-[1.6rem] border border-dashed border-white/10 bg-[rgba(20,22,37,0.45)] p-4 text-sm text-slate-400">
                    <div className="mb-2 flex items-center gap-2 font-medium text-slate-200">
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
        )}
      </div>
    </div>
  );
}
