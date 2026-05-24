"""
core/audit.py
─────────────────────────────────────────────────────
Admin action audit trail.

Every admin mutation (user create/update/delete, kill-switch toggle,
scan trigger, etc) is recorded in Supabase with:
  • actor user_id and email
  • action string (e.g. "user.create", "risk.soft_kill")
  • target (optional — e.g. affected user_id)
  • details (JSON — request payload or reason)
  • source IP and request ID

Required table (add to supabase_schema.sql):

    CREATE TABLE IF NOT EXISTS audit_log (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_id     UUID REFERENCES users(id),
        actor_email  TEXT,
        action       TEXT NOT NULL,
        target       TEXT,
        details      JSONB,
        ip           TEXT,
        request_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);
"""
from __future__ import annotations

from typing import Any, Optional

from loguru import logger

from core.logging_config import current_request_id
from core.supabase_pool import admin_client


def audit(
    actor: dict,
    action: str,
    target: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
    ip: Optional[str] = None,
) -> None:
    """
    Persist an audit event. Fire-and-forget — never raises.

    Args:
        actor:   the verified admin user dict (must contain id and email)
        action:  dotted identifier like "user.create" or "risk.hard_kill"
        target:  optional identifier of the affected resource
        details: optional JSON-serializable detail dict (redact secrets!)
        ip:      optional client IP
    """
    try:
        admin_client().table("audit_log").insert({
            "actor_id": actor.get("id"),
            "actor_email": actor.get("email"),
            "action": action,
            "target": target,
            "details": _redact(details or {}),
            "ip": ip,
            "request_id": current_request_id(),
        }).execute()
    except Exception as e:
        # An audit failure should NEVER block the underlying action,
        # but it must be loud in the logs so we notice infra problems.
        logger.error(f"AUDIT LOG FAILED action={action} target={target} err={e}")


# Never log these keys even if a caller passes them in `details`
_SECRET_KEYS = {
    "password", "passwd", "api_key", "api_secret", "secret", "totp",
    "groww_api_key", "groww_api_secret", "groww_totp_secret",
    "delta_api_key", "delta_api_secret", "token", "access_token",
    "refresh_token", "authorization", "cookie",
}


def _redact(details: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for k, v in details.items():
        if k.lower() in _SECRET_KEYS:
            out[k] = "[REDACTED]"
        elif isinstance(v, dict):
            out[k] = _redact(v)
        else:
            out[k] = v
    return out
