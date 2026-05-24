"""
tests/test_security.py
─────────────────────────────────────────────────────
Security-critical unit tests. Run with:  pytest tests/ -v
"""
import os
import secrets

import pytest

# Ensure a valid ENCRYPTION_KEY is set before importing the module
os.environ.setdefault("ENCRYPTION_KEY", secrets.token_hex(32))
os.environ.setdefault("ENVIRONMENT", "dev")

from core.security import (  # noqa: E402
    decrypt_key,
    decrypt_key_legacy_v2,
    decrypted_broker_config,
    encrypt_key,
    is_encrypted,
    mask_secret,
)


class TestEncryption:
    def test_roundtrip(self):
        secret = "gw_live_abcdefgh12345678"
        ct = encrypt_key(secret)
        assert ct != secret
        assert is_encrypted(ct)
        assert decrypt_key(ct) == secret

    def test_empty_inputs(self):
        assert encrypt_key("") == ""
        assert decrypt_key("") == ""

    def test_encrypt_is_idempotent(self):
        """Encrypting an already-encrypted value should not double-wrap."""
        secret = "my_secret"
        ct1 = encrypt_key(secret)
        ct2 = encrypt_key(ct1)
        assert ct1 == ct2
        assert decrypt_key(ct2) == secret

    def test_different_nonces(self):
        """Same plaintext must produce different ciphertexts (nonce)."""
        s = "same_secret"
        assert encrypt_key(s) != encrypt_key(s)

    def test_decrypt_garbage_returns_empty(self):
        """Decrypting non-v3 ciphertext must NOT return a guess."""
        # This was the v2 footgun — it would return the raw input
        # for short strings, corrupting downstream logic.
        assert decrypt_key("not_encrypted_value") == ""
        assert decrypt_key("abcdef") == ""

    def test_is_encrypted_discriminator(self):
        assert is_encrypted(encrypt_key("x"))
        assert not is_encrypted("")
        assert not is_encrypted("plaintext")
        assert not is_encrypted("notbase64@@")

    def test_tampered_ciphertext_fails_cleanly(self):
        import base64
        ct = encrypt_key("secret")
        raw = bytearray(base64.b64decode(ct))
        raw[-1] ^= 0xFF  # flip a bit in the tag
        tampered = base64.b64encode(bytes(raw)).decode()
        # Should fail auth and return empty, NOT raise
        assert decrypt_key(tampered) == ""


class TestMasking:
    def test_mask_short(self):
        assert mask_secret("abc") == "SET"

    def test_mask_long(self):
        out = mask_secret("gw_live_supersecretkey12345")
        assert out.endswith("2345")
        assert "supersecret" not in out
        assert out.startswith("•")

    def test_mask_empty(self):
        assert mask_secret(None) == ""
        assert mask_secret("") == ""


class TestBrokerConfigDecryption:
    def test_decrypts_only_broker_fields(self):
        cfg = {
            "groww_api_key": encrypt_key("gw_real"),
            "delta_api_key": encrypt_key("dx_real"),
            "twitter_handles": "not_a_secret",
            "groww_capital": 200000,
        }
        out = decrypted_broker_config(cfg)
        assert out["groww_api_key"] == "gw_real"
        assert out["delta_api_key"] == "dx_real"
        assert out["twitter_handles"] == "not_a_secret"
        assert out["groww_capital"] == 200000

    def test_empty_input(self):
        assert decrypted_broker_config({}) == {}
        assert decrypted_broker_config(None) == {}
