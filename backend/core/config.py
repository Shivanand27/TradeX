"""
core/config.py  (v3)
─────────────────────────────────────────────────────
Central configuration backed by Pydantic Settings.

Every setting is validated at startup. If a critical env var is
missing or malformed, the process refuses to start with a clear
error instead of silently degrading in production.

Design notes vs v2:
  • CORS origin allow-list is now explicit (no more "*" with credentials)
  • ENCRYPTION_KEY is validated as 32-byte hex at load time
  • Environment is typed (dev | staging | prod) so other modules can
    gate behaviour (e.g. disable docs in prod)
  • All legacy top-level names are re-exported at module level so
    existing imports (`from core.config import SUPABASE_URL`) keep working
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


ENV_FILE = Path(__file__).parent.parent / ".env"


class Settings(BaseSettings):
    """Single source of truth for configuration."""

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ─── Environment ─────────────────────────────────────────────
    ENVIRONMENT: Literal["dev", "staging", "prod"] = "dev"
    LOG_LEVEL: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    PAPER_TRADING: bool = True

    # ─── Database ────────────────────────────────────────────────
    SUPABASE_URL: str = ""
    SUPABASE_KEY: str = ""
    SUPABASE_SERVICE_KEY: SecretStr = SecretStr("")
    UPSTASH_REDIS_REST_URL: str = ""
    UPSTASH_REDIS_REST_TOKEN: SecretStr = SecretStr("")

    # ─── Security ────────────────────────────────────────────────
    ENCRYPTION_KEY: SecretStr = SecretStr("")
    JWT_CACHE_TTL_SECONDS: int = 60          # verified-user cache
    ADMIN_RATE_LIMIT_PER_MIN: int = 30
    USER_RATE_LIMIT_PER_MIN: int = 120
    SCAN_RATE_LIMIT_PER_MIN: int = 5         # protects expensive ops

    # ─── CORS ────────────────────────────────────────────────────
    # Comma-separated allowed origins, e.g.
    #   CORS_ALLOWED_ORIGINS=https://tradex.app,https://admin.tradex.app
    CORS_ALLOWED_ORIGINS: str = "http://localhost:5173"

    # ─── LLM ─────────────────────────────────────────────────────
    # Primary: Azure OpenAI
    AZURE_OPENAI_API_KEY: SecretStr = SecretStr("")
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_API_VERSION: str = "2025-01-01-preview"
    AZURE_OPENAI_DEPLOYMENT: str = "gpt-4o"
    # Secondary: Ollama (local fallback)
    OLLAMA_BASE_URL: str = "http://13.202.31.186:11434"
    OLLAMA_MODEL: str = "gemma:2b"

    # ─── Telegram ────────────────────────────────────────────────
    TELEGRAM_BOT_TOKEN: SecretStr = SecretStr("")
    TELEGRAM_CHAT_ID: str = ""

    # ─── Brokers ─────────────────────────────────────────────────
    GROWW_API_KEY: SecretStr = SecretStr("")
    GROWW_API_SECRET: SecretStr = SecretStr("")
    GROWW_TOTP_SECRET: SecretStr = SecretStr("")
    GROWW_ACCESS_TOKEN: SecretStr = SecretStr("")

    DELTA_API_KEY: SecretStr = SecretStr("")
    DELTA_API_SECRET: SecretStr = SecretStr("")
    DELTA_TESTNET_API_KEY: SecretStr = SecretStr("")
    DELTA_TESTNET_API_SECRET: SecretStr = SecretStr("")
    DELTA_BASE_URL: str = "https://api.india.delta.exchange"
    DELTA_TESTNET_URL: str = "https://testnet-api.delta.exchange"
    DELTA_WS_URL: str = "wss://socket.india.delta.exchange"
    DELTA_TESTNET_WS: str = "wss://testnet-socket.delta.exchange"

    # ─── TradingView webhook ─────────────────────────────────────
    TV_WEBHOOK_SECRET: str = ""   # shared token validated by /webhook/tradingview

    # ─── Supplementary ──────────────────────────────────────────
    COINGLASS_API_KEY: SecretStr = SecretStr("")
    CRYPTOPANIC_API_KEY: SecretStr = SecretStr("")

    # ─── Platform ────────────────────────────────────────────────
    TOTAL_CAPITAL_INR: float = 200_000
    MAX_POSITION_PCT: float = 10
    MAX_CRYPTO_PCT: float = 30

    # ─── Validators ──────────────────────────────────────────────
    @field_validator("ENCRYPTION_KEY")
    @classmethod
    def _validate_encryption_key(cls, v: SecretStr) -> SecretStr:
        raw = v.get_secret_value()
        if not raw:
            # Allowed only in dev — production check happens in
            # `_validate_production_requirements` below
            return v
        try:
            key_bytes = bytes.fromhex(raw)
        except ValueError as e:
            raise ValueError(
                "ENCRYPTION_KEY must be a valid hex string. "
                "Generate with: python -c \"import secrets; print(secrets.token_hex(32))\""
            ) from e
        if len(key_bytes) != 32:
            raise ValueError(
                f"ENCRYPTION_KEY must decode to 32 bytes (got {len(key_bytes)})."
            )
        return v

    @model_validator(mode="after")
    def _validate_production_requirements(self) -> "Settings":
        if self.ENVIRONMENT == "prod":
            required: list[tuple[str, str]] = [
                ("SUPABASE_URL", self.SUPABASE_URL),
                ("SUPABASE_KEY", self.SUPABASE_KEY),
                ("SUPABASE_SERVICE_KEY", self.SUPABASE_SERVICE_KEY.get_secret_value()),
                ("ENCRYPTION_KEY", self.ENCRYPTION_KEY.get_secret_value()),
                ("UPSTASH_REDIS_REST_URL", self.UPSTASH_REDIS_REST_URL),
                (
                    "UPSTASH_REDIS_REST_TOKEN",
                    self.UPSTASH_REDIS_REST_TOKEN.get_secret_value(),
                ),
            ]
            missing = [name for name, val in required if not val]
            if missing:
                raise RuntimeError(
                    "ENVIRONMENT=prod requires these env vars: "
                    + ", ".join(missing)
                )
            # Reject wildcard CORS in prod
            origins = [o.strip() for o in self.CORS_ALLOWED_ORIGINS.split(",")]
            if "*" in origins:
                raise RuntimeError(
                    "CORS_ALLOWED_ORIGINS cannot contain '*' in production. "
                    "Specify explicit origins."
                )
        return self

    # ─── Derived views ───────────────────────────────────────────
    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ALLOWED_ORIGINS.split(",") if o.strip()]

    @property
    def is_prod(self) -> bool:
        return self.ENVIRONMENT == "prod"

    @property
    def delta_active_base_url(self) -> str:
        return self.DELTA_TESTNET_URL if self.PAPER_TRADING else self.DELTA_BASE_URL

    @property
    def delta_active_ws_url(self) -> str:
        return self.DELTA_TESTNET_WS if self.PAPER_TRADING else self.DELTA_WS_URL


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Singleton accessor used across the codebase."""
    return Settings()


# ─── Legacy module-level exports ─────────────────────────────────
# Kept so existing imports continue to work without churn.
_s = get_settings()

ENVIRONMENT = _s.ENVIRONMENT
LOG_LEVEL = _s.LOG_LEVEL
PAPER_TRADING = _s.PAPER_TRADING

SUPABASE_URL = _s.SUPABASE_URL
SUPABASE_KEY = _s.SUPABASE_KEY
SUPABASE_SERVICE_KEY = _s.SUPABASE_SERVICE_KEY.get_secret_value()
UPSTASH_REDIS_REST_URL = _s.UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN = _s.UPSTASH_REDIS_REST_TOKEN.get_secret_value()

AZURE_OPENAI_API_KEY = _s.AZURE_OPENAI_API_KEY.get_secret_value()
AZURE_OPENAI_ENDPOINT = _s.AZURE_OPENAI_ENDPOINT
AZURE_OPENAI_API_VERSION = _s.AZURE_OPENAI_API_VERSION
AZURE_OPENAI_DEPLOYMENT = _s.AZURE_OPENAI_DEPLOYMENT
OLLAMA_BASE_URL = _s.OLLAMA_BASE_URL
OLLAMA_MODEL = _s.OLLAMA_MODEL

TELEGRAM_BOT_TOKEN = _s.TELEGRAM_BOT_TOKEN.get_secret_value()
TELEGRAM_CHAT_ID = _s.TELEGRAM_CHAT_ID

GROWW_API_KEY = _s.GROWW_API_KEY.get_secret_value()
GROWW_API_SECRET = _s.GROWW_API_SECRET.get_secret_value()
GROWW_TOTP_SECRET = _s.GROWW_TOTP_SECRET.get_secret_value()
GROWW_ACCESS_TOKEN = _s.GROWW_ACCESS_TOKEN.get_secret_value()

DELTA_API_KEY = _s.DELTA_API_KEY.get_secret_value()
DELTA_API_SECRET = _s.DELTA_API_SECRET.get_secret_value()
DELTA_TESTNET_API_KEY = _s.DELTA_TESTNET_API_KEY.get_secret_value()
DELTA_TESTNET_API_SECRET = _s.DELTA_TESTNET_API_SECRET.get_secret_value()
DELTA_BASE_URL = _s.DELTA_BASE_URL
DELTA_TESTNET_URL = _s.DELTA_TESTNET_URL
DELTA_WS_URL = _s.DELTA_WS_URL
DELTA_TESTNET_WS = _s.DELTA_TESTNET_WS

TV_WEBHOOK_SECRET = _s.TV_WEBHOOK_SECRET

COINGLASS_API_KEY = _s.COINGLASS_API_KEY.get_secret_value()
CRYPTOPANIC_API_KEY = _s.CRYPTOPANIC_API_KEY.get_secret_value()

TOTAL_CAPITAL_INR = _s.TOTAL_CAPITAL_INR
MAX_POSITION_PCT = _s.MAX_POSITION_PCT
MAX_CRYPTO_PCT = _s.MAX_CRYPTO_PCT

# ─── Hard-coded platform lists (unchanged from v2) ───────────────
LLM_PRIMARY = "azure:gpt-4o"   # Azure OpenAI deployment
LLM_FALLBACK = "ollama"        # Local Ollama fallback

INDIA_WATCHLIST = [
    # ── Nifty 50 constituents ────────────────────────────────────────
    # Banking & Financial Services
    "HDFCBANK.NS", "ICICIBANK.NS", "SBIN.NS", "KOTAKBANK.NS", "AXISBANK.NS",
    "BAJFINANCE.NS", "BAJAJFINSV.NS", "INDUSINDBK.NS", "SBILIFE.NS", "HDFCLIFE.NS",
    # IT & Technology
    "TCS.NS", "INFY.NS", "WIPRO.NS", "HCLTECH.NS", "TECHM.NS",
    # Energy & Oil
    "RELIANCE.NS", "ONGC.NS", "BPCL.NS", "COALINDIA.NS", "NTPC.NS", "POWERGRID.NS",
    # Consumer & FMCG
    "HINDUNILVR.NS", "ITC.NS", "NESTLEIND.NS", "BRITANNIA.NS", "TATACONSUM.NS",
    # Auto & Ancillaries
    "MARUTI.NS", "TVSMOTOR.NS", "M&M.NS", "EICHERMOT.NS", "HEROMOTOCO.NS", "BAJAJ-AUTO.NS",
    # Pharma & Healthcare
    "SUNPHARMA.NS", "CIPLA.NS", "DRREDDY.NS", "DIVISLAB.NS", "APOLLOHOSP.NS",
    # Metals & Mining
    "JSWSTEEL.NS", "TATASTEEL.NS", "HINDALCO.NS",
    # Cement & Infrastructure
    "ULTRACEMCO.NS", "SHREECEM.NS", "GRASIM.NS", "LT.NS", "ADANIPORTS.NS",
    # Consumer & Retail
    "ASIANPAINT.NS", "TITAN.NS",
    # Conglomerates
    "ADANIENT.NS", "BEL.NS",
    # ── Sector leaders not in Nifty 50 ──────────────────────────────
    # IT Mid-cap
    "LTTS.NS", "PERSISTENT.NS", "MPHASIS.NS",
    # Pharma Mid-cap
    "LUPIN.NS", "TORNTPHARM.NS", "BIOCON.NS",
    # FMCG Mid-cap
    "GODREJCP.NS", "DABUR.NS", "MARICO.NS",
    # Banking Mid-cap
    "FEDERALBNK.NS", "BANDHANBNK.NS",
    # Auto Ancillaries
    "BALKRISIND.NS", "MOTHERSON.NS",
    # Real Estate
    "DLF.NS", "OBEROIRLTY.NS",
    # Infrastructure / Capital Goods
    "BHEL.NS", "SIEMENS.NS",
    # Chemicals & Specialty
    "PIDILITIND.NS", "BERGEPAINT.NS",
    # New-age / Digital
    "ETERNAL.NS", "NYKAA.NS",
    # Retail
    "TRENT.NS", "DMART.NS",
]
INDIA_INDICES = ["^NSEI", "^NSEBANK", "^CNXIT", "^NSMIDCP", "^INDIAVIX"]
FNO_SYMBOLS = [
    "NIFTY", "BANKNIFTY", "FINNIFTY",
    "RELIANCE", "HDFCBANK", "TCS", "ICICIBANK", "INFY",
    "BAJFINANCE", "SBIN", "WIPRO", "MARUTI", "ITC",
]
CRYPTO_WATCHLIST = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "AVAXUSDT"]
CRYPTO_PERP_PAIRS = [f"{s}PERP" if not s.endswith("PERP") else s for s in CRYPTO_WATCHLIST]

MIN_TECHNICAL_SCORE_FOR_DEBATE = 6.0
MIN_PATTERN_SUCCESS_RATE = 0.70
MIN_RR_RATIO = 2.0
MAX_INDIA_VIX_FOR_LONGS = 25.0
MIN_BEAR_DAYS_TO_EARNINGS = 3

IST_TIMEZONE = "Asia/Kolkata"
INDIA_MARKET_OPEN = "09:15"
INDIA_MARKET_CLOSE = "15:30"
REDIS_STATE_TTL_SECONDS = 7200  # 2 hours — covers the gap between scheduled data runs
DEBATE_MAX_ROUNDS = 2
MAX_CONCURRENT_DEBATES = 3

# ─── Multi-Timeframe (MTF) Analysis ──────────────────────────────
# Top-down cascade: 1D → 4H → 1H → 15m → 5m → entry on 3m/1m
#
# Hard gate: 1D AND 4H must both be bullish for a GO signal.
# If only 1D bullish → WATCH.  1D + 4H + 1H aligned → HIGH conviction.

MTF_TIMEFRAMES = ["1d", "4h", "1h", "15m", "5m"]

# Contribution weight of each TF to the composite MTF alignment score
MTF_WEIGHTS: dict = {
    "1d":  0.35,
    "4h":  0.30,
    "1h":  0.20,
    "15m": 0.10,
    "5m":  0.05,
}

# Numeric value assigned to each bias label for alignment arithmetic
MTF_BIAS_VALUE: dict = {
    "strong_bullish": 2.0,
    "bullish":        1.0,
    "neutral":        0.0,
    "bearish":       -1.0,
    "strong_bearish":-2.0,
}

# These two TFs MUST both be >= "bullish" for a GO signal (hard gate)
MTF_REQUIRED_ALIGNED_TFS = ("1d", "4h")

# yfinance fetch config for India lower TFs (4H is resampled from 1H)
MTF_INDIA_FETCH: dict = {
    "4h":  {"period": "60d",  "interval": "1h",  "resample": "4h", "min_bars": 30},
    "1h":  {"period": "60d",  "interval": "1h",  "resample": None,  "min_bars": 40},
    "15m": {"period": "7d",   "interval": "15m", "resample": None,  "min_bars": 50},
    "5m":  {"period": "3d",   "interval": "5m",  "resample": None,  "min_bars": 50},
}

# Delta Exchange resolution strings for crypto lower TFs
MTF_CRYPTO_FETCH: dict = {
    "4h":  {"resolution": "4h",  "limit": 120},
    "1h":  {"resolution": "1h",  "limit": 120},
    "15m": {"resolution": "15m", "limit": 100},
    "5m":  {"resolution": "5m",  "limit": 100},
}
