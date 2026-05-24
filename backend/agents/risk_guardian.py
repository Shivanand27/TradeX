"""
agents/risk_guardian.py
─────────────────────────────────────────────────────
RiskGuardianAgent — the last gate before any order touches an exchange.
Cannot be bypassed. Runs pre-trade checks + continuous monitoring.

Pre-trade checks (block order if ANY fail):
  1. Daily loss limit: stop new entries if down > 2% today
  2. Max drawdown: full halt if down > 8% from peak
  3. Position size: max 10% per India stock, 5% per crypto
  4. Sector concentration: max 25% in one sector (India)
  5. Crypto exposure: max 30% of total capital
  6. India VIX: block longs if VIX > 25
  7. Reward:Risk: block if R:R < 2.0
  8. Earnings buffer: block India trades within 3 days of results
  9. Funding cost: block crypto perp longs if funding > 0.3%/8h
  10. Delta budget: Delta Exchange margin utilisation < 60%

Continuous monitoring (every minute):
  - Check all open positions vs stop-loss levels
  - Alert if trailing stop needs updating
  - Detect stop triggers and auto-exit in paper mode

Kill switch:
  - Soft: pause new entries
  - Hard: cancel all orders + close all positions
"""
from __future__ import annotations
import asyncio
from datetime import datetime, date, timezone
from typing import Optional
from loguru import logger

from core.config import (
    TOTAL_CAPITAL_INR, MAX_POSITION_PCT, MAX_CRYPTO_PCT,
    MAX_INDIA_VIX_FOR_LONGS, MIN_RR_RATIO, MIN_BEAR_DAYS_TO_EARNINGS,
)
from typing import Optional
from core.state_store import state
from core.database import get_open_signals, update_signal_outcome
from core.trading_mode import is_paper_trading
from notifications.telegram import send_alert, send_stop_triggered

# ─── Risk limits ─────────────────────────────────────────────────
DAILY_LOSS_LIMIT_PCT  = 2.0    # Stop new entries if daily loss > 2%
MAX_DRAWDOWN_PCT      = 8.0    # Full halt if drawdown from peak > 8%
MAX_SECTOR_PCT        = 25.0   # Max 25% in one sector (India)
MAX_CRYPTO_EXP_PCT    = 30.0   # Max 30% of capital in crypto
MAX_FUNDING_RATE_8H   = 0.003  # 0.3% — too expensive for perp longs
MAX_DELTA_MARGIN_PCT  = 60.0   # Margin utilisation ceiling

# ─── Kill switch state ────────────────────────────────────────────
_SOFT_KILL = False
_HARD_KILL = False


def is_soft_killed() -> bool:
    return _SOFT_KILL or state.get("/risk/soft_kill") is True


def is_hard_killed() -> bool:
    return _HARD_KILL or state.get("/risk/hard_kill") is True


def soft_kill(reason: str) -> None:
    """Pause new entries. Existing positions continue."""
    global _SOFT_KILL
    _SOFT_KILL = True
    state.set("/risk/soft_kill", True, ttl=86400)
    state.set("/risk/kill_reason", reason, ttl=86400)
    logger.warning(f"🔶 SOFT KILL activated: {reason}")
    asyncio.create_task(send_alert(
        "SOFT KILL — New entries paused",
        reason, level="WARNING"
    ))


def hard_kill(reason: str) -> None:
    """Cancel all orders and close all positions immediately."""
    global _HARD_KILL
    _HARD_KILL = True
    state.set("/risk/hard_kill", True, ttl=86400)
    state.set("/risk/kill_reason", reason, ttl=86400)
    logger.critical(f"🔴 HARD KILL activated: {reason}")
    asyncio.create_task(send_alert(
        "HARD KILL — ALL POSITIONS CLOSING",
        reason, level="CRITICAL"
    ))
    if not is_paper_trading():
        asyncio.create_task(_execute_hard_kill())


def reset_kill(operator: str = "manual") -> None:
    """Re-enable trading (requires manual confirmation)."""
    global _SOFT_KILL, _HARD_KILL
    _SOFT_KILL = False
    _HARD_KILL = False
    state.delete("/risk/soft_kill")
    state.delete("/risk/hard_kill")
    logger.info(f"✓ Kill switch reset by: {operator}")


# ─── Position Registry ────────────────────────────────────────────

def register_position(signal: dict) -> None:
    """
    Record an active position in the state store.
    Call this when a GO verdict is accepted and a trade is entered.
    """
    symbol   = signal.get("symbol", "")
    market   = signal.get("market", "")
    setup    = signal.get("TRADE SETUP", {})
    exits    = setup.get("EXIT RULES — MANDATORY", {})
    risk     = signal.get("RISK MANAGEMENT", {})

    position_pct    = float(risk.get("position_size_pct") or 5)
    capital_deployed = TOTAL_CAPITAL_INR * position_pct / 100

    # Fetch sector from fundamentals (best-effort)
    sector = "Unknown"
    if "india" in market:
        fund   = state.read_fundamentals(symbol) or {}
        sector = fund.get("raw_data", {}).get("sector", "Unknown")

    position = {
        "signal_id":            signal.get("signal_id"),
        "symbol":               symbol,
        "market":               market,
        "entry_price":          float(setup.get("entry_price") or 0),
        "stop_loss":            float(exits.get("stop_loss") or 0),
        "target_1":             float(exits.get("target_1") or 0),
        "target_2":             float(exits.get("target_2") or 0),
        "position_size_pct":    position_pct,
        "capital_deployed_inr": capital_deployed,
        "sector":               sector,
        "registered_at":        datetime.now(timezone.utc).isoformat(),
    }

    market_key = "india" if "india" in market else "crypto"
    state.write_position(market_key, symbol, position)
    logger.info(f"  Position registered: {symbol} ({market_key}) — ₹{capital_deployed:,.0f}")


def unregister_position(market: str, symbol: str) -> None:
    """Remove a closed position from the state store."""
    market_key = "india" if "india" in market else "crypto"
    state.delete_position(market_key, symbol)
    logger.info(f"  Position unregistered: {symbol} ({market_key})")


# ─── Pre-trade validation ─────────────────────────────────────────

class RiskCheckResult:
    def __init__(self, passed: bool, reason: str = ""):
        self.passed = passed
        self.reason = reason

    def __bool__(self):
        return self.passed

    def __repr__(self):
        return f"{'✓ PASS' if self.passed else '✗ FAIL'}: {self.reason}"


def validate_trade(signal: dict) -> RiskCheckResult:
    """
    Run all pre-trade checks on a signal.
    Returns RiskCheckResult — if False, trade must be blocked.

    Call this before placing any order.
    """
    market   = signal.get("market", "")
    setup    = signal.get("TRADE SETUP", {})
    exits    = setup.get("EXIT RULES — MANDATORY", {})
    risk     = signal.get("RISK MANAGEMENT", {})
    scores   = signal.get("SCORE CARD", {})

    position_pct = float(risk.get("position_size_pct", 5))
    rr_ratio     = _compute_rr(setup)
    entry        = float(setup.get("entry_price", 0))
    stop         = float(exits.get("stop_loss") or entry * 0.92)

    checks = [
        _check_kill_switch(),
        _check_daily_loss(),
        _check_max_drawdown(),
        _check_position_size(position_pct, market),
        _check_rr_ratio(rr_ratio),
        _check_india_vix(market),
        _check_earnings_proximity(signal, market),
        _check_sector_concentration(signal, market),
        _check_crypto_exposure(market),
        _check_delta_funding(signal, market),
    ]

    for check in checks:
        if not check.passed:
            logger.warning(f"  ✗ Risk check failed: {check.reason}")
            return check

    return RiskCheckResult(True, "All checks passed")


def _check_kill_switch() -> RiskCheckResult:
    if is_hard_killed():
        return RiskCheckResult(False, "HARD KILL active — no new trades allowed")
    if is_soft_killed():
        reason = state.get("/risk/kill_reason") or "manual pause"
        return RiskCheckResult(False, f"SOFT KILL active: {reason}")
    return RiskCheckResult(True)


def _check_daily_loss() -> RiskCheckResult:
    pnl_today = state.get("/risk/daily_pnl_pct") or 0.0
    if float(pnl_today) <= -DAILY_LOSS_LIMIT_PCT:
        soft_kill(f"Daily loss {pnl_today:.2f}% exceeds limit {DAILY_LOSS_LIMIT_PCT}%")
        return RiskCheckResult(False, f"Daily loss limit hit: {pnl_today:.2f}%")
    return RiskCheckResult(True)


def _check_max_drawdown() -> RiskCheckResult:
    dd = state.get("/risk/drawdown_from_peak_pct") or 0.0
    if float(dd) >= MAX_DRAWDOWN_PCT:
        hard_kill(f"Max drawdown {dd:.2f}% exceeded {MAX_DRAWDOWN_PCT}%")
        return RiskCheckResult(False, f"Max drawdown breached: {dd:.2f}%")
    return RiskCheckResult(True)


def _check_position_size(position_pct: float, market: str) -> RiskCheckResult:
    max_pct = MAX_POSITION_PCT if "india" in market else 5.0
    if position_pct > max_pct:
        return RiskCheckResult(False,
            f"Position size {position_pct}% exceeds max {max_pct}%")
    return RiskCheckResult(True)


def _check_rr_ratio(rr: float) -> RiskCheckResult:
    if rr < MIN_RR_RATIO:
        return RiskCheckResult(False,
            f"R:R ratio {rr:.2f} below minimum {MIN_RR_RATIO}")
    return RiskCheckResult(True)


def _check_india_vix(market: str) -> RiskCheckResult:
    if "india" not in market:
        return RiskCheckResult(True)
    vix = float(state.get("/market/india_vix") or 15)
    if vix > MAX_INDIA_VIX_FOR_LONGS:
        return RiskCheckResult(False,
            f"India VIX={vix:.1f} > {MAX_INDIA_VIX_FOR_LONGS} — high volatility, avoid longs")
    return RiskCheckResult(True)


def _check_earnings_proximity(signal: dict, market: str) -> RiskCheckResult:
    if "india" not in market:
        return RiskCheckResult(True)
    sym      = signal.get("symbol", "")
    sent     = state.read_sentiment("india", sym) or {}
    days     = sent.get("earnings_next_days", 99)
    if days and int(days) <= MIN_BEAR_DAYS_TO_EARNINGS:
        return RiskCheckResult(False,
            f"Earnings in {days} days — binary event, skip entry")
    return RiskCheckResult(True)


def _check_sector_concentration(signal: dict, market: str) -> RiskCheckResult:
    if "india" not in market:
        return RiskCheckResult(True)
    sym    = signal.get("symbol", "")
    fund   = state.read_fundamentals(sym) or {}
    sector = fund.get("raw_data", {}).get("sector", "Unknown")
    if not sector or sector == "Unknown":
        return RiskCheckResult(True)   # can't check without sector data
    exposure_pct = state.get_sector_exposure_pct(sector, TOTAL_CAPITAL_INR)
    if exposure_pct >= MAX_SECTOR_PCT:
        return RiskCheckResult(False,
            f"Sector '{sector}' exposure {exposure_pct:.1f}% >= max {MAX_SECTOR_PCT}%")
    return RiskCheckResult(True)


def _check_crypto_exposure(market: str) -> RiskCheckResult:
    if "crypto" not in market:
        return RiskCheckResult(True)
    crypto_pct = state.get_crypto_exposure_pct(TOTAL_CAPITAL_INR)
    if crypto_pct >= MAX_CRYPTO_EXP_PCT:
        return RiskCheckResult(False,
            f"Crypto exposure {crypto_pct:.1f}% >= max {MAX_CRYPTO_EXP_PCT}%")
    return RiskCheckResult(True)


def _check_delta_funding(signal: dict, market: str) -> RiskCheckResult:
    if "crypto" not in market:
        return RiskCheckResult(True)
    sym = signal.get("symbol", "")
    snap = state.get("/sentiment/crypto/delta_snapshot") or {}
    funding = snap.get("funding", {}).get(sym, 0)
    if float(funding) > MAX_FUNDING_RATE_8H * 100:  # in %
        return RiskCheckResult(False,
            f"Funding rate {funding:.4f}%/8h too expensive for long on {sym}")
    return RiskCheckResult(True)


def _compute_rr(setup: dict) -> float:
    """Compute reward:risk from setup dict."""
    try:
        exits  = setup.get("EXIT RULES — MANDATORY", {})
        entry  = float(setup.get("entry_price", 0))
        target = float(exits.get("target_1", 0))
        stop   = float(exits.get("stop_loss", 0))
        if entry <= 0 or target <= 0 or stop <= 0:
            return 2.5  # default if missing
        reward = abs(target - entry)
        risk   = abs(entry - stop)
        return round(reward / risk, 2) if risk > 0 else 0
    except Exception:
        return 2.5


# ─── Continuous monitoring ────────────────────────────────────────

async def run_position_monitor() -> None:
    """
    Check all open signals against current prices.
    Detect stop-loss triggers and trailing stop updates.
    Runs continuously in a background loop.
    """
    logger.info("▶ RiskGuardian position monitor — running")

    while True:
        try:
            await _check_all_positions()
        except Exception as e:
            logger.error(f"Position monitor error: {e}")
        await asyncio.sleep(10)  # check every 10 seconds


async def _check_all_positions() -> None:
    """Check every open signal against its exit rules."""
    open_signals = get_open_signals()
    if not open_signals:
        return

    for sig in open_signals:
        try:
            await _check_position(sig)
        except Exception as e:
            logger.debug(f"Position check {sig.get('symbol')}: {e}")


async def _check_position(sig: dict) -> None:
    """Check one open position against stop and trailing stop."""
    symbol = sig.get("symbol", "")
    market = sig.get("market", "")
    entry  = float(sig.get("entry_price") or 0)
    stop   = float(sig.get("stop_loss") or 0)

    if not (symbol and entry and stop):
        return

    # Get current price
    market_key = "india" if "india" in market else "crypto"
    data = state.read_market_data(market_key, symbol)
    if not data:
        return

    current = float(data.get("ltp") or data.get("close") or 0)
    if current <= 0:
        return

    pnl_pct = (current - entry) / entry * 100

    # Hard stop breach
    if current <= stop:
        logger.warning(
            f"🛑 STOP HIT: {symbol}  "
            f"Entry={entry:.2f}  Current={current:.2f}  "
            f"Stop={stop:.2f}  P&L={pnl_pct:+.2f}%"
        )
        await send_stop_triggered(symbol, "stop_loss_hit", entry, current)
        # Always record outcome in database
        update_signal_outcome(
            sig.get("signal_id", ""),
            "loss" if pnl_pct < 0 else "win",
            current, pnl_pct
        )
        # Live trading: place market order to actually exit the position
        if not is_paper_trading():
            asyncio.create_task(
                _execute_stop_order(symbol, market, sig),
                name=f"stop_{symbol}",
            )
        # Remove from active positions and update daily P&L
        unregister_position(market, symbol)
        _update_daily_pnl(pnl_pct * float(sig.get("position_size_pct", 5)) / 100)

    # TP1 reached — auto-update trailing stop and alert
    tp1 = float(sig.get("target_1") or 0)
    if tp1 > 0 and current >= tp1:
        trail_pct = 8 if "india" in market else 15
        trail_stop = round(current * (1 - trail_pct / 100), 2)
        if trail_stop > stop:
            logger.info(
                f"📈 TP1 reached: {symbol}  "
                f"Current={current:.2f}  TP1={tp1:.2f}  "
                f"Trailing stop auto-updated → {trail_stop:.2f}"
            )
            # Auto-update stop in the position register (so next cycle uses new level)
            market_key = "india" if "india" in market else "crypto"
            pos = state.read_position(market_key, symbol) or {}
            pos["stop_loss"] = trail_stop
            state.write_position(market_key, symbol, pos)
            # Mutate the signal dict in-memory so the caller's open_signals cache is updated
            sig["stop_loss"] = trail_stop
            await send_alert(
                f"TP1 REACHED — {symbol}",
                f"Current: {current:.2f} (+{pnl_pct:.1f}%)\n"
                f"Trailing stop AUTO-UPDATED to: {trail_stop:.2f} ({trail_pct}% trail)\n"
                f"Exit 50% of position at TP1.",
                level="INFO"
            )


async def _execute_stop_order(symbol: str, market: str, sig: dict) -> None:
    """Place a market exit order when stop-loss is hit in live trading."""
    try:
        qty = int(sig.get("qty") or sig.get("position_size_pct") or 1)
        if "crypto" in market:
            from data.delta_client import delta_rest
            products = {p["symbol"]: p["id"] for p in delta_rest.get_products()}
            candidates = [symbol, f"{symbol}USD", symbol.replace("USD", "")]
            pid = next((products[c] for c in candidates if c in products), None)
            if pid:
                await asyncio.to_thread(
                    delta_rest.place_order, pid, "sell", qty, "market_order", None
                )
                logger.info(f"  ✓ Stop-loss order placed: SELL {qty}× {symbol} (crypto market order)")
            else:
                logger.error(f"  Stop-loss exit failed: no Delta product found for {symbol}")
        else:
            from data.groww_client import groww
            if groww.is_connected:
                await asyncio.to_thread(
                    groww.place_equity_order, symbol, qty, "SELL", "MARKET"
                )
                logger.info(f"  ✓ Stop-loss order placed: SELL {qty}× {symbol} (India market order)")
            else:
                logger.error(f"  Stop-loss exit failed: Groww not connected for {symbol}")
    except Exception as e:
        logger.error(f"  _execute_stop_order({symbol}): {e}")


def _update_daily_pnl(pnl_pct: float) -> None:
    """Update the daily PnL tracker."""
    current = float(state.get("/risk/daily_pnl_pct") or 0)
    new_val = round(current + pnl_pct, 4)
    state.set("/risk/daily_pnl_pct", new_val, ttl=86400)

    # Check if we need to trigger soft kill
    if new_val <= -DAILY_LOSS_LIMIT_PCT:
        soft_kill(f"Daily loss {new_val:.2f}% reached limit")


def reset_daily_pnl() -> None:
    """Call at midnight IST to reset daily P&L tracking."""
    state.set("/risk/daily_pnl_pct", 0.0, ttl=86400)
    state.set("/risk/trades_today", 0, ttl=86400)
    # Reset soft kill from daily loss (but not manual kills)
    if state.get("/risk/kill_reason") and "daily loss" in str(state.get("/risk/kill_reason")):
        reset_kill("daily_reset")
    logger.info("✓ Daily risk counters reset")


async def _execute_hard_kill() -> None:
    """Execute hard kill — close all open positions (live trading only)."""
    logger.critical("Executing HARD KILL — closing all positions")
    # India positions via Groww
    try:
        from data.groww_client import groww
        if groww.is_connected:
            positions = groww.get_positions()
            for pos in positions.get("cash", []) + positions.get("fno", []):
                sym = pos.get("tradingSymbol", "")
                qty = abs(int(pos.get("netQty", 0)))
                if qty > 0:
                    side = "SELL" if int(pos.get("netQty", 0)) > 0 else "BUY"
                    groww.place_equity_order(sym, qty, side, "MARKET")
                    logger.info(f"  Closed India position: {side} {qty} × {sym}")
    except Exception as e:
        logger.error(f"Hard kill India positions failed: {e}")

    # Crypto positions via Delta Exchange
    try:
        from data.delta_client import delta_rest
        positions = delta_rest.get_positions()
        for pos in positions:
            pid = pos.get("product_id")
            if pid:
                delta_rest.close_position(pid)
                logger.info(f"  Closed Delta position: product_id={pid}")
    except Exception as e:
        logger.error(f"Hard kill Delta positions failed: {e}")


# ─── Portfolio risk summary ───────────────────────────────────────

def get_risk_summary() -> dict:
    """Return current portfolio risk state for dashboard."""
    return {
        "soft_kill":             is_soft_killed(),
        "hard_kill":             is_hard_killed(),
        "kill_reason":           state.get("/risk/kill_reason") or "",
        "daily_pnl_pct":        float(state.get("/risk/daily_pnl_pct") or 0),
        "drawdown_from_peak":   float(state.get("/risk/drawdown_from_peak_pct") or 0),
        "india_vix":            float(state.get("/market/india_vix") or 15),
        "daily_loss_limit_pct": DAILY_LOSS_LIMIT_PCT,
        "max_drawdown_pct":     MAX_DRAWDOWN_PCT,
        "max_india_vix_longs":  MAX_INDIA_VIX_FOR_LONGS,
        "open_signals_count":   len(get_open_signals()),
    }
