"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GeoJSONSourceSpecification,
  LngLatBoundsLike,
  MapLayerMouseEvent,
  MapMouseEvent,
  Map as MapLibreMap,
  StyleSpecification,
} from "maplibre-gl";
import type {
  PlannedRouteOverlay,
  TerrainExplorerEntry,
} from "@/components/terrain-explorer-session";

type TrailPlannerMapProps = {
  entry: TerrainExplorerEntry;
  plannedRoute: PlannedRouteOverlay | null;
  referenceTrail?: PlannedRouteOverlay | null;
  knownTrails?: PlannedRouteOverlay[];
  viewBounds?: {
    min_lat: number;
    min_lon: number;
    max_lat: number;
    max_lon: number;
  } | null;
  viewSyncNonce?: number;
  focusSearchResult?: {
    place_id: number | string;
    display_name: string;
    lat: string;
    lon: string;
    boundingbox?: string[];
  } | null;
  onViewBoundsChange?: (bounds: {
    min_lat: number;
    min_lon: number;
    max_lat: number;
    max_lon: number;
  }) => void;
  onPlannedRouteChange: (route: PlannedRouteOverlay | null) => void;
  className?: string;
  mapClassName?: string;
};

type PlannerMapStyle = "topo" | "osm" | "satellite";

type RouteStats = {
  distanceKm: number;
  estimatedHours: number;
  renderedPointCount: number;
  controlPointCount: number;
};

type RouteBuildSource = "idle" | "manual" | "stadia" | "local-graph" | "direct";

type RouteBuildResult = {
  overlay: PlannedRouteOverlay | null;
  source: RouteBuildSource;
  diagnostics?: string[];
};

type RoutePoint = {
  latitude: number;
  longitude: number;
};

type TrailGraphNode = {
  id: string;
  point: RoutePoint;
  neighbors: Array<{
    nodeId: string;
    weight: number;
  }>;
};

type TrailGraph = {
  nodes: Map<string, TrailGraphNode>;
  pointIndex: Map<string, string>;
};

type SnappedTrailPoint = {
  point: RoutePoint;
  segmentStartNodeId: string;
  segmentEndNodeId: string;
  segmentStartPoint: RoutePoint;
  segmentEndPoint: RoutePoint;
  distanceToSegmentStartMeters: number;
  distanceToSegmentEndMeters: number;
  distanceFromOriginalMeters: number;
};

const DEFAULT_ROUTE_NAME = "Custom route";
const DEFAULT_PROVO_CENTER: [number, number] = [-111.65, 40.30];
const DEFAULT_PROVO_ZOOM = 11;
const DEFAULT_PROVO_BOUNDS: LngLatBoundsLike = [
  [-111.82, 40.18],
  [-111.48, 40.42],
];
const TRAIL_GRAPH_NODE_MERGE_METERS = 28;

function cn(...values: Array<string | undefined | false | null>) {
  return values.filter(Boolean).join(" ");
}

function buildBaseStyle(mode: PlannerMapStyle): StyleSpecification {
  const rasterSource =
    mode === "topo"
      ? {
          type: "raster" as const,
          tiles: ["https://tile.opentopomap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "\u00a9 OpenTopoMap, \u00a9 OpenStreetMap contributors",
        }
      : mode === "satellite"
      ? {
          type: "raster" as const,
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          attribution: "Esri, Maxar, Earthstar Geographics",
        }
      : {
          type: "raster" as const,
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "\u00a9 OpenStreetMap contributors",
        };

  return {
    version: 8,
    sources: {
      basemap: rasterSource,
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": "#06101a",
        },
      },
      {
        id: "basemap",
        type: "raster",
        source: "basemap",
        paint:
          mode === "satellite"
            ? {
                "raster-opacity": 0.94,
                "raster-saturation": -0.08,
                "raster-contrast": 0.12,
                "raster-fade-duration": 0,
              }
            : {
                "raster-opacity": 0.96,
                "raster-saturation": mode === "topo" ? -0.02 : -0.14,
                "raster-contrast": mode === "topo" ? 0.14 : 0.04,
                "raster-fade-duration": 0,
              },
      },
    ],
  };
}

function normalizeRoutePoints(points: RoutePoint[]) {
  return points.filter(
    (point) =>
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      Math.abs(point.latitude) <= 90 &&
      Math.abs(point.longitude) <= 180
  );
}

function cloneRoutePoints(points: RoutePoint[]) {
  return points.map((point) => ({
    latitude: point.latitude,
    longitude: point.longitude,
  }));
}

function buildOverlayFromPoints(
  name: string,
  controlPoints: RoutePoint[],
  renderedPoints?: RoutePoint[]
): PlannedRouteOverlay | null {
  const normalizedControlPoints = normalizeRoutePoints(controlPoints);
  if (!normalizedControlPoints.length) {
    return null;
  }

  return {
    name: name.trim() || DEFAULT_ROUTE_NAME,
    controlPoints: normalizedControlPoints,
    points: normalizeRoutePoints(renderedPoints?.length ? renderedPoints : normalizedControlPoints),
  };
}

export function getRouteControlPoints(route: PlannedRouteOverlay | null) {
  if (!route) {
    return [] as RoutePoint[];
  }

  return normalizeRoutePoints(route.controlPoints?.length ? route.controlPoints : route.points);
}

function approxDistanceMeters(a: RoutePoint, b: RoutePoint) {
  const latScale = 111_320;
  const meanLatRadians = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const lonScale = Math.max(1, Math.cos(meanLatRadians) * latScale);
  const dx = (b.longitude - a.longitude) * lonScale;
  const dy = (b.latitude - a.latitude) * latScale;
  return Math.sqrt(dx * dx + dy * dy);
}

function shouldAppendFreeDrawPoint(previousPoint: RoutePoint, nextPoint: RoutePoint) {
  return approxDistanceMeters(previousPoint, nextPoint) >= 8;
}

function distanceToSegmentMeters(point: RoutePoint, start: RoutePoint, end: RoutePoint) {
  const latScale = 111_320;
  const meanLatRadians = ((point.latitude + start.latitude + end.latitude) / 3) * (Math.PI / 180);
  const lonScale = Math.max(1, Math.cos(meanLatRadians) * latScale);

  const px = point.longitude * lonScale;
  const py = point.latitude * latScale;
  const x1 = start.longitude * lonScale;
  const y1 = start.latitude * latScale;
  const x2 = end.longitude * lonScale;
  const y2 = end.latitude * latScale;

  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }

  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const projectionX = x1 + t * dx;
  const projectionY = y1 + t * dy;
  return Math.sqrt((px - projectionX) ** 2 + (py - projectionY) ** 2);
}

function projectPointOntoSegment(point: RoutePoint, start: RoutePoint, end: RoutePoint) {
  const latScale = 111_320;
  const meanLatRadians = ((point.latitude + start.latitude + end.latitude) / 3) * (Math.PI / 180);
  const lonScale = Math.max(1, Math.cos(meanLatRadians) * latScale);

  const px = point.longitude * lonScale;
  const py = point.latitude * latScale;
  const x1 = start.longitude * lonScale;
  const y1 = start.latitude * latScale;
  const x2 = end.longitude * lonScale;
  const y2 = end.latitude * latScale;
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return {
      point: start,
      distanceFromOriginalMeters: Math.sqrt((px - x1) ** 2 + (py - y1) ** 2),
      distanceToSegmentStartMeters: 0,
      distanceToSegmentEndMeters: 0,
    };
  }

  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const projectedX = x1 + t * dx;
  const projectedY = y1 + t * dy;
  const projectedPoint = {
    latitude: projectedY / latScale,
    longitude: projectedX / lonScale,
  };

  return {
    point: projectedPoint,
    distanceFromOriginalMeters: Math.sqrt((px - projectedX) ** 2 + (py - projectedY) ** 2),
    distanceToSegmentStartMeters: Math.sqrt((projectedX - x1) ** 2 + (projectedY - y1) ** 2),
    distanceToSegmentEndMeters: Math.sqrt((projectedX - x2) ** 2 + (projectedY - y2) ** 2),
  };
}

function simplifyFreehandPoints(points: RoutePoint[], toleranceMeters = 10) {
  if (points.length <= 2) {
    return cloneRoutePoints(points);
  }

  const simplified: RoutePoint[] = [points[0]];

  const simplifySegment = (startIndex: number, endIndex: number) => {
    let maxDistance = 0;
    let maxIndex = -1;

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = distanceToSegmentMeters(points[index], points[startIndex], points[endIndex]);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = index;
      }
    }

    if (maxIndex !== -1 && maxDistance > toleranceMeters) {
      simplifySegment(startIndex, maxIndex);
      simplified.push(points[maxIndex]);
      simplifySegment(maxIndex, endIndex);
    }
  };

  simplifySegment(0, points.length - 1);
  simplified.push(points[points.length - 1]);

  return simplified.sort((a, b) => points.indexOf(a) - points.indexOf(b));
}

function buildTrailGraph(trails: PlannedRouteOverlay[]) {
  const nodes = new Map<string, TrailGraphNode>();
  const pointIndex = new Map<string, string>();
  const edgePairs = new Set<string>();
  const keyForPoint = (point: RoutePoint) =>
    `${point.latitude.toFixed(5)}:${point.longitude.toFixed(5)}`;

  const getOrCreateNode = (point: RoutePoint) => {
    const exactKey = keyForPoint(point);
    const indexedNodeId = pointIndex.get(exactKey);
    let node = indexedNodeId ? nodes.get(indexedNodeId) : undefined;
    if (!node) {
      for (const existingNode of nodes.values()) {
        if (approxDistanceMeters(existingNode.point, point) <= TRAIL_GRAPH_NODE_MERGE_METERS) {
          node = existingNode;
          break;
        }
      }
    }

    if (!node) {
      const id = exactKey;
      node = {
        id,
        point: {
          latitude: point.latitude,
          longitude: point.longitude,
        },
        neighbors: [],
      };
      nodes.set(id, node);
    }
    pointIndex.set(exactKey, node.id);
    return node;
  };

  const addEdge = (start: TrailGraphNode, end: TrailGraphNode) => {
    if (start.id === end.id) {
      return;
    }
    const pairKey = [start.id, end.id].sort().join("|");
    if (edgePairs.has(pairKey)) {
      return;
    }
    edgePairs.add(pairKey);
    const weight = approxDistanceMeters(start.point, end.point);
    start.neighbors.push({ nodeId: end.id, weight });
    end.neighbors.push({ nodeId: start.id, weight });
  };

  trails.forEach((trail) => {
    const points = normalizeRoutePoints(trail.points);
    for (let index = 1; index < points.length; index += 1) {
      const start = getOrCreateNode(points[index - 1]);
      const end = getOrCreateNode(points[index]);
      addEdge(start, end);
    }
  });

  return { nodes, pointIndex } satisfies TrailGraph;
}

function getTrailGraphNodeIdForPoint(graph: TrailGraph, point: RoutePoint) {
  const exactKey = `${point.latitude.toFixed(5)}:${point.longitude.toFixed(5)}`;
  const indexedNodeId = graph.pointIndex.get(exactKey);
  if (indexedNodeId && graph.nodes.has(indexedNodeId)) {
    return indexedNodeId;
  }

  let bestNodeId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const node of graph.nodes.values()) {
    const distance = approxDistanceMeters(node.point, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestNodeId = node.id;
    }
  }

  return bestDistance <= TRAIL_GRAPH_NODE_MERGE_METERS ? bestNodeId : null;
}

function snapPointToTrailGraph(
  point: RoutePoint,
  trails: PlannedRouteOverlay[],
  graph: TrailGraph,
  maxSnapMeters = 180
): SnappedTrailPoint | null {
  let bestMatch: SnappedTrailPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  trails.forEach((trail) => {
    const trailPoints = normalizeRoutePoints(trail.points);
    for (let index = 1; index < trailPoints.length; index += 1) {
      const segmentStartPoint = trailPoints[index - 1];
      const segmentEndPoint = trailPoints[index];
      const segmentStartNodeId = getTrailGraphNodeIdForPoint(graph, segmentStartPoint);
      const segmentEndNodeId = getTrailGraphNodeIdForPoint(graph, segmentEndPoint);
      if (!segmentStartNodeId || !segmentEndNodeId) {
        continue;
      }

      const projection = projectPointOntoSegment(point, segmentStartPoint, segmentEndPoint);
      if (projection.distanceFromOriginalMeters < bestDistance) {
        bestDistance = projection.distanceFromOriginalMeters;
        bestMatch = {
          point: projection.point,
          segmentStartNodeId,
          segmentEndNodeId,
          segmentStartPoint,
          segmentEndPoint,
          distanceToSegmentStartMeters: projection.distanceToSegmentStartMeters,
          distanceToSegmentEndMeters: projection.distanceToSegmentEndMeters,
          distanceFromOriginalMeters: projection.distanceFromOriginalMeters,
        };
      }
    }
  });

  return bestDistance <= maxSnapMeters ? bestMatch : null;
}

function dedupeRoutePoints(points: RoutePoint[]) {
  return points.filter((point, index) => {
    if (index === 0) {
      return true;
    }
    return approxDistanceMeters(point, points[index - 1]) > 1;
  });
}

function findShortestPathInTrailGraph(
  graph: TrailGraph,
  startNodeId: string,
  endNodeId: string
) {
  if (startNodeId === endNodeId) {
    const node = graph.nodes.get(startNodeId);
    return node
      ? {
          distanceMeters: 0,
          points: [node.point],
        }
      : null;
  }

  const distances = new Map<string, number>([[startNodeId, 0]]);
  const previous = new Map<string, string | null>([[startNodeId, null]]);
  const visited = new Set<string>();

  while (true) {
    let currentNodeId: string | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;

    distances.forEach((distance, nodeId) => {
      if (!visited.has(nodeId) && distance < currentDistance) {
        currentDistance = distance;
        currentNodeId = nodeId;
      }
    });

    if (!currentNodeId) {
      return null;
    }

    if (currentNodeId === endNodeId) {
      const pathNodeIds: string[] = [];
      let cursor: string | null = endNodeId;
      while (cursor) {
        pathNodeIds.unshift(cursor);
        cursor = previous.get(cursor) ?? null;
      }

      const points = pathNodeIds
        .map((nodeId) => graph.nodes.get(nodeId)?.point)
        .filter((point): point is RoutePoint => Boolean(point));

      return {
        distanceMeters: currentDistance,
        points,
      };
    }

    visited.add(currentNodeId);
    const currentNode = graph.nodes.get(currentNodeId);
    if (!currentNode) {
      continue;
    }

    currentNode.neighbors.forEach((neighbor) => {
      if (visited.has(neighbor.nodeId)) {
        return;
      }

      const candidateDistance = currentDistance + neighbor.weight;
      const knownDistance = distances.get(neighbor.nodeId) ?? Number.POSITIVE_INFINITY;
      if (candidateDistance < knownDistance) {
        distances.set(neighbor.nodeId, candidateDistance);
        previous.set(neighbor.nodeId, currentNodeId);
      }
    });
  }
}

function buildGraphRoutedSegment(
  graph: TrailGraph,
  start: SnappedTrailPoint,
  end: SnappedTrailPoint
) {
  const directSameSegmentDistance =
    start.segmentStartNodeId === end.segmentStartNodeId &&
    start.segmentEndNodeId === end.segmentEndNodeId
      ? approxDistanceMeters(start.point, end.point)
      : Number.POSITIVE_INFINITY;

  const candidateRoutes = [
    {
      startNodeId: start.segmentStartNodeId,
      endNodeId: end.segmentStartNodeId,
      startJoinMeters: start.distanceToSegmentStartMeters,
      endJoinMeters: end.distanceToSegmentStartMeters,
    },
    {
      startNodeId: start.segmentStartNodeId,
      endNodeId: end.segmentEndNodeId,
      startJoinMeters: start.distanceToSegmentStartMeters,
      endJoinMeters: end.distanceToSegmentEndMeters,
    },
    {
      startNodeId: start.segmentEndNodeId,
      endNodeId: end.segmentStartNodeId,
      startJoinMeters: start.distanceToSegmentEndMeters,
      endJoinMeters: end.distanceToSegmentStartMeters,
    },
    {
      startNodeId: start.segmentEndNodeId,
      endNodeId: end.segmentEndNodeId,
      startJoinMeters: start.distanceToSegmentEndMeters,
      endJoinMeters: end.distanceToSegmentEndMeters,
    },
  ];

  let bestRoute:
    | {
        distanceMeters: number;
        points: RoutePoint[];
      }
    | null = null;

  candidateRoutes.forEach((candidate) => {
    const graphRoute = findShortestPathInTrailGraph(graph, candidate.startNodeId, candidate.endNodeId);
    if (!graphRoute) {
      return;
    }

    const points = dedupeRoutePoints([
      start.point,
      ...graphRoute.points,
      end.point,
    ]);
    const totalDistance =
      candidate.startJoinMeters + graphRoute.distanceMeters + candidate.endJoinMeters;

    if (!bestRoute || totalDistance < bestRoute.distanceMeters) {
      bestRoute = {
        distanceMeters: totalDistance,
        points,
      };
    }
  });

  if (directSameSegmentDistance < Number.POSITIVE_INFINITY) {
    const directRoute = {
      distanceMeters: directSameSegmentDistance,
      points: dedupeRoutePoints([start.point, end.point]),
    };
    if (!bestRoute || directRoute.distanceMeters < bestRoute.distanceMeters) {
      bestRoute = directRoute;
    }
  }

  return bestRoute?.points ?? [];
}

function getEntryCoordinates(entry: TerrainExplorerEntry) {
  const source = entry.route_points.length ? entry.route_points : entry.visits;
  return source
    .map((point) => [point.longitude, point.latitude] as [number, number])
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

function buildLineFeatureCollection(coordinates: Array<[number, number]>) {
  return {
    type: "FeatureCollection" as const,
    features: coordinates.length
      ? [
          {
            type: "Feature" as const,
            geometry: {
              type: "LineString" as const,
              coordinates,
            },
            properties: {},
          },
        ]
      : [],
  };
}

function buildTrailFeatureCollection(trails: PlannedRouteOverlay[] = []) {
  return {
    type: "FeatureCollection" as const,
    features: trails
      .map((trail) => {
        const coordinates = normalizeRoutePoints(trail.points || []).map((point) => [
          point.longitude,
          point.latitude,
        ]) as Array<[number, number]>;
        if (coordinates.length < 2) {
          return null;
        }

        return {
          type: "Feature" as const,
          geometry: {
            type: "LineString" as const,
            coordinates,
          },
          properties: {
            name: trail.name,
          },
        };
      })
      .filter((feature): feature is NonNullable<typeof feature> => Boolean(feature)),
  };
}

function buildControlPointCollection(points: RoutePoint[]) {
  return {
    type: "FeatureCollection" as const,
    features: points.map((point, index) => ({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: [point.longitude, point.latitude] as [number, number],
      },
      properties: {
        index,
        kind:
          index === 0
            ? "start"
            : index === points.length - 1
            ? "end"
            : "mid",
      },
    })),
  };
}

function buildBoundsFromCoordinates(
  coordinates: Array<[number, number]>
): LngLatBoundsLike | null {
  if (!coordinates.length) {
    return null;
  }

  const longitudes = coordinates.map((point) => point[0]);
  const latitudes = coordinates.map((point) => point[1]);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const lonPadding = Math.max((maxLon - minLon) * 0.14, 0.008);
  const latPadding = Math.max((maxLat - minLat) * 0.14, 0.008);

  return [
    [minLon - lonPadding, minLat - latPadding],
    [maxLon + lonPadding, maxLat + latPadding],
  ];
}

function buildBoundsFromViewRectangle(viewBounds: TrailPlannerMapProps["viewBounds"]): LngLatBoundsLike | null {
  if (!viewBounds) {
    return null;
  }

  const latSpan = viewBounds.max_lat - viewBounds.min_lat;
  const lonSpan = viewBounds.max_lon - viewBounds.min_lon;
  if (
    !Number.isFinite(latSpan) ||
    !Number.isFinite(lonSpan) ||
    latSpan <= 0 ||
    lonSpan <= 0 ||
    latSpan > 4 ||
    lonSpan > 4
  ) {
    return null;
  }

  return [
    [viewBounds.min_lon, viewBounds.min_lat],
    [viewBounds.max_lon, viewBounds.max_lat],
  ];
}

function upsertGeoJsonSource(
  map: MapLibreMap,
  id: string,
  data: GeoJSONSourceSpecification["data"]
) {
  const source = map.getSource(id) as
    | { setData?: (value: GeoJSONSourceSpecification["data"]) => void }
    | undefined;
  if (source?.setData) {
    source.setData(data);
    return;
  }

  map.addSource(id, {
    type: "geojson",
    data,
  });
}

function ensurePlannerLayers(map: MapLibreMap) {
  if (!map.getLayer("planner-known-trails-glow")) {
    map.addLayer({
      id: "planner-known-trails-glow",
      type: "line",
      source: "planner-known-trails",
      paint: {
        "line-color": "rgba(34,211,238,0.08)",
        "line-width": 4,
        "line-blur": 1.2,
      },
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
    });
  }

  if (!map.getLayer("planner-known-trails")) {
    map.addLayer({
      id: "planner-known-trails",
      type: "line",
      source: "planner-known-trails",
      paint: {
        "line-color": "#22d3ee",
        "line-width": 1.4,
        "line-opacity": 0.2,
      },
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
    });
  }

  if (!map.getLayer("planner-actual-route")) {
    map.addLayer({
      id: "planner-actual-route",
      type: "line",
      source: "planner-actual-route",
      paint: {
        "line-color": "#34d399",
        "line-width": 3,
        "line-opacity": 0.72,
      },
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
    });
  }

  if (!map.getLayer("planner-reference-route")) {
    map.addLayer({
      id: "planner-reference-route",
      type: "line",
      source: "planner-reference-route",
      paint: {
        "line-color": "#fb923c",
        "line-width": 3,
        "line-opacity": 0.9,
      },
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
    });
  }

  if (!map.getLayer("planner-route-glow")) {
    map.addLayer({
      id: "planner-route-glow",
      type: "line",
      source: "planner-route",
      paint: {
        "line-color": "rgba(251,191,36,0.34)",
        "line-width": 12,
        "line-blur": 2,
      },
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
    });
  }

  if (!map.getLayer("planner-route")) {
    map.addLayer({
      id: "planner-route",
      type: "line",
      source: "planner-route",
      paint: {
        "line-color": "#f59e0b",
        "line-width": 4,
      },
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
    });
  }

  if (!map.getLayer("planner-control-points")) {
    map.addLayer({
      id: "planner-control-points",
      type: "circle",
      source: "planner-control-points",
      paint: {
        "circle-radius": [
          "match",
          ["get", "kind"],
          "start",
          7,
          "end",
          7,
          5,
        ],
        "circle-color": [
          "match",
          ["get", "kind"],
          "start",
          "#fde68a",
          "end",
          "#f97316",
          "#fff7d6",
        ],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#111827",
      },
    });
  }
}

function fitBounds(map: MapLibreMap, bounds: LngLatBoundsLike) {
  const container = map.getContainer();
  const horizontalPadding = Math.max(Math.min(container.clientWidth * 0.08, 42), 24);
  const verticalPadding = Math.max(Math.min(container.clientHeight * 0.12, 42), 24);
  map.fitBounds(bounds, {
    padding: {
      top: verticalPadding,
      right: horizontalPadding,
      bottom: verticalPadding,
      left: horizontalPadding,
    },
    duration: 0,
    maxZoom: 15,
  });
}

function getMapViewBounds(map: MapLibreMap) {
  const bounds = map.getBounds();
  return {
    min_lat: bounds.getSouth(),
    min_lon: bounds.getWest(),
    max_lat: bounds.getNorth(),
    max_lon: bounds.getEast(),
  };
}

function getPlannerTargetBounds(
  entry: TerrainExplorerEntry,
  plannedRoute: PlannedRouteOverlay | null,
  viewBounds: TrailPlannerMapProps["viewBounds"]
) {
  return (
    buildBoundsFromViewRectangle(viewBounds) ||
    buildBoundsFromCoordinates(
      normalizeRoutePoints(plannedRoute?.points || []).map((point) => [
        point.longitude,
        point.latitude,
      ]) as Array<[number, number]>
    ) ||
    buildBoundsFromCoordinates(getEntryCoordinates(entry)) ||
    DEFAULT_PROVO_BOUNDS
  );
}

function buildBoundsFromSearchResult(
  result: NonNullable<TrailPlannerMapProps["focusSearchResult"]>
): LngLatBoundsLike | null {
  const bounds = result.boundingbox;
  if (Array.isArray(bounds) && bounds.length === 4) {
    const south = Number(bounds[0]);
    const north = Number(bounds[1]);
    const west = Number(bounds[2]);
    const east = Number(bounds[3]);
    if (
      Number.isFinite(south) &&
      Number.isFinite(north) &&
      Number.isFinite(west) &&
      Number.isFinite(east)
    ) {
      return [
        [west, south],
        [east, north],
      ];
    }
  }

  const latitude = Number(result.lat);
  const longitude = Number(result.lon);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return [
      [longitude - 0.02, latitude - 0.02],
      [longitude + 0.02, latitude + 0.02],
    ];
  }

  return null;
}

function syncPlannerMap(
  map: MapLibreMap,
  entry: TerrainExplorerEntry,
  plannedRoute: PlannedRouteOverlay | null,
  referenceTrail: PlannedRouteOverlay | null,
  knownTrails: PlannedRouteOverlay[] = []
) {
  const entryCoordinates = getEntryCoordinates(entry);
  const routeCoordinates = normalizeRoutePoints(plannedRoute?.points || []).map((point) => [
    point.longitude,
    point.latitude,
  ]) as Array<[number, number]>;
  const controlPoints = getRouteControlPoints(plannedRoute);
  const referenceCoordinates = normalizeRoutePoints(referenceTrail?.points || []).map((point) => [
    point.longitude,
    point.latitude,
  ]) as Array<[number, number]>;

  upsertGeoJsonSource(map, "planner-known-trails", buildTrailFeatureCollection(knownTrails));
  upsertGeoJsonSource(map, "planner-actual-route", buildLineFeatureCollection(entryCoordinates));
  upsertGeoJsonSource(map, "planner-reference-route", buildLineFeatureCollection(referenceCoordinates));
  upsertGeoJsonSource(map, "planner-route", buildLineFeatureCollection(routeCoordinates));
  upsertGeoJsonSource(map, "planner-control-points", buildControlPointCollection(controlPoints));
  ensurePlannerLayers(map);
}

function formatHours(hours: number) {
  if (!Number.isFinite(hours) || hours <= 0) {
    return "--";
  }

  if (hours < 1) {
    return `${Math.round(hours * 60)} min`;
  }

  return `${hours.toFixed(1)} hr`;
}

function formatDistanceKm(distanceKm: number) {
  return `${distanceKm.toFixed(distanceKm >= 10 ? 1 : 2)} km`;
}

function haversineDistanceKm(a: RoutePoint, b: RoutePoint) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

export function calculateRouteStats(route: PlannedRouteOverlay | null): RouteStats {
  const points = normalizeRoutePoints(route?.points || []);
  const controlPoints = getRouteControlPoints(route);
  let distanceKm = 0;

  for (let index = 1; index < points.length; index += 1) {
    distanceKm += haversineDistanceKm(points[index - 1], points[index]);
  }

  return {
    distanceKm,
    estimatedHours: distanceKm / 4.2,
    renderedPointCount: points.length,
    controlPointCount: controlPoints.length,
  };
}

async function routeSegmentViaHostedRouter(
  start: RoutePoint,
  end: RoutePoint
): Promise<{ points: RoutePoint[]; provider: "stadia" }> {
  const response = await fetch("/jarvis-routing", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ start, end }),
    cache: "no-store",
  });
  if (!response.ok) {
    let detail = "";
    try {
      const data = (await response.json()) as { detail?: string };
      detail = data.detail || "";
    } catch {
      try {
        detail = await response.text();
      } catch {
        detail = "";
      }
    }

    throw new Error(detail || `Routing API returned ${response.status}`);
  }

  const data = (await response.json()) as {
    points?: RoutePoint[];
    provider?: "stadia";
  };
  const points = normalizeRoutePoints(data.points || []);
  return {
    points: points.length ? points : [start, end],
    provider: data.provider === "stadia" ? "stadia" : "stadia",
  };
}

export async function buildPlannedRouteOverlay(args: {
  name: string;
  controlPoints: RoutePoint[];
  snapToPaths: boolean;
  preferredTrails?: PlannedRouteOverlay[];
}): Promise<RouteBuildResult> {
  const controlPoints = normalizeRoutePoints(args.controlPoints);
  if (!controlPoints.length) {
    return {
      overlay: null,
      source: "idle",
      diagnostics: [],
    };
  }

  if (controlPoints.length === 1) {
    return {
      overlay: {
        name: args.name.trim() || DEFAULT_ROUTE_NAME,
        controlPoints,
        points: controlPoints,
      } satisfies PlannedRouteOverlay,
      source: args.snapToPaths ? "idle" : "manual",
      diagnostics: [],
    };
  }

  if (!args.snapToPaths) {
    return {
      overlay: {
        name: args.name.trim() || DEFAULT_ROUTE_NAME,
        controlPoints,
        points: controlPoints,
      } satisfies PlannedRouteOverlay,
      source: "manual",
      diagnostics: [],
    };
  }

  const graph = buildTrailGraph(args.preferredTrails || []);
  const hasKnownTrailGraph = graph.nodes.size > 0;
  const routedPoints: RoutePoint[] = [];
  let resolvedSource: RouteBuildSource = "direct";
  const diagnostics: string[] = [];
  for (let index = 1; index < controlPoints.length; index += 1) {
    const start = controlPoints[index - 1];
    const end = controlPoints[index];
    const snappedStart = snapPointToTrailGraph(start, args.preferredTrails || [], graph);
    const snappedEnd = snapPointToTrailGraph(end, args.preferredTrails || [], graph);
    const forcedSnappedStart =
      snappedStart ??
      (hasKnownTrailGraph
        ? snapPointToTrailGraph(
            start,
            args.preferredTrails || [],
            graph,
            Number.POSITIVE_INFINITY
          )
        : null);
    const forcedSnappedEnd =
      snappedEnd ??
      (hasKnownTrailGraph
        ? snapPointToTrailGraph(
            end,
            args.preferredTrails || [],
            graph,
            Number.POSITIVE_INFINITY
          )
        : null);

    if (forcedSnappedStart && forcedSnappedEnd) {
      const trailSegment = buildGraphRoutedSegment(graph, forcedSnappedStart, forcedSnappedEnd);
      if (trailSegment.length) {
        routedPoints.push(...(index === 1 ? trailSegment : trailSegment.slice(1)));
        if (resolvedSource !== "stadia") {
          resolvedSource = "local-graph";
        }
        if (!snappedStart || !snappedEnd) {
          diagnostics.push(
            `Segment ${index}: one or both anchors were off-trail, so the planner snapped them to the nearest loaded trail and kept the route trail-constrained.`
          );
        }
        continue;
      }
    }

    if (hasKnownTrailGraph) {
      if (forcedSnappedStart && forcedSnappedEnd) {
        routedPoints.push(
          ...(index === 1
            ? [forcedSnappedStart.point, forcedSnappedEnd.point]
            : [forcedSnappedEnd.point])
        );
        diagnostics.push(
          `Segment ${index}: loaded trail data was available but did not provide a connected path, so the route stayed constrained to the nearest snapped trail anchors instead of falling back to Stadia.`
        );
        continue;
      }

      if (forcedSnappedStart || forcedSnappedEnd) {
        routedPoints.push(
          ...(index === 1
            ? [forcedSnappedStart?.point || start, forcedSnappedEnd?.point || end]
            : [forcedSnappedEnd?.point || end])
        );
        diagnostics.push(
          `Segment ${index}: the planner snapped toward the nearest loaded trail geometry and skipped Stadia because loaded trails are authoritative in snap mode.`
        );
        continue;
      }
    }

    try {
      const hostedRoute = await routeSegmentViaHostedRouter(start, end);
      routedPoints.push(...(index === 1 ? hostedRoute.points : hostedRoute.points.slice(1)));
      resolvedSource = hostedRoute.provider;
      continue;
    } catch (error) {
      const hostedError =
        error instanceof Error ? error.message : "Hosted routing request failed.";

      diagnostics.push(
        `Segment ${index}: no connected hiking-trail path was available, and Stadia fallback failed (${hostedError}); the planner fell back to a direct line.`
      );
      routedPoints.push(...(index === 1 ? [start, end] : [end]));
    }
  }

  return {
    overlay: {
      name: args.name.trim() || DEFAULT_ROUTE_NAME,
      controlPoints,
      points: normalizeRoutePoints(routedPoints),
    } satisfies PlannedRouteOverlay,
    source: resolvedSource,
    diagnostics,
  };
}

export function TrailPlannerMap({
  entry,
  plannedRoute,
  referenceTrail = null,
  knownTrails = [],
  viewBounds = null,
  viewSyncNonce = 0,
  focusSearchResult = null,
  onViewBoundsChange,
  onPlannedRouteChange,
  className,
  mapClassName,
}: TrailPlannerMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const latestEntryRef = useRef(entry);
  const latestRouteRef = useRef(plannedRoute);
  const latestReferenceTrailRef = useRef(referenceTrail);
  const latestKnownTrailsRef = useRef(knownTrails);
  const onViewBoundsChangeRef = useRef(onViewBoundsChange);
  const onPlannedRouteChangeRef = useRef(onPlannedRouteChange);
  const draftNameRef = useRef(plannedRoute?.name || DEFAULT_ROUTE_NAME);
  const snapToPathsRef = useRef(true);
  const commitControlPointsRef = useRef<
    ((controlPoints: RoutePoint[], options?: {
      selectedIndex?: number | null;
      provisionalRenderedPoints?: RoutePoint[];
    }) => Promise<void>) | null
  >(null);
  const controlPointsRef = useRef<RoutePoint[]>(getRouteControlPoints(plannedRoute));
  const renderedPointsRef = useRef<RoutePoint[]>(cloneRoutePoints(plannedRoute?.points || []));
  const dragStateRef = useRef<{ index: number } | null>(null);
  const freeDrawStateRef = useRef<{
    baseControlPoints: RoutePoint[];
    baseRenderedPoints: RoutePoint[];
    sampledPoints: RoutePoint[];
    lastPoint: RoutePoint;
  } | null>(null);
  const rerouteRequestIdRef = useRef(0);
  const lastAppliedViewBoundsKeyRef = useRef<string | null>(null);
  const [draftName, setDraftName] = useState(plannedRoute?.name || DEFAULT_ROUTE_NAME);
  const [mapStyle, setMapStyle] = useState<PlannerMapStyle>("topo");
  const [snapToPaths, setSnapToPaths] = useState(true);
  const [selectedControlPointIndex, setSelectedControlPointIndex] = useState<number | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [routeDiagnostics, setRouteDiagnostics] = useState<string[]>([]);
  const [routingSource, setRoutingSource] = useState<RouteBuildSource>(plannedRoute ? "direct" : "idle");
  const [localControlPoints, setLocalControlPoints] = useState<RoutePoint[]>(
    getRouteControlPoints(plannedRoute)
  );
  const [localRenderedPoints, setLocalRenderedPoints] = useState<RoutePoint[]>(
    cloneRoutePoints(plannedRoute?.points || [])
  );
  const [isDraggingPoint, setIsDraggingPoint] = useState(false);

  const entryKey = useMemo(
    () =>
      JSON.stringify({
        route_points: entry.route_points.map((point) => [point.longitude, point.latitude]),
        visits: entry.visits.map((visit) => [visit.longitude, visit.latitude, visit.label || ""]),
      }),
    [entry]
  );
  const routeKey = useMemo(
    () =>
      JSON.stringify({
        points: (plannedRoute?.points || []).map((point) => [point.longitude, point.latitude]),
        controlPoints: getRouteControlPoints(plannedRoute).map((point) => [point.longitude, point.latitude]),
      }),
    [plannedRoute]
  );
  const referenceTrailKey = useMemo(
    () =>
      JSON.stringify((referenceTrail?.points || []).map((point) => [point.longitude, point.latitude])),
    [referenceTrail]
  );
  const stats = useMemo(() => calculateRouteStats(plannedRoute), [plannedRoute]);
  const hasExplicitControlPoints = Boolean(plannedRoute?.controlPoints?.length);
  const viewBoundsKey = useMemo(
    () =>
      viewBounds
        ? `${viewBounds.min_lat}:${viewBounds.min_lon}:${viewBounds.max_lat}:${viewBounds.max_lon}`
        : "null",
    [viewBounds]
  );
  const viewSyncKey = `${viewSyncNonce}:${viewBoundsKey}`;
  const focusSearchKey = useMemo(
    () =>
      focusSearchResult
        ? `${String(focusSearchResult.place_id)}:${focusSearchResult.lat}:${focusSearchResult.lon}:${focusSearchResult.display_name}`
        : "null",
    [focusSearchResult]
  );

  useEffect(() => {
    latestEntryRef.current = entry;
  }, [entry, entryKey]);

  useEffect(() => {
    latestRouteRef.current = plannedRoute;
    setDraftName(plannedRoute?.name || DEFAULT_ROUTE_NAME);
    draftNameRef.current = plannedRoute?.name || DEFAULT_ROUTE_NAME;
    const controlPointCount = getRouteControlPoints(plannedRoute).length;
    setSelectedControlPointIndex((current) =>
      current !== null && current < controlPointCount ? current : null
    );
    if (!dragStateRef.current) {
      const nextControlPoints = getRouteControlPoints(plannedRoute);
      const nextRenderedPoints = cloneRoutePoints(plannedRoute?.points || []);
      controlPointsRef.current = nextControlPoints;
      renderedPointsRef.current = nextRenderedPoints;
      setLocalControlPoints(nextControlPoints);
      setLocalRenderedPoints(nextRenderedPoints);
    }
    if (!plannedRoute) {
      setRoutingSource("idle");
      setRouteDiagnostics([]);
    }
  }, [plannedRoute, routeKey]);

  useEffect(() => {
    latestReferenceTrailRef.current = referenceTrail;
  }, [referenceTrail, referenceTrailKey]);

  useEffect(() => {
    latestKnownTrailsRef.current = knownTrails;
  }, [knownTrails]);

  useEffect(() => {
    onViewBoundsChangeRef.current = onViewBoundsChange;
  }, [onViewBoundsChange]);

  useEffect(() => {
    onPlannedRouteChangeRef.current = onPlannedRouteChange;
  }, [onPlannedRouteChange]);

  useEffect(() => {
    draftNameRef.current = draftName;
  }, [draftName]);

  useEffect(() => {
    snapToPathsRef.current = snapToPaths;
  }, [snapToPaths]);

  const applyLocalRouteDraft = (
    controlPoints: RoutePoint[],
    renderedPoints?: RoutePoint[],
    options?: {
      selectedIndex?: number | null;
    }
  ) => {
    const nextControlPoints = cloneRoutePoints(controlPoints);
    const nextRenderedPoints = cloneRoutePoints(
      renderedPoints?.length ? renderedPoints : nextControlPoints
    );
    controlPointsRef.current = nextControlPoints;
    renderedPointsRef.current = nextRenderedPoints;
    setLocalControlPoints(nextControlPoints);
    setLocalRenderedPoints(nextRenderedPoints);
    if (options && "selectedIndex" in options) {
      setSelectedControlPointIndex(options.selectedIndex ?? null);
    }
  };

  const commitControlPoints = async (
    controlPoints: RoutePoint[],
    options?: {
      selectedIndex?: number | null;
      provisionalRenderedPoints?: RoutePoint[];
    }
  ) => {
    const normalizedControlPoints = normalizeRoutePoints(controlPoints);
    const nextRequestId = rerouteRequestIdRef.current + 1;
    rerouteRequestIdRef.current = nextRequestId;
    const shouldUseProvisionalRenderedPoints =
      !snapToPathsRef.current || Boolean(options?.provisionalRenderedPoints?.length);
    applyLocalRouteDraft(
      normalizedControlPoints,
      shouldUseProvisionalRenderedPoints
        ? options?.provisionalRenderedPoints
        : renderedPointsRef.current,
      { selectedIndex: options?.selectedIndex }
    );
    setRouteError("");

    if (snapToPathsRef.current && normalizedControlPoints.length < 2) {
      const nextRoute = await buildPlannedRouteOverlay({
        name: draftNameRef.current || DEFAULT_ROUTE_NAME,
        controlPoints: normalizedControlPoints,
        snapToPaths: true,
        preferredTrails: knownTrails,
      });
      if (rerouteRequestIdRef.current !== nextRequestId) {
        return;
      }

      applyLocalRouteDraft(
        nextRoute.overlay?.controlPoints || [],
        nextRoute.overlay?.points || [],
        { selectedIndex: options?.selectedIndex }
      );
      setRoutingSource(nextRoute.source);
      setRouteDiagnostics(nextRoute.diagnostics || []);
      onPlannedRouteChangeRef.current(nextRoute.overlay);
      setRouteLoading(false);
      return;
    }

    setRouteLoading(true);

    try {
      const nextRoute =
        !snapToPathsRef.current && options?.provisionalRenderedPoints?.length
          ? {
              overlay: buildOverlayFromPoints(
                draftNameRef.current || DEFAULT_ROUTE_NAME,
                normalizedControlPoints,
                options.provisionalRenderedPoints
              ),
              source: "manual" as const,
            }
          : await buildPlannedRouteOverlay({
              name: draftNameRef.current || DEFAULT_ROUTE_NAME,
              controlPoints: normalizedControlPoints,
              snapToPaths: snapToPathsRef.current,
              preferredTrails: knownTrails,
            });
      if (rerouteRequestIdRef.current !== nextRequestId) {
        return;
      }

      applyLocalRouteDraft(
        nextRoute.overlay?.controlPoints || [],
        nextRoute.overlay?.points || [],
        { selectedIndex: options?.selectedIndex }
      );
      setRoutingSource(nextRoute.source);
      setRouteDiagnostics(nextRoute.diagnostics || []);
      onPlannedRouteChangeRef.current(nextRoute.overlay);
    } catch (error) {
      if (rerouteRequestIdRef.current !== nextRequestId) {
        return;
      }
      setRouteError(error instanceof Error ? error.message : "Unable to update the route.");
      setRouteDiagnostics([]);
    } finally {
      if (rerouteRequestIdRef.current === nextRequestId) {
        setRouteLoading(false);
      }
    }
  };

  useEffect(() => {
    commitControlPointsRef.current = commitControlPoints;
  });

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      if (!containerRef.current || mapRef.current) {
        return;
      }

      const maplibregl = (await import("maplibre-gl")).default;
      if (cancelled || !containerRef.current) {
        return;
      }

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: buildBaseStyle("topo"),
        center: DEFAULT_PROVO_CENTER,
        zoom: DEFAULT_PROVO_ZOOM,
        attributionControl: false,
        interactive: true,
        dragPan: true,
        scrollZoom: true,
        boxZoom: false,
        dragRotate: true,
        doubleClickZoom: false,
        touchZoomRotate: true,
        cooperativeGestures: false,
        pitchWithRotate: false,
        keyboard: true,
        maxZoom: 17,
      });

      mapRef.current = map;
      map.addControl(
        new maplibregl.NavigationControl({
          showCompass: true,
          showZoom: true,
          visualizePitch: false,
        }),
        "bottom-right"
      );

      map.on("load", () => {
        if (cancelled) {
          return;
        }
        syncPlannerMap(
          map,
          latestEntryRef.current,
          latestRouteRef.current,
          latestReferenceTrailRef.current,
          latestKnownTrailsRef.current
        );
        onViewBoundsChangeRef.current?.(getMapViewBounds(map));
      });

      map.on("styledata", () => {
        if (!map.isStyleLoaded()) {
          return;
        }
        syncPlannerMap(
          map,
          latestEntryRef.current,
          buildOverlayFromPoints(
            draftNameRef.current,
            controlPointsRef.current,
            renderedPointsRef.current
          ),
          latestReferenceTrailRef.current
        );
      });

      const handlePointMouseDown = (event: MapLayerMouseEvent) => {
        const feature = event.features?.[0];
        const pointIndex = Number(feature?.properties?.index);
        if (!Number.isFinite(pointIndex)) {
          return;
        }
        dragStateRef.current = { index: pointIndex };
        setSelectedControlPointIndex(pointIndex);
        setIsDraggingPoint(true);
        map.getCanvas().style.cursor = "grabbing";
        map.dragPan.disable();
      };

      const handleMapMouseDown = (event: MapMouseEvent) => {
        if (dragStateRef.current || snapToPathsRef.current) {
          return;
        }

        if (!event.originalEvent.shiftKey) {
          return;
        }

        const pointFeatures = map.queryRenderedFeatures(event.point, {
          layers: ["planner-control-points"],
        });
        if (pointFeatures.length) {
          return;
        }

        const startPoint = {
          latitude: event.lngLat.lat,
          longitude: event.lngLat.lng,
        };
        const baseControlPoints = cloneRoutePoints(controlPointsRef.current);
        const baseRenderedPoints = cloneRoutePoints(renderedPointsRef.current);
        const sampledStart =
          baseControlPoints.length > 0
            ? baseControlPoints[baseControlPoints.length - 1]
            : startPoint;
        const provisionalControlPoints = baseControlPoints.length
          ? [...baseControlPoints, startPoint]
          : [sampledStart, startPoint];
        freeDrawStateRef.current = {
          baseControlPoints,
          baseRenderedPoints,
          sampledPoints: [sampledStart, startPoint],
          lastPoint: startPoint,
        };
        setSelectedControlPointIndex(provisionalControlPoints.length - 1);
        setIsDraggingPoint(true);
        map.getCanvas().style.cursor = "crosshair";
        map.dragPan.disable();
        applyLocalRouteDraft(provisionalControlPoints, [
          ...baseRenderedPoints,
          ...(baseRenderedPoints.length ? [startPoint] : [sampledStart, startPoint]),
        ], {
          selectedIndex: provisionalControlPoints.length - 1,
        });
      };

      const handleMouseMove = (event: MapMouseEvent) => {
        if (!dragStateRef.current) {
          if (!freeDrawStateRef.current) {
            return;
          }

          const nextPoint = {
            latitude: event.lngLat.lat,
            longitude: event.lngLat.lng,
          };
          if (!shouldAppendFreeDrawPoint(freeDrawStateRef.current.lastPoint, nextPoint)) {
            return;
          }

          freeDrawStateRef.current = {
            ...freeDrawStateRef.current,
            sampledPoints: [...freeDrawStateRef.current.sampledPoints, nextPoint],
            lastPoint: nextPoint,
          };
          const provisionalControlPoints = freeDrawStateRef.current.baseControlPoints.length
            ? [...freeDrawStateRef.current.baseControlPoints, nextPoint]
            : [freeDrawStateRef.current.sampledPoints[0], nextPoint];
          const provisionalRenderedPoints = [
            ...freeDrawStateRef.current.baseRenderedPoints,
            ...freeDrawStateRef.current.sampledPoints.slice(
              freeDrawStateRef.current.baseRenderedPoints.length ? 1 : 0
            ),
          ];
          applyLocalRouteDraft(
            provisionalControlPoints,
            provisionalRenderedPoints,
            {
              selectedIndex: provisionalControlPoints.length - 1,
            }
          );
          return;
        }
        const nextControlPoints = cloneRoutePoints(controlPointsRef.current);
        nextControlPoints[dragStateRef.current.index] = {
          latitude: event.lngLat.lat,
          longitude: event.lngLat.lng,
        };
        applyLocalRouteDraft(
          nextControlPoints,
          snapToPathsRef.current ? renderedPointsRef.current : nextControlPoints,
          {
            selectedIndex: dragStateRef.current.index,
          }
        );
      };

      const finishDrag = async () => {
        if (freeDrawStateRef.current) {
          const { baseControlPoints, baseRenderedPoints, sampledPoints } = freeDrawStateRef.current;
          freeDrawStateRef.current = null;
          setIsDraggingPoint(false);
          map.getCanvas().style.cursor = "";
          map.dragPan.enable();
          const simplifiedSegment = simplifyFreehandPoints(sampledPoints);
          const endPoint = simplifiedSegment[simplifiedSegment.length - 1];
          const finalControlPoints = baseControlPoints.length
            ? [...baseControlPoints, endPoint]
            : [sampledPoints[0], endPoint];
          const finalRenderedPoints = [
            ...baseRenderedPoints,
            ...simplifiedSegment.slice(baseRenderedPoints.length ? 1 : 0),
          ];
          await commitControlPointsRef.current?.(finalControlPoints, {
            selectedIndex: finalControlPoints.length - 1,
            provisionalRenderedPoints: finalRenderedPoints,
          });
          return;
        }

        if (!dragStateRef.current) {
          return;
        }
        const dragIndex = dragStateRef.current.index;
        dragStateRef.current = null;
        setIsDraggingPoint(false);
        map.getCanvas().style.cursor = "";
        map.dragPan.enable();
        await commitControlPointsRef.current?.(controlPointsRef.current, {
          selectedIndex: dragIndex,
          provisionalRenderedPoints: snapToPathsRef.current ? undefined : controlPointsRef.current,
        });
      };

      map.on("mousedown", handleMapMouseDown);
      map.on("mousedown", "planner-control-points", handlePointMouseDown);
      map.on("mousemove", handleMouseMove);
      map.on("mouseup", () => {
        void finishDrag();
      });
      map.on("touchend", () => {
        void finishDrag();
      });

      map.on("mouseenter", "planner-control-points", () => {
        if (!dragStateRef.current) {
          map.getCanvas().style.cursor = "grab";
        }
      });
      map.on("mouseleave", "planner-control-points", () => {
        if (!dragStateRef.current) {
          map.getCanvas().style.cursor = "";
        }
      });

      map.on("click", async (event) => {
        if (dragStateRef.current || event.originalEvent.shiftKey) {
          return;
        }
        const pointFeatures = map.queryRenderedFeatures(event.point, {
          layers: ["planner-control-points"],
        });
        const pointIndex = pointFeatures[0]?.properties?.index;
        if (pointIndex !== undefined && pointIndex !== null && pointIndex !== "") {
          const parsedIndex = Number(pointIndex);
          if (Number.isFinite(parsedIndex)) {
            setSelectedControlPointIndex(parsedIndex);
            return;
          }
        }

        setRouteLoading(true);
        try {
          const nextControlPoints = [
            ...cloneRoutePoints(controlPointsRef.current),
            {
              latitude: event.lngLat.lat,
              longitude: event.lngLat.lng,
            },
          ];
          await commitControlPointsRef.current?.(nextControlPoints, {
            selectedIndex: nextControlPoints.length - 1,
            provisionalRenderedPoints: snapToPathsRef.current ? undefined : nextControlPoints,
          });
        } catch (error) {
          setRouteError(error instanceof Error ? error.message : "Unable to update the route.");
        }
      });

      map.on("dblclick", (event) => {
        event.preventDefault();
      });

      map.on("moveend", () => {
        onViewBoundsChangeRef.current?.(getMapViewBounds(map));
      });

      return () => {
        map.off("mousedown", handleMapMouseDown);
        map.off("mousedown", "planner-control-points", handlePointMouseDown);
        map.off("mousemove", handleMouseMove);
      };
    }

    let cleanup: (() => void) | undefined;
    void mount().then((result) => {
      cleanup = result;
    });

    return () => {
      cancelled = true;
      cleanup?.();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    map.setStyle(buildBaseStyle(mapStyle));
  }, [mapStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (map.isStyleLoaded()) {
      syncPlannerMap(map, entry, plannedRoute, referenceTrail, knownTrails);
      return;
    }

    const handleLoad = () => syncPlannerMap(map, entry, plannedRoute, referenceTrail, knownTrails);
    map.once("load", handleLoad);
    return () => {
      map.off("load", handleLoad);
    };
  }, [entry, entryKey, plannedRoute, routeKey, referenceTrail, referenceTrailKey, knownTrails]);

  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container || typeof ResizeObserver === "undefined") {
      return;
    }

    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        map.resize();
      });
    });

    observer.observe(container);

    return () => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const routeBounds = getPlannerTargetBounds(entry, plannedRoute, viewBounds);
    if (!routeBounds) {
      return;
    }

    const applyBounds = () => {
      if (!map.isStyleLoaded()) {
        return;
      }
      if (lastAppliedViewBoundsKeyRef.current === viewSyncKey) {
        return;
      }
      fitBounds(map, routeBounds);
      lastAppliedViewBoundsKeyRef.current = viewSyncKey;
    };

    if (map.isStyleLoaded()) {
      applyBounds();
      return;
    }

    map.once("load", applyBounds);
    return () => {
      map.off("load", applyBounds);
    };
  }, [entry, plannedRoute, viewBounds, viewBoundsKey, viewSyncKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusSearchResult) {
      return;
    }

    const bounds = buildBoundsFromSearchResult(focusSearchResult);
    if (!bounds) {
      return;
    }

    const applyFocus = () => {
      if (!map.isStyleLoaded()) {
        return;
      }
      fitBounds(map, bounds);
    };

    if (map.isStyleLoaded()) {
      applyFocus();
      return;
    }

    map.once("load", applyFocus);
    return () => {
      map.off("load", applyFocus);
    };
  }, [focusSearchKey, focusSearchResult]);

  useEffect(() => {
    if (!hasExplicitControlPoints) {
      return;
    }

    const controlPoints = cloneRoutePoints(controlPointsRef.current);
    if (controlPoints.length < 2) {
      return;
    }

    void commitControlPointsRef.current?.(controlPoints, {
      selectedIndex: selectedControlPointIndex,
      provisionalRenderedPoints: snapToPaths ? undefined : controlPoints,
    });
  }, [hasExplicitControlPoints, selectedControlPointIndex, snapToPaths]);

  const renameRoute = (name: string) => {
    setDraftName(name);
    if (!plannedRoute) {
      return;
    }
    onPlannedRouteChange({
      ...plannedRoute,
      name: name.trim() || DEFAULT_ROUTE_NAME,
    });
  };

  const rebuildFromControlPoints = async (
    controlPoints: RoutePoint[],
    options?: {
      selectedIndex?: number | null;
      provisionalRenderedPoints?: RoutePoint[];
    }
  ) => {
    await commitControlPoints(controlPoints, options);
  };

  const controlPoints = localControlPoints;
  const clearRoute = () => {
    rerouteRequestIdRef.current += 1;
    dragStateRef.current = null;
    freeDrawStateRef.current = null;
    setRouteLoading(false);
    setRouteError("");
    setRoutingSource("idle");
    setRouteDiagnostics([]);
    applyLocalRouteDraft([], [], { selectedIndex: null });
    onPlannedRouteChangeRef.current(null);
  };
  const displayRoute = useMemo(
    () => buildOverlayFromPoints(draftName, localControlPoints, localRenderedPoints),
    [draftName, localControlPoints, localRenderedPoints]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }
    syncPlannerMap(map, entry, displayRoute, referenceTrail, knownTrails);
  }, [displayRoute, entry, referenceTrail, knownTrails]);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-3 rounded-[1.1rem] border border-white/10 bg-black/10 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={draftName}
              onChange={(event) => renameRoute(event.target.value)}
              placeholder="Route name"
              className="h-10 min-w-[15rem] flex-1 rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-amber-300/40"
            />
            <label className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200">
              <span className="mr-2 text-slate-400">Basemap</span>
              <select
                value={mapStyle}
                onChange={(event) => setMapStyle(event.target.value as PlannerMapStyle)}
                className="bg-transparent text-slate-100 outline-none"
              >
                <option value="topo">Topo</option>
                <option value="osm">Streets</option>
                <option value="satellite">Satellite</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => setSnapToPaths((current) => !current)}
              className={cn(
                "rounded-full border px-3 py-2 text-xs transition",
                snapToPaths
                  ? "border-emerald-300/25 bg-emerald-400/12 text-emerald-100"
                  : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
              )}
            >
              {snapToPaths ? "Snap to paths" : "Manual draw"}
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                void rebuildFromControlPoints(controlPoints.slice(0, -1), {
                  selectedIndex: null,
                  provisionalRenderedPoints: snapToPaths ? undefined : controlPoints.slice(0, -1),
                })
              }
              disabled={!controlPoints.length || routeLoading}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => {
                if (selectedControlPointIndex === null) {
                  return;
                }
                const nextControlPoints = controlPoints.filter(
                  (_, index) => index !== selectedControlPointIndex
                );
                void rebuildFromControlPoints(nextControlPoints, {
                  selectedIndex: null,
                  provisionalRenderedPoints: snapToPaths ? undefined : nextControlPoints,
                });
              }}
              disabled={selectedControlPointIndex === null || routeLoading}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Delete selected
            </button>
            <button
              type="button"
              onClick={() =>
                void rebuildFromControlPoints([...controlPoints].reverse(), {
                  selectedIndex: null,
                  provisionalRenderedPoints: snapToPaths ? undefined : [...controlPoints].reverse(),
                })
              }
              disabled={controlPoints.length < 2 || routeLoading}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Reverse
            </button>
            <button
              type="button"
              onClick={() =>
                void rebuildFromControlPoints([
                  ...controlPoints,
                  ...[...controlPoints].slice(0, -1).reverse(),
                ], {
                  selectedIndex: null,
                  provisionalRenderedPoints: snapToPaths
                    ? undefined
                    : [
                        ...controlPoints,
                        ...[...controlPoints].slice(0, -1).reverse(),
                      ],
                })
              }
              disabled={controlPoints.length < 2 || routeLoading}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Double back
            </button>
            <button
              type="button"
              onClick={() => {
                if (!controlPoints.length) {
                  return;
                }
                const first = controlPoints[0];
                const last = controlPoints[controlPoints.length - 1];
                const alreadyClosed =
                  Math.abs(first.latitude - last.latitude) < 0.000001 &&
                  Math.abs(first.longitude - last.longitude) < 0.000001;
                void rebuildFromControlPoints(
                  alreadyClosed ? controlPoints : [...controlPoints, first],
                  {
                    selectedIndex: null,
                    provisionalRenderedPoints: snapToPaths
                      ? undefined
                      : alreadyClosed
                      ? controlPoints
                      : [...controlPoints, first],
                  }
                );
              }}
              disabled={controlPoints.length < 3 || routeLoading}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Close loop
            </button>
            <button
              type="button"
              onClick={clearRoute}
              disabled={!plannedRoute || routeLoading}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Clear
            </button>
          </div>

          {routeError ? <div className="text-xs text-rose-200">{routeError}</div> : null}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={cn(
                "rounded-full border px-2.5 py-1",
                routingSource === "stadia"
                  ? "border-emerald-300/25 bg-emerald-400/12 text-emerald-100"
                  : routingSource === "local-graph"
                  ? "border-amber-300/25 bg-amber-400/12 text-amber-100"
                  : "border-white/10 bg-white/5 text-slate-300"
              )}
            >
              {routingSource === "idle"
                ? "Routing: idle"
                : routingSource === "stadia"
                ? "Routing: Stadia"
                : routingSource === "local-graph"
                ? "Routing: loaded trails"
                : routingSource === "manual"
                ? "Routing: manual"
                : "Routing: direct"}
            </span>
            {routingSource !== "stadia" && routingSource !== "idle" && snapToPaths ? (
              <span className="text-slate-500">
                In snap mode, loaded trail geometry is preferred. Stadia is only used when no usable loaded trail graph is available.
              </span>
            ) : null}
          </div>
          {routeDiagnostics.length ? (
            <div className="rounded-xl border border-amber-300/15 bg-amber-400/8 px-3 py-2 text-xs text-amber-100">
              {routeDiagnostics[routeDiagnostics.length - 1]}
            </div>
          ) : null}
          <div className="text-xs text-slate-400">
            Click the map to add route points. Click an existing anchor to select it for deletion.{" "}
            {snapToPaths
              ? "Segments will follow mapped paths when the routing service can find one."
              : "Segments will connect as straight lines for freehand planning."}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-[1.1rem] border border-white/10 bg-black/10 p-3 text-sm text-slate-200">
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Distance</div>
            <div className="mt-1 text-lg font-semibold text-white">{formatDistanceKm(stats.distanceKm)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Estimated time</div>
            <div className="mt-1 text-lg font-semibold text-white">{formatHours(stats.estimatedHours)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Anchors</div>
            <div className="mt-1 text-lg font-semibold text-white">{stats.controlPointCount}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Rendered points</div>
            <div className="mt-1 text-lg font-semibold text-white">{stats.renderedPointCount}</div>
          </div>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-[1.1rem] border border-white/10">
        <div
          ref={containerRef}
          className={cn(
            "h-[280px] w-full [cursor:crosshair] [filter:saturate(0.96)_brightness(0.92)_contrast(1.02)]",
            mapClassName
          )}
          aria-label="Trail planner map"
        />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.14),transparent_32%),linear-gradient(180deg,rgba(7,10,18,0.05),rgba(7,10,18,0.24))]" />
        <div className="pointer-events-none absolute left-3 top-3 rounded-full border border-white/10 bg-[rgba(8,11,18,0.76)] px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-amber-100/90">
          {routeLoading ? "Routing..." : snapToPaths ? "Snapping to mapped paths" : "Manual draw mode"}
        </div>
        <div className="pointer-events-none absolute bottom-2 left-3 rounded-full border border-white/10 bg-[rgba(8,11,18,0.76)] px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-200/85">
          {isDraggingPoint
            ? "Dragging anchor"
            : selectedControlPointIndex === null
            ? `${stats.controlPointCount} anchors`
            : `Selected anchor ${selectedControlPointIndex + 1}`}
        </div>
        <div className="pointer-events-none absolute bottom-2 right-3 rounded-full border border-white/10 bg-[rgba(8,11,18,0.76)] px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300/85">
          {mapStyle === "topo" ? "OpenTopoMap" : mapStyle === "satellite" ? "Esri imagery" : "OpenStreetMap"}
        </div>
      </div>
    </div>
  );
}
