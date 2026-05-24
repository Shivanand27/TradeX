"""
data/groww_client.py
─────────────────────────────────────────────────────
Groww Trade API client for Indian stocks and F&O.
Cost: ₹499 + taxes / month
SDK:  pip install growwapi
Docs: https://groww.in/trade-api/docs/python-sdk

Covers:
  - Live LTP, OHLC, order book depth (stocks + FnO)
  - Place / modify / cancel orders (CASH + FNO segments)
  - Portfolio positions, holdings, margins
  - Option chain with Greeks (NIFTY, BANKNIFTY, stocks)
  - Historical candles for backtesting

Auth flow:
  1. Generate API key + TOTP secret from Groww Cloud dashboard
  2. Use TOTP to get a fresh access_token (valid for 1 day)
  3. Store access_token; refresh daily at 08:00 IST
"""
from __future__ import annotations
import os
import time
from datetime import datetime, date
from typing import Optional
from loguru import logger

from core.config import (
    GROWW_API_KEY, GROWW_API_SECRET, GROWW_TOTP_SECRET,
    GROWW_ACCESS_TOKEN, IST_TIMEZONE,
    INDIA_WATCHLIST, FNO_SYMBOLS,
)
from core.state_store import state
from core.trading_mode import is_paper_trading

# ─── Lazy import (only if growwapi is installed) ──────────────────
try:
    from growwapi import GrowwAPI, GrowwFeed
    import pyotp
    _GROWW_AVAILABLE = True
except ImportError:
    _GROWW_AVAILABLE = False
    logger.warning(
        "growwapi not installed. Run: pip install growwapi pyotp\n"
        "Live India data will fall back to yfinance (15-min delayed)."
    )


class GrowwClient:
    """
    Wrapper around the Groww Python SDK.
    Falls back gracefully to yfinance if SDK not installed or
    if API key not configured.
    """

    def __init__(self):
        self._groww: Optional[GrowwAPI] = None
        self._feed:  Optional[GrowwFeed] = None
        self._connected = False
        self._initialise()

    def _initialise(self):
        if not _GROWW_AVAILABLE:
            return
        if not (GROWW_API_KEY or GROWW_ACCESS_TOKEN):
            logger.warning(
                "Groww API key not set — using yfinance fallback.\n"
                "Subscribe at https://groww.in/trade-api (₹499/month)"
            )
            return
        try:
            token = self._get_access_token()
            if token:
                self._groww   = GrowwAPI(token)
                self._feed    = GrowwFeed(self._groww)
                self._connected = True
                logger.info("✓ Groww API connected")
        except Exception as e:
            logger.error(f"Groww init failed: {e}")

    def _get_access_token(self) -> str | None:
        """Exchange API key + secret (or TOTP) for a Groww session access token."""
        # Pre-generated final token takes priority
        if GROWW_ACCESS_TOKEN:
            return GROWW_ACCESS_TOKEN
        if not GROWW_API_KEY:
            return None
        try:
            totp = pyotp.TOTP(GROWW_TOTP_SECRET).now() if GROWW_TOTP_SECRET else None
            secret = GROWW_API_SECRET if GROWW_API_SECRET else None
            result = GrowwAPI.get_access_token(
                api_key=GROWW_API_KEY,
                secret=secret,
                totp=totp,
            )
            # SDK returns response.json()["token"] — may be str or dict
            token = result if isinstance(result, str) else (
                result.get("accessToken") or result.get("token") or result.get("access_token")
            )
            if token:
                logger.info("✓ Groww access token obtained via API key + secret")
            else:
                logger.error(f"Groww token response has no token field: {result}")
            return token
        except Exception as e:
            logger.error(f"Groww token exchange failed: {e}")
        return None

    @property
    def is_connected(self) -> bool:
        return self._connected and self._groww is not None

    # ─── Live Market Data ─────────────────────────────────────────

    def get_ltp(self, symbols: list[str],
                segment: str = "CASH") -> dict[str, float]:
        """
        Fetch last traded price for up to 50 symbols at once.

        symbols: NSE symbols like ["RELIANCE", "TCS"]
        segment: "CASH" for stocks, "FNO" for derivatives
        Returns: {"RELIANCE": 2456.75, "TCS": 3890.20}
        """
        if not self.is_connected:
            return self._yfinance_ltp_fallback(symbols)

        try:
            ex_symbols = tuple(f"NSE_{s}" for s in symbols)
            resp       = self._groww.get_ltp(
                segment=self._groww.SEGMENT_CASH if segment == "CASH"
                        else self._groww.SEGMENT_FNO,
                exchange_trading_symbols=ex_symbols,
            )
            result = {}
            if resp and isinstance(resp, dict):
                for key, data in resp.items():
                    sym = key.replace("NSE_", "")
                    # SDK returns float directly for LTP, or dict with "ltp" key
                    result[sym] = float(data) if isinstance(data, (int, float)) \
                                  else float(data.get("ltp", 0))
            return result
        except Exception as e:
            logger.error(f"get_ltp failed: {e}")
            return self._yfinance_ltp_fallback(symbols)

    def get_ohlc(self, symbols: list[str],
                 segment: str = "CASH") -> dict[str, dict]:
        """Fetch OHLC + volume for multiple symbols."""
        if not self.is_connected:
            return {}
        try:
            ex_symbols = tuple(f"NSE_{s}" for s in symbols)
            resp       = self._groww.get_ohlc(
                segment=self._groww.SEGMENT_CASH if segment == "CASH"
                        else self._groww.SEGMENT_FNO,
                exchange_trading_symbols=ex_symbols,
            )
            result = {}
            if resp and isinstance(resp, dict):
                for key, data in resp.items():
                    sym = key.replace("NSE_", "")
                    result[sym] = {
                        "open":   float(data.get("open", 0)),
                        "high":   float(data.get("high", 0)),
                        "low":    float(data.get("low", 0)),
                        "close":  float(data.get("close", 0)),
                        "volume": float(data.get("volume", 0)),
                    }
            return result
        except Exception as e:
            logger.error(f"get_ohlc failed: {e}")
            return {}

    def get_historical_candles(self, symbol: str,
                               start: str, end: str,
                               interval: str = "1d",
                               segment: str = "CASH") -> list[dict]:
        """
        Fetch historical OHLCV candles for backtesting.

        symbol:   "RELIANCE" or "NSE-RELIANCE" (Groww format)
        start/end: "YYYY-MM-DD HH:MM:SS"
        interval: "1m","5m","15m","30m","1h","1d"
        """
        if not self.is_connected:
            return []
        try:
            interval_map = {
                "1m":  self._groww.CANDLE_INTERVAL_MIN_1,
                "5m":  self._groww.CANDLE_INTERVAL_MIN_5,
                "15m": self._groww.CANDLE_INTERVAL_MIN_15,
                "30m": self._groww.CANDLE_INTERVAL_MIN_30,
                "1h":  self._groww.CANDLE_INTERVAL_HOUR_1,
                "1d":  self._groww.CANDLE_INTERVAL_DAY,
            }
            groww_sym = f"NSE-{symbol}" if not symbol.startswith("NSE-") else symbol
            resp      = self._groww.get_historical_candles(
                exchange=self._groww.EXCHANGE_NSE,
                segment=(self._groww.SEGMENT_CASH if segment == "CASH"
                         else self._groww.SEGMENT_FNO),
                groww_symbol=groww_sym,
                start_time=start,
                end_time=end,
                candle_interval=interval_map.get(interval,
                                self._groww.CANDLE_INTERVAL_DAY),
            )
            candles = []
            for c in (resp or {}).get("candles", []):
                # Groww format: [timestamp, open, high, low, close, volume, oi]
                candles.append({
                    "timestamp": c[0],
                    "open":      float(c[1]),
                    "high":      float(c[2]),
                    "low":       float(c[3]),
                    "close":     float(c[4]),
                    "volume":    float(c[5]),
                    "oi":        float(c[6]) if len(c) > 6 and c[6] else None,
                })
            return candles
        except Exception as e:
            logger.error(f"get_historical_candles({symbol}): {e}")
            return []

    def get_option_chain(self, underlying: str,
                         expiry_date: str) -> dict:
        """
        Fetch full option chain with Greeks for NIFTY, BANKNIFTY, or stocks.

        underlying:  "NIFTY", "BANKNIFTY", "RELIANCE"
        expiry_date: "2025-11-28"
        """
        if not self.is_connected:
            return {}
        try:
            resp = self._groww.get_option_chain(
                exchange=self._groww.EXCHANGE_NSE,
                underlying=underlying,
                expiry_date=expiry_date,
            )
            return resp or {}
        except Exception as e:
            logger.error(f"get_option_chain({underlying}, {expiry_date}): {e}")
            return {}

    def get_greeks(self, underlying: str, trading_symbol: str,
                   expiry: str) -> dict:
        """Fetch Greeks for a specific FnO contract."""
        if not self.is_connected:
            return {}
        try:
            return self._groww.get_greeks(
                exchange=self._groww.EXCHANGE_NSE,
                underlying=underlying,
                trading_symbol=trading_symbol,
                expiry=expiry,
            ) or {}
        except Exception as e:
            logger.error(f"get_greeks({trading_symbol}): {e}")
            return {}

    def get_india_vix(self) -> float | None:
        """Fetch India VIX from Groww."""
        if not self.is_connected:
            return None
        try:
            resp = self._groww.get_ltp(
                segment=self._groww.SEGMENT_CASH,
                exchange_trading_symbols="NSE_INDIA VIX",
            )
            if resp:
                for v in resp.values():
                    return float(v.get("ltp", 0))
        except Exception as e:
            logger.error(f"get_india_vix: {e}")
        return None

    # ─── Portfolio & Positions ────────────────────────────────────

    def get_orders(self, page: int = 0, page_size: int = 50) -> list:
        """Fetch recent orders (CASH + FNO) from Groww."""
        if not self.is_connected or is_paper_trading():
            return []
        try:
            resp = self._groww.get_order_list(page=page, page_size=page_size)
            items = resp.get("data", resp.get("orders", []))
            if not isinstance(items, list):
                items = []
            return items
        except Exception as e:
            logger.error(f"get_orders: {e}")
            return []

    def get_positions(self) -> dict:
        """Get all open positions (CASH + FNO)."""
        if not self.is_connected or is_paper_trading():
            return {"cash": [], "fno": []}
        try:
            cash = self._groww.get_positions_for_user(
                segment=self._groww.SEGMENT_CASH)
            fno  = self._groww.get_positions_for_user(
                segment=self._groww.SEGMENT_FNO)
            return {"cash": cash or [], "fno": fno or []}
        except Exception as e:
            logger.error(f"get_positions: {e}")
            return {"cash": [], "fno": []}

    def get_holdings(self) -> list:
        """Get long-term holdings (DEMAT)."""
        if not self.is_connected or is_paper_trading():
            return []
        try:
            return self._groww.get_holdings_for_user() or []
        except Exception as e:
            logger.error(f"get_holdings: {e}")
            return []

    def get_margins(self) -> dict:
        """Get available margin across segments."""
        if not self.is_connected or is_paper_trading():
            return {}
        try:
            return self._groww.get_margins() or {}
        except Exception as e:
            logger.error(f"get_margins: {e}")
            return {}

    # ─── Order Execution ─────────────────────────────────────────

    def place_equity_order(self, symbol: str, qty: int,
                           side: str, order_type: str = "MARKET",
                           price: float = 0,
                           product: str = "CNC") -> dict:
        """
        Place an equity (stock) order.

        symbol:     "RELIANCE"
        qty:        number of shares
        side:       "BUY" | "SELL"
        order_type: "MARKET" | "LIMIT"
        price:      required for LIMIT orders
        product:    "CNC" (delivery) | "MIS" (intraday)
        """
        if is_paper_trading():
            logger.info(
                f"[PAPER] {side} {qty} × {symbol} @ "
                f"{'MARKET' if order_type == 'MARKET' else price}"
            )
            return {"paper": True, "symbol": symbol, "qty": qty,
                    "side": side, "status": "SIMULATED"}

        if not self.is_connected:
            raise RuntimeError("Groww API not connected")

        try:
            resp = self._groww.place_order(
                trading_symbol=symbol,
                quantity=qty,
                validity=self._groww.VALIDITY_DAY,
                exchange=self._groww.EXCHANGE_NSE,
                segment=self._groww.SEGMENT_CASH,
                product=(self._groww.PRODUCT_CNC if product == "CNC"
                         else self._groww.PRODUCT_MIS),
                order_type=(self._groww.ORDER_TYPE_MARKET
                            if order_type == "MARKET"
                            else self._groww.ORDER_TYPE_LIMIT),
                transaction_type=(self._groww.TRANSACTION_TYPE_BUY
                                  if side == "BUY"
                                  else self._groww.TRANSACTION_TYPE_SELL),
                price=price if order_type == "LIMIT" else None,
            )
            logger.info(
                f"✓ Order placed: {side} {qty} × {symbol} — "
                f"ID: {resp.get('growwOrderId', '?')}"
            )
            return resp or {}
        except Exception as e:
            logger.error(f"place_equity_order({symbol}): {e}")
            return {"error": str(e)}

    def place_fno_order(self, trading_symbol: str, qty: int,
                        side: str, order_type: str = "MARKET",
                        price: float = 0) -> dict:
        """
        Place an FnO order.

        trading_symbol: Groww FnO format e.g. "NIFTY25O1425100CE"
        qty:   number of lots (1 lot = lot size in contract)
        side:  "BUY" | "SELL"
        """
        if is_paper_trading():
            logger.info(f"[PAPER] FnO {side} {qty} lots × {trading_symbol}")
            return {"paper": True, "symbol": trading_symbol,
                    "qty": qty, "side": side, "status": "SIMULATED"}

        if not self.is_connected:
            raise RuntimeError("Groww API not connected")

        try:
            resp = self._groww.place_order(
                trading_symbol=trading_symbol,
                quantity=qty,
                validity=self._groww.VALIDITY_DAY,
                exchange=self._groww.EXCHANGE_NSE,
                segment=self._groww.SEGMENT_FNO,
                product=self._groww.PRODUCT_NRML,
                order_type=(self._groww.ORDER_TYPE_MARKET
                            if order_type == "MARKET"
                            else self._groww.ORDER_TYPE_LIMIT),
                transaction_type=(self._groww.TRANSACTION_TYPE_BUY
                                  if side == "BUY"
                                  else self._groww.TRANSACTION_TYPE_SELL),
                price=price if order_type == "LIMIT" else None,
            )
            logger.info(f"✓ FnO order placed: {side} {qty} × {trading_symbol}")
            return resp or {}
        except Exception as e:
            logger.error(f"place_fno_order({trading_symbol}): {e}")
            return {"error": str(e)}

    def cancel_order(self, order_id: str, segment: str = "CASH") -> dict:
        """Cancel an open order."""
        if is_paper_trading():
            return {"paper": True, "cancelled": order_id}
        try:
            seg = (self._groww.SEGMENT_CASH if segment == "CASH"
                   else self._groww.SEGMENT_FNO)
            return self._groww.cancel_order(
                groww_order_id=order_id, segment=seg) or {}
        except Exception as e:
            logger.error(f"cancel_order({order_id}): {e}")
            return {"error": str(e)}

    # ─── Scheduled refresh ────────────────────────────────────────

    def refresh_token(self) -> bool:
        """
        Call this daily at 08:00 IST to refresh the access token.
        Groww tokens expire daily.
        """
        try:
            self._initialise()
            return self.is_connected
        except Exception as e:
            logger.error(f"Token refresh failed: {e}")
            return False

    # ─── Fallback ─────────────────────────────────────────────────

    def _yfinance_ltp_fallback(self, symbols: list[str]) -> dict[str, float]:
        """Use yfinance when Groww not available (15-min delayed)."""
        try:
            import yfinance as yf
            result = {}
            for sym in symbols:
                ticker = yf.Ticker(f"{sym}.NS")
                info   = ticker.fast_info
                result[sym] = float(getattr(info, "last_price", 0) or 0)
            return result
        except Exception as e:
            logger.error(f"yfinance fallback failed: {e}")
            return {}


# ─── Singleton ────────────────────────────────────────────────────
groww = GrowwClient()


# ─── Quick test ───────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"Groww connected: {groww.is_connected}")
    prices = groww.get_ltp(["RELIANCE", "TCS", "HDFCBANK"])
    for sym, price in prices.items():
        print(f"  {sym}: ₹{price:,.2f}")
