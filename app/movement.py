from app.movement_store import init_movement_store, list_movement_daily_entries, upsert_movement_daily_entry
from app.schemas import MovementDailyEntry, MovementDailySyncRequest, MovementDailySyncResponse, MovementListResponse
from app.user_context import get_default_user_context


def sync_movement_daily_entry(payload: MovementDailySyncRequest) -> MovementDailySyncResponse:
    init_movement_store()
    user_id = get_default_user_context().user_id
    entry = MovementDailyEntry(
        date=payload.date,
        source=payload.source,
        total_distance_km=payload.total_distance_km,
        time_away_minutes=payload.time_away_minutes,
        visited_places_count=payload.visited_places_count,
        movement_story=payload.movement_story,
        home_label=payload.home_label,
        commute_start=payload.commute_start,
        commute_end=payload.commute_end,
        visits=payload.visits,
        route_points=payload.route_points,
        place_labels=payload.place_labels,
    )
    saved = upsert_movement_daily_entry(entry, user_id=user_id)
    return MovementDailySyncResponse(saved=True, entry=saved)


def list_movement_entries(days: int = 14) -> MovementListResponse:
    init_movement_store()
    user_id = get_default_user_context().user_id
    entries = list_movement_daily_entries(days=days, user_id=user_id)
    return MovementListResponse(entries=entries)
