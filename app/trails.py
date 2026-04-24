import json
import math
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from app.schemas import TrailPoint, TrailSearchItem, TrailSearchResponse

USGS_TRAILS_QUERY_URL = os.getenv(
    "USGS_TRAILS_QUERY_URL",
    "https://cartowfs.nationalmap.gov/arcgis/rest/services/transportation/MapServer/8/query",
)
NPS_TRAILS_QUERY_URL = os.getenv(
    "NPS_TRAILS_QUERY_URL",
    "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails_Geographic/MapServer/0/query",
)
OVERPASS_API_URL = os.getenv(
    "OVERPASS_API_URL", "https://overpass-api.de/api/interpreter"
)
OVERPASS_API_URLS = [
    candidate.strip()
    for candidate in os.getenv("OVERPASS_API_URLS", OVERPASS_API_URL).split(",")
    if candidate.strip()
]
USGS_TIMEOUT_SECONDS = int(os.getenv("USGS_TIMEOUT_SECONDS", "20"))
NPS_TIMEOUT_SECONDS = int(os.getenv("NPS_TIMEOUT_SECONDS", "20"))
OVERPASS_TIMEOUT_SECONDS = int(os.getenv("OVERPASS_TIMEOUT_SECONDS", "25"))
MAX_TRAIL_SEARCH_SPAN_DEGREES = float(
    os.getenv("MAX_TRAIL_SEARCH_SPAN_DEGREES", "0.35")
)
MIN_TRAIL_SEGMENT_LENGTH_M = float(os.getenv("MIN_TRAIL_SEGMENT_LENGTH_M", "250"))
MAX_TRAIL_SEGMENT_LENGTH_M = float(os.getenv("MAX_TRAIL_SEGMENT_LENGTH_M", "32000"))
TRAIL_STITCH_TOLERANCE_M = float(os.getenv("TRAIL_STITCH_TOLERANCE_M", "20"))
DEBUG_OSM_RELATION_ID = int(os.getenv("DEBUG_OSM_RELATION_ID", "13764771"))
DEBUG_OSM_RELATION_MEMBER_WAY_IDS = {
    1114698619,
    117952269,
    113629481,
    1095105782,
}


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _validate_bounds(
    min_lat: float, min_lon: float, max_lat: float, max_lon: float
) -> tuple[float, float, float, float]:
    if min_lat > max_lat:
        min_lat, max_lat = max_lat, min_lat
    if min_lon > max_lon:
        min_lon, max_lon = max_lon, min_lon

    min_lat = _clamp(min_lat, -90.0, 90.0)
    max_lat = _clamp(max_lat, -90.0, 90.0)
    min_lon = _clamp(min_lon, -180.0, 180.0)
    max_lon = _clamp(max_lon, -180.0, 180.0)

    if (max_lat - min_lat) > MAX_TRAIL_SEARCH_SPAN_DEGREES:
        raise ValueError(
            f"Trail search latitude span is too large. Keep it under {MAX_TRAIL_SEARCH_SPAN_DEGREES:.2f} degrees."
        )
    if (max_lon - min_lon) > MAX_TRAIL_SEARCH_SPAN_DEGREES:
        raise ValueError(
            f"Trail search longitude span is too large. Keep it under {MAX_TRAIL_SEARCH_SPAN_DEGREES:.2f} degrees."
        )

    return min_lat, min_lon, max_lat, max_lon


def _expanded_bounds(
    min_lat: float, min_lon: float, max_lat: float, max_lon: float
) -> tuple[float, float, float, float]:
    lat_padding = max(0.0025, (max_lat - min_lat) * 0.18)
    lon_padding = max(0.0025, (max_lon - min_lon) * 0.18)
    return (
        max(-90.0, min_lat - lat_padding),
        max(-180.0, min_lon - lon_padding),
        min(90.0, max_lat + lat_padding),
        min(180.0, max_lon + lon_padding),
    )


def _meters_between(
    left_lat: float, left_lon: float, right_lat: float, right_lon: float
) -> float:
    earth_radius_m = 6371000.0
    left_lat_rad = math.radians(left_lat)
    right_lat_rad = math.radians(right_lat)
    lat_delta = math.radians(right_lat - left_lat)
    lon_delta = math.radians(right_lon - left_lon)

    a = (
        math.sin(lat_delta / 2) ** 2
        + math.cos(left_lat_rad)
        * math.cos(right_lat_rad)
        * math.sin(lon_delta / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return earth_radius_m * c


def _polyline_length_m(points: list[dict[str, float]]) -> float | None:
    if len(points) < 2:
        return None

    total = 0.0
    for index in range(1, len(points)):
        previous = points[index - 1]
        current = points[index]
        total += _meters_between(
            previous["lat"],
            previous["lon"],
            current["lat"],
            current["lon"],
        )
    return round(total, 1)


def _distance_to_center_m(
    center_lat: float, center_lon: float, points: list[dict[str, float]]
) -> float | None:
    if not points:
        return None

    closest = min(
        _meters_between(center_lat, center_lon, point["lat"], point["lon"])
        for point in points
    )
    return round(closest, 1)


def _normalize_points(points: list[dict[str, float]]) -> list[dict[str, float]]:
    normalized: list[dict[str, float]] = []
    last: tuple[float, float] | None = None

    for point in points:
        latitude = point.get("lat")
        longitude = point.get("lon")
        if latitude is None or longitude is None:
            latitude = point.get("latitude")
            longitude = point.get("longitude")
        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            continue
        if math.isnan(latitude) or math.isnan(longitude):
            continue

        candidate = (float(latitude), float(longitude))
        if last == candidate:
            continue
        normalized.append({"lat": candidate[0], "lon": candidate[1]})
        last = candidate

    return normalized


def _trail_item_points_as_dicts(item: TrailSearchItem) -> list[dict[str, float]]:
    normalized: list[dict[str, float]] = []
    for point in item.points:
        if isinstance(point, dict):
            latitude = point.get("latitude")
            longitude = point.get("longitude")
            if latitude is None or longitude is None:
                latitude = point.get("lat")
                longitude = point.get("lon")
        else:
            latitude = getattr(point, "latitude", None)
            longitude = getattr(point, "longitude", None)

        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            continue

        normalized.append({"lat": float(latitude), "lon": float(longitude)})

    return _normalize_points(normalized)


def _trail_points_models(points: list[dict[str, float]]) -> list[TrailPoint]:
    return [
        TrailPoint(latitude=point["lat"], longitude=point["lon"])
        for point in points
    ]


def _normalized_text(value: str | None) -> str:
    return " ".join((value or "").strip().lower().split())


def _preferred_trail_name(item: TrailSearchItem) -> str:
    if not item.name.lower().startswith("unnamed "):
        return item.name
    return item.ref or item.name


def _item_matches_for_stitch(left: TrailSearchItem, right: TrailSearchItem) -> bool:
    if left.source != right.source:
        return False

    left_name = _normalized_text(left.name)
    right_name = _normalized_text(right.name)
    left_ref = _normalized_text(left.ref)
    right_ref = _normalized_text(right.ref)

    same_name = (
        left_name
        and right_name
        and not left_name.startswith("unnamed ")
        and not right_name.startswith("unnamed ")
        and left_name == right_name
    )
    same_ref = left_ref and right_ref and left_ref == right_ref
    if not (same_name or same_ref):
        return False

    left_points = _trail_item_points_as_dicts(left)
    right_points = _trail_item_points_as_dicts(right)
    if len(left_points) < 2 or len(right_points) < 2:
        return False

    endpoint_pairs = (
        (left_points[0], right_points[0]),
        (left_points[0], right_points[-1]),
        (left_points[-1], right_points[0]),
        (left_points[-1], right_points[-1]),
    )

    return any(
        _meters_between(
            left_point["lat"],
            left_point["lon"],
            right_point["lat"],
            right_point["lon"],
        )
        <= max(TRAIL_STITCH_TOLERANCE_M * 2, 40)
        for left_point, right_point in endpoint_pairs
    )


def _merge_point_sequences(
    left_points: list[dict[str, float]],
    right_points: list[dict[str, float]],
    tolerance_m: float,
) -> list[dict[str, float]] | None:
    if len(left_points) < 2 or len(right_points) < 2:
        return None

    left_start = left_points[0]
    left_end = left_points[-1]
    right_start = right_points[0]
    right_end = right_points[-1]

    if _meters_between(left_end["lat"], left_end["lon"], right_start["lat"], right_start["lon"]) <= tolerance_m:
        return _normalize_points([*left_points, *right_points[1:]])
    if _meters_between(left_end["lat"], left_end["lon"], right_end["lat"], right_end["lon"]) <= tolerance_m:
        return _normalize_points([*left_points, *list(reversed(right_points))[1:]])
    if _meters_between(left_start["lat"], left_start["lon"], right_end["lat"], right_end["lon"]) <= tolerance_m:
        return _normalize_points([*right_points, *left_points[1:]])
    if _meters_between(left_start["lat"], left_start["lon"], right_start["lat"], right_start["lon"]) <= tolerance_m:
        return _normalize_points([*list(reversed(right_points)), *left_points[1:]])

    return None


def _merge_trail_items(
    primary: TrailSearchItem,
    secondary: TrailSearchItem,
    merged_points: list[dict[str, float]],
) -> TrailSearchItem:
    chosen_name = _preferred_trail_name(primary)
    secondary_name = _preferred_trail_name(secondary)
    if chosen_name.lower().startswith("unnamed ") and not secondary_name.lower().startswith("unnamed "):
        chosen_name = secondary_name

    return primary.model_copy(
        update={
            "name": chosen_name,
            "ref": primary.ref or secondary.ref,
            "operator": primary.operator or secondary.operator,
            "network": primary.network or secondary.network,
            "trail_type": primary.trail_type if primary.trail_type != "hiking" else secondary.trail_type or primary.trail_type,
            "points": _trail_points_models(merged_points),
        }
    )


def _ordered_point_sequences_for_join(
    left_points: list[dict[str, float]],
    right_points: list[dict[str, float]],
) -> tuple[list[dict[str, float]], list[dict[str, float]]]:
    candidates = [
        (
            _meters_between(
                left_points[-1]["lat"],
                left_points[-1]["lon"],
                right_points[0]["lat"],
                right_points[0]["lon"],
            ),
            left_points,
            right_points,
        ),
        (
            _meters_between(
                left_points[-1]["lat"],
                left_points[-1]["lon"],
                right_points[-1]["lat"],
                right_points[-1]["lon"],
            ),
            left_points,
            list(reversed(right_points)),
        ),
        (
            _meters_between(
                left_points[0]["lat"],
                left_points[0]["lon"],
                right_points[-1]["lat"],
                right_points[-1]["lon"],
            ),
            right_points,
            left_points,
        ),
        (
            _meters_between(
                left_points[0]["lat"],
                left_points[0]["lon"],
                right_points[0]["lat"],
                right_points[0]["lon"],
            ),
            list(reversed(right_points)),
            left_points,
        ),
    ]
    _, ordered_left, ordered_right = min(candidates, key=lambda candidate: candidate[0])
    return ordered_left, ordered_right


def _compress_cluster_items(cluster: list[TrailSearchItem]) -> TrailSearchItem:
    if len(cluster) == 1:
        return cluster[0]

    working = sorted(
        cluster,
        key=lambda item: len(item.points),
        reverse=True,
    )
    compressed = working.pop(0)

    while working:
        next_index = 0
        next_points: list[dict[str, float]] | None = None
        next_distance = float("inf")
        current_points = _trail_item_points_as_dicts(compressed)
        if not current_points:
            fallback = next(
                (
                    item
                    for item in working
                    if _trail_item_points_as_dicts(item)
                ),
                None,
            )
            if fallback is not None:
                compressed = fallback
                working = [item for item in working if item is not fallback]
                continue
            return compressed

        for index, candidate in enumerate(working):
            candidate_points = _trail_item_points_as_dicts(candidate)
            if not candidate_points:
                continue
            ordered_left, ordered_right = _ordered_point_sequences_for_join(
                current_points,
                candidate_points,
            )
            join_distance = _meters_between(
                ordered_left[-1]["lat"],
                ordered_left[-1]["lon"],
                ordered_right[0]["lat"],
                ordered_right[0]["lon"],
            )
            if join_distance < next_distance:
                next_distance = join_distance
                next_index = index
                next_points = _normalize_points([*ordered_left, *ordered_right[1:]])

        if next_points is None:
            break

        candidate = working.pop(next_index)
        compressed = _merge_trail_items(
            compressed,
            candidate,
            next_points or current_points,
        )

    return compressed


def _stitch_trail_items(items: list[TrailSearchItem]) -> list[TrailSearchItem]:
    if len(items) < 2:
        return items

    clusters: list[list[TrailSearchItem]] = []
    remaining = items[:]
    while remaining:
        current = remaining.pop(0)
        cluster = [current]
        changed = True
        while changed:
            changed = False
            next_remaining: list[TrailSearchItem] = []
            for candidate in remaining:
                if any(_item_matches_for_stitch(member, candidate) for member in cluster):
                    cluster.append(candidate)
                    changed = True
                else:
                    next_remaining.append(candidate)
            remaining = next_remaining
        clusters.append(cluster)

    stitched: list[TrailSearchItem] = []
    for cluster in clusters:
        working = cluster[:]
        merged_any = True
        while merged_any and len(working) > 1:
            merged_any = False
            for left_index in range(len(working)):
                if merged_any:
                    break
                for right_index in range(left_index + 1, len(working)):
                    left = working[left_index]
                    right = working[right_index]
                    merged_points = _merge_point_sequences(
                        _trail_item_points_as_dicts(left),
                        _trail_item_points_as_dicts(right),
                        TRAIL_STITCH_TOLERANCE_M,
                    )
                    if not merged_points:
                        continue

                    merged_item = _merge_trail_items(left, right, merged_points)
                    next_working = [
                        item
                        for index, item in enumerate(working)
                        if index not in {left_index, right_index}
                    ]
                    next_working.append(merged_item)
                    working = next_working
                    merged_any = True
                    break
        stitched.extend(working)

    return stitched


def _point_in_bounds(
    point: dict[str, float],
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> bool:
    return (
        min_lat <= point["lat"] <= max_lat and min_lon <= point["lon"] <= max_lon
    )


def _clip_points_to_bounds(
    points: list[dict[str, float]],
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> list[dict[str, float]]:
    if not points:
        return []

    clipped: list[dict[str, float]] = []
    previous_in_bounds = False

    for index, point in enumerate(points):
        in_bounds = _point_in_bounds(point, min_lat, min_lon, max_lat, max_lon)
        if in_bounds:
            if index > 0 and not previous_in_bounds:
                clipped.append(points[index - 1])
            clipped.append(point)
            if index + 1 < len(points):
                next_point = points[index + 1]
                if not _point_in_bounds(next_point, min_lat, min_lon, max_lat, max_lon):
                    clipped.append(next_point)
        previous_in_bounds = in_bounds

    return _normalize_points(clipped)


def _trail_score(item: TrailSearchItem, search_diagonal_m: float) -> float:
    score = 0.0

    if item.source == "usgs":
        score -= 12.0
    elif item.source == "nps":
        score -= 10.0
    elif item.source == "osm_way":
        score += 6.0
    else:
        score += 12.0

    distance_m = item.distance_from_center_m or (search_diagonal_m * 2)
    score += min(distance_m / 300.0, 40.0)

    length_m = item.length_m or 0.0
    if length_m < MIN_TRAIL_SEGMENT_LENGTH_M:
        score += 100.0
    elif length_m <= 12000:
        score += abs(length_m - 5000.0) / 2500.0
    elif length_m <= MAX_TRAIL_SEGMENT_LENGTH_M:
        score += 5.0 + ((length_m - 12000.0) / 4000.0)
    else:
        score += 100.0

    if not item.ref and not item.operator and not item.network:
        score += 2.0

    if item.name.lower().startswith("unnamed "):
        score += 25.0

    return score


def _normalized_name_key(item: TrailSearchItem) -> str:
    return " ".join((item.name or "").lower().split())


def _trail_items_are_near_duplicates(left: TrailSearchItem, right: TrailSearchItem) -> bool:
    if _normalized_name_key(left) != _normalized_name_key(right):
        return False
    if left.source != right.source:
        return False
    if (left.ref or "") != (right.ref or ""):
        return False

    left_points = _trail_item_points_as_dicts(left)
    right_points = _trail_item_points_as_dicts(right)
    if not left_points or not right_points:
        return False

    candidate_pairs = (
        (left_points[0], right_points[0]),
        (left_points[0], right_points[-1]),
        (left_points[-1], right_points[0]),
        (left_points[-1], right_points[-1]),
    )

    return any(
        _meters_between(
            left_point["lat"],
            left_point["lon"],
            right_point["lat"],
            right_point["lon"],
        )
        <= 120
        for left_point, right_point in candidate_pairs
    )


def _finalize_items(
    items: list[TrailSearchItem],
    center_lat: float,
    center_lon: float,
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    limit: int,
    debug: dict | None = None,
) -> TrailSearchResponse:
    items = _stitch_trail_items(items)
    expanded_min_lat, expanded_min_lon, expanded_max_lat, expanded_max_lon = _expanded_bounds(
        min_lat, min_lon, max_lat, max_lon
    )
    filtered: list[TrailSearchItem] = []
    search_diagonal_m = _meters_between(min_lat, min_lon, max_lat, max_lon)
    max_distance_m = max(5000.0, search_diagonal_m * 2.5)

    for item in items:
        clipped_points = _clip_points_to_bounds(
            _trail_item_points_as_dicts(item),
            expanded_min_lat,
            expanded_min_lon,
            expanded_max_lat,
            expanded_max_lon,
        )
        if len(clipped_points) < 2:
            continue

        distance_from_center_m = _distance_to_center_m(center_lat, center_lon, clipped_points)
        length_m = _polyline_length_m(clipped_points)
        if (
            length_m is not None
            and (length_m < MIN_TRAIL_SEGMENT_LENGTH_M or length_m > MAX_TRAIL_SEGMENT_LENGTH_M)
        ):
            continue
        if distance_from_center_m is not None and distance_from_center_m > max_distance_m:
            continue

        filtered.append(
            item.model_copy(
                update={
                    "distance_from_center_m": distance_from_center_m,
                    "length_m": length_m,
                    "points": _trail_points_models(clipped_points),
                }
            )
        )

    filtered.sort(key=lambda item: _trail_score(item, search_diagonal_m))
    deduped: list[TrailSearchItem] = []
    for item in filtered:
        if any(_trail_items_are_near_duplicates(item, existing) for existing in deduped):
            continue
        deduped.append(item)

    deduped.sort(
        key=lambda item: (
            item.distance_from_center_m or float("inf"),
            item.name.lower(),
        )
    )
    limited = deduped[: max(1, min(limit, 60))]
    source_counts: dict[str, int] = {}
    for item in limited:
        source_counts[item.source] = source_counts.get(item.source, 0) + 1

    has_usgs = any(item.source == "usgs" for item in limited)
    has_nps = any(item.source == "nps" for item in limited)
    has_osm = any(item.source in {"osm_way", "osm_relation"} for item in limited)
    if has_usgs and has_nps and has_osm:
        provider = "usgs_nps_osm"
    elif has_usgs and has_nps:
        provider = "usgs_nps"
    elif has_usgs and has_osm:
        provider = "usgs_osm"
    elif has_nps and has_osm:
        provider = "nps_osm"
    elif has_usgs:
        provider = "usgs_national_map"
    elif has_nps:
        provider = "nps_public_trails"
    else:
        provider = "openstreetmap_overpass"
    return TrailSearchResponse(
        provider=provider,
        count=len(limited),
        source_counts=source_counts,
        debug=debug or {},
        items=limited,
    )


def _fetch_json(url: str, timeout_seconds: int) -> dict:
    request = Request(
        url,
        headers={"User-Agent": "Jarvis Trail Search/1.0"},
        method="GET",
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        return json.loads(response.read().decode("utf-8"))


def _fetch_usgs_trails(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> list[TrailSearchItem]:
    where = "trailtype = 'Terra Trail'"
    params = urlencode(
        {
            "f": "geojson",
            "where": where,
            "geometry": f"{min_lon},{min_lat},{max_lon},{max_lat}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "returnGeometry": "true",
            "outFields": ",".join(
                [
                    "objectid",
                    "name",
                    "namealternate",
                    "trailnumber",
                    "trailnumberalternate",
                    "trailtype",
                    "lengthmiles",
                    "hikerpedestrian",
                    "primarytrailmaintainer",
                    "routetype",
                    "sourceoriginator",
                    "nationaltraildesignation",
                    "sourcefeatureid",
                    "permanentidentifier",
                ]
            ),
            "outSR": "4326",
            "resultRecordCount": "200",
        }
    )
    payload = _fetch_json(f"{USGS_TRAILS_QUERY_URL}?{params}", USGS_TIMEOUT_SECONDS)
    features = payload.get("features", [])
    items: list[TrailSearchItem] = []

    for feature in features:
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        geometry_type = geometry.get("type")
        if geometry_type not in {"LineString", "MultiLineString"} or not isinstance(
            coordinates, list
        ):
            continue

        raw_points: list[dict[str, float]] = []
        if geometry_type == "LineString":
            raw_points.extend(
                [
                    {"lat": coordinate[1], "lon": coordinate[0]}
                    for coordinate in coordinates
                    if isinstance(coordinate, list)
                    and len(coordinate) >= 2
                    and isinstance(coordinate[0], (int, float))
                    and isinstance(coordinate[1], (int, float))
                ]
            )
        else:
            for segment in coordinates:
                if not isinstance(segment, list):
                    continue
                raw_points.extend(
                    [
                        {"lat": coordinate[1], "lon": coordinate[0]}
                        for coordinate in segment
                        if isinstance(coordinate, list)
                        and len(coordinate) >= 2
                        and isinstance(coordinate[0], (int, float))
                        and isinstance(coordinate[1], (int, float))
                    ]
                )

        points = _normalize_points(raw_points)
        if len(points) < 2:
            continue

        properties = feature.get("properties") or {}
        trail_name = (
            properties.get("name")
            or properties.get("namealternate")
            or properties.get("trailnumber")
            or properties.get("trailnumberalternate")
            or "Unnamed USGS trail"
        )
        trail_ref = properties.get("trailnumber") or properties.get("trailnumberalternate")
        maintainer = properties.get("primarytrailmaintainer") or properties.get("sourceoriginator")
        permanent_identifier = properties.get("permanentidentifier") or properties.get("sourcefeatureid") or properties.get("objectid")

        items.append(
            TrailSearchItem(
                id=f"usgs-{permanent_identifier}",
                name=str(trail_name),
                source="usgs",
                trail_type="hiking",
                ref=str(trail_ref) if trail_ref else None,
                operator=str(maintainer) if maintainer else None,
                network=str(properties.get("nationaltraildesignation")) if properties.get("nationaltraildesignation") else None,
                length_m=(float(properties["lengthmiles"]) * 1609.344)
                if isinstance(properties.get("lengthmiles"), (int, float))
                else None,
                points=_trail_points_models(points),
                osm_url=None,
            )
        )

    return items


def _nps_looks_hike_relevant(properties: dict) -> bool:
    public_display = _normalized_text(str(properties.get("PUBLICDISPLAY") or ""))
    open_to_public = _normalized_text(str(properties.get("OPENTOPUBLIC") or ""))
    data_access = _normalized_text(str(properties.get("DATAACCESS") or ""))
    line_type = _normalized_text(str(properties.get("LINETYPE") or ""))
    trail_use = _normalized_text(str(properties.get("TRLUSE") or ""))
    trail_type = _normalized_text(str(properties.get("TRLTYPE") or ""))
    trail_class = _normalized_text(str(properties.get("TRLCLASS") or ""))
    surface = _normalized_text(str(properties.get("TRLSURFACE") or ""))

    if public_display in {"n", "no", "false"} or open_to_public in {"n", "no", "false"}:
        return False
    if any(token in data_access for token in ("private", "restricted", "internal")):
        return False
    if line_type in {"road", "street"}:
        return False
    if surface in {"asphalt", "concrete", "paved"}:
        return False

    combined = " ".join(value for value in (trail_use, trail_type, trail_class) if value)
    disallowed = (
        "motor",
        "vehicle",
        "atv",
        "ohv",
        "4wd",
        "drive",
        "road",
    )
    if any(token in combined for token in disallowed):
        return False

    return True


def _fetch_nps_trails(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> list[TrailSearchItem]:
    params = urlencode(
        {
            "f": "geojson",
            "where": "1=1",
            "geometry": f"{min_lon},{min_lat},{max_lon},{max_lat}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "returnGeometry": "true",
            "outFields": ",".join(
                [
                    "OBJECTID",
                    "TRLNAME",
                    "TRLALTNAME",
                    "MAPLABEL",
                    "TRLSTATUS",
                    "TRLSURFACE",
                    "TRLTYPE",
                    "TRLCLASS",
                    "TRLUSE",
                    "PUBLICDISPLAY",
                    "DATAACCESS",
                    "ORIGINATOR",
                    "UNITCODE",
                    "UNITNAME",
                    "UNITTYPE",
                    "GROUPCODE",
                    "GROUPNAME",
                    "REGIONCODE",
                    "LINETYPE",
                    "GEOMETRYID",
                    "FEATUREID",
                    "OPENTOPUBLIC",
                    "MAINTAINER",
                ]
            ),
            "outSR": "4326",
            "resultRecordCount": "200",
        }
    )
    payload = _fetch_json(f"{NPS_TRAILS_QUERY_URL}?{params}", NPS_TIMEOUT_SECONDS)
    features = payload.get("features", [])
    items: list[TrailSearchItem] = []

    for feature in features:
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        geometry_type = geometry.get("type")
        if geometry_type not in {"LineString", "MultiLineString"} or not isinstance(coordinates, list):
            continue

        raw_points: list[dict[str, float]] = []
        if geometry_type == "LineString":
            raw_points.extend(
                [
                    {"lat": coordinate[1], "lon": coordinate[0]}
                    for coordinate in coordinates
                    if isinstance(coordinate, list)
                    and len(coordinate) >= 2
                    and isinstance(coordinate[0], (int, float))
                    and isinstance(coordinate[1], (int, float))
                ]
            )
        else:
            for segment in coordinates:
                if not isinstance(segment, list):
                    continue
                raw_points.extend(
                    [
                        {"lat": coordinate[1], "lon": coordinate[0]}
                        for coordinate in segment
                        if isinstance(coordinate, list)
                        and len(coordinate) >= 2
                        and isinstance(coordinate[0], (int, float))
                        and isinstance(coordinate[1], (int, float))
                    ]
                )

        points = _normalize_points(raw_points)
        if len(points) < 2:
            continue

        properties = feature.get("properties") or {}
        trail_name = (
            properties.get("TRLNAME")
            or properties.get("TRLALTNAME")
            or properties.get("MAPLABEL")
            or properties.get("FEATUREID")
            or "Unnamed NPS trail"
        )
        unit_name = properties.get("UNITNAME")
        network = properties.get("GROUPNAME") or unit_name
        permanent_identifier = properties.get("GEOMETRYID") or properties.get("FEATUREID") or properties.get("OBJECTID")
        maintainer = properties.get("MAINTAINER") or properties.get("ORIGINATOR")

        items.append(
            TrailSearchItem(
                id=f"nps-{permanent_identifier}",
                name=str(trail_name),
                source="nps",
                trail_type=str(properties.get("TRLUSE") or properties.get("TRLTYPE") or "hiking"),
                ref=str(properties.get("FEATUREID")) if properties.get("FEATUREID") else None,
                operator=str(maintainer) if maintainer else None,
                network=str(network) if network else None,
                points=_trail_points_models(points),
                osm_url=None,
            )
        )

    return items


def _build_overpass_query(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> str:
    return f"""
[out:json][timeout:{OVERPASS_TIMEOUT_SECONDS}];
(
  relation["type"="route"]["route"~"^(hiking|foot|walking)$"]({min_lat},{min_lon},{max_lat},{max_lon});
  way["highway"~"^(path|track|bridleway|footway|steps)$"]({min_lat},{min_lon},{max_lat},{max_lon});
  way["route"~"^(hiking|foot|walking)$"]({min_lat},{min_lon},{max_lat},{max_lon});
);
out geom;
""".strip()


def _extract_overpass_geometry(element: dict) -> list[dict[str, float]]:
    geometry = element.get("geometry")
    if isinstance(geometry, list):
        return _normalize_points(
            [
                {"lat": point.get("lat"), "lon": point.get("lon")}
                for point in geometry
                if isinstance(point, dict)
            ]
        )

    if element.get("type") == "relation":
        points: list[dict[str, float]] = []
        for member in element.get("members", []):
            member_geometry = member.get("geometry")
            if member.get("type") != "way" or not isinstance(member_geometry, list):
                continue
            points.extend(
                _normalize_points(
                    [
                        {"lat": point.get("lat"), "lon": point.get("lon")}
                        for point in member_geometry
                        if isinstance(point, dict)
                    ]
                )
            )
        return _normalize_points(points)

    return []


def _is_hiking_relevant_way(tags: dict) -> bool:
    highway = _normalized_text(tags.get("highway"))
    route = _normalized_text(tags.get("route"))
    name = _normalized_text(tags.get("name"))
    ref = _normalized_text(tags.get("ref"))
    footway = _normalized_text(tags.get("footway"))
    surface = _normalized_text(tags.get("surface"))
    informal = _normalized_text(tags.get("informal"))
    lit = _normalized_text(tags.get("lit"))
    indoor = _normalized_text(tags.get("indoor"))
    access = _normalized_text(tags.get("access"))
    motor_vehicle = _normalized_text(tags.get("motor_vehicle"))
    vehicle = _normalized_text(tags.get("vehicle"))
    bicycle = _normalized_text(tags.get("bicycle"))
    sac_scale = _normalized_text(tags.get("sac_scale"))
    trail_visibility = _normalized_text(tags.get("trail_visibility"))
    foot = _normalized_text(tags.get("foot"))

    if route in {"hiking", "foot", "walking"}:
        return True
    if indoor in {"yes", "true", "1"}:
        return False
    if footway in {"sidewalk", "crossing", "access_aisle", "link"}:
        return False
    if access in {"private", "no"}:
        return False
    if motor_vehicle not in {"", "no"}:
        return False
    if vehicle not in {"", "no"}:
        return False
    if informal in {"yes", "true", "1"}:
        return False
    if lit in {"yes", "true", "1"} and highway == "footway":
        return False
    if surface in {"asphalt", "concrete", "paved"}:
        return False

    if highway in {"path", "track", "bridleway"}:
        return True
    if highway == "steps":
        return bool(name or ref or sac_scale or trail_visibility)
    if highway == "footway":
        if foot in {"designated", "yes", "permissive"} and (
            sac_scale or trail_visibility
        ):
            return True
        if sac_scale or trail_visibility:
            return True
        if name or ref:
            trailish_tokens = ("trail", "path", "loop", "ridge", "canyon", "peak")
            return any(token in name for token in trailish_tokens)
        if bicycle in {"designated", "yes"}:
            return False

    return False


def _fetch_osm_trails(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> tuple[list[TrailSearchItem], dict]:
    query = _build_overpass_query(min_lat, min_lon, max_lat, max_lon)
    payload = None
    endpoint_errors: list[str] = []
    for overpass_url in OVERPASS_API_URLS:
        request = Request(
            overpass_url,
            data=query.encode("utf-8"),
            headers={
                "Content-Type": "text/plain; charset=utf-8",
                "User-Agent": "Jarvis Trail Search/1.0",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=OVERPASS_TIMEOUT_SECONDS + 5) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore").strip()
            endpoint_errors.append(
                f"{overpass_url} returned HTTP {exc.code}{f' ({detail})' if detail else ''}"
            )
        except URLError as exc:
            endpoint_errors.append(f"{overpass_url} unreachable ({exc.reason})")

    if payload is None:
        raise URLError("; ".join(endpoint_errors) or "No Overpass endpoint could be reached")

    items: list[TrailSearchItem] = []
    seen_keys: set[tuple[str, int]] = set()
    raw_elements = payload.get("elements", [])
    payload_remark = payload.get("remark")
    debug_relation = next(
        (
            element
            for element in raw_elements
            if element.get("type") == "relation"
            and element.get("id") == DEBUG_OSM_RELATION_ID
        ),
        None,
    )
    raw_debug_way_ids = sorted(
        element.get("id")
        for element in raw_elements
        if element.get("type") == "way"
        and isinstance(element.get("id"), int)
        and element.get("id") in DEBUG_OSM_RELATION_MEMBER_WAY_IDS
    )
    emitted_debug_item = False

    for element in raw_elements:
        element_type = element.get("type")
        element_id = element.get("id")
        if element_type not in {"relation", "way"} or not isinstance(element_id, int):
            continue
        key = (element_type, element_id)
        if key in seen_keys:
            continue
        seen_keys.add(key)

        tags = element.get("tags") or {}
        if element_type == "way" and not _is_hiking_relevant_way(tags):
            continue

        points = _extract_overpass_geometry(element)
        if len(points) < 2:
            continue

        name = (
            tags.get("name")
            or tags.get("official_name")
            or tags.get("ref")
            or tags.get("alt_name")
            or f"Unnamed {'trail route' if element_type == 'relation' else 'trail'}"
        )
        items.append(
            TrailSearchItem(
                id=f"{element_type}-{element_id}",
                name=name,
                source="osm_relation" if element_type == "relation" else "osm_way",
                trail_type=tags.get("route") or tags.get("highway") or "hiking",
                ref=tags.get("ref"),
                operator=tags.get("operator"),
                network=tags.get("network"),
                points=_trail_points_models(points),
                osm_url=f"https://www.openstreetmap.org/{element_type}/{element_id}",
            )
        )
        if element_type == "relation" and element_id == DEBUG_OSM_RELATION_ID:
            emitted_debug_item = True

    relation_member_way_ids: list[int] = []
    relation_member_geometry_count = 0
    relation_tags: dict[str, str] = {}
    if isinstance(debug_relation, dict):
        relation_tags = {
            str(key): str(value)
            for key, value in (debug_relation.get("tags") or {}).items()
        }
        relation_member_way_ids = [
            member.get("ref")
            for member in debug_relation.get("members", [])
            if member.get("type") == "way" and isinstance(member.get("ref"), int)
        ]
        relation_member_geometry_count = sum(
            1
            for member in debug_relation.get("members", [])
            if member.get("type") == "way" and isinstance(member.get("geometry"), list)
        )

    debug = {
        "y_mountain_relation_id": DEBUG_OSM_RELATION_ID,
        "overpass_endpoints": OVERPASS_API_URLS,
        "osm_raw_element_count": len(raw_elements),
        "osm_raw_relation_count": sum(
            1 for element in raw_elements if element.get("type") == "relation"
        ),
        "osm_payload_remark": str(payload_remark) if payload_remark else None,
        "y_mountain_relation_present_in_overpass": bool(debug_relation),
        "y_mountain_relation_member_way_ids": relation_member_way_ids,
        "y_mountain_relation_member_geometry_count": relation_member_geometry_count,
        "y_mountain_member_way_hits_in_overpass": raw_debug_way_ids,
        "y_mountain_relation_emitted_as_item": emitted_debug_item,
        "y_mountain_relation_tags": relation_tags,
    }
    return items, debug


def search_openstreetmap_trails(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    limit: int = 12,
) -> TrailSearchResponse:
    min_lat, min_lon, max_lat, max_lon = _validate_bounds(
        min_lat, min_lon, max_lat, max_lon
    )
    center_lat = (min_lat + max_lat) / 2
    center_lon = (min_lon + max_lon) / 2

    collected_items: list[TrailSearchItem] = []
    errors: list[str] = []
    debug: dict[str, object] = {}

    try:
        collected_items.extend(_fetch_usgs_trails(min_lat, min_lon, max_lat, max_lon))
    except Exception as exc:
        errors.append(f"USGS trail search failed ({exc})")

    try:
        collected_items.extend(_fetch_nps_trails(min_lat, min_lon, max_lat, max_lon))
    except Exception as exc:
        errors.append(f"NPS trail search failed ({exc})")

    try:
        osm_items, osm_debug = _fetch_osm_trails(min_lat, min_lon, max_lat, max_lon)
        collected_items.extend(osm_items)
        debug.update(osm_debug)
        if osm_debug.get("osm_payload_remark"):
            debug["osm_error"] = f"OpenStreetMap Overpass remark: {osm_debug['osm_payload_remark']}"
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore").strip()
        message = (
            f"OpenStreetMap trail search failed with Overpass status {exc.code}. "
            f"{detail or 'No error body returned.'}"
        )
        errors.append(message)
        debug["osm_error"] = message
    except URLError as exc:
        message = f"OpenStreetMap trail data could not be reached ({exc.reason})"
        errors.append(message)
        debug["osm_error"] = message
    except Exception as exc:
        message = f"OpenStreetMap trail search failed ({exc})"
        errors.append(message)
        debug["osm_error"] = message

    if "osm_error" not in debug:
        debug["osm_error"] = None
    debug["search_errors"] = errors[:]

    response = _finalize_items(
        collected_items,
        center_lat=center_lat,
        center_lon=center_lon,
        min_lat=min_lat,
        min_lon=min_lon,
        max_lat=max_lat,
        max_lon=max_lon,
        limit=limit,
        debug=debug,
    )
    return response
