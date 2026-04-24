"use client";

import { Suspense, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { TerrainExplorerWorkspace } from "@/components/terrain-explorer-workspace";
import {
  getTerrainExplorerSessionSnapshot,
} from "@/components/terrain-explorer-session";

function TerrainExplorerPageInner() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");
  const payload = useSyncExternalStore(
    () => () => {},
    () => getTerrainExplorerSessionSnapshot(sessionId, "desktop"),
    () => getTerrainExplorerSessionSnapshot(null, "desktop")
  );

  return (
    <TerrainExplorerWorkspace
      terrainExplorerOptions={payload.terrainExplorerOptions}
      initialSelectedTerrainExplorerId={payload.selectedTerrainExplorerId}
      initialPlannedRouteOverlay={payload.plannedRouteOverlay}
      initialNearbyTrails={payload.nearbyTrails}
      initialSelectedNearbyTrailId={payload.selectedNearbyTrailId}
      initialTerrainViewBounds={payload.terrainViewBounds}
      initialSessionId={sessionId}
      initialPlannerViewNonce={payload.plannerViewNonce}
    />
  );
}

export default function TerrainExplorerPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[linear-gradient(180deg,#090c16,#0f121c)] px-6 text-center text-slate-300">
          Loading terrain explorer...
        </div>
      }
    >
      <TerrainExplorerPageInner />
    </Suspense>
  );
}
