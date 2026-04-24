import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const STADIA_ROUTE_URL = "https://api.stadiamaps.com/route/v1";

type RoutePoint = {
  latitude: number;
  longitude: number;
};

function decodePolyline(value: string, precision = 6) {
  const coordinates: RoutePoint[] = [];
  const factor = 10 ** precision;
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < value.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = value.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= value.length);

    latitude += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = value.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= value.length);

    longitude += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push({
      latitude: latitude / factor,
      longitude: longitude / factor,
    });
  }

  return coordinates.filter(isValidRoutePoint);
}

function readEnvValueFromFile(
  filePath: string,
  key: string
): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const currentKey = trimmed.slice(0, separatorIndex).trim();
    if (currentKey !== key) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    return value;
  }

  return undefined;
}

function readRootEnvValue(key: string): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env.local"),
    path.resolve(process.cwd(), "..", ".env"),
  ];

  for (const candidate of candidates) {
    const value = readEnvValueFromFile(candidate, key);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function isValidRoutePoint(value: unknown): value is RoutePoint {
  if (!value || typeof value !== "object") {
    return false;
  }

  const point = value as Partial<RoutePoint>;
  return (
    typeof point.latitude === "number" &&
    Number.isFinite(point.latitude) &&
    Math.abs(point.latitude) <= 90 &&
    typeof point.longitude === "number" &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.longitude) <= 180
  );
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { detail: "Invalid route request payload." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const start = (body as { start?: unknown })?.start;
  const end = (body as { end?: unknown })?.end;

  if (!isValidRoutePoint(start) || !isValidRoutePoint(end)) {
    return NextResponse.json(
      { detail: "A valid start and end point are required." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const apiKey =
    process.env.STADIA_MAPS_API_KEY ||
    readRootEnvValue("STADIA_MAPS_API_KEY") ||
    "";
  if (!apiKey) {
    return NextResponse.json(
      { detail: "Stadia Maps API key is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  const stadiaRequest = {
    locations: [
      { lat: start.latitude, lon: start.longitude, type: "break" },
      { lat: end.latitude, lon: end.longitude, type: "break" },
    ],
    costing: "pedestrian",
    costing_options: {
      pedestrian: {
        walkway_factor: 0.1,
        sidewalk_factor: 1.8,
        alley_factor: 6,
        driveway_factor: 8,
        use_tracks: 1,
        use_hills: 0.35,
        use_living_streets: 0.1,
        use_lit: 0.2,
      },
    },
    format: "osrm",
    directions_options: {
      units: "kilometers",
    },
  };

  const response = await fetch(
    apiKey ? `${STADIA_ROUTE_URL}?api_key=${encodeURIComponent(apiKey)}` : STADIA_ROUTE_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(stadiaRequest),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return NextResponse.json(
      {
        detail: detail || `Hosted routing failed with status ${response.status}.`,
      },
      { status: response.status, headers: { "Cache-Control": "no-store" } }
    );
  }

  const data = (await response.json()) as {
    routes?: Array<{
      geometry?:
        | {
            coordinates?: Array<[number, number]>;
          }
        | string;
      distance?: number;
      duration?: number;
    }>;
    waypoints?: Array<{
      location?: [number, number];
      distance?: number;
      name?: string;
    }>;
  };

  const route = data.routes?.[0];
  const points =
    typeof route?.geometry === "string"
      ? decodePolyline(route.geometry, 6)
      : (route?.geometry?.coordinates || [])
          .map(([longitude, latitude]) => ({ latitude, longitude }))
          .filter(isValidRoutePoint);

  if (points.length < 2) {
    return NextResponse.json(
      { detail: "Stadia route response did not contain a usable path geometry." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    {
      points,
      distanceMeters: typeof route?.distance === "number" ? route.distance : null,
      durationSeconds: typeof route?.duration === "number" ? route.duration : null,
      provider: "stadia",
      waypoints: Array.isArray(data.waypoints) ? data.waypoints : [],
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
