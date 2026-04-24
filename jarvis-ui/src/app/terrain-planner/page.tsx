"use client";

import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { TrailPlannerMap } from "@/components/trail-planner-map";
import {
  getTerrainExplorerSessionSnapshot,
  persistTerrainExplorerSession,
  subscribeTerrainExplorerSession,
  type NearbyTrailItem,
  type TerrainExplorerSessionPayload,
} from "@/components/terrain-explorer-session";
import { Button } from "@/components/ui/button";

type GeocodeResult = {
  place_id: number | string;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: string[];
};

type TrailSearchResponse = {
  provider: string;
  count: number;
  source_counts?: Record<string, number>;
  items: NearbyTrailItem[];
};

const MAX_TRAIL_SEARCH_SPAN_DEGREES = 0.35;

function clampTrailSearchBounds(bounds: {
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
}) {
  const centerLat = (bounds.min_lat + bounds.max_lat) / 2;
  const centerLon = (bounds.min_lon + bounds.max_lon) / 2;
  const latSpan = Math.min(
    Math.max(bounds.max_lat - bounds.min_lat, 0.0005),
    MAX_TRAIL_SEARCH_SPAN_DEGREES
  );
  const lonSpan = Math.min(
    Math.max(bounds.max_lon - bounds.min_lon, 0.0005),
    MAX_TRAIL_SEARCH_SPAN_DEGREES
  );
  const halfLat = latSpan / 2;
  const halfLon = lonSpan / 2;

  return {
    min_lat: Math.max(-90, centerLat - halfLat),
    min_lon: Math.max(-180, centerLon - halfLon),
    max_lat: Math.min(90, centerLat + halfLat),
    max_lon: Math.min(180, centerLon + halfLon),
  };
}

function mergeNearbyTrailSets(
  existingTrails: NearbyTrailItem[],
  nextTrails: NearbyTrailItem[]
) {
  const merged = new Map<string, NearbyTrailItem>();

  for (const trail of existingTrails) {
    merged.set(trail.id, trail);
  }

  for (const trail of nextTrails) {
    const current = merged.get(trail.id);
    if (!current) {
      merged.set(trail.id, trail);
      continue;
    }

    merged.set(
      trail.id,
      trail.points.length >= current.points.length
        ? {
            ...current,
            ...trail,
          }
        : {
            ...trail,
            ...current,
          }
    );
  }

  return Array.from(merged.values());
}

async function getErrorMessage(response: Response, fallback: string) {
  try {
    const data = (await response.json()) as { detail?: string };
    return data.detail || fallback;
  } catch {
    return fallback;
  }
}

function TerrainPlannerPageInner() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");
  const payload = useSyncExternalStore<TerrainExplorerSessionPayload>(
    (onStoreChange) =>
      sessionId ? subscribeTerrainExplorerSession(sessionId, onStoreChange) : () => {},
    () => getTerrainExplorerSessionSnapshot(sessionId, "desktop"),
    () => getTerrainExplorerSessionSnapshot(null, "desktop")
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [focusedSearchResult, setFocusedSearchResult] = useState<GeocodeResult | null>(null);
  const [plannerKnownTrails, setPlannerKnownTrails] = useState<NearbyTrailItem[]>(payload.nearbyTrails);
  const [plannerViewBounds, setPlannerViewBounds] = useState(payload.terrainViewBounds);
  const latestPayloadRef = useRef(payload);
  const latestTerrainViewBoundsRef = useRef(payload.terrainViewBounds);
  const terrainViewBoundsKey = useMemo(
    () =>
      payload.terrainViewBounds
        ? [
            payload.terrainViewBounds.min_lat,
            payload.terrainViewBounds.min_lon,
            payload.terrainViewBounds.max_lat,
            payload.terrainViewBounds.max_lon,
          ].join(":")
        : "null",
    [payload.terrainViewBounds]
  );

  useEffect(() => {
    latestPayloadRef.current = payload;
  }, [payload]);

  useEffect(() => {
    latestTerrainViewBoundsRef.current = payload.terrainViewBounds;
  }, [payload.terrainViewBounds]);

  useEffect(() => {
    setPlannerKnownTrails((current) => mergeNearbyTrailSets(current, payload.nearbyTrails));
  }, [payload.nearbyTrails]);

  useEffect(() => {
    if (latestTerrainViewBoundsRef.current) {
      setPlannerViewBounds(latestTerrainViewBoundsRef.current);
    }
  }, [payload.plannerViewNonce]);

  useEffect(() => {
    const activeBounds = plannerViewBounds || latestTerrainViewBoundsRef.current;
    if (!activeBounds) {
      return;
    }

    let cancelled = false;
    const searchBounds = clampTrailSearchBounds(activeBounds);
    const params = new URLSearchParams({
      min_lat: String(searchBounds.min_lat),
      min_lon: String(searchBounds.min_lon),
      max_lat: String(searchBounds.max_lat),
      max_lon: String(searchBounds.max_lon),
      limit: "60",
    });

    const fetchTrails = async () => {
      try {
        const response = await fetch(`/api/trails/search?${params.toString()}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(
            await getErrorMessage(response, `Trail search failed with status ${response.status}`)
          );
        }

        const data = (await response.json()) as TrailSearchResponse;
        if (cancelled) {
          return;
        }

        setPlannerKnownTrails((current) => {
          const merged = mergeNearbyTrailSets(current, data.items || []);
          if (
            sessionId &&
            merged.length !== latestPayloadRef.current.nearbyTrails.length
          ) {
            persistTerrainExplorerSession(sessionId, {
              ...latestPayloadRef.current,
              nearbyTrails: merged,
            });
          }
          return merged;
        });
      } catch {
        // Keep using whatever trails are already loaded in-session.
      }
    };

    void fetchTrails();

    return () => {
      cancelled = true;
    };
  }, [
    payload.nearbyTrails.length,
    payload.plannedRouteOverlay,
    payload.selectedNearbyTrailId,
    plannerViewBounds,
    sessionId,
    terrainViewBoundsKey,
  ]);

  const selectedTerrainExplorer =
    payload.terrainExplorerOptions.find((option) => option.id === payload.selectedTerrainExplorerId) ??
    payload.terrainExplorerOptions[0] ??
    null;
  const selectedNearbyTrail = payload.selectedNearbyTrailId
    ? payload.nearbyTrails.find((trail) => trail.id === payload.selectedNearbyTrailId) ?? null
    : null;

  const returnToDesktop = () => {
    try {
      const desktopWindow =
        window.opener && "opener" in window.opener && window.opener.opener && !window.opener.opener.closed
          ? window.opener.opener
          : window.opener && !window.opener.closed
          ? window.opener
          : null;

      if (desktopWindow) {
        desktopWindow.location.assign("/");
        desktopWindow.focus();
        return;
      }
    } catch {
      // Fall back to navigating this window.
    }

    window.location.assign("/");
  };

  const returnTo3DMap = () => {
    const targetUrl = sessionId
      ? `/terrain-explorer?session=${encodeURIComponent(sessionId)}`
      : "/terrain-explorer";

    try {
      if (window.opener && !window.opener.closed) {
        window.opener.location.assign(targetUrl);
        window.opener.focus();
        return;
      }
    } catch {
      // Fall back to navigating this window.
    }

    window.location.assign(targetUrl);
  };

  const runLocationSearch = async () => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError("Enter a place, trailhead, canyon, or mountain to search.");
      return;
    }

    setSearchLoading(true);
    setSearchError("");

    try {
      const params = new URLSearchParams({ q: query, limit: "5" });
      const response = await fetch(`/jarvis-geocode/search?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Location search failed with status ${response.status}`)
        );
      }

      const data = (await response.json()) as { items?: GeocodeResult[] };
      const results = data.items || [];
      setSearchResults(results);
      if (!results.length) {
        setSearchError("No places matched that search.");
        return;
      }

      setFocusedSearchResult(results[0]);
    } catch (error) {
      setSearchResults([]);
      setSearchError(
        error instanceof Error ? error.message : "Unable to search for that place."
      );
    } finally {
      setSearchLoading(false);
    }
  };

  if (!selectedTerrainExplorer) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[linear-gradient(180deg,#090c16,#0f121c)] px-6 text-center text-slate-300">
        No terrain route data is available for the planner.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#090c16,#0f121c)] px-4 py-4 text-slate-100 md:px-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-[1.4rem] border border-white/10 bg-[rgba(8,11,18,0.78)] p-4 backdrop-blur">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-amber-100/80">
              Dedicated route planner
            </div>
            <div className="mt-2 text-2xl font-semibold text-white">
              {selectedTerrainExplorer.label || "2D route planner"}
            </div>
            <div className="mt-1 max-w-3xl text-sm text-slate-300">
              Click to place trail points. The 3D explorer keeps the route overlay in sync, and point placement preserves your current 2D map camera.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-2xl border-white/10 bg-white/5 text-slate-100 hover:border-white/20 hover:bg-white/10"
              onClick={returnTo3DMap}
            >
              Return to 3D map
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-2xl border-white/10 bg-white/5 text-slate-100 hover:border-white/20 hover:bg-white/10"
              onClick={returnToDesktop}
            >
              Return to desktop
            </Button>
          </div>
        </div>

        <div className="rounded-[1.4rem] border border-white/10 bg-[rgba(8,11,18,0.72)] p-4 backdrop-blur">
          <div className="mb-4 rounded-[1rem] border border-white/8 bg-black/10 p-3">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Map search</div>
            <div className="mt-1 text-xs text-slate-500">
              Planner opens over Provo by default. Search any trailhead, canyon, town, or landmark to jump the 2D map there.
            </div>
            <div className="mt-3 flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void runLocationSearch();
                    }
                  }}
                  placeholder="Search Provo Canyon, Sundance..."
                  className="h-10 w-full rounded-xl border border-white/10 bg-black/20 pl-9 pr-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-2xl"
                onClick={() => void runLocationSearch()}
                disabled={searchLoading}
              >
                {searchLoading ? "Searching..." : "Search"}
              </Button>
            </div>
            {searchError ? (
              <div className="mt-2 text-xs text-rose-200">{searchError}</div>
            ) : null}
            {searchResults.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {searchResults.slice(0, 5).map((result) => (
                  <button
                    key={String(result.place_id)}
                    type="button"
                    onClick={() => setFocusedSearchResult(result)}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-left text-xs text-slate-200 transition hover:border-white/20"
                  >
                    {result.display_name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <TrailPlannerMap
            entry={selectedTerrainExplorer.entry}
            plannedRoute={payload.plannedRouteOverlay}
            referenceTrail={
              selectedNearbyTrail
                ? {
                    name: selectedNearbyTrail.name,
                    points: selectedNearbyTrail.points,
                  }
                : null
            }
            knownTrails={plannerKnownTrails.map((trail) => ({
              name: trail.name,
              points: trail.points,
            }))}
            viewBounds={payload.terrainViewBounds}
            viewSyncNonce={payload.plannerViewNonce}
            focusSearchResult={focusedSearchResult}
            onViewBoundsChange={setPlannerViewBounds}
            onPlannedRouteChange={(route) => {
              const nextPayload = {
                ...payload,
                plannedRouteOverlay: route,
              };
              if (sessionId) {
                persistTerrainExplorerSession(sessionId, nextPayload);
              }
            }}
            mapClassName="h-[calc(100vh-13rem)] min-h-[24rem]"
          />
        </div>
      </div>
    </div>
  );
}

export default function TerrainPlannerPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[linear-gradient(180deg,#090c16,#0f121c)] px-6 text-center text-slate-300">
          Loading route planner...
        </div>
      }
    >
      <TerrainPlannerPageInner />
    </Suspense>
  );
}
