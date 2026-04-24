"use client";

export type TerrainExplorerViewBounds = {
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
};

export type TerrainExplorerEntry = {
  route_points: Array<{
    timestamp?: string | null;
    latitude: number;
    longitude: number;
  }>;
  visits: Array<{
    arrival?: string | null;
    departure?: string | null;
    latitude: number;
    longitude: number;
    label?: string | null;
  }>;
};

export type TerrainExplorerOption = {
  id: string;
  label: string;
  detail: string;
  entry: TerrainExplorerEntry;
};

export type PlannedRouteOverlay = {
  name: string;
  points: Array<{
    latitude: number;
    longitude: number;
  }>;
  controlPoints?: Array<{
    latitude: number;
    longitude: number;
  }>;
};

export type NearbyTrailItem = {
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

export type TerrainExplorerSessionPayload = {
  terrainExplorerOptions: TerrainExplorerOption[];
  selectedTerrainExplorerId: string | null;
  plannedRouteOverlay: PlannedRouteOverlay | null;
  nearbyTrails: NearbyTrailItem[];
  selectedNearbyTrailId: string | null;
  terrainViewBounds: TerrainExplorerViewBounds | null;
  plannerViewNonce: number;
  sourceContext: "desktop" | "mobile";
};

const STORAGE_PREFIX = "jarvis-terrain-explorer:";
const CHANNEL_PREFIX = "jarvis-terrain-explorer-channel:";
const DEFAULT_TERRAIN_EXPLORER_OPTION: TerrainExplorerOption = {
  id: "terrain-explore",
  label: "Explore terrain",
  detail: "Free-roam 3D terrain view centered on Provo Valley.",
  entry: {
    route_points: [],
    visits: [],
  },
};
const DEFAULT_DESKTOP_SESSION_PAYLOAD: TerrainExplorerSessionPayload = {
  terrainExplorerOptions: [DEFAULT_TERRAIN_EXPLORER_OPTION],
  selectedTerrainExplorerId: DEFAULT_TERRAIN_EXPLORER_OPTION.id,
  plannedRouteOverlay: null,
  nearbyTrails: [],
  selectedNearbyTrailId: null,
  terrainViewBounds: null,
  plannerViewNonce: 0,
  sourceContext: "desktop",
};
const DEFAULT_MOBILE_SESSION_PAYLOAD: TerrainExplorerSessionPayload = {
  ...DEFAULT_DESKTOP_SESSION_PAYLOAD,
  sourceContext: "mobile",
};
const sessionSnapshotCache = new Map<
  string,
  {
    raw: string;
    payload: TerrainExplorerSessionPayload;
  }
>();

export function createDefaultTerrainExplorerSessionPayload(
  sourceContext: TerrainExplorerSessionPayload["sourceContext"] = "desktop"
): TerrainExplorerSessionPayload {
  const source =
    sourceContext === "mobile"
      ? DEFAULT_MOBILE_SESSION_PAYLOAD
      : DEFAULT_DESKTOP_SESSION_PAYLOAD;
  return {
    terrainExplorerOptions: source.terrainExplorerOptions.map((option) => ({
      ...option,
      entry: {
        route_points: [...option.entry.route_points],
        visits: [...option.entry.visits],
      },
    })),
    selectedTerrainExplorerId: source.selectedTerrainExplorerId,
    plannedRouteOverlay: null,
    nearbyTrails: [],
    selectedNearbyTrailId: null,
    terrainViewBounds: null,
    sourceContext,
  };
}

function getStorageKey(sessionId: string) {
  return `${STORAGE_PREFIX}${sessionId}`;
}

function writeTerrainExplorerSession(
  sessionId: string,
  payload: TerrainExplorerSessionPayload
) {
  const serialized = JSON.stringify(payload);
  sessionSnapshotCache.set(sessionId, {
    raw: serialized,
    payload,
  });
  window.localStorage.setItem(getStorageKey(sessionId), serialized);
  window.sessionStorage.setItem(getStorageKey(sessionId), serialized);
}

function broadcastTerrainExplorerSession(
  sessionId: string,
  payload: TerrainExplorerSessionPayload
) {
  if (typeof BroadcastChannel === "undefined") {
    return;
  }

  const channel = new BroadcastChannel(`${CHANNEL_PREFIX}${sessionId}`);
  channel.postMessage(payload);
  channel.close();
}

export function saveTerrainExplorerSession(
  payload: TerrainExplorerSessionPayload
) {
  if (typeof window === "undefined") {
    return "";
  }

  const sessionId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeTerrainExplorerSession(sessionId, payload);
  return sessionId;
}

export function loadTerrainExplorerSession(sessionId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const storageKey = getStorageKey(sessionId);
  const raw =
    window.localStorage.getItem(storageKey) ??
    window.sessionStorage.getItem(storageKey);
  if (!raw) {
    return null;
  }

  try {
    const cached = sessionSnapshotCache.get(sessionId);
    if (cached && cached.raw === raw) {
      return cached.payload;
    }

    const parsed = JSON.parse(raw) as TerrainExplorerSessionPayload;
    sessionSnapshotCache.set(sessionId, {
      raw,
      payload: parsed,
    });
    return parsed;
  } catch {
    return null;
  }
}

export function getTerrainExplorerSessionSnapshot(
  sessionId: string | null,
  sourceContext: TerrainExplorerSessionPayload["sourceContext"] = "desktop"
) {
  if (!sessionId) {
    return sourceContext === "mobile"
      ? DEFAULT_MOBILE_SESSION_PAYLOAD
      : DEFAULT_DESKTOP_SESSION_PAYLOAD;
  }

  return (
    loadTerrainExplorerSession(sessionId) ??
    (sourceContext === "mobile"
      ? DEFAULT_MOBILE_SESSION_PAYLOAD
      : DEFAULT_DESKTOP_SESSION_PAYLOAD)
  );
}

export function persistTerrainExplorerSession(
  sessionId: string,
  payload: TerrainExplorerSessionPayload
) {
  if (typeof window === "undefined") {
    return;
  }

  writeTerrainExplorerSession(sessionId, payload);
  broadcastTerrainExplorerSession(sessionId, payload);
}

export function subscribeTerrainExplorerSession(
  sessionId: string,
  onPayload: (payload: TerrainExplorerSessionPayload) => void
) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const storageKey = getStorageKey(sessionId);
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== storageKey || !event.newValue) {
      return;
    }

    try {
      onPayload(JSON.parse(event.newValue) as TerrainExplorerSessionPayload);
    } catch {
      // Ignore malformed storage updates.
    }
  };

  window.addEventListener("storage", handleStorage);

  const channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(`${CHANNEL_PREFIX}${sessionId}`)
      : null;
  if (channel) {
    channel.onmessage = (event: MessageEvent<TerrainExplorerSessionPayload>) => {
      if (event.data) {
        onPayload(event.data);
      }
    };
  }

  return () => {
    window.removeEventListener("storage", handleStorage);
    channel?.close();
  };
}
