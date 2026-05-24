"""
data/delta_client.py
─────────────────────────────────────────────────────
Delta Exchange India API client — crypto futures, perps, options.
India endpoint: https://api.india.delta.exchange
WebSocket:      wss://socket.india.delta.exchange
Testnet:        https://testnet-api.delta.exchange  (use when PAPER_TRADING=true)

FREE API — no subscription cost for market data.
API key required only for placing orders.

Products on Delta India:
  Perpetual Futures:  BTCUSD, ETHUSD, SOLUSDT, BNBUSD ...
  Options:            C-BTC-90000-310125 (Call), P-BTC-90000-310125 (Put)
  Dated Futures:      BTCUSD-DD-MMM-YY format

Testnet signup: https://testnet.delta.exchange
Live account:   https://www.delta.exchange
"""
from __future__ import annotations
import asyncio
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional
import aiohttp
import requests
from loguru import logger
from tenacity import retry, stop_after_attempt, wait_exponential

from core.config import (
    DELTA_API_KEY, DELTA_API_SECRET, DELTA_BASE_URL,
    DELTA_WS_URL, DELTA_TESTNET_URL, DELTA_TESTNET_WS,
    PAPER_TRADING,
)
from core.state_store import state

# ─── Active endpoint (testnet if paper trading) ───────────────────
# Module-level defaults — used only by the singleton (delta_rest).
# Per-user clients created by broker_factory pass credentials directly
# via DeltaRestClient constructor kwargs, bypassing these constants.
_BASE = DELTA_TESTNET_URL if PAPER_TRADING else DELTA_BASE_URL
_WS   = DELTA_TESTNET_WS  if PAPER_TRADING else DELTA_WS_URL

logger.info(f"Delta Exchange: using {'TESTNET' if PAPER_TRADING else 'LIVE'} — {_BASE}")

# ─── Delta Exchange India — instrument constants ──────────────────
# Perpetual symbol format (India): BTCUSD, ETHUSD, SOLUSDT
DELTA_PERPS = {
    "BTC":  "BTCUSD",
    "ETH":  "ETHUSD",
    "SOL":  "SOLUSDT",
    "BNB":  "BNBUSD",
    "AVAX": "AVAXUSD",
    "XRP":  "XRPUSD",
}
# Options format: C-BTC-90000-310125 or P-ETH-2500-280225
DELTA_INDIA_BASE = "https://api.india.delta.exchange"

# ─── Module-level products cache — keyed by base_url ─────────────
# Avoids a 200 ms+ HTTP fetch on every bot order cycle.
# Products list changes rarely; 5-minute TTL is safe.
_PRODUCTS_CACHE: dict[str, tuple[float, list]] = {}  # base_url -> (ts, products)
_PRODUCTS_TTL = 300  # seconds


# ─── Signature generator ─────────────────────────────────────────

def _sign(method: str, path: str, body: str = "",
          api_key: str = None, api_secret: str = None) -> dict:
    """Generate HMAC-SHA256 signature headers for Delta Exchange."""
    key    = api_key    or DELTA_API_KEY
    secret = api_secret or DELTA_API_SECRET
    ts  = str(int(time.time()))
    msg = method.upper() + ts + path + body
    sig = hmac.new(
        secret.encode(),
        msg.encode(),
        hashlib.sha256,
    ).hexdigest()
    return {
        "api-key":   key,
        "timestamp": ts,
        "signature": sig,
        "Content-Type": "application/json",
    }


# ─── REST client ─────────────────────────────────────────────────

class DeltaRestClient:
    """Thin REST wrapper for Delta Exchange India API."""

    def __init__(self, api_key: str = None, api_secret: str = None,
                 base_url: str = None, paper: bool = None):
        # Per-user credentials override module-level defaults.
        self._api_key    = api_key    or DELTA_API_KEY
        self._api_secret = api_secret or DELTA_API_SECRET
        self._base       = base_url   or _BASE
        # paper flag: explicit arg > module-level default
        self._paper      = paper if paper is not None else PAPER_TRADING
        self._session    = requests.Session()
        self._session.headers.update({"Accept": "application/json"})
        logger.info(
            f"DeltaRestClient init: {'TESTNET' if self._paper else 'LIVE'} — {self._base}"
        )

    # ── Public endpoints (no auth) ────────────────────────────────

    def get_products(self, contract_types: str = "perpetual_futures") -> list[dict]:
        """
        Fetch all listed products. Results are cached for 5 minutes per base URL
        so repeated bot-cycle calls never hit the network.
        contract_types: perpetual_futures | call_options | put_options |
                        futures | move_options
        """
        cache_key = f"{self._base}:{contract_types}"
        cached = _PRODUCTS_CACHE.get(cache_key)
        if cached:
            ts, products = cached
            if time.time() - ts < _PRODUCTS_TTL:
                return products
        resp = self._get("/v2/products", {"contract_types": contract_types})
        products = resp.get("result", [])
        if products:
            _PRODUCTS_CACHE[cache_key] = (time.time(), products)
        return products

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=8))
    def get_ticker(self, symbol: str) -> dict:
        """Fetch live ticker for a single product (e.g. BTCUSD)."""
        resp = self._get("/v2/tickers", {"contract_types": "perpetual_futures"})
        for t in resp.get("result", []):
            if t.get("symbol") == symbol:
                return t
        return {}

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=8))
    def get_all_tickers(self) -> list[dict]:
        """Fetch tickers for all perps + futures."""
        resp = self._get("/v2/tickers", {
            "contract_types": "perpetual_futures,futures"
        })
        return resp.get("result", [])

    def get_option_chain(self, underlying: str, expiry_date: str) -> list[dict]:
        """
        Fetch option chain with Greeks.
        underlying:  "BTC" | "ETH" | "SOL"
        expiry_date: "26-10-2025" (DD-MM-YYYY)
        """
        resp = self._get("/v2/tickers", {
            "contract_types": "call_options,put_options",
            "underlying_asset_symbols": underlying,
            "expiry_date": expiry_date,
        })
        return resp.get("result", [])

    def get_orderbook(self, symbol: str, depth: int = 5) -> dict:
        """Fetch L2 order book for a product."""
        resp = self._get(f"/v2/l2orderbook/{symbol}", {"depth": depth})
        return resp.get("result", {})

    def get_candlestick(self, symbol: str, resolution: str = "1D",
                        start: int = None, end: int = None) -> list[dict]:
        """
        Fetch OHLCV candlestick history.
        symbol:     product symbol e.g. "BTCUSD"
        resolution: 1m | 3m | 5m | 15m | 30m | 1h | 2h | 4h | 6h | 1D
        start/end:  Unix timestamps (seconds)
        """
        params: dict[str, Any] = {"symbol": symbol, "resolution": resolution}
        if start:
            params["start"] = start
        if end:
            params["end"] = end
        resp = self._get("/v2/history/candles", params)
        raw  = resp.get("result", [])
        candles = []
        for c in raw:
            candles.append({
                "timestamp": datetime.utcfromtimestamp(c.get("time", 0)).isoformat(),
                "open":      float(c.get("open", 0)),
                "high":      float(c.get("high", 0)),
                "low":       float(c.get("low", 0)),
                "close":     float(c.get("close", 0)),
                "volume":    float(c.get("volume", 0)),
            })
        return candles

    def get_funding_rate(self, symbol: str) -> dict:
        """Fetch current + predicted funding rate for a perp."""
        resp = self._get(f"/v2/products/{symbol}/funding_rate")
        return resp.get("result", {})

    def get_all_funding_rates(self) -> dict[str, float]:
        """Read funding rates from ticker data — already fetched, no extra calls needed."""
        rates = {}
        try:
            for t in self.get_all_tickers():
                sym = t.get("symbol", "")
                if sym in DELTA_PERPS.values():
                    raw = t.get("funding_rate", 0)
                    rates[sym] = round(float(raw or 0) * 100, 6)
        except Exception as e:
            logger.debug(f"Funding rates from tickers failed: {e}")
        return rates

    def get_open_interest(self) -> dict[str, float]:
        """Fetch open interest for all tracked perps."""
        tickers = self.get_all_tickers()
        oi      = {}
        for t in tickers:
            sym = t.get("symbol", "")
            if sym in DELTA_PERPS.values():
                oi[sym] = float(t.get("oi", 0) or 0)
        return oi

    def get_mark_price(self, symbol: str) -> float:
        """Fetch mark price for a product."""
        ticker = self.get_ticker(symbol)
        return float(ticker.get("mark_price", 0))

    def get_indices(self) -> list[dict]:
        """Fetch Delta spot price indices (underlying for futures)."""
        resp = self._get("/v2/indices")
        return resp.get("result", [])

    # ── Authenticated endpoints (order management) ─────────────────

    def get_orders(self, state: str = "open", page_size: int = 50) -> list[dict]:
        """Get orders from Delta Exchange (state: open | closed | cancelled)."""
        if self._paper:
            return []
        resp = self._get_auth("GET", f"/v2/orders?state={state}&page_size={page_size}")
        return resp.get("result", [])

    def get_positions(self) -> list[dict]:
        """Get all open positions."""
        if self._paper:
            return []
        resp = self._get_auth("GET", "/v2/positions/margined")
        return resp.get("result", [])

    def get_wallet_balance(self) -> dict:
        """Get wallet balances (USDT, BTC etc.)."""
        if self._paper:
            return {"USDT": {"balance": "paper_mode"}}
        resp = self._get_auth("GET", "/v2/wallet/balances")
        return {
            b.get("asset_symbol"): b
            for b in resp.get("result", [])
        }

    def place_order(self, product_id: int, side: str, size: int,
                    order_type: str = "market_order",
                    limit_price: float = None,
                    stop_loss: float = None,
                    take_profit: float = None,
                    reduce_only: bool = False) -> dict:
        """
        Place a futures/options order on Delta Exchange India.

        product_id: integer from get_products() response
        side:       "buy" | "sell"
        size:       number of contracts
        order_type: "market_order" | "limit_order" | "stop_loss_order"

        Raises RuntimeError if Delta API returns success=false so callers
        can distinguish a rejected order from a network failure.
        """
        # Place bracket order (with SL + TP) when either is provided
        if stop_loss or take_profit:
            return self._place_bracket_order(
                product_id, side, size, order_type,
                limit_price, stop_loss, take_profit)

        body: dict[str, Any] = {
            "product_id":  product_id,
            "side":        side,
            "size":        size,
            "order_type":  order_type,
            "reduce_only": reduce_only,
        }
        if limit_price and order_type == "limit_order":
            body["limit_price"] = str(round(limit_price, 2))

        resp = self._post_auth("/v2/orders", body)
        if not resp.get("success"):
            err = resp.get("error", {})
            code = err.get("code", "unknown") if isinstance(err, dict) else str(err)
            ctx  = err.get("context", {}) if isinstance(err, dict) else {}
            msg  = ctx.get("message") or str(ctx) if ctx else str(err)
            raise RuntimeError(f"Delta order rejected [{code}]: {msg}")

        result = resp.get("result", {})
        logger.info(
            f"✓ Delta {'LIVE' if not self._paper else 'TESTNET'} order placed: "
            f"{side.upper()} {size}× product {product_id} "
            f"| id={result.get('id')} avg_px={result.get('average_fill_price', '—')}"
        )
        result["paper"] = self._paper
        return result

    def _place_bracket_order(self, product_id: int, side: str, size: int,
                             order_type: str, price: float,
                             stop_loss: float, take_profit: float) -> dict:
        """Place an order with embedded SL and TP via Delta's bracket endpoint."""
        # First place the entry order
        entry_body: dict[str, Any] = {
            "product_id": product_id,
            "side":       side,
            "size":       size,
            "order_type": order_type,
        }
        if price and order_type == "limit_order":
            entry_body["limit_price"] = str(round(price, 2))

        entry_resp = self._post_auth("/v2/orders", entry_body)
        if not entry_resp.get("success"):
            err = entry_resp.get("error", {})
            code = err.get("code", "unknown") if isinstance(err, dict) else str(err)
            ctx  = err.get("context", {}) if isinstance(err, dict) else {}
            msg  = ctx.get("message") or str(ctx) if ctx else str(err)
            raise RuntimeError(f"Delta entry order rejected [{code}]: {msg}")

        entry_result = entry_resp.get("result", {})
        order_id = entry_result.get("id")
        logger.info(
            f"✓ Delta entry order placed: {side.upper()} {size}× product {product_id} "
            f"| id={order_id}"
        )

        # Attach bracket (SL/TP) to the placed order
        if order_id and (stop_loss or take_profit):
            bracket_body: dict[str, Any] = {"order_id": order_id}
            if stop_loss:
                bracket_body["stop_loss_order"] = {
                    "order_type": "market_order",
                    "stop_price": str(round(stop_loss, 2)),
                    "bracket_stop_trigger_method": "last_traded_price",
                }
            if take_profit:
                bracket_body["take_profit_order"] = {
                    "order_type": "market_order",
                    "stop_price": str(round(take_profit, 2)),
                    "bracket_stop_trigger_method": "last_traded_price",
                }
            self._post_auth("/v2/orders/bracket", bracket_body)
            logger.info(f"  Bracket attached: SL={stop_loss} TP={take_profit}")

        entry_result["paper"] = self._paper
        return entry_result

    def set_leverage(self, product_id: int, leverage: float) -> dict:
        """
        Set leverage for a product before placing a futures order.
        Delta Exchange India: POST /v2/products/{product_id}/orders/leverage
        """
        resp = self._post_auth(
            f"/v2/products/{product_id}/orders/leverage",
            {"leverage": str(int(leverage))},
        )
        logger.info(f"✓ Delta leverage set: {leverage}× for product {product_id}")
        return resp.get("result", resp)

    def cancel_order(self, order_id: int, product_id: int) -> dict:
        """Cancel an open order."""
        body = {"id": order_id, "product_id": product_id}
        return self._delete_auth("/v2/orders", body)

    def close_position(self, product_id: int) -> dict:
        """Close entire position for a product at market price using a reduce_only market order."""
        # Fetch current position to determine side and size
        pos_resp = self._get_auth("GET", "/v2/positions/margined")
        positions = pos_resp.get("result", [])
        pos = next((p for p in positions if p.get("product_id") == product_id), None)
        if not pos:
            return {"error": "no_open_position", "product_id": product_id}
        size = abs(int(pos.get("size", 0)))
        if size == 0:
            return {"error": "position_size_zero", "product_id": product_id}
        # Positive size = long (close with sell), negative = short (close with buy)
        close_side = "sell" if int(pos.get("size", 0)) > 0 else "buy"
        resp = self._post_auth("/v2/orders", {
            "product_id": product_id,
            "side": close_side,
            "size": size,
            "order_type": "market_order",
            "reduce_only": True,
        })
        if resp.get("success"):
            r = resp.get("result", {})
            logger.info(f"✓ Delta position closed: product={product_id} fill={r.get('average_fill_price')}")
        return resp.get("result", resp)

    # ── Helpers ───────────────────────────────────────────────────

    def _get(self, path: str, params: dict = None) -> dict:
        try:
            resp = self._session.get(
                f"{self._base}{path}", params=params, timeout=10)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Delta GET {path} failed: {e}")
            return {}

    def _get_auth(self, method: str, path: str) -> dict:
        headers = _sign(method, path,
                        api_key=self._api_key, api_secret=self._api_secret)
        try:
            resp = self._session.get(
                f"{self._base}{path}", headers=headers, timeout=10)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Delta auth GET {path} failed: {e}")
            return {}

    def _post_auth(self, path: str, body: dict) -> dict:
        body_str = json.dumps(body)
        headers  = _sign("POST", path, body_str,
                         api_key=self._api_key, api_secret=self._api_secret)
        try:
            resp = self._session.post(
                f"{self._base}{path}", headers=headers,
                data=body_str, timeout=10)
            # Always read JSON first — Delta returns structured errors even on 4xx
            try:
                data = resp.json()
            except Exception:
                data = {}
            if not resp.ok:
                logger.error(
                    f"Delta POST {path} HTTP {resp.status_code}: {data}"
                )
                # Ensure callers get a structured error they can inspect
                if not data:
                    data = {
                        "success": False,
                        "error": {
                            "code": str(resp.status_code),
                            "context": {"message": resp.text[:500]},
                        },
                    }
                elif "success" not in data:
                    data["success"] = False
                return data
            return data
        except Exception as e:
            logger.error(f"Delta POST {path} failed: {e}")
            return {}

    def _delete_auth(self, path: str, body: dict) -> dict:
        body_str = json.dumps(body)
        headers  = _sign("DELETE", path, body_str,
                         api_key=self._api_key, api_secret=self._api_secret)
        try:
            resp = self._session.delete(
                f"{self._base}{path}", headers=headers,
                data=body_str, timeout=10)
            try:
                data = resp.json()
            except Exception:
                data = {}
            if not resp.ok:
                logger.error(f"Delta DELETE {path} HTTP {resp.status_code}: {data}")
                if "success" not in data:
                    data["success"] = False
                return data
            return data
        except Exception as e:
            logger.error(f"Delta DELETE {path} failed: {e}")
            return {}


# ─── WebSocket Stream ─────────────────────────────────────────────

class DeltaWebSocketStream:
    """
    Real-time market data via Delta Exchange India WebSocket.
    Handles authenticated + public channels.

    Channels:
      v2/ticker        — live price, mark price, OI, funding rate
      v2/candlestick   — OHLCV candles (1m, 5m, 1h, 1D)
      v2/l2orderbook   — order book depth
    """

    def __init__(self, on_tick: Optional[Callable] = None):
        self.on_tick  = on_tick or self._default_handler
        self._running = False
        self._ws      = None

    async def start(self, symbols: list[str] = None) -> None:
        """Connect and subscribe to ticker streams for given symbols."""
        self._running = True
        symbols = symbols or list(DELTA_PERPS.values())

        logger.info(f"▶ Delta WebSocket — connecting ({len(symbols)} symbols)")

        while self._running:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(
                        _WS, heartbeat=25, receive_timeout=45
                    ) as ws:
                        self._ws = ws
                        # Authenticate if keys available
                        if DELTA_API_KEY and DELTA_API_SECRET:
                            await self._authenticate(ws)
                        # Subscribe to tickers
                        await ws.send_str(json.dumps({
                            "type": "subscribe",
                            "payload": {
                                "channels": [
                                    {
                                        "name": "v2/ticker",
                                        "symbols": symbols,
                                    },
                                    {
                                        "name": "v2/candlestick",
                                        "symbols": [
                                            f"{s}_{r}"
                                            for s in symbols
                                            for r in ["1h", "1D"]
                                        ],
                                    }
                                ]
                            }
                        }))
                        logger.info("✓ Delta WebSocket subscribed")

                        async for msg in ws:
                            if not self._running:
                                break
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await self._handle(msg.data)

            except Exception as e:
                logger.warning(f"Delta WS disconnected: {e}. Reconnecting in 5s...")
                await asyncio.sleep(5)

    async def stop(self) -> None:
        self._running = False
        if self._ws:
            await self._ws.close()

    async def _authenticate(self, ws) -> None:
        ts  = str(int(time.time()))
        sig = hmac.new(
            DELTA_API_SECRET.encode(),
            f"GET{ts}/live".encode(),
            hashlib.sha256,
        ).hexdigest()
        await ws.send_str(json.dumps({
            "type": "key-auth",
            "payload": {
                "api-key":   DELTA_API_KEY,
                "signature": sig,
                "timestamp": ts,
            }
        }))

    async def _handle(self, raw: str) -> None:
        try:
            data = json.loads(raw)
            msg_type = data.get("type", "")

            if msg_type == "v2/ticker":
                symbol = data.get("symbol", "")
                tick   = _parse_delta_ticker(data)
                state.write_market_data("crypto", symbol, tick)
                await self.on_tick(symbol, tick)
                # Push immediately to all frontend WS clients (thread-safe)
                try:
                    from core.event_bus import emit_ticker
                    emit_ticker(symbol, tick.get("ltp"), tick.get("change_pct", 0))
                except Exception:
                    pass

            elif msg_type == "subscriptions":
                logger.debug(f"Delta subscriptions confirmed: {data}")

        except Exception as e:
            logger.error(f"Delta WS parse error: {e}")

    async def _default_handler(self, symbol: str, tick: dict) -> None:
        logger.debug(
            f"  Δ {symbol}: ${tick.get('ltp', 0):,.2f}  "
            f"Mark: ${tick.get('mark_price', 0):,.2f}  "
            f"Funding: {tick.get('funding_rate', 0):.4f}%"
        )


def _parse_delta_ticker(data: dict) -> dict:
    """Parse Delta Exchange ticker message into standard format."""
    return {
        "symbol":        data.get("symbol", ""),
        "timestamp":     datetime.now(timezone.utc).isoformat(),
        "ltp":           float(data.get("close", 0)),   # last traded price
        "mark_price":    float(data.get("mark_price", 0)),
        "index_price":   float(data.get("spot_price", 0)),
        "open":          float(data.get("open", 0)),
        "high":          float(data.get("high", 0)),
        "low":           float(data.get("low", 0)),
        "close":         float(data.get("close", 0)),
        "volume":        float(data.get("volume", 0)),
        "oi":            float(data.get("oi", 0)),
        "oi_value":      float(data.get("oi_value", 0)),
        "funding_rate":  float(data.get("funding_rate", 0)),
        "turnover":      float(data.get("turnover", 0)),
        "change_pct":    float(data.get("change", 0)),
        "greeks": {
            "delta": data.get("greeks", {}).get("delta"),
            "gamma": data.get("greeks", {}).get("gamma"),
            "theta": data.get("greeks", {}).get("theta"),
            "vega":  data.get("greeks", {}).get("vega"),
        } if data.get("greeks") else None,
    }


# ─── Snapshot builder ─────────────────────────────────────────────

def build_delta_snapshot() -> dict:
    """
    Full crypto snapshot for the CryptoSentimentOnChainAgent.
    Runs every 15 minutes.
    """
    logger.info("▶ Delta Exchange snapshot — fetching")
    client  = DeltaRestClient()
    tickers = client.get_all_tickers()
    funding = client.get_all_funding_rates()
    oi      = client.get_open_interest()

    snap = {
        "timestamp":    datetime.now(timezone.utc).isoformat(),
        "exchange":     "delta_india",
        "tickers":      {},
        "funding":      funding,
        "open_interest": oi,
    }

    for t in tickers:
        sym = t.get("symbol", "")
        if not sym:
            continue
        snap["tickers"][sym] = {
            "ltp":         float(t.get("close", 0)),
            "mark_price":  float(t.get("mark_price", 0)),
            "change_pct":  float(t.get("change", 0)),
            "volume":      float(t.get("volume", 0)),
            "oi":          float(t.get("oi", 0)),
            "funding_rate": funding.get(sym, 0),
        }
        # Write each coin to state store
        state.write_market_data("crypto", sym, _parse_delta_ticker(t))

    # Write full snapshot
    state.write_sentiment("crypto", "delta_snapshot", snap)

    btc = snap["tickers"].get("BTCUSD", {})
    eth = snap["tickers"].get("ETHUSD", {})
    logger.info(
        f"✓ Delta snapshot: BTC=${btc.get('ltp', 0):,.0f} "
        f"(funding={funding.get('BTCUSD', 0):.4f}%)  "
        f"ETH=${eth.get('ltp', 0):,.0f}"
    )
    return snap


# ─── Singletons ───────────────────────────────────────────────────
delta_rest = DeltaRestClient()
_ws_stream: Optional[DeltaWebSocketStream] = None


async def start_delta_stream(symbols: list[str] = None) -> None:
    global _ws_stream
    _ws_stream = DeltaWebSocketStream()
    await _ws_stream.start(symbols)


async def stop_delta_stream() -> None:
    global _ws_stream
    if _ws_stream:
        await _ws_stream.stop()


# ─── Quick test ───────────────────────────────────────────────────
if __name__ == "__main__":
    from pprint import pprint

    print("=== Delta Exchange India — public API test ===\n")

    print("Fetching BTC perp ticker...")
    client  = DeltaRestClient()
    tickers = client.get_all_tickers()
    for t in tickers:
        if t.get("symbol") in ("BTCUSD", "ETHUSD", "SOLUSDT"):
            print(
                f"  {t['symbol']:12s}  "
                f"Price: ${float(t.get('close',0)):>10,.2f}  "
                f"OI: {float(t.get('oi',0)):>10,.0f}  "
                f"Funding: {float(t.get('funding_rate',0)):.4f}%"
            )

    print("\nFull snapshot:")
    snap = build_delta_snapshot()
    print(f"  Tracked {len(snap['tickers'])} instruments")
    print(f"  Funding rates: {snap['funding']}")
