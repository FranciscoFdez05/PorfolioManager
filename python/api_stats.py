from datetime import date
from threading import Lock

_lock = Lock()
_stats = {"date": None, "counts": {}}


def record_api_call(provider: str) -> None:
    today = date.today().isoformat()
    with _lock:
        if _stats["date"] != today:
            _stats["date"] = today
            _stats["counts"] = {}
        _stats["counts"][provider] = _stats["counts"].get(provider, 0) + 1


def get_today_stats() -> dict:
    today = date.today().isoformat()
    with _lock:
        if _stats["date"] != today:
            return {"date": today, "counts": {}, "total": 0}
        counts = dict(_stats["counts"])
    total = sum(counts.values())
    return {"date": today, "counts": counts, "total": total}
