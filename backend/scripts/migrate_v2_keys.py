"""
scripts/migrate_v2_keys.py
─────────────────────────────────────────────────────
One-shot migration: rotate existing broker-key ciphertexts from
the v2 format (nonce || ct) to the v3 format ("TXV" || nonce || ct).

Run ONCE after deploying v3, BEFORE any user tries to use their
saved broker keys. Otherwise v3's decrypt_key will refuse to touch
v2 ciphertexts (it requires the "TXV" magic header).

Usage:
    cd backend
    python -m scripts.migrate_v2_keys --dry-run
    python -m scripts.migrate_v2_keys --apply

Idempotent: already-v3 values are left alone.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Ensure backend/ is on the path when invoked as `python -m scripts.migrate_v2_keys`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from loguru import logger

from core.security import (
    decrypt_key_legacy_v2,
    encrypt_key,
    is_encrypted,
)
from core.supabase_pool import admin_client


BROKER_FIELDS = (
    "groww_api_key",
    "groww_totp_secret",
    "delta_api_key",
    "delta_api_secret",
)


def migrate(dry_run: bool) -> int:
    db = admin_client()
    rows = db.table("user_configs").select("*").execute().data or []
    logger.info(f"Found {len(rows)} user_configs rows")

    updated = 0
    for row in rows:
        uid = row.get("user_id")
        patch = {}
        for field in BROKER_FIELDS:
            val = row.get(field)
            if not val:
                continue
            if is_encrypted(val):
                # Already v3
                continue
            plain = decrypt_key_legacy_v2(val)
            if not plain:
                logger.warning(f"user={uid} field={field}: legacy decrypt failed — skipping")
                continue
            patch[field] = encrypt_key(plain)

        if not patch:
            continue

        logger.info(f"user={uid}: re-encrypting {sorted(patch.keys())}")
        if not dry_run:
            db.table("user_configs").update(patch).eq("user_id", uid).execute()
        updated += 1

    mode = "DRY-RUN" if dry_run else "APPLIED"
    logger.info(f"{mode}: {updated} users migrated")
    return updated


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Print what would change, don't write")
    ap.add_argument("--apply", action="store_true", help="Actually update the database")
    args = ap.parse_args()

    if not (args.dry_run or args.apply):
        ap.error("Specify --dry-run or --apply")

    migrate(dry_run=args.dry_run)
