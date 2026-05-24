"""
core/security.py  (v3)
─────────────────────────────────────────────────────
AES-256-GCM encryption for broker API keys + explicit-credential
client factories.

Critical fix vs v2
------------------
v2's `get_user_groww_client` / `get_user_delta_client` mutated
`os.environ` at request time, then built a client that reads those
env vars. Under concurrent requests, User A and User B can interleave
their writes and cross-contaminate credentials — a real multi-tenant
data leak.

v3 passes credentials *explicitly* into the client constructors.
The caller never touches process-global state. This means the broker
client classes need to accept `api_key=` / `api_secret=` kwargs; the
`data/groww_factory.py` and `data/delta_factory.py` shims do that.

Ciphertext format
-----------------
    base64( nonce[12] || ciphertext || tag[16] )

We also add a 3-byte magic header "TXV" (TradeX-Vault) to the
ciphertext BEFORE base64, so we can cleanly distinguish encrypted
values from plaintext or legacy values without fragile length
heuristics.

    plaintext  -> "TXV" || nonce[12] || aesgcm(plaintext) -> base64

If decryption of the legacy format is ever needed, call
`decrypt_key_legacy()` explicitly.
"""
from __future__ import annotations

import base64
import secrets
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from loguru import logger

from core.config import get_settings


_MAGIC = b"TXV"  # 3 bytes — ciphertext discriminator
_NONCE_LEN = 12


def _get_key_bytes() -> bytes:
    raw = get_settings().ENCRYPTION_KEY.get_secret_value()
    if not raw:
        raise RuntimeError(
            "ENCRYPTION_KEY not set. "
            "Generate with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )
    return bytes.fromhex(raw)


def is_encrypted(value: str) -> bool:
    """Return True if `value` looks like a v3-encrypted ciphertext."""
    if not value:
        return False
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception:
        return False
    return raw[:3] == _MAGIC and len(raw) > 3 + _NONCE_LEN


def encrypt_key(plaintext: str) -> str:
    """
    Encrypt a secret with AES-256-GCM. Returns a base64 string.
    Empty input returns empty string (not an error — simplifies upsert logic).
    """
    if not plaintext:
        return ""
    if is_encrypted(plaintext):
        # idempotent — already encrypted, don't double-wrap
        return plaintext

    aesgcm = AESGCM(_get_key_bytes())
    nonce = secrets.token_bytes(_NONCE_LEN)
    ct = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
    return base64.b64encode(_MAGIC + nonce + ct).decode("ascii")


def decrypt_key(ciphertext_b64: str) -> str:
    """
    Decrypt a v3 ciphertext. Returns empty string on any failure —
    callers must check for "" and not fall back to treating the
    input as plaintext (that was the v2 footgun).

    For explicit plaintext fallback during migration, the caller
    should inspect `is_encrypted()` first.
    """
    if not ciphertext_b64:
        return ""
    if not is_encrypted(ciphertext_b64):
        logger.warning("decrypt_key called with non-v3 ciphertext; refusing to guess")
        return ""

    try:
        raw = base64.b64decode(ciphertext_b64)
        nonce = raw[3 : 3 + _NONCE_LEN]
        ct = raw[3 + _NONCE_LEN :]
        aesgcm = AESGCM(_get_key_bytes())
        return aesgcm.decrypt(nonce, ct, None).decode("utf-8")
    except Exception as e:
        logger.error(f"Key decryption failed: {type(e).__name__}")
        return ""


def mask_secret(value: Optional[str], visible_tail: int = 4) -> str:
    """Mask a stored secret for display (never decrypt for display)."""
    if not value:
        return ""
    if len(value) <= visible_tail:
        return "SET"
    return "•" * 8 + value[-visible_tail:]


# ─── Legacy decryption (for migration) ───────────────────────────
def decrypt_key_legacy_v2(ciphertext_b64: str) -> str:
    """
    One-shot helper for migrating v2 ciphertexts (no magic header)
    into v3 format. Do not call from request paths.
    """
    if not ciphertext_b64:
        return ""
    try:
        raw = base64.b64decode(ciphertext_b64)
        nonce = raw[:_NONCE_LEN]
        ct = raw[_NONCE_LEN:]
        aesgcm = AESGCM(_get_key_bytes())
        return aesgcm.decrypt(nonce, ct, None).decode("utf-8")
    except Exception:
        return ""


# ─── Decrypted user config (for factory consumption) ─────────────
def decrypted_broker_config(user_config: dict) -> dict:
    """
    Return a copy of user_config with the four broker-secret fields
    decrypted. Other fields are passed through untouched.

    Never persist the returned dict — hold only long enough to pass
    into a client factory.
    """
    if not user_config:
        return {}
    decrypted_fields = (
        "groww_api_key",
        "groww_totp_secret",
        "delta_api_key",
        "delta_api_secret",
    )
    out = dict(user_config)
    for field in decrypted_fields:
        raw = out.get(field)
        if raw:
            out[field] = decrypt_key(raw)
    return out
