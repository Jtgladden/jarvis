import json
import os
from contextlib import suppress
from datetime import datetime, timezone
from hashlib import sha256
from threading import Lock

from app.schemas import ClassificationGuidanceResponse

_guidance_lock = Lock()


def _guidance_path() -> str:
    path = os.getenv("CLASSIFICATION_GUIDANCE_FILE", "data/classification_guidance.json")
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    return path


def _default_payload() -> dict[str, str]:
    return {
        "text": "",
        "updated_at": "",
    }


def init_classification_guidance() -> None:
    path = _guidance_path()
    if os.path.exists(path):
        return

    with _guidance_lock:
        if os.path.exists(path):
            return
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(_default_payload(), handle)


def _load_payload() -> dict[str, str]:
    init_classification_guidance()
    with _guidance_lock:
        with open(_guidance_path(), encoding="utf-8") as handle:
            payload = json.load(handle)

    if not isinstance(payload, dict):
        return _default_payload()

    return {
        "text": str(payload.get("text") or ""),
        "updated_at": str(payload.get("updated_at") or ""),
    }


def _normalized_text(text: str | None) -> str:
    lines = [line.rstrip() for line in (text or "").splitlines()]
    normalized = "\n".join(lines).strip()
    return normalized[:8000]


def get_classification_guidance() -> ClassificationGuidanceResponse:
    payload = _load_payload()
    text = _normalized_text(payload.get("text"))
    version = sha256(text.encode("utf-8")).hexdigest()
    return ClassificationGuidanceResponse(
        text=text,
        updated_at=payload.get("updated_at") or None,
        version=version,
    )


def update_classification_guidance(text: str | None) -> ClassificationGuidanceResponse:
    normalized_text = _normalized_text(text)
    payload = {
        "text": normalized_text,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    with _guidance_lock:
        with open(_guidance_path(), "w", encoding="utf-8") as handle:
            json.dump(payload, handle)

    return get_classification_guidance()


def get_classification_guidance_version() -> str:
    with suppress(Exception):
        return get_classification_guidance().version
    return sha256(b"").hexdigest()
