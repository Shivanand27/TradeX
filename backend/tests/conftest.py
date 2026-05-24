"""
tests/conftest.py
─────────────────────────────────────────────────────
Shared pytest fixtures and bootstrap.
"""
import os
import secrets
import sys
from pathlib import Path

# Put backend/ on sys.path so tests can import `core.*`, `data.*`, etc.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Minimal env so config validation passes in dev mode
os.environ.setdefault("ENVIRONMENT", "dev")
os.environ.setdefault("ENCRYPTION_KEY", secrets.token_hex(32))
os.environ.setdefault("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
