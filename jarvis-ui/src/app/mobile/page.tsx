"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import React, { Suspense, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  Activity,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  CheckCircle2,
  Ellipsis,
  ChevronRight,
  House,
  Mail,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Smartphone,
} from "lucide-react";
import { AssistantPanel } from "@/components/assistant-panel";
import { MovementMap } from "@/components/movement-map";
import { saveTerrainExplorerSession } from "@/components/terrain-explorer-session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";
const LIVE_MOVEMENT_REFRESH_MS = 15000;
const KM_TO_MILES = 0.621371;
const KG_TO_POUNDS = 2.20462;
const ML_TO_FLUID_OUNCES = 0.033814;

type MobileTab = "today" | "assistant" | "mail" | "tasks" | "journal" | "schedule" | "health" | "more";
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
  health_summary?: DashboardHealthSummary | null;
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
  visits: Array<{
    arrival?: string | null;
    departure?: string | null;
    latitude: number;
    longitude: number;
    horizontal_accuracy_m?: number | null;
    label?: string | null;
  }>;
  route_points: Array<{
    timestamp: string;
    latitude: number;
    longitude: number;
    horizontal_accuracy_m?: number | null;
  }>;
  place_labels: string[];
  synced_at?: string | null;
};

type MovementListResponse = {
  entries: MovementDailyEntry[];
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
  route_points: Array<{
    timestamp: string;
    latitude: number;
    longitude: number;
    altitude_m?: number | null;
    horizontal_accuracy_m?: number | null;
    vertical_accuracy_m?: number | null;
  }>;
  synced_at?: string | null;
};

type WorkoutListResponse = {
  workouts: WorkoutEntry[];
};

type PlannedRouteOverlay = {
  name: string;
  points: Array<{
    latitude: number;
    longitude: number;
  }>;
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

type GoogleOAuthStatus = {
  authorized: boolean;
  start_path?: string;
  instructions?: string;
};

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

function formatScheduleDateTime(value: string | null | undefined, isAllDay = false) {
  if (!value) return "Not scheduled";
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;

  return new Intl.DateTimeFormat(undefined, isAllDay
    ? { weekday: "short", month: "short", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
  ).format(parsed);
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
  if (start && end) return `${formatScheduleTime(start)} to ${formatScheduleTime(end)}`;
  if (start) return `Started ${formatScheduleTime(start)}`;
  if (end) return `Ended ${formatScheduleTime(end)}`;
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
  const items = entry.visits.map((visit, index) => {
    const arrivalText = formatTimeOnly(visit.arrival);
    const departureText = formatTimeOnly(visit.departure);
    const stayMinutes = minutesBetween(visit.arrival, visit.departure);

    return {
      id: `${visit.latitude}-${visit.longitude}-${index}`,
      title: formatMovementVisitTitle(visit, index),
      detail:
        arrivalText && departureText
          ? `${arrivalText} to ${departureText}`
          : arrivalText
          ? `Arrived ${arrivalText}`
          : departureText
          ? `Departed ${departureText}`
          : "Visit detected",
      meta: stayMinutes ? `${formatMinutes(stayMinutes)} there` : null,
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
  const [googleAuthStatus, setGoogleAuthStatus] = useState<GoogleOAuthStatus | null>(null);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [healthEntries, setHealthEntries] = useState<HealthDailyEntry[]>([]);
  const [selectedHealthDate, setSelectedHealthDate] = useState<string | null>(null);
  const [movementEntries, setMovementEntries] = useState<MovementDailyEntry[]>([]);
  const [workoutEntries, setWorkoutEntries] = useState<WorkoutEntry[]>([]);
  const [expandedMetricsOpen, setExpandedMetricsOpen] = useState(false);
  const [healthRoutesTab, setHealthRoutesTab] = useState<"overview" | "routes">("overview");
  const [plannedRouteOverlay, setPlannedRouteOverlay] = useState<PlannedRouteOverlay | null>(null);
  const [plannedRouteError, setPlannedRouteError] = useState("");
  const [selectedTerrainExplorerId, setSelectedTerrainExplorerId] = useState<string | null>(null);
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
  const healthSummary = dashboard?.health_summary ?? null;
  const hasLoadedJournalRef = useRef(false);
  const hasLoadedScheduleRef = useRef(false);
  const latestHealthDate = healthEntries[0]?.date ?? healthSummary?.today_entry?.date ?? formatLocalDateKey(new Date());
  const earliestHealthDate = healthEntries[healthEntries.length - 1]?.date ?? latestHealthDate;
  const activeHealthDate = selectedHealthDate ?? latestHealthDate;
  const selectedHealthEntry = healthEntries.find((entry) => entry.date === activeHealthDate)
    ?? (healthSummary?.today_entry?.date === activeHealthDate ? healthSummary.today_entry : null);
  const currentMovementEntry = movementEntries[0] ?? null;
  const latestMovementEntry = movementEntries.find((entry) => entry.date === activeHealthDate) ?? null;
  const mappedWorkoutEntries = workoutEntries.filter((workout) => {
    const parsed = parseCalendarDate(workout.start_date);
    return parsed ? formatLocalDateKey(parsed) === activeHealthDate && workout.route_points.length > 1 : false;
  }).slice(0, 1);
  const movementStoryboard = latestMovementEntry ? buildMovementStoryboard(latestMovementEntry) : [];
  const hasMovementMap = Boolean(
    latestMovementEntry && (latestMovementEntry.route_points.length || latestMovementEntry.visits.length)
  );
  const terrainExplorerOptions = useMemo(
    () => [
      createBaseTerrainExplorerOption(),
      ...mappedWorkoutEntries.map((workout) => ({
        id: `workout-${workout.workout_id}`,
        label: formatWorkoutLabel(workout.activity_label, workout.activity_type),
        detail: formatScheduleDateTime(workout.start_date),
        entry: workoutToMapEntry(workout),
      })),
    ],
    [mappedWorkoutEntries]
  );
  const selectedTerrainExplorer =
    terrainExplorerOptions.find((option) => option.id === selectedTerrainExplorerId) ??
    terrainExplorerOptions[0] ??
    null;

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

  useEffect(() => {
    setPlannedRouteOverlay(null);
    setPlannedRouteError("");
  }, [selectedTerrainExplorerId, activeHealthDate]);

  const loadGoogleAuthStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/google/oauth/status`);
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as GoogleOAuthStatus;
      setGoogleAuthStatus(data);
    } catch {
      // Keep the mobile view usable even if auth status probing fails.
    }
  }, []);

  const loadJournal = useCallback(async (query = "") => {
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
      hasLoadedJournalRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load journal.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSchedule = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/calendar/schedule?days=7&max_results=24`);
      if (!response.ok) {
        throw new Error(`Schedule request failed with status ${response.status}`);
      }

      const data = (await response.json()) as CalendarAgendaResponse;
      setSchedule(data.items);
      hasLoadedScheduleRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedule.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [dashboardResponse, tasksResponse, healthResponse, movementResponse, journalResponse, workoutsResponse] = await Promise.all([
        fetch(`${API_BASE}/dashboard`),
        fetch(`${API_BASE}/tasks?include_completed=true`),
        fetch(`${API_BASE}/health?days=3650`),
        fetch(`${API_BASE}/movement?days=14`),
        fetch(`${API_BASE}/journal?days=3`),
        fetch(`${API_BASE}/workouts?days=90&limit=30`),
      ]);

      for (const response of [dashboardResponse, tasksResponse]) {
        if (!response.ok) {
          throw new Error(`Mobile page request failed with status ${response.status}`);
        }
      }

      const [dashboardData, tasksData] = await Promise.all([
        dashboardResponse.json() as Promise<DashboardResponse>,
        tasksResponse.json() as Promise<TaskListResponse>,
      ]);

      setDashboard(dashboardData);
      setTasks(tasksData.tasks);
      if (healthResponse.ok) {
        const healthData = (await healthResponse.json()) as HealthListResponse;
        const nextHealthEntries = [...healthData.entries].sort((left, right) => right.date.localeCompare(left.date));
        setHealthEntries(nextHealthEntries);
        setSelectedHealthDate((current) => current ?? nextHealthEntries[0]?.date ?? dashboardData.health_summary?.today_entry?.date ?? null);
      } else {
        setHealthEntries([]);
      }
      if (movementResponse.ok) {
        const movementData = (await movementResponse.json()) as MovementListResponse;
        setMovementEntries(movementData.entries);
      } else {
        setMovementEntries([]);
      }
      if (workoutsResponse.ok) {
        const workoutData = (await workoutsResponse.json()) as WorkoutListResponse;
        setWorkoutEntries(workoutData.workouts);
      } else {
        setWorkoutEntries([]);
      }
      if (journalResponse.ok) {
        const journalData = (await journalResponse.json()) as JournalResponse;
        setJournal(journalData.entries);
        hasLoadedJournalRef.current = true;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load mobile view.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void loadGoogleAuthStatus();
  }, [loadGoogleAuthStatus]);

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
      sourceContext: "mobile",
    });
    window.open(`/terrain-explorer?session=${encodeURIComponent(sessionId)}`, "jarvis-terrain-explorer");
  };

  const refreshLiveMovement = useEffectEvent(async () => {
    try {
      const [dashboardResponse, movementResponse] = await Promise.all([
        fetch(`${API_BASE}/dashboard`, { cache: "no-store" }),
        fetch(`${API_BASE}/movement?days=14`, { cache: "no-store" }),
      ]);

      if (dashboardResponse.ok) {
        const dashboardData = (await dashboardResponse.json()) as DashboardResponse;
        setDashboard(dashboardData);
      }

      if (movementResponse.ok) {
        const movementData = (await movementResponse.json()) as MovementListResponse;
        setMovementEntries(movementData.entries);
      }
    } catch {
      // Ignore background refresh hiccups and keep the current mobile view stable.
    }
  });

  useEffect(() => {
    if (activeTab !== "today" && activeTab !== "health") {
      return;
    }

    const poll = window.setInterval(() => {
      void refreshLiveMovement();
    }, LIVE_MOVEMENT_REFRESH_MS);

    return () => window.clearInterval(poll);
  }, [activeTab]);

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
    if (activeTab === "journal" && !hasLoadedJournalRef.current) {
      void loadJournal(journalQuery);
    }
  }, [activeTab, journalQuery, loadJournal]);

  useEffect(() => {
    if (activeTab === "schedule" && !hasLoadedScheduleRef.current) {
      void loadSchedule();
    }
  }, [activeTab, loadSchedule]);

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "today" || tab === "mail" || tab === "tasks" || tab === "journal" || tab === "schedule" || tab === "health") {
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
  const featuredMail = useMemo(
    () => dashboard?.important_emails[0] ?? null,
    [dashboard]
  );
  const nextCalendarItem = useMemo(
    () => dashboard?.calendar_items[0] ?? null,
    [dashboard]
  );
  const topFocusTasks = useMemo(
    () => activeTasks.slice(0, 3),
    [activeTasks]
  );
  const featuredJournalEntry = useMemo(
    () => journal[0] ?? null,
    [journal]
  );
  const todayStepCount = healthSummary?.today_entry?.steps ?? null;
  const todaySleepHours = healthSummary?.today_entry?.sleep_hours ?? healthSummary?.seven_day_avg_sleep_hours ?? null;
  const todayDistanceKm = currentMovementEntry?.total_distance_km ?? null;
  const attentionItems = [
    featuredMail ? "mail" : null,
    nextCalendarItem ? "calendar" : null,
    topFocusTasks[0] ? "task" : null,
  ].filter(Boolean).length;

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

  const primaryNavItems: Array<{ key: MobileTab; label: string; icon: React.ReactNode }> = [
    { key: "today", label: "Today", icon: <House className="h-4 w-4" /> },
    { key: "assistant", label: "Ask", icon: <Sparkles className="h-4 w-4" /> },
    { key: "mail", label: "Mail", icon: <Mail className="h-4 w-4" /> },
    { key: "tasks", label: "Tasks", icon: <CheckCircle2 className="h-4 w-4" /> },
    { key: "health", label: "Health", icon: <Activity className="h-4 w-4" /> },
    { key: "more", label: "More", icon: <Ellipsis className="h-4 w-4" /> },
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
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">
                  {dashboard?.date_label || "Today"}, with signal first
                </h1>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  {dashboard?.overview || "A tighter mobile home built around what needs attention next."}
                </p>
              </div>
              <Button asChild variant="outline" className="rounded-2xl">
                <Link href="/">Desktop</Link>
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-[1.4rem] border border-white/8 bg-white/5 p-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Needs attention</div>
                <div className="mt-2 text-2xl font-semibold text-white">{attentionItems}</div>
              </div>
              <div className="rounded-[1.4rem] border border-white/8 bg-white/5 p-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Steps</div>
                <div className="mt-2 text-2xl font-semibold text-white">{formatHealthStat(todayStepCount)}</div>
              </div>
              <div className="rounded-[1.4rem] border border-white/8 bg-white/5 p-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Distance</div>
                <div className="mt-2 text-2xl font-semibold text-white">{todayDistanceKm != null ? formatDistanceMiles(todayDistanceKm, 1) : "--"}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button className="h-12 rounded-2xl" onClick={() => setActiveTab("assistant")}>
                <Sparkles className="mr-2 h-4 w-4" />
                Ask Jarvis
              </Button>
              <Button variant="outline" className="h-12 rounded-2xl" onClick={() => setActiveTab("tasks")}>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Focus list
              </Button>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-slate-300">
                {featuredMail?.needs_reply
                  ? "You have at least one message that likely needs a reply."
                  : nextCalendarItem
                    ? "Your next event is already queued below."
                    : "This view stays focused on what you can act on quickly."}
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

        {(googleAuthStatus ? !googleAuthStatus.authorized : false) || isGoogleAuthIssue(error) ? (
          <div className="rounded-[1.4rem] border border-cyan-300/15 bg-cyan-400/10 px-4 py-4 text-sm text-cyan-50">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <ShieldCheck className="h-4 w-4 text-cyan-200" />
              Google connection
            </div>
            <div className="mt-2 leading-6 text-cyan-100/85">
              {googleAuthStatus?.authorized
                ? "Google is connected, but the latest Gmail or Calendar request looks like it needs re-authorization."
                : googleAuthStatus?.instructions || "Connect Google so this running container can reach Gmail and Calendar."}
            </div>
            <Button asChild variant="outline" className="mt-3 rounded-2xl border-cyan-200/30 bg-white/5 text-cyan-50 hover:bg-white/10">
              <a href={googleAuthStatus?.start_path || `${API_BASE}/google/oauth/start`}>
                Connect Google
              </a>
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-3 gap-2">
          {primaryNavItems.map((item) => (
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
                <CardTitle className="text-lg">What matters now</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  {featuredMail ? (
                    <button
                      type="button"
                      onClick={() => setActiveTab("mail")}
                      className="w-full rounded-[1.2rem] border border-fuchsia-300/18 bg-fuchsia-400/8 px-4 py-4 text-left transition hover:border-fuchsia-200/30 hover:bg-fuchsia-400/12"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-fuchsia-100/80">Important mail</div>
                          <div className="mt-2 text-sm font-semibold text-white">{featuredMail.subject || "Untitled message"}</div>
                          <div className="mt-1 text-xs text-fuchsia-100">{featuredMail.sender}</div>
                        </div>
                        <Badge className="rounded-xl border border-fuchsia-300/30 bg-black/10 text-fuchsia-50">
                          {featuredMail.needs_reply ? "Reply" : featuredMail.urgency}
                        </Badge>
                      </div>
                      <div className="mt-3 text-sm leading-6 text-slate-200">
                        {featuredMail.summary || featuredMail.why_it_matters || "Open mail to review the top thread."}
                      </div>
                    </button>
                  ) : null}

                  {nextCalendarItem ? (
                    <button
                      type="button"
                      onClick={() => setActiveTab("schedule")}
                      className="w-full rounded-[1.2rem] border border-cyan-300/18 bg-cyan-400/8 px-4 py-4 text-left transition hover:border-cyan-200/30 hover:bg-cyan-400/12"
                    >
                      <div className="text-[11px] uppercase tracking-[0.18em] text-cyan-100/80">Next on your calendar</div>
                      <div className="mt-2 text-sm font-semibold text-white">{nextCalendarItem.title}</div>
                      <div className="mt-1 text-xs text-cyan-100">
                        {formatScheduleDateTime(nextCalendarItem.start, nextCalendarItem.is_all_day)}
                      </div>
                    </button>
                  ) : null}

                  {topFocusTasks[0] ? (
                    <button
                      type="button"
                      onClick={() => setActiveTab("tasks")}
                      className="w-full rounded-[1.2rem] border border-emerald-300/18 bg-emerald-400/8 px-4 py-4 text-left transition hover:border-emerald-200/30 hover:bg-emerald-400/12"
                    >
                      <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-100/80">Top task</div>
                      <div className="mt-2 text-sm font-semibold text-white">{topFocusTasks[0].title}</div>
                      <div className="mt-1 text-xs text-emerald-100">
                        {topFocusTasks[0].due_text || `${activeTasks.length} open tasks in queue`}
                      </div>
                      {topFocusTasks[0].detail ? (
                        <div className="mt-3 text-sm leading-6 text-slate-200">{topFocusTasks[0].detail}</div>
                      ) : null}
                    </button>
                  ) : null}

                  {!featuredMail && !nextCalendarItem && !topFocusTasks[0] && !loading ? (
                    <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                      Nothing urgent is surfaced right now. Use Ask for a broader scan.
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Focus lane</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {topFocusTasks.map((task) => (
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
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" className="rounded-2xl" onClick={() => setActiveTab("assistant")}>
                    Ask what to do
                  </Button>
                  <Button variant="outline" className="rounded-2xl" onClick={() => setActiveTab("tasks")}>
                    Open tasks
                  </Button>
                </div>
                {!activeTasks.length && !loading ? (
                  <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                    No open tasks right now.
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Body and movement</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <button
                  type="button"
                  onClick={() => setActiveTab("health")}
                  className="w-full rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3 text-left"
                >
                  <div className="text-sm font-medium text-white">
                    {formatHealthStat(todayStepCount)} steps · {todayDistanceKm != null ? formatDistanceMiles(todayDistanceKm, 1) : "--"}
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    Sleep {formatHealthStat(todaySleepHours, 1)} hr · Resting HR {formatHealthStat(dashboard?.health_summary?.today_entry?.resting_heart_rate)} bpm
                  </div>
                  <div className="mt-2 text-sm leading-6 text-slate-300">
                    {movementEntries[0]?.movement_story
                      ? movementEntries[0].movement_story
                      : dashboard?.health_summary
                      ? `${dashboard.health_summary.streak_days} day movement streak and ${dashboard.health_summary.recent_entries.length} synced days.`
                      : "No health data synced yet."}
                  </div>
                </button>
              </CardContent>
            </Card>

            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Reflection and context</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {featuredJournalEntry ? (
                  <Link
                    href={`/mobile/journal/${featuredJournalEntry.date}`}
                    className="block rounded-[1.2rem] border border-amber-300/18 bg-amber-400/8 px-4 py-4 transition hover:border-amber-200/30 hover:bg-amber-400/12"
                  >
                    <div className="text-[11px] uppercase tracking-[0.18em] text-amber-100/80">Recent journal</div>
                    <div className="mt-2 text-sm font-semibold text-white">{featuredJournalEntry.date_label}</div>
                    <div className="mt-2 text-sm leading-6 text-slate-200">{summarizeJournal(featuredJournalEntry)}</div>
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => setActiveTab("journal")}
                    className="w-full rounded-[1.2rem] border border-dashed border-white/10 px-4 py-4 text-left text-sm text-slate-400"
                  >
                    Open journal to load recent days and reflections.
                  </button>
                )}

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
          </div>
        ) : null}

        {activeTab === "assistant" ? (
          <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Ask Jarvis</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm leading-6 text-slate-300">
                Ask about priorities, overdue threads, health trends, recent movement, journal patterns, or what deserves your attention next.
              </p>
              <AssistantPanel
                apiBase={API_BASE}
                compact
                starterPrompts={[
                  "What should I focus on today?",
                  "What stands out in my recent movement and health data?",
                  "What looks neglected across my tasks, mail, and journal?",
                ]}
              />
            </CardContent>
          </Card>
        ) : activeTab === "mail" ? (
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

        {activeTab === "health" ? (
          <div className="space-y-4">
            <Card className="overflow-hidden rounded-[1.8rem] border border-white/8 bg-[linear-gradient(180deg,rgba(19,24,42,0.94),rgba(13,15,28,0.94))]">
              <CardHeader className="pb-2">
                <div className="inline-flex items-center gap-2 self-start rounded-full border border-cyan-300/18 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-cyan-100">
                  <Activity className="h-3.5 w-3.5" />
                  Health Atlas
                </div>
                <CardTitle className="text-lg">Body, workouts, and movement</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setHealthRoutesTab("overview")}
                    className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition ${
                      healthRoutesTab === "overview"
                        ? "border-cyan-300/25 bg-cyan-400/12 text-cyan-100"
                        : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
                    }`}
                  >
                    Overview
                  </button>
                  <button
                    type="button"
                    onClick={() => setHealthRoutesTab("routes")}
                    className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition ${
                      healthRoutesTab === "routes"
                        ? "border-emerald-300/25 bg-emerald-400/12 text-emerald-100"
                        : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
                    }`}
                  >
                    Routes
                  </button>
                </div>
                <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Selected day</div>
                  <div className="mt-1 text-sm font-semibold text-white">{formatSelectedDayLabel(activeHealthDate)}</div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => setSelectedHealthDate(shiftLocalDateKey(activeHealthDate, -1))}
                      disabled={activeHealthDate <= earliestHealthDate}
                    >
                      <ChevronLeft className="mr-2 h-4 w-4" />
                      Previous
                    </Button>
                    <input
                      type="date"
                      value={activeHealthDate}
                      min={earliestHealthDate}
                      max={latestHealthDate}
                      onChange={(event) => setSelectedHealthDate(event.target.value)}
                      className="h-10 rounded-2xl border border-white/10 bg-[rgba(20,22,37,0.88)] px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/40"
                    />
                    <Button
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => setSelectedHealthDate(shiftLocalDateKey(activeHealthDate, 1))}
                      disabled={activeHealthDate >= latestHealthDate}
                    >
                      Next
                      <ChevronRight className="ml-2 h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {dashboard?.health_summary || movementEntries.length ? (
                  <>
                    {healthRoutesTab === "routes" ? (
                      <div className="space-y-3">
                        <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                          <div className="text-xs uppercase tracking-[0.18em] text-slate-400">3D route explorer</div>
                          <div className="mt-1 text-sm text-slate-300">
                            Open the terrain explorer in a separate fullscreen window to freely explore the map, then layer in workout routes, planned hikes, and live trail overlays when you want them.
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
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
                          <div className="mt-3 flex flex-wrap gap-2">
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
                          {selectedTerrainExplorer?.detail ? (
                            <div className="mt-3 text-[11px] text-slate-500">{selectedTerrainExplorer.detail}</div>
                          ) : null}
                        </div>

                        <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                          <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Planned route overlay</div>
                          <div className="mt-1 text-xs text-slate-500">
                            Import a GPX or GeoJSON route here, then launch fullscreen to preview it on the terrain globe.
                          </div>
                          {plannedRouteOverlay ? (
                            <div className="mt-2 text-xs text-emerald-200">
                              Loaded {plannedRouteOverlay.name} with {plannedRouteOverlay.points.length} points.
                            </div>
                          ) : null}
                          {plannedRouteError ? (
                            <div className="mt-2 text-xs text-rose-200">{plannedRouteError}</div>
                          ) : null}
                          <div className="mt-3 flex flex-wrap gap-2">
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
                                Clear route
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3 text-sm text-slate-300">
                          Trail search, terrain overlays, and hike-planning controls now live only in the fullscreen explorer so the embedded mobile view stays stable.
                        </div>
                      </div>
                    ) : null}

                    {healthRoutesTab === "overview" ? (
                      <>
                    {selectedHealthEntry ? (
                      <>
                        <div className="rounded-[1.3rem] border border-cyan-300/18 bg-[linear-gradient(135deg,rgba(56,189,248,0.14),rgba(17,19,34,0.5))] p-4">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-100/80">Day baseline</div>
                          <div className="mt-3 grid grid-cols-2 gap-3">
                            <div>
                              <div className="text-3xl font-semibold text-white">
                                {formatHealthStat(selectedHealthEntry.steps)}
                              </div>
                              <div className="mt-1 text-xs text-slate-300">steps</div>
                            </div>
                            <div>
                              <div className="text-2xl font-semibold text-white">
                                {formatHealthStat(healthSummary?.seven_day_avg_sleep_hours, 1)} hr
                              </div>
                              <div className="mt-1 text-xs text-slate-300">sleep avg</div>
                            </div>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2 text-xs text-cyan-100">
                            <span className="rounded-full border border-cyan-300/25 bg-black/10 px-2.5 py-1">
                              7-day avg {formatHealthStat(healthSummary?.seven_day_avg_steps)}
                            </span>
                            <span className="rounded-full border border-cyan-300/25 bg-black/10 px-2.5 py-1">
                              {healthSummary?.streak_days ?? 0} day streak
                            </span>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-[1.2rem] border border-white/8 bg-white/5 p-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Resting heart rate</div>
                            <div className="mt-2 text-2xl font-semibold text-white">
                              {formatHealthStat(selectedHealthEntry.resting_heart_rate)}
                            </div>
                            <div className="mt-2 text-xs text-slate-400">bpm</div>
                          </div>
                          <div className="rounded-[1.2rem] border border-white/8 bg-white/5 p-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Workouts logged</div>
                            <div className="mt-2 text-2xl font-semibold text-white">
                              {formatHealthStat(selectedHealthEntry.workouts)}
                            </div>
                            <div className="mt-2 text-xs text-slate-400">logged sessions</div>
                          </div>
                        </div>

                        <div className="rounded-[1.2rem] border border-cyan-300/18 bg-cyan-400/8 px-4 py-3 text-sm leading-6 text-slate-200">
                          Latest sync {healthSummary?.last_synced_at ? formatScheduleDateTime(healthSummary.last_synced_at) : "unknown"}.
                        </div>
                      </>
                    ) : null}

                    <div className="rounded-[1.3rem] border border-emerald-300/18 bg-[linear-gradient(135deg,rgba(16,185,129,0.18),rgba(17,19,34,0.56))] px-4 py-4">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-100/80">Movement story</div>
                      {latestMovementEntry ? (
                        <>
                          <div className="mt-2 text-base font-semibold text-white">
                            {formatMovementStoryText(latestMovementEntry.movement_story, {
                              selectedDate: activeHealthDate,
                            })}
                          </div>
                          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                            <div className="rounded-[0.9rem] border border-white/10 bg-black/10 px-2 py-2">
                              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-300">Distance</div>
                              <div className="mt-1 text-sm font-semibold text-white">
                                {formatDistanceMiles(latestMovementEntry.total_distance_km, 1)}
                              </div>
                            </div>
                            <div className="rounded-[0.9rem] border border-white/10 bg-black/10 px-2 py-2">
                              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-300">Away</div>
                              <div className="mt-1 text-sm font-semibold text-white">
                                {formatMinutes(latestMovementEntry.time_away_minutes)}
                              </div>
                            </div>
                            <div className="rounded-[0.9rem] border border-white/10 bg-black/10 px-2 py-2">
                              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-300">Stops</div>
                              <div className="mt-1 text-sm font-semibold text-white">
                                {latestMovementEntry.visited_places_count}
                              </div>
                            </div>
                          </div>
                          <div className="mt-3 text-xs text-slate-200">
                            {formatMovementWindow(latestMovementEntry.commute_start, latestMovementEntry.commute_end)}
                          </div>
                          {latestMovementEntry.place_labels.length ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {latestMovementEntry.place_labels.map((label) => (
                                <span
                                  key={label}
                                  className="rounded-full border border-emerald-300/20 bg-black/10 px-2.5 py-1 text-[11px] text-emerald-50"
                                >
                                  {label}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div className="mt-2 text-sm text-slate-300">
                          No movement journal synced yet.
                        </div>
                      )}
                    </div>

                    {hasMovementMap && latestMovementEntry ? (
                      <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Route postcard</div>
                            <div className="mt-1 text-xs text-slate-500">A subtle geographic sketch of today&apos;s path.</div>
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {latestMovementEntry.route_points.length || latestMovementEntry.visits.length} pts
                          </div>
                        </div>
                        <div className="mt-3 overflow-hidden rounded-[1rem] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.14),transparent_32%),linear-gradient(180deg,rgba(9,12,22,0.96),rgba(15,18,28,0.96))]">
                          <MovementMap entry={latestMovementEntry} className="h-[380px] min-h-[380px]" />
                        </div>
                      </div>
                    ) : null}

                    {selectedHealthEntry?.extra_metrics &&
                    Object.keys(selectedHealthEntry.extra_metrics).length ? (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => setExpandedMetricsOpen((current) => !current)}
                          className="flex w-full items-center justify-between rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3 text-left"
                        >
                          <div>
                            <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Expanded metrics</div>
                            <div className="mt-1 text-xs text-slate-500">
                              {expandedMetricsOpen ? "Hide detailed measurements" : "Show detailed measurements"}
                            </div>
                          </div>
                          <span className="text-xs text-cyan-200">
                            {expandedMetricsOpen ? "Hide" : "Show"}
                          </span>
                        </button>
                        {expandedMetricsOpen
                          ? Object.entries(selectedHealthEntry.extra_metrics)
                              .filter(([, value]) => value !== null && value !== undefined)
                              .slice(0, 12)
                              .map(([key, value]) => (
                                <div
                                  key={key}
                                  className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3"
                                >
                                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">
                                    {healthMetricLabel(key)}
                                  </div>
                                  <div className="mt-1 text-sm font-medium text-white">
                                    {formatHealthMetricValue(key, value)}
                                  </div>
                                </div>
                              ))
                          : null}
                      </div>
                    ) : null}

                    {workoutEntries[0] ? (
                      <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                        <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Workout spotlight</div>
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <div className="text-sm font-medium text-white">
                            {formatWorkoutLabel(workoutEntries[0].activity_label, workoutEntries[0].activity_type)}
                          </div>
                          <div className="text-xs text-slate-400">
                            {formatHealthStat(workoutEntries[0].duration_minutes)} min
                          </div>
                        </div>
                        <div className="mt-1 text-xs text-slate-400">
                          {formatScheduleDateTime(workoutEntries[0].start_date)}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-300">
                          <span>{formatDistanceMiles(workoutEntries[0].total_distance_km, 1)}</span>
                          <span>{formatHealthStat(workoutEntries[0].active_energy_kcal)} Cal</span>
                          <span>{formatHealthStat(workoutEntries[0].avg_heart_rate_bpm)} avg bpm</span>
                        </div>
                      </div>
                    ) : null}

                    {mappedWorkoutEntries.length ? (
                      <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Workout route</div>
                            <div className="mt-1 text-sm font-medium text-white">{formatWorkoutLabel(mappedWorkoutEntries[0].activity_label, mappedWorkoutEntries[0].activity_type)}</div>
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {formatDistanceMiles(mappedWorkoutEntries[0].total_distance_km, 1)}
                          </div>
                        </div>
                        <div className="mt-3 overflow-hidden rounded-[1rem] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_32%),linear-gradient(180deg,rgba(9,12,22,0.96),rgba(15,18,28,0.96))]">
                          <MovementMap entry={workoutToMapEntry(mappedWorkoutEntries[0])} className="h-[340px] min-h-[340px]" />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-300">
                          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                            {formatScheduleDateTime(mappedWorkoutEntries[0].start_date)}
                          </span>
                          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                            {mappedWorkoutEntries[0].route_points.length} route point{mappedWorkoutEntries[0].route_points.length === 1 ? "" : "s"}
                          </span>
                        </div>
                      </div>
                    ) : null}

                    <div className="space-y-2">
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Movement storyboard</div>
                      {movementStoryboard.length ? (
                        movementStoryboard.map((item, index) => (
                          <div
                            key={item.id}
                            className="flex gap-3 rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3"
                          >
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-xs font-semibold text-emerald-100">
                              {index + 1}
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-white">{item.title}</div>
                              <div className="mt-1 text-xs text-slate-300">{item.detail}</div>
                              {item.meta ? (
                                <div className="mt-1 text-[11px] text-slate-500">{item.meta}</div>
                              ) : null}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                          No movement storyboard yet.
                        </div>
                      )}
                    </div>
                      </>
                    ) : null}

                  </>
                ) : (
                  <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                    No health data synced yet.
                  </div>
                )}
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

        {activeTab === "more" ? (
          <div className="space-y-4">
            <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">More</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <button
                  type="button"
                  onClick={() => setActiveTab("journal")}
                  className="flex w-full items-center justify-between rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                >
                  <div className="flex items-center gap-3">
                    <div className="rounded-full border border-white/10 bg-white/5 p-2 text-slate-200">
                      <BookOpen className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-white">Journal</div>
                      <div className="mt-1 text-xs text-slate-400">
                        Search reflections, gratitude, and world-event notes.
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-500" />
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("schedule")}
                  className="flex w-full items-center justify-between rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                >
                  <div className="flex items-center gap-3">
                    <div className="rounded-full border border-white/10 bg-white/5 p-2 text-slate-200">
                      <CalendarDays className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-white">Schedule</div>
                      <div className="mt-1 text-xs text-slate-400">
                        Review upcoming events and today&apos;s calendar flow.
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-500" />
                </button>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/8 bg-[rgba(11,13,25,0.94)] px-4 pb-4 pt-3 backdrop-blur-xl">
        <div className="mx-auto grid max-w-md grid-cols-6 gap-2">
          {primaryNavItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveTab(item.key)}
              className={`flex flex-col items-center justify-center gap-1 rounded-[1.2rem] px-2 py-2.5 text-[11px] font-medium transition ${
                activeTab === item.key
                  ? "bg-fuchsia-400/18 text-fuchsia-100 shadow-[0_10px_24px_rgba(192,132,252,0.12)]"
                  : "text-slate-400"
              }`}
            >
              {item.icon}
              <span className="whitespace-nowrap">{item.label}</span>
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
