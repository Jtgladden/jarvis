from datetime import date

from app.health_store import init_health_store, list_health_daily_entries, upsert_health_daily_entry
from app.schemas import HealthDailyEntry, HealthDailySyncRequest, HealthDailySyncResponse, HealthListResponse
from app.user_context import get_default_user_context


def sync_health_daily_entry(payload: HealthDailySyncRequest) -> HealthDailySyncResponse:
    init_health_store()
    user_id = get_default_user_context().user_id
    entry_date = payload.date or date.today().isoformat()
    entry = upsert_health_daily_entry(
        entry_date,
        source=payload.source,
        steps=payload.steps,
        active_energy_kcal=payload.active_energy_kcal,
        sleep_hours=payload.sleep_hours,
        workouts=payload.workouts,
        resting_heart_rate=payload.resting_heart_rate,
        extra_metrics=payload.extra_metrics,
        user_id=user_id,
    )
    return HealthDailySyncResponse(saved=True, entry=entry)


def list_health_entries(days: int = 7) -> HealthListResponse:
    init_health_store()
    user_id = get_default_user_context().user_id
    entries: list[HealthDailyEntry] = list_health_daily_entries(days=days, user_id=user_id)
    return HealthListResponse(entries=entries)
