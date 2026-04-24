"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type RouteVisit = {
  latitude: number;
  longitude: number;
  label?: string | null;
};

type RoutePoint = {
  timestamp?: string | null;
  latitude: number;
  longitude: number;
};

type TrailExplorerEntry = {
  route_points: RoutePoint[];
  visits: RouteVisit[];
};

type PlannedRouteOverlay = {
  name?: string;
  points: Array<{
    latitude: number;
    longitude: number;
  }>;
};

type NearbyTrailOverlay = {
  id: string;
  name?: string;
  lengthMeters?: number | null;
  points: Array<{
    latitude: number;
    longitude: number;
  }>;
};

type TrailExplorer3DProps = {
  entry: TrailExplorerEntry;
  plannedRoute?: PlannedRouteOverlay | null;
  referenceTrail?: PlannedRouteOverlay | null;
  nearbyTrails?: NearbyTrailOverlay[];
  activeReferenceTrailId?: string | null;
  onReferenceTrailSelect?: ((trailId: string) => void) | null;
  focusSearchResult?: GeocodeResult | null;
  imageryMode?: ImageryMode;
  onImageryModeChange?: ((mode: ImageryMode) => void) | null;
  terrainMode?: TerrainMode;
  onTerrainModeChange?: ((mode: TerrainMode) => void) | null;
  lightingEnabled?: boolean;
  onLightingEnabledChange?: ((enabled: boolean) => void) | null;
  onViewBoundsChange?: ((bounds: {
    min_lat: number;
    min_lon: number;
    max_lat: number;
    max_lon: number;
  } | null) => void) | null;
  onCameraMovingChange?: ((moving: boolean) => void) | null;
  className?: string;
  showOverlayControls?: boolean;
};

type GeocodeResult = {
  place_id: number | string;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: string[];
};

type RuntimeTerrainConfig = {
  cesiumIonToken: string;
  cesiumTerrainUrl: string;
};

type ImageryMode = "satellite" | "topo" | "osm";
type TerrainMode = "local" | "world" | "ellipsoid";

declare global {
  interface Window {
    Cesium?: any;
  }
}

const CESIUM_JS_URL =
  "https://cesium.com/downloads/cesiumjs/releases/1.113/Build/Cesium/Cesium.js";
const CESIUM_CSS_URL =
  "https://cesium.com/downloads/cesiumjs/releases/1.113/Build/Cesium/Widgets/widgets.css";
const MAX_VISIBLE_TRAIL_BADGES = 18;

let cesiumLoadPromise: Promise<any> | null = null;

function cn(...values: Array<string | undefined | false | null>) {
  return values.filter(Boolean).join(" ");
}

function formatTrailLength(lengthMeters: number | null | undefined) {
  if (!lengthMeters || !Number.isFinite(lengthMeters) || lengthMeters <= 0) {
    return null;
  }

  const miles = lengthMeters / 1609.344;
  return `${miles.toFixed(miles >= 10 ? 0 : 1)} mi`;
}

function getTrailEntityId(kind: "line" | "badge", trailId: string) {
  return `jarvis-nearby-trail-${kind}-${trailId}`;
}

function getTrailIdFromPickedObject(picked: any) {
  const pickedId = picked?.id;
  const trailId = pickedId?.properties?.trailId?.getValue?.();
  return typeof trailId === "string" && trailId ? trailId : null;
}

function updateHoveredTrailVisuals(
  viewer: any,
  hoveredTrailId: string | null,
  activeTrailId: string | null | undefined
) {
  const entities = viewer.entities.values || [];
  for (const entity of entities) {
    const trailId = entity?.properties?.trailId?.getValue?.();
    const entityKind = entity?.properties?.entityKind?.getValue?.();
    if (typeof trailId !== "string" || entityKind !== "nearby-trail-line") {
      continue;
    }

    entity.show = trailId === activeTrailId || trailId === hoveredTrailId;
  }
}

function flyToEntities(Cesium: any, viewer: any, coordinateCount: number) {
  viewer.flyTo(viewer.entities, {
    duration: 0.9,
    offset: new Cesium.HeadingPitchRange(
      0,
      Cesium.Math.toRadians(-42),
      Math.max(1800, coordinateCount * 18)
    ),
  });
}

function flyToRectangle3D(
  Cesium: any,
  viewer: any,
  rectangle: { west: number; south: number; east: number; north: number },
  minimumRange = 4200
) {
  const lonSpan = Math.max(rectangle.east - rectangle.west, 0.004);
  const latSpan = Math.max(rectangle.north - rectangle.south, 0.004);
  const lonPadding = Math.max(0.01, lonSpan * 0.75);
  const latPadding = Math.max(0.01, latSpan * 0.75);
  const west = Math.max(-180, rectangle.west - lonPadding);
  const south = Math.max(-90, rectangle.south - latPadding);
  const east = Math.min(180, rectangle.east + lonPadding);
  const north = Math.min(90, rectangle.north + latPadding);
  const positions = [
    Cesium.Cartesian3.fromDegrees(west, south),
    Cesium.Cartesian3.fromDegrees(west, north),
    Cesium.Cartesian3.fromDegrees(east, south),
    Cesium.Cartesian3.fromDegrees(east, north),
    Cesium.Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2),
  ];
  const sphere = Cesium.BoundingSphere.fromPoints(positions);

  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 1.1,
    offset: new Cesium.HeadingPitchRange(
      0,
      Cesium.Math.toRadians(-36),
      Math.max(minimumRange, sphere.radius * 3.6)
    ),
  });
}

function flyToProvoValley(Cesium: any, viewer: any) {
  flyToRectangle3D(Cesium, viewer, {
    west: -111.82,
    south: 40.18,
    east: -111.48,
    north: 40.42,
  }, 9000);
}

function flyToSearchResult(Cesium: any, viewer: any, result: GeocodeResult) {
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
      flyToRectangle3D(Cesium, viewer, { west, south, east, north }, 6000);
      return;
    }
  }

  const latitude = Number(result.lat);
  const longitude = Number(result.lon);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, 16000),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-42),
        roll: 0,
      },
      duration: 1.1,
    });
  }
}

function pickCartographicAtScreenPoint(
  Cesium: any,
  viewer: any,
  x: number,
  y: number
) {
  const windowPosition = new Cesium.Cartesian2(x, y);
  const ray = viewer.camera.getPickRay(windowPosition);
  const pickedCartesian = ray ? viewer.scene.globe.pick(ray, viewer.scene) : null;
  return pickedCartesian ? Cesium.Cartographic.fromCartesian(pickedCartesian) : null;
}

function buildBoundsFromCartographics(
  Cesium: any,
  cartographics: any[]
) {
  if (cartographics.length < 3) {
    return null;
  }

  const latitudes = cartographics.map((point) => Cesium.Math.toDegrees(point.latitude));
  const longitudes = cartographics.map((point) => Cesium.Math.toDegrees(point.longitude));
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const latSpan = maxLat - minLat;
  const lonSpan = maxLon - minLon;

  if (
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLat) ||
    !Number.isFinite(minLon) ||
    !Number.isFinite(maxLon) ||
    latSpan <= 0 ||
    lonSpan <= 0 ||
    latSpan > 4 ||
    lonSpan > 4
  ) {
    return null;
  }

  const latPadding = Math.max(latSpan * 0.06, 0.0025);
  const lonPadding = Math.max(lonSpan * 0.06, 0.0025);
  return {
    min_lat: Math.max(-90, minLat - latPadding),
    min_lon: Math.max(-180, minLon - lonPadding),
    max_lat: Math.min(90, maxLat + latPadding),
    max_lon: Math.min(180, maxLon + lonPadding),
  };
}

function extractViewBounds(Cesium: any, viewer: any) {
  const canvas = viewer.scene.canvas;
  const sampleFractions: Array<[number, number]> = [
    [0.12, 0.2],
    [0.5, 0.18],
    [0.88, 0.2],
    [0.12, 0.45],
    [0.5, 0.42],
    [0.88, 0.45],
    [0.18, 0.72],
    [0.5, 0.74],
    [0.82, 0.72],
    [0.5, 0.9],
  ];
  const sampledCartographics = sampleFractions
    .map(([xFraction, yFraction]) =>
      pickCartographicAtScreenPoint(
        Cesium,
        viewer,
        canvas.clientWidth * xFraction,
        canvas.clientHeight * yFraction
      )
    )
    .filter(Boolean);

  const sampledBounds = buildBoundsFromCartographics(Cesium, sampledCartographics);
  if (sampledBounds) {
    return sampledBounds;
  }

  const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (rectangle) {
    const west = Cesium.Math.toDegrees(rectangle.west);
    const south = Cesium.Math.toDegrees(rectangle.south);
    const east = Cesium.Math.toDegrees(rectangle.east);
    const north = Cesium.Math.toDegrees(rectangle.north);
    const lonSpan = east - west;
    const latSpan = north - south;

    if (
      Number.isFinite(west) &&
      Number.isFinite(south) &&
      Number.isFinite(east) &&
      Number.isFinite(north) &&
      west <= east &&
      lonSpan > 0 &&
      latSpan > 0 &&
      lonSpan < 2 &&
      latSpan < 2
    ) {
      return {
        min_lat: Math.max(-90, south),
        min_lon: Math.max(-180, west),
        max_lat: Math.min(90, north),
        max_lon: Math.min(180, east),
      };
    }
  }

  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const ray = viewer.camera.getPickRay(center);
  const pickedCartesian =
    ray ? viewer.scene.globe.pick(ray, viewer.scene) : null;
  const cartographic = pickedCartesian
    ? Cesium.Cartographic.fromCartesian(pickedCartesian)
    : viewer.camera.positionCartographic;

  if (!cartographic) {
    return null;
  }

  const centerLat = Cesium.Math.toDegrees(cartographic.latitude);
  const centerLon = Cesium.Math.toDegrees(cartographic.longitude);
  const cameraHeight = Math.max(200, Number(viewer.camera.positionCartographic?.height) || 2000);
  const latHalfSpan = Math.min(18, Math.max(0.01, cameraHeight / 80000));
  const lonScale = Math.max(0.2, Math.cos(Cesium.Math.toRadians(centerLat)));
  const lonHalfSpan = Math.min(24, Math.max(0.01, latHalfSpan / lonScale));

  return {
    min_lat: Math.max(-90, centerLat - latHalfSpan),
    min_lon: Math.max(-180, centerLon - lonHalfSpan),
    max_lat: Math.min(90, centerLat + latHalfSpan),
    max_lon: Math.min(180, centerLon + lonHalfSpan),
  };
}

function loadCesium() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Cesium can only be loaded in the browser."));
  }

  if (window.Cesium) {
    return Promise.resolve(window.Cesium);
  }

  if (cesiumLoadPromise) {
    return cesiumLoadPromise;
  }

  cesiumLoadPromise = new Promise((resolve, reject) => {
    const existingStyle = document.querySelector(
      `link[data-jarvis-cesium="true"]`
    ) as HTMLLinkElement | null;
    if (!existingStyle) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = CESIUM_CSS_URL;
      link.dataset.jarvisCesium = "true";
      document.head.appendChild(link);
    }

    const existingScript = document.querySelector(
      `script[data-jarvis-cesium="true"]`
    ) as HTMLScriptElement | null;

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(window.Cesium), {
        once: true,
      });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("Failed to load Cesium.")),
        { once: true }
      );
      return;
    }

    const script = document.createElement("script");
    script.src = CESIUM_JS_URL;
    script.async = true;
    script.dataset.jarvisCesium = "true";
    script.onload = () => resolve(window.Cesium);
    script.onerror = () => reject(new Error("Failed to load Cesium."));
    document.head.appendChild(script);
  });

  return cesiumLoadPromise;
}

function getRouteCoordinates(entry: TrailExplorerEntry) {
  const source = entry.route_points.length ? entry.route_points : entry.visits;
  return source
    .map((point) => [point.longitude, point.latitude] as const)
    .filter(
      (point) => Number.isFinite(point[0]) && Number.isFinite(point[1])
    );
}

function createImageryProvider(Cesium: any, mode: ImageryMode) {
  switch (mode) {
    case "topo":
      return new Cesium.UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
        credit: "Esri, HERE, Garmin, FAO, USGS",
      });
    case "osm":
      return new Cesium.UrlTemplateImageryProvider({
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        subdomains: ["a", "b", "c"],
        credit: "\u00a9 OpenStreetMap contributors",
      });
    case "satellite":
    default:
      return new Cesium.UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        credit: "Esri, Maxar, Earthstar Geographics",
      });
  }
}

async function createTerrainProvider(
  Cesium: any,
  mode: TerrainMode,
  terrainUrl: string,
  ionToken: string
) {
  if (mode === "local" && terrainUrl) {
    return Cesium.CesiumTerrainProvider.fromUrl(terrainUrl, {
      requestVertexNormals: true,
    });
  }

  if (mode === "world" && ionToken) {
    return Cesium.createWorldTerrainAsync({
      requestVertexNormals: true,
      requestWaterMask: true,
    });
  }

  return new Cesium.EllipsoidTerrainProvider();
}

function syncTrailEntities(
  Cesium: any,
  viewer: any,
  entry: TrailExplorerEntry,
  plannedRoute: PlannedRouteOverlay | null | undefined,
  referenceTrail: PlannedRouteOverlay | null | undefined,
  nearbyTrails: NearbyTrailOverlay[],
  activeReferenceTrailId: string | null | undefined,
  onStatus: (value: string) => void,
  options?: {
    zoomToFit?: boolean;
  }
) {
  const coordinates = getRouteCoordinates(entry);
  const visits = entry.visits.filter(
    (visit) =>
      Number.isFinite(visit.longitude) && Number.isFinite(visit.latitude)
  );
  const plannedCoordinates = (plannedRoute?.points || [])
    .map((point) => [point.longitude, point.latitude] as const)
    .filter(
      (point) => Number.isFinite(point[0]) && Number.isFinite(point[1])
    );
  const referenceTrailCoordinates = (referenceTrail?.points || [])
    .map((point) => [point.longitude, point.latitude] as const)
    .filter(
      (point) => Number.isFinite(point[0]) && Number.isFinite(point[1])
    );
  const validNearbyTrails = nearbyTrails
    .map((trail) => ({
      id: trail.id,
      name: trail.name,
      lengthMeters: trail.lengthMeters ?? null,
      coordinates: (trail.points || [])
        .map((point) => [point.longitude, point.latitude] as const)
        .filter(
          (point) => Number.isFinite(point[0]) && Number.isFinite(point[1])
        ),
    }))
    .filter((trail) => trail.coordinates.length);
  const badgeTrailIds = new Set(
    validNearbyTrails
      .filter((trail) => trail.id === activeReferenceTrailId || trail.name)
      .slice(0, MAX_VISIBLE_TRAIL_BADGES)
      .map((trail) => trail.id)
  );
  viewer.entities.removeAll();

  if (
    !coordinates.length &&
    !plannedCoordinates.length &&
    !referenceTrailCoordinates.length &&
    !validNearbyTrails.length
  ) {
    onStatus("waiting for route data");
    return;
  }

  if (coordinates.length) {
    const positions = coordinates.map(([longitude, latitude]) =>
      Cesium.Cartesian3.fromDegrees(longitude, latitude)
    );

    viewer.entities.add({
      id: "jarvis-trail-line",
      polyline: {
        positions,
        width: 5,
        clampToGround: true,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.2,
          color: Cesium.Color.fromCssColorString("#4ade80"),
        }),
      },
    });

    const [startLongitude, startLatitude] = coordinates[0];
    const [endLongitude, endLatitude] = coordinates[coordinates.length - 1];

    viewer.entities.add({
      id: "jarvis-trail-start",
      position: Cesium.Cartesian3.fromDegrees(startLongitude, startLatitude),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString("#4ade80"),
        outlineColor: Cesium.Color.fromCssColorString("#08111b"),
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });

    viewer.entities.add({
      id: "jarvis-trail-end",
      position: Cesium.Cartesian3.fromDegrees(endLongitude, endLatitude),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString("#22d3ee"),
        outlineColor: Cesium.Color.fromCssColorString("#08111b"),
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });
  }

  if (visits.length) {
    for (const [index, visit] of visits.entries()) {
      viewer.entities.add({
        id: `jarvis-visit-${index}`,
        position: Cesium.Cartesian3.fromDegrees(
          visit.longitude,
          visit.latitude
        ),
        point: {
          pixelSize: 8,
          color: Cesium.Color.fromCssColorString("#f8fafc").withAlpha(0.92),
          outlineColor: Cesium.Color.fromCssColorString("#0f172a"),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: visit.label
          ? {
              text: visit.label,
              font: '12px "SF Pro Display", "Segoe UI", sans-serif',
              fillColor: Cesium.Color.fromCssColorString("#e2e8f0"),
              outlineColor: Cesium.Color.fromCssColorString("#020617"),
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString("#0f172a").withAlpha(0.72),
              pixelOffset: new Cesium.Cartesian2(0, -18),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: 1000,
            }
          : undefined,
      });
    }
  }

  if (plannedCoordinates.length) {
    const plannedPositions = plannedCoordinates.map(([longitude, latitude]) =>
      Cesium.Cartesian3.fromDegrees(longitude, latitude)
    );

    viewer.entities.add({
      id: "jarvis-planned-trail-line",
      polyline: {
        positions: plannedPositions,
        width: 4,
        clampToGround: true,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString("#f59e0b"),
          dashLength: 18,
        }),
      },
    });
  }

  if (referenceTrailCoordinates.length) {
    const trailPositions = referenceTrailCoordinates.map(([longitude, latitude]) =>
      Cesium.Cartesian3.fromDegrees(longitude, latitude)
    );

    viewer.entities.add({
      id: "jarvis-reference-trail-line",
      polyline: {
        positions: trailPositions,
        width: 5,
        clampToGround: true,
        material: Cesium.Color.fromCssColorString("#f97316"),
      },
    });
  }

  for (const trail of validNearbyTrails) {
    const trailPositions = trail.coordinates.map(([longitude, latitude]) =>
      Cesium.Cartesian3.fromDegrees(longitude, latitude)
    );
    const isActive = trail.id === activeReferenceTrailId;
    const midpoint = trail.coordinates[Math.floor(trail.coordinates.length / 2)];
    const labelText = [trail.name || "Trail", formatTrailLength(trail.lengthMeters)]
      .filter(Boolean)
      .join(" · ");
    viewer.entities.add({
      id: getTrailEntityId("line", trail.id),
      show: isActive,
      polyline: {
        positions: trailPositions,
        width: isActive ? 6 : 4,
        clampToGround: true,
        material: isActive
          ? Cesium.Color.fromCssColorString("#fb923c")
          : Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.82),
      },
      properties: {
        trailId: trail.id,
        trailName: trail.name || "",
        entityKind: "nearby-trail-line",
      },
    });

    if (midpoint && badgeTrailIds.has(trail.id)) {
      viewer.entities.add({
        id: getTrailEntityId("badge", trail.id),
        position: Cesium.Cartesian3.fromDegrees(midpoint[0], midpoint[1]),
        point: {
          pixelSize: 10,
          color: isActive
            ? Cesium.Color.fromCssColorString("#fb923c")
            : Cesium.Color.fromCssColorString("#f59e0b"),
          outlineColor: Cesium.Color.fromCssColorString("#08111b"),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 15000,
        },
        label: {
          text: labelText,
          font: '12px "SF Pro Display", "Segoe UI", sans-serif',
          fillColor: Cesium.Color.fromCssColorString("#fff7ed"),
          outlineColor: Cesium.Color.fromCssColorString("#111827"),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: isActive
            ? Cesium.Color.fromCssColorString("#7c2d12").withAlpha(0.78)
            : Cesium.Color.fromCssColorString("#78350f").withAlpha(0.72),
          pixelOffset: new Cesium.Cartesian2(0, -18),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 15000,
          scaleByDistance: new Cesium.NearFarScalar(1000, 1, 18000, 0.6),
          translucencyByDistance: new Cesium.NearFarScalar(1000, 1, 24000, 0.15),
        },
        properties: {
          trailId: trail.id,
          trailName: trail.name || "",
          entityKind: "nearby-trail-badge",
          trailLength: trail.lengthMeters ?? null,
        },
      });
    }
  }

  updateHoveredTrailVisuals(viewer, null, activeReferenceTrailId);

  if (options?.zoomToFit) {
    flyToEntities(Cesium, viewer, coordinates.length);
  }
  onStatus(
    validNearbyTrails.length
      ? `actual ${coordinates.length || 0} pts, imported ${plannedCoordinates.length || 0} pts, nearby trails ${validNearbyTrails.length}`
      : referenceTrailCoordinates.length
      ? `actual ${coordinates.length || 0} pts, imported ${plannedCoordinates.length || 0} pts, trail ${referenceTrailCoordinates.length} pts`
      : plannedCoordinates.length
      ? `actual ${coordinates.length || 0} pts, planned ${plannedCoordinates.length} pts`
      : `rendering ${coordinates.length} route points`
  );
}

export function TrailExplorer3D({
  entry,
  plannedRoute,
  referenceTrail,
  nearbyTrails = [],
  activeReferenceTrailId = null,
  onReferenceTrailSelect = null,
  focusSearchResult,
  imageryMode: controlledImageryMode,
  onImageryModeChange,
  terrainMode: controlledTerrainMode,
  onTerrainModeChange,
  lightingEnabled = true,
  onLightingEnabledChange,
  onViewBoundsChange,
  onCameraMovingChange,
  className,
  showOverlayControls = true,
}: TrailExplorer3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any | null>(null);
  const cesiumRef = useRef<any | null>(null);
  const onViewBoundsChangeRef = useRef(onViewBoundsChange);
  const onCameraMovingChangeRef = useRef(onCameraMovingChange);
  const latestEntryRef = useRef(entry);
  const latestPlannedRouteRef = useRef(plannedRoute);
  const latestReferenceTrailRef = useRef(referenceTrail);
  const latestNearbyTrailsRef = useRef(nearbyTrails);
  const latestActiveReferenceTrailIdRef = useRef(activeReferenceTrailId);
  const onReferenceTrailSelectRef = useRef(onReferenceTrailSelect);
  const hoveredTrailIdRef = useRef<string | null>(null);
  const lastRenderedRouteKeyRef = useRef<string | null>(null);
  const lastFocusedSearchResultKeyRef = useRef<string | null>(null);
  const lastEmittedBoundsKeyRef = useRef<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [status, setStatus] = useState("loading Cesium");
  const [uncontrolledImageryMode, setUncontrolledImageryMode] = useState<ImageryMode>("satellite");
  const [uncontrolledTerrainMode, setUncontrolledTerrainMode] = useState<TerrainMode>("ellipsoid");
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeTerrainConfig>({
    cesiumIonToken: "",
    cesiumTerrainUrl: "",
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);

  const entryKey = useMemo(
    () =>
      JSON.stringify({
        route_points: entry.route_points.map((point) => [
          point.longitude,
          point.latitude,
          point.timestamp || "",
        ]),
        visits: entry.visits.map((visit) => [
          visit.longitude,
          visit.latitude,
          visit.label || "",
        ]),
      }),
    [entry]
  );
  const plannedRouteKey = useMemo(
    () =>
      JSON.stringify(
        (plannedRoute?.points || []).map((point) => [
          point.longitude,
          point.latitude,
        ])
      ),
    [plannedRoute]
  );
  const referenceTrailKey = useMemo(
    () =>
      JSON.stringify(
        (referenceTrail?.points || []).map((point) => [
          point.longitude,
          point.latitude,
        ])
      ),
    [referenceTrail]
  );
  const nearbyTrailsKey = useMemo(
    () =>
      JSON.stringify(
        nearbyTrails.map((trail) => ({
          id: trail.id,
          points: trail.points.map((point) => [point.longitude, point.latitude]),
        }))
      ),
    [nearbyTrails]
  );
  const terrainUrl = runtimeConfig.cesiumTerrainUrl.trim();
  const ionToken = runtimeConfig.cesiumIonToken.trim();
  const imageryMode = controlledImageryMode ?? uncontrolledImageryMode;
  const terrainMode = controlledTerrainMode ?? uncontrolledTerrainMode;
  const routeSceneKey = `${entryKey}::${plannedRouteKey}::${referenceTrailKey}::${nearbyTrailsKey}::${activeReferenceTrailId ?? "none"}`;
  const zoomSceneKey = `${entryKey}::${plannedRouteKey}`;

  useEffect(() => {
    onViewBoundsChangeRef.current = onViewBoundsChange;
  }, [onViewBoundsChange]);

  useEffect(() => {
    onCameraMovingChangeRef.current = onCameraMovingChange;
  }, [onCameraMovingChange]);

  const emitViewBounds = () => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) {
      return;
    }

    const bounds = extractViewBounds(Cesium, viewer);
    const nextKey = bounds
      ? `${bounds.min_lat.toFixed(5)}:${bounds.min_lon.toFixed(5)}:${bounds.max_lat.toFixed(5)}:${bounds.max_lon.toFixed(5)}`
      : "null";

    if (lastEmittedBoundsKeyRef.current === nextKey) {
      return;
    }

    lastEmittedBoundsKeyRef.current = nextKey;
    onViewBoundsChangeRef.current?.(bounds);
  };

  useEffect(() => {
    latestEntryRef.current = entry;
  }, [entry, entryKey]);

  useEffect(() => {
    latestPlannedRouteRef.current = plannedRoute;
  }, [plannedRoute, plannedRouteKey]);

  useEffect(() => {
    latestReferenceTrailRef.current = referenceTrail;
  }, [referenceTrail, referenceTrailKey]);

  useEffect(() => {
    latestNearbyTrailsRef.current = nearbyTrails;
  }, [nearbyTrails, nearbyTrailsKey]);

  useEffect(() => {
    latestActiveReferenceTrailIdRef.current = activeReferenceTrailId;
  }, [activeReferenceTrailId]);

  useEffect(() => {
    onReferenceTrailSelectRef.current = onReferenceTrailSelect;
  }, [onReferenceTrailSelect]);

  useEffect(() => {
    let cancelled = false;

    async function loadRuntimeConfig() {
      try {
        const response = await fetch("/jarvis-runtime-config", {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as RuntimeTerrainConfig;
        if (!cancelled) {
          setRuntimeConfig(data);
        }
      } catch {
        if (!cancelled) {
          setStatus("runtime terrain config unavailable");
        }
      }
    }

    void loadRuntimeConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (terrainUrl) {
      if (onTerrainModeChange) {
        onTerrainModeChange("local");
      } else {
        setUncontrolledTerrainMode("local");
      }
    } else if (ionToken) {
      if (onTerrainModeChange) {
        onTerrainModeChange("world");
      } else {
        setUncontrolledTerrainMode("world");
      }
    }
  }, [terrainUrl, ionToken, onTerrainModeChange]);

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      if (!containerRef.current || viewerRef.current) {
        return;
      }

      try {
        const Cesium = await loadCesium();
        if (cancelled || !containerRef.current) {
          return;
        }

        cesiumRef.current = Cesium;

        if (ionToken) {
          Cesium.Ion.defaultAccessToken = ionToken;
        }

        const viewer = new Cesium.Viewer(containerRef.current, {
          terrainProvider: new Cesium.EllipsoidTerrainProvider(),
          baseLayer: false,
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          infoBox: false,
          scene3DOnly: true,
          selectionIndicator: false,
        });

        viewer.imageryLayers.removeAll();
        viewer.imageryLayers.addImageryProvider(
          createImageryProvider(Cesium, imageryMode)
        );
        viewer.scene.globe.enableLighting = lightingEnabled;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        viewer.scene.globe.maximumScreenSpaceError = 2;
        viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(
          "2024-07-04T20:00:00Z"
        );
        viewer.scene.requestRender?.();

        viewerRef.current = viewer;
        const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandler.setInputAction((movement: any) => {
          const trailId = getTrailIdFromPickedObject(viewer.scene.pick(movement.position));
          if (trailId) {
            onReferenceTrailSelectRef.current?.(trailId);
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
        clickHandler.setInputAction((movement: any) => {
          const nextHoveredTrailId = getTrailIdFromPickedObject(viewer.scene.pick(movement.endPosition));
          if (hoveredTrailIdRef.current === nextHoveredTrailId) {
            return;
          }

          hoveredTrailIdRef.current = nextHoveredTrailId;
          updateHoveredTrailVisuals(
            viewer,
            nextHoveredTrailId,
            latestActiveReferenceTrailIdRef.current
          );
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
        (viewer as any).__jarvisTrailClickHandler = clickHandler;
        const handleMoveStart = () => {
          onCameraMovingChangeRef.current?.(true);
        };
        const handleMoveEnd = () => {
          onCameraMovingChangeRef.current?.(false);
          emitViewBounds();
        };
        (viewer as any).__jarvisMoveStartHandler = handleMoveStart;
        (viewer as any).__jarvisMoveEndHandler = handleMoveEnd;
        viewer.camera.moveStart.addEventListener(handleMoveStart);
        viewer.camera.moveEnd.addEventListener(handleMoveEnd);
        flyToProvoValley(Cesium, viewer);
        window.setTimeout(emitViewBounds, 1200);
        setIsReady(true);
        setStatus("viewer ready");
      } catch (error) {
        if (!cancelled) {
          setStatus(
            error instanceof Error ? error.message : "Failed to load 3D explorer"
          );
        }
      }
    }

    void mount();

    return () => {
      cancelled = true;
      if (viewerRef.current && !viewerRef.current.isDestroyed?.()) {
        const clickHandler = (viewerRef.current as any).__jarvisTrailClickHandler;
        clickHandler?.destroy?.();
        const handleMoveStart = (viewerRef.current as any).__jarvisMoveStartHandler;
        const handleMoveEnd = (viewerRef.current as any).__jarvisMoveEndHandler;
        if (handleMoveStart) {
          viewerRef.current.camera.moveStart.removeEventListener(handleMoveStart);
        }
        if (handleMoveEnd) {
          viewerRef.current.camera.moveEnd.removeEventListener(handleMoveEnd);
        }
        viewerRef.current.destroy();
      }
      viewerRef.current = null;
      cesiumRef.current = null;
      lastEmittedBoundsKeyRef.current = "null";
      onViewBoundsChangeRef.current?.(null);
      onCameraMovingChangeRef.current?.(false);
      setIsReady(false);
    };
  }, [ionToken, imageryMode]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }

    viewer.scene.globe.enableLighting = lightingEnabled;
    viewer.scene.requestRender?.();
  }, [lightingEnabled, isReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) {
      return;
    }

    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(
      createImageryProvider(Cesium, imageryMode)
    );
    viewer.scene.requestRender?.();
  }, [imageryMode, isReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) {
      return;
    }

    let cancelled = false;

    async function applyTerrain() {
      try {
        if (terrainMode === "local" && !terrainUrl) {
          viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
          setStatus("local terrain not configured");
          return;
        }

        if (terrainMode === "world" && !ionToken) {
          viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
          setStatus("Cesium Ion token not configured");
          return;
        }

        setStatus(
          terrainMode === "ellipsoid"
            ? "flat globe"
            : terrainMode === "local"
            ? "loading self-hosted terrain"
            : "loading Cesium World Terrain"
        );
        viewer.terrainProvider = await createTerrainProvider(
          Cesium,
          terrainMode,
          terrainUrl,
          ionToken
        );
        if (!cancelled) {
          syncTrailEntities(
            Cesium,
            viewer,
            latestEntryRef.current,
            latestPlannedRouteRef.current,
            latestReferenceTrailRef.current,
            latestNearbyTrailsRef.current,
            latestActiveReferenceTrailIdRef.current,
            setStatus,
            { zoomToFit: false }
          );
        }
      } catch {
        if (!cancelled) {
          viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
          setStatus("terrain unavailable, using flat globe");
          syncTrailEntities(
            Cesium,
            viewer,
            latestEntryRef.current,
            latestPlannedRouteRef.current,
            latestReferenceTrailRef.current,
            latestNearbyTrailsRef.current,
            latestActiveReferenceTrailIdRef.current,
            setStatus,
            { zoomToFit: false }
          );
        }
      }
    }

    void applyTerrain();

    return () => {
      cancelled = true;
    };
  }, [terrainMode, terrainUrl, ionToken, isReady, plannedRouteKey, referenceTrailKey]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) {
      return;
    }

    const isInitialSceneRender = lastRenderedRouteKeyRef.current === null;
    const shouldZoomToFit =
      !isInitialSceneRender && lastRenderedRouteKeyRef.current !== zoomSceneKey;
    syncTrailEntities(
      Cesium,
      viewer,
      latestEntryRef.current,
      latestPlannedRouteRef.current,
      latestReferenceTrailRef.current,
      latestNearbyTrailsRef.current,
      latestActiveReferenceTrailIdRef.current,
      setStatus,
      {
      zoomToFit: shouldZoomToFit,
      }
    );
    updateHoveredTrailVisuals(
      viewer,
      hoveredTrailIdRef.current,
      latestActiveReferenceTrailIdRef.current
    );
    window.setTimeout(emitViewBounds, shouldZoomToFit ? 950 : 0);
    lastRenderedRouteKeyRef.current = zoomSceneKey;
  }, [entryKey, plannedRouteKey, referenceTrailKey, routeSceneKey, zoomSceneKey, isReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || !isReady || !focusSearchResult) {
      return;
    }

    const nextKey = `${String(focusSearchResult.place_id)}:${focusSearchResult.lat}:${focusSearchResult.lon}:${focusSearchResult.display_name}`;
    if (lastFocusedSearchResultKeyRef.current === nextKey) {
      return;
    }

    flyToSearchResult(Cesium, viewer, focusSearchResult);
    window.setTimeout(emitViewBounds, 950);
    lastFocusedSearchResultKeyRef.current = nextKey;
  }, [focusSearchResult, isReady]);

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
        throw new Error(`Location search failed with status ${response.status}`);
      }

      const data = (await response.json()) as { items?: GeocodeResult[] };
      const results = data.items || [];
      setSearchResults(results);
      if (!results.length) {
        setSearchError("No places matched that search.");
        return;
      }

      const viewer = viewerRef.current;
      const Cesium = cesiumRef.current;
      if (viewer && Cesium) {
        flyToSearchResult(Cesium, viewer, results[0]);
      }
    } catch (error) {
      setSearchResults([]);
      setSearchError(
        error instanceof Error ? error.message : "Unable to search for that place."
      );
    } finally {
      setSearchLoading(false);
    }
  };

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-[1.2rem] border border-white/8 bg-[linear-gradient(180deg,rgba(9,12,22,0.96),rgba(15,18,28,0.96))]",
        className || "h-[420px]"
      )}
    >
      {showOverlayControls ? (
        <>
          <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                const viewer = viewerRef.current;
                const Cesium = cesiumRef.current;
                if (viewer && Cesium) {
                  flyToProvoValley(Cesium, viewer);
                }
              }}
              className="rounded-full border border-white/10 bg-[rgba(8,11,18,0.78)] px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-slate-100"
            >
              Provo Valley
            </button>
            <button
              type="button"
              onClick={() => {
                const viewer = viewerRef.current;
                const Cesium = cesiumRef.current;
                if (viewer && Cesium) {
                  flyToEntities(Cesium, viewer, getRouteCoordinates(entry).length);
                }
              }}
              className="rounded-full border border-white/10 bg-[rgba(8,11,18,0.78)] px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-slate-100"
            >
              Fit Route
            </button>
            <label className="rounded-full border border-white/10 bg-[rgba(8,11,18,0.78)] px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-slate-200">
              <span className="mr-2 text-slate-400">Imagery</span>
              <select
                value={imageryMode}
                onChange={(event) =>
                  (onImageryModeChange
                    ? onImageryModeChange(event.target.value as ImageryMode)
                    : setUncontrolledImageryMode(event.target.value as ImageryMode))
                }
                className="bg-transparent text-slate-100 outline-none"
              >
                <option value="satellite">Satellite</option>
                <option value="topo">Topo</option>
                <option value="osm">OSM</option>
              </select>
            </label>
            <label className="rounded-full border border-white/10 bg-[rgba(8,11,18,0.78)] px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-slate-200">
              <span className="mr-2 text-slate-400">Terrain</span>
              <select
                value={terrainMode}
                onChange={(event) =>
                  (onTerrainModeChange
                    ? onTerrainModeChange(event.target.value as TerrainMode)
                    : setUncontrolledTerrainMode(event.target.value as TerrainMode))
                }
                className="bg-transparent text-slate-100 outline-none"
              >
                <option value="local">Self-hosted</option>
                <option value="world">World</option>
                <option value="ellipsoid">Flat</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                onLightingEnabledChange?.(!lightingEnabled);
              }}
              className="rounded-full border border-white/10 bg-[rgba(8,11,18,0.78)] px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-slate-100"
            >
              {lightingEnabled ? "Lighting On" : "Lighting Off"}
            </button>
          </div>
          <div className="absolute right-3 top-3 z-10 w-[min(28rem,calc(100%-1.5rem))] rounded-[1rem] border border-white/10 bg-[rgba(8,11,18,0.82)] p-3 backdrop-blur">
            <div className="flex gap-2">
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void runLocationSearch();
                  }
                }}
                placeholder="Search Provo Canyon, Sundance, trailheads..."
                className="h-9 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
              />
              <button
                type="button"
                onClick={() => void runLocationSearch()}
                className="rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-slate-100 transition hover:border-white/20"
              >
                {searchLoading ? "Searching..." : "Search"}
              </button>
            </div>
            {searchError ? (
              <div className="mt-2 text-xs text-rose-200">{searchError}</div>
            ) : null}
            {searchResults.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {searchResults.slice(0, 3).map((result) => (
                  <button
                    key={String(result.place_id)}
                    type="button"
                    onClick={() => {
                      const viewer = viewerRef.current;
                      const Cesium = cesiumRef.current;
                      if (viewer && Cesium) {
                        flyToSearchResult(Cesium, viewer, result);
                      }
                    }}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-left text-xs text-slate-200 transition hover:border-white/20"
                  >
                    {result.display_name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <div
        ref={containerRef}
        className="absolute inset-0"
        aria-label="3D terrain route explorer"
        role="img"
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.12),transparent_30%),linear-gradient(180deg,rgba(7,10,18,0.08),rgba(7,10,18,0.26))]" />
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-full border border-white/10 bg-[rgba(8,11,18,0.78)] px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300/85">
        {status}
      </div>
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-full border border-emerald-300/18 bg-emerald-400/10 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-emerald-100/90">
        Trail Explorer 3D
      </div>
    </div>
  );
}
