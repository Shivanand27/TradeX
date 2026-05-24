"""
data/crypto_market.py
─────────────────────────────────────────────────────
Crypto market data via Binance WebSocket (free, no API key needed).
Also fetches funding rates, OI, Fear & Greed — all free APIs.

Architecture:
  - WebSocket streams for real-time price (24/7)
  - REST API polling for funding rates, OI (every 30 min)
  - alternative.me for Fear & Greed (no key needed)
  - Multi-source RSS for crypto news (no key needed)
  - CoinGecko for trending coins (no key needed)
  - Coinglass for liquidations / long-short ratio (free-tier key optional)
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import time
from datetime import datetime, timezone
from typing import Callable, Optional
import aiohttp
import feedparser
import requests
from loguru import logger
from tenacity import retry, stop_after_attempt, wait_exponential

from core.config import CRYPTO_WATCHLIST, COINGLASS_API_KEY
from core.state_store import state

# ─── Binance endpoints ────────────────────────────────────────────
BINANCE_WS_BASE  = "wss://stream.binance.com:9443/stream"
BINANCE_REST     = "https://api.binance.com/api/v3"
BINANCE_FAPI     = "https://fapi.binance.com/fapi/v1"  # futures
BINANCE_DAPI     = "https://dapi.binance.com/dapi/v1"  # coin-margined

# ─── Free external APIs ───────────────────────────────────────────
FEAR_GREED_URL   = "https://api.alternative.me/fng/?limit=1"
COINGECKO_URL    = "https://api.coingecko.com/api/v3"
COINGLASS_URL    = "https://open-api.coinglass.com/public/v3"

# ─── Free crypto news RSS feeds (no API key) ─────────────────────
CRYPTO_RSS_FEEDS = [
    ("CoinTelegraph", "https://cointelegraph.com/rss"),
    ("CoinDesk",      "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("Decrypt",       "https://decrypt.co/feed"),
    ("The Block",     "https://www.theblock.co/rss.xml"),
    ("NewsBTC",       "https://www.newsbtc.com/feed/"),
    ("AMBCrypto",     "https://ambcrypto.com/feed/"),
    ("CryptoSlate",   "https://cryptoslate.com/feed/"),
]

# Keywords to filter crypto-relevant articles
_CRYPTO_KEYWORDS = {
    "bitcoin", "btc", "ethereum", "eth", "crypto", "blockchain",
    "defi", "altcoin", "solana", "sol", "bnb", "xrp", "ripple",
    "nft", "web3", "stablecoin", "cbdc", "mining", "halving",
    "binance", "coinbase", "exchange", "wallet", "token",
}


# ─── Real-time WebSocket stream ───────────────────────────────────

class BinanceCryptoStream:
    """
    Subscribes to Binance combined stream for multiple symbols.
    Handles reconnection automatically.
    """

    def __init__(self, symbols: list[str],
                 on_tick: Optional[Callable] = None):
        self.symbols   = [s.lower() for s in symbols]
        self.on_tick   = on_tick or self._default_tick_handler
        self._running  = False
        self._ws       = None

    def _stream_url(self) -> str:
        streams = "/".join(f"{s}@ticker" for s in self.symbols)
        return f"{BINANCE_WS_BASE}?streams={streams}"

    async def start(self) -> None:
        """Start streaming. Reconnects on disconnect."""
        self._running = True
        logger.info(f"▶ Binance WebSocket — connecting for {len(self.symbols)} symbols")

        while self._running:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(
                        self._stream_url(),
                        heartbeat=30,
                        receive_timeout=60,
                    ) as ws:
                        self._ws = ws
                        logger.info("✓ Binance WebSocket connected")
                        async for msg in ws:
                            if not self._running:
                                break
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await self._handle_message(msg.data)
                            elif msg.type == aiohttp.WSMsgType.ERROR:
                                logger.error(f"WebSocket error: {ws.exception()}")
                                break
            except Exception as e:
                logger.warning(f"WebSocket disconnected: {e}. Reconnecting in 5s...")
                await asyncio.sleep(5)

    async def stop(self) -> None:
        self._running = False
        if self._ws:
            await self._ws.close()

    async def _handle_message(self, raw: str) -> None:
        try:
            envelope = json.loads(raw)
            data     = envelope.get("data", {})
            if not data:
                return

            symbol = data.get("s", "")  # e.g. "BTCUSDT"
            if not symbol:
                return

            tick = _parse_binance_ticker(data)
            state.write_market_data("crypto", symbol, tick)
            await self.on_tick(symbol, tick)
            # Push immediately to all frontend WS clients (thread-safe)
            # Normalize BTCUSDT → BTCUSD so frontend keys match TickerStrip
            try:
                from core.event_bus import emit_ticker
                frontend_sym = symbol.replace("USDT", "USD")
                emit_ticker(frontend_sym, tick.get("ltp"), tick.get("change_pct", 0))
            except Exception:
                pass

        except Exception as e:
            logger.error(f"WebSocket message parse error: {e}")

    async def _default_tick_handler(self, symbol: str, tick: dict) -> None:
        logger.debug(
            f"  ₿ {symbol}: ${tick['ltp']:,.2f} "
            f"({tick['change_pct']:+.2f}%) Vol×{tick['volume_ratio']:.1f}"
        )


def _parse_binance_ticker(data: dict) -> dict:
    """Parse Binance 24hr ticker stream into our standard format."""
    ltp      = float(data.get("c", 0))  # last price
    open_    = float(data.get("o", 0))
    high     = float(data.get("h", 0))
    low      = float(data.get("l", 0))
    volume   = float(data.get("v", 0))  # base asset volume
    q_volume = float(data.get("q", 0))  # quote volume (USDT)

    return {
        "symbol":       data.get("s", ""),
        "timestamp":    datetime.now(timezone.utc).isoformat(),
        "ltp":          ltp,
        "open":         open_,
        "high":         high,
        "low":          low,
        "close":        ltp,
        "volume":       volume,
        "quote_volume": q_volume,
        "volume_ratio": 1.0,   # computed separately from history
        "change_pct":   float(data.get("P", 0)),
        "trades_count": int(data.get("n", 0)),
        "bid":          float(data.get("b", 0)),
        "ask":          float(data.get("a", 0)),
    }


# ─── REST-based fetchers (run on schedule) ────────────────────────

@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=10))
def fetch_crypto_ohlcv(symbol: str, interval: str = "1d",
                       limit: int = 200) -> list[dict]:
    """
    Fetch OHLCV candlestick data from Binance REST.
    Returns list of dicts with open/high/low/close/volume.
    
    interval: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w
    """
    try:
        resp = requests.get(
            f"{BINANCE_REST}/klines",
            params={"symbol": symbol, "interval": interval, "limit": limit},
            timeout=10,
        )
        resp.raise_for_status()
        candles = []
        for k in resp.json():
            candles.append({
                "timestamp": datetime.utcfromtimestamp(k[0] / 1000).isoformat(),
                "open":      float(k[1]),
                "high":      float(k[2]),
                "low":       float(k[3]),
                "close":     float(k[4]),
                "volume":    float(k[5]),
            })
        return candles
    except Exception as e:
        logger.error(f"fetch_crypto_ohlcv({symbol}, {interval}): {e}")
        return []


def fetch_funding_rates() -> dict[str, float]:
    """
    Fetch current perpetual funding rates from Binance FAPI.
    Returns {symbol: rate_pct} e.g. {"BTCUSDT": 0.0100}
    No API key required for public endpoint.
    """
    try:
        resp = requests.get(
            f"{BINANCE_FAPI}/premiumIndex",
            timeout=10,
        )
        resp.raise_for_status()
        rates = {}
        for item in resp.json():
            sym  = item.get("symbol", "")
            rate = float(item.get("lastFundingRate", 0)) * 100  # to percentage
            if any(s in sym for s in ["BTC", "ETH", "SOL", "BNB", "AVAX"]):
                rates[sym] = round(rate, 6)
        return rates
    except Exception as e:
        logger.error(f"fetch_funding_rates: {e}")
        return {}


def fetch_open_interest() -> dict[str, dict]:
    """Fetch open interest for major perp pairs from Binance FAPI."""
    result = {}
    try:
        for symbol in CRYPTO_WATCHLIST:
            resp = requests.get(
                f"{BINANCE_FAPI}/openInterest",
                params={"symbol": symbol},
                timeout=5,
            )
            if resp.status_code == 200:
                data = resp.json()
                result[symbol] = {
                    "oi":        float(data.get("openInterest", 0)),
                    "timestamp": data.get("time"),
                }
            time.sleep(0.2)  # gentle rate limiting
    except Exception as e:
        logger.error(f"fetch_open_interest: {e}")
    return result


def fetch_fear_greed() -> dict:
    """
    Fetch Crypto Fear & Greed Index from alternative.me.
    Completely free, no API key needed.
    """
    try:
        resp = requests.get(FEAR_GREED_URL, timeout=5)
        resp.raise_for_status()
        data  = resp.json()["data"][0]
        value = int(data["value"])
        signal = (
            "extreme_fear"  if value < 25  else
            "fear"          if value < 45  else
            "neutral"       if value < 55  else
            "greed"         if value < 75  else
            "extreme_greed"
        )
        return {
            "value":       value,
            "signal":      signal,
            "label":       data.get("value_classification", ""),
            "timestamp":   data.get("timestamp", ""),
        }
    except Exception as e:
        logger.error(f"fetch_fear_greed: {e}")
        return {"value": 50, "signal": "neutral", "label": "Neutral"}


def fetch_crypto_news(max_per_source: int = 5, total_limit: int = 30) -> list[dict]:
    """
    Aggregate crypto news from multiple free RSS feeds + CoinGecko trending.
    No API key required. Deduplicates by title hash.
    Sources: CoinTelegraph, CoinDesk, Decrypt, The Block, NewsBTC, AMBCrypto, CryptoSlate.
    """
    seen: set[str] = set()
    items: list[dict] = []

    for source_name, feed_url in CRYPTO_RSS_FEEDS:
        try:
            feed = feedparser.parse(feed_url)
            count = 0
            for entry in feed.entries:
                if count >= max_per_source:
                    break
                title = entry.get("title", "").strip()
                if not title:
                    continue
                # Deduplicate
                title_hash = hashlib.md5(title.lower().encode()).hexdigest()
                if title_hash in seen:
                    continue
                # Filter for crypto relevance (Decrypt covers non-crypto too)
                if not any(kw in title.lower() for kw in _CRYPTO_KEYWORDS):
                    continue
                seen.add(title_hash)
                items.append({
                    "title":     title,
                    "source":    source_name,
                    "sentiment": "neutral",   # LLM will score this downstream
                    "published": entry.get("published", ""),
                    "url":       entry.get("link", ""),
                })
                count += 1
        except Exception as e:
            logger.debug(f"RSS fetch failed for {source_name}: {e}")

    # Append CoinGecko trending as signal (no key needed)
    try:
        resp = requests.get(f"{COINGECKO_URL}/search/trending", timeout=8)
        if resp.ok:
            for coin in resp.json().get("coins", [])[:5]:
                item = coin.get("item", {})
                name = item.get("name", "")
                sym  = item.get("symbol", "")
                rank = item.get("market_cap_rank", "?")
                items.append({
                    "title":     f"Trending: {name} ({sym}) — market cap rank #{rank}",
                    "source":    "CoinGecko Trending",
                    "sentiment": "bullish",
                    "published": datetime.now(timezone.utc).isoformat(),
                    "url":       f"https://www.coingecko.com/en/coins/{item.get('id','')}",
                })
    except Exception as e:
        logger.debug(f"CoinGecko trending fetch failed: {e}")

    logger.info(f"fetch_crypto_news: {len(items)} articles from {len(CRYPTO_RSS_FEEDS)} RSS sources + CoinGecko")
    return items[:total_limit]


def fetch_coinglass_data() -> dict:
    """
    Fetch liquidation + long/short ratio from Coinglass.
    Requires COINGLASS_API_KEY (free tier available at coinglass.com/pricing).
    Returns empty dict gracefully if key not set.
    """
    if not COINGLASS_API_KEY:
        return {}
    headers = {"coinglassSecret": COINGLASS_API_KEY, "accept": "application/json"}
    result  = {}
    try:
        r = requests.get(
            f"{COINGLASS_URL}/futures/longShortAccount",
            params={"symbol": "BTC", "time_type": "h4"},
            headers=headers, timeout=8,
        )
        if r.ok:
            data = r.json().get("data", {})
            result["btc_long_pct"]  = data.get("longAccount", 0)
            result["btc_short_pct"] = data.get("shortAccount", 0)
    except Exception as e:
        logger.debug(f"Coinglass long/short fetch failed: {e}")
    try:
        r = requests.get(
            f"{COINGLASS_URL}/futures/liquidation/chart",
            params={"symbol": "BTC", "range": "h4"},
            headers=headers, timeout=8,
        )
        if r.ok:
            result["btc_liquidations"] = r.json().get("data", [])
    except Exception as e:
        logger.debug(f"Coinglass liquidations fetch failed: {e}")
    return result


def fetch_long_short_ratios() -> dict:
    """
    Fetch global long/short account ratios from Binance FAPI.
    Free endpoint — no API key needed.
    Returns {coin: {long_pct, short_pct}} e.g. {"btc": {long_pct: 60.3, short_pct: 39.7}}
    """
    result = {}
    for sym in ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]:
        try:
            r = requests.get(
                f"{BINANCE_FAPI}/globalLongShortAccountRatio",
                params={"symbol": sym, "period": "4h", "limit": 1},
                timeout=5,
            )
            if r.ok and r.json():
                d   = r.json()[0]
                key = sym.replace("USDT", "").lower()
                result[key] = {
                    "long_pct":  round(float(d.get("longAccount", 0.5)) * 100, 1),
                    "short_pct": round(float(d.get("shortAccount", 0.5)) * 100, 1),
                }
        except Exception as e:
            logger.debug(f"L/S ratio {sym}: {e}")
        time.sleep(0.1)
    return result


def compute_oi_usd(oi_raw: dict) -> dict:
    """
    Convert open interest from contract units to USD by multiplying by mark price.
    oi_raw: {symbol: {oi: float, timestamp: ...}}  (symbol = BTCUSDT etc.)
    """
    result = {}
    for sym, data in oi_raw.items():
        oi_units = data.get("oi", 0)
        tick     = state.read_market_data("crypto", sym) or {}
        price    = tick.get("ltp", 0)
        if oi_units and price:
            oi_usd = oi_units * price
            coin   = sym.replace("USDT", "").lower()
            result[coin] = {
                "oi_usd":   round(oi_usd, 0),
                "oi_units": round(oi_units, 2),
                "price":    price,
            }
    return result


def fetch_btc_dominance() -> float | None:
    """Fetch BTC dominance from CoinGecko (free, no key)."""
    try:
        resp = requests.get(
            "https://api.coingecko.com/api/v3/global",
            timeout=10,
        )
        data = resp.json().get("data", {})
        dom  = data.get("market_cap_percentage", {}).get("btc", 0)
        return round(float(dom), 2)
    except Exception as e:
        logger.error(f"fetch_btc_dominance: {e}")
        return None


# ─── Unified crypto snapshot ──────────────────────────────────────

def build_crypto_onchain_snapshot() -> dict:
    """
    Assemble the full crypto on-chain + derivatives snapshot.
    Called every 15 minutes by CryptoSentimentOnChainAgent.
    """
    logger.info("▶ CryptoSentimentOnChainAgent — fetching")

    funding   = fetch_funding_rates()
    oi        = fetch_open_interest()
    ls_ratios = fetch_long_short_ratios()
    fg        = fetch_fear_greed()
    btc_dom   = fetch_btc_dominance()
    news      = fetch_crypto_news()
    coinglass = fetch_coinglass_data()
    oi_usd    = compute_oi_usd(oi)

    # BTC/ETH ratio
    btc_data = state.read_market_data("crypto", "BTCUSDT") or {}
    eth_data = state.read_market_data("crypto", "ETHUSDT") or {}
    btc_price = btc_data.get("ltp", 0)
    eth_price = eth_data.get("ltp", 0)
    btc_eth_ratio = round(btc_price / eth_price, 4) if eth_price else 0

    snapshot = {
        "timestamp":          datetime.now(timezone.utc).isoformat(),
        "fear_greed":         fg.get("value", 50),
        "fear_greed_signal":  fg.get("signal", "neutral"),
        "btc_dominance_pct":  btc_dom,
        "btc_funding_8h":     funding.get("BTCUSDT", 0),
        "eth_funding_8h":     funding.get("ETHUSDT", 0),
        "sol_funding_8h":     funding.get("SOLUSDT", 0),
        "bnb_funding_8h":     funding.get("BNBUSDT", 0),
        "funding_all":        funding,
        "open_interest":      oi,
        "btc_eth_ratio":      btc_eth_ratio,
        "crypto_news":        news,
        "news_sentiment":     _compute_news_sentiment(news),
        "coinglass":          coinglass,
        "long_short_ratios":  ls_ratios,
        "open_interest_usd":  oi_usd,
    }

    state.write_sentiment("crypto", "global", snapshot)
    logger.info(
        f"✓ Crypto snapshot: F&G={fg['value']} ({fg['signal']}), "
        f"BTC dom={btc_dom}%, BTC funding={funding.get('BTCUSDT', 0):.4f}%"
    )
    return snapshot


# ─── Background WebSocket runner ─────────────────────────────────

_stream: BinanceCryptoStream | None = None


async def start_crypto_stream() -> None:
    """
    Start the persistent Binance WebSocket stream.
    Run this in a background asyncio task.
    """
    global _stream
    _stream = BinanceCryptoStream(CRYPTO_WATCHLIST)
    await _stream.start()


async def stop_crypto_stream() -> None:
    global _stream
    if _stream:
        await _stream.stop()


# ─── Helpers ──────────────────────────────────────────────────────

def _compute_news_sentiment(news: list[dict]) -> float:
    """Compute -1 to +1 sentiment score from news list."""
    if not news:
        return 0.0
    scores = {"bullish": 1, "neutral": 0, "bearish": -1}
    total  = sum(scores.get(n.get("sentiment", "neutral"), 0) for n in news)
    return round(total / len(news), 3)


# ─── Quick test ───────────────────────────────────────────────────

if __name__ == "__main__":
    from pprint import pprint

    print("Testing Fear & Greed...")
    pprint(fetch_fear_greed())

    print("\nTesting funding rates...")
    pprint(fetch_funding_rates())

    print("\nTesting BTC OHLCV (last 5 daily candles)...")
    candles = fetch_crypto_ohlcv("BTCUSDT", "1d", 5)
    for c in candles:
        print(f"  {c['timestamp'][:10]}  O:{c['open']:.0f}  H:{c['high']:.0f}  "
              f"L:{c['low']:.0f}  C:{c['close']:.0f}  V:{c['volume']:.0f}")
