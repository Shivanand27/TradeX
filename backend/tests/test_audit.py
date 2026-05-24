"""
tests/test_audit.py
─────────────────────────────────────────────────────
Tests for audit log secret redaction.
The DB persistence itself is mocked — we only verify that secrets
NEVER make it into the persisted payload.
"""
import os
import secrets

os.environ.setdefault("ENCRYPTION_KEY", secrets.token_hex(32))
os.environ.setdefault("ENVIRONMENT", "dev")

from core.audit import _redact  # noqa: E402


def test_top_level_secrets_redacted():
    details = {
        "password": "swordfish",
        "groww_api_key": "gw_real_key",
        "delta_api_secret": "dx_real_secret",
        "plan": "PRO",
        "email": "user@example.com",
    }
    out = _redact(details)
    assert out["password"] == "[REDACTED]"
    assert out["groww_api_key"] == "[REDACTED]"
    assert out["delta_api_secret"] == "[REDACTED]"
    assert out["plan"] == "PRO"
    assert out["email"] == "user@example.com"


def test_nested_secrets_redacted():
    details = {
        "config": {
            "groww_api_key": "leak_me",
            "groww_capital": 500000,
        },
        "actor": "admin@tradex.app",
    }
    out = _redact(details)
    assert out["config"]["groww_api_key"] == "[REDACTED]"
    assert out["config"]["groww_capital"] == 500000
    assert out["actor"] == "admin@tradex.app"


def test_case_insensitive_key_match():
    details = {"PASSWORD": "x", "Api_Key": "y"}
    out = _redact(details)
    assert out["PASSWORD"] == "[REDACTED]"
    assert out["Api_Key"] == "[REDACTED]"


def test_empty_details():
    assert _redact({}) == {}
