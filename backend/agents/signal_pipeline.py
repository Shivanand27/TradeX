"""
agents/signal_pipeline.py
─────────────────────────────────────────────────────
The full signal pipeline:
  1. Screen instruments for debate-worthy setups
  2. Run Bull/Bear adversarial debate (≤2 rounds, Gemini Pro)
  3. Compute VERDICT_SCORE + apply hard veto rules
  4. Issue GO/WATCH/NO_GO signals → Telegram + Supabase
  5. Spot trade big-move scanner (40-100%+ setups)

Cost controls:
  - Only debates instruments with technical_score > 6.0
  - Max 2 debate rounds per session
  - Max 3 concurrent debates
  - Caches results for 5 min (no repeated debates)
"""
from __future__ import annotations
import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from loguru import logger

from core.config import (
    MIN_TECHNICAL_SCORE_FOR_DEBATE, DEBATE_MAX_ROUNDS,
    MAX_CONCURRENT_DEBATES, MIN_RR_RATIO, MAX_INDIA_VIX_FOR_LONGS,
    MIN_BEAR_DAYS_TO_EARNINGS, TOTAL_CAPITAL_INR, MTF_BIAS_VALUE,
)
from core.state_store import state
from core.database import save_signal, get_open_signals
from notifications.telegram import send_signal, send_alert, send_pipeline_setups
from utils.llm_router import deep_llm, fast_llm

_debate_semaphore = asyncio.Semaphore(MAX_CONCURRENT_DEBATES)


# ─── Main pipeline ────────────────────────────────────────────────

async def run_signal_pipeline(market: str = "both") -> list[dict]:
    """
    Run the full 3-factor debate → verdict pipeline.

    Three entry paths:
      1. Technical breakout  — chart_pattern_agent score >= 6.0, bullish bias
      2. Fundamental trigger — fundamentals score >= 7.0 on any watchlist stock
      3. News event trigger  — HIGH-impact news (<2h old) mentioning a stock
    """
    logger.info(f"▶ Signal Pipeline [{market}] — starting (3-factor)")
    signals = []

    markets = (["india", "crypto"] if market == "both"
               else [market] if market in ("india", "crypto")
               else [])

    for mkt in markets:
        # ── Path 1: Technical breakout (chart pattern watchlist) ──────
        watch_list = state.get(f"/watch_list/{mkt}") or []
        technical_candidates = {
            w["symbol"]: {**w, "trigger_source": "technical_breakout"}
            for w in watch_list
            if w.get("technical_score", 0) >= MIN_TECHNICAL_SCORE_FOR_DEBATE
            and w.get("overall_bias") in ("strong_bullish", "bullish")
        }

        # ── Path 2: Fundamental trigger (strong quality + value) ──────
        if mkt == "india":
            fundamental_candidates = _get_fundamental_triggered(mkt)
            for sym, item in fundamental_candidates.items():
                if sym not in technical_candidates:
                    technical_candidates[sym] = item

        # ── Path 3: News-event trigger (sudden market events) ─────────
        news_candidates = _get_news_triggered(mkt)
        for sym, item in news_candidates.items():
            if sym not in technical_candidates:
                technical_candidates[sym] = item
            else:
                # Upgrade existing entry with news trigger note
                technical_candidates[sym]["news_headlines"] = item.get("news_headlines", [])
                technical_candidates[sym]["trigger_source"] = "technical_breakout+news"

        qualified = list(technical_candidates.values())

        if not qualified:
            logger.info(f"  No debate-worthy setups in {mkt} (technical={len(watch_list)}, news_events=0)")
            continue

        # Count by trigger source for logging
        sources = {}
        for q in qualified:
            src = q.get("trigger_source", "unknown")
            sources[src] = sources.get(src, 0) + 1
        logger.info(f"  {len(qualified)} qualifying setups in {mkt}: {sources}")

        # ── MTF alignment gate ────────────────────────────────────
        # 1D + 4H both bullish = GO candidate.
        # 1D-only bullish = demote to WATCH (no LLM spend).
        go_candidates   = []
        watch_demoted   = []
        for q in qualified:
            sym = q.get("symbol", "")
            # higher_tf_aligned is set by chart_pattern_agent MTF pass
            if q.get("higher_tf_aligned") is True:
                go_candidates.append(q)
            elif q.get("higher_tf_aligned") is False:
                watch_demoted.append(sym)
            else:
                # MTF data unavailable — fall back to 1D score gate only
                go_candidates.append(q)

        if watch_demoted:
            logger.info(
                f"  MTF gate demoted {len(watch_demoted)} to WATCH "
                f"(1D bullish but 4H not aligned): {watch_demoted}"
            )

        if not go_candidates:
            logger.info(f"  No MTF-aligned candidates in {mkt} — skipping debate")
            continue

        # Notify before debate — user knows what's being analysed
        await send_pipeline_setups(go_candidates[:5], mkt)

        tasks = [
            _run_debate_and_verdict(sym_data, mkt)
            for sym_data in go_candidates[:5]
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for result in results:
            if isinstance(result, dict) and result.get("verdict") == "GO":
                signals.append(result)
                await send_signal(result)
                save_signal(result)
                try:
                    from agents.risk_guardian import register_position
                    register_position(result)
                except Exception as _rp_err:
                    logger.warning(f"  register_position failed for {result.get('symbol')}: {_rp_err}")
                logger.info(
                    f"  🟢 GO: {result['symbol']} [{result.get('trigger_source','?')}] — "
                    f"Score {result['SCORE CARD']['overall']}/10  "
                    f"Conviction={result['conviction']}"
                )
            elif isinstance(result, Exception):
                logger.error(f"  Debate error: {result}")

        # Write GO signals to /latest_signals/{mkt} so bots can read them without
        # scanning all /verdict/* keys or polling Supabase on every cycle.
        mkt_go = [s for s in signals if s.get("market", "").startswith(mkt)]
        if mkt_go:
            existing = state.get(f"/latest_signals/{mkt}") or []
            seen_ids = {s.get("signal_id") for s in existing}
            fresh = [s for s in mkt_go if s.get("signal_id") not in seen_ids]
            merged = (fresh + existing)[:20]  # keep last 20 signals per market
            state.set(f"/latest_signals/{mkt}", merged, ttl=14400)  # 4h TTL

    logger.info(f"✓ Signal pipeline complete — {len(signals)} GO signals issued")
    return signals


def _get_fundamental_triggered(market: str) -> dict[str, dict]:
    """
    Path 2: Stocks with strong fundamentals (score >= 7) that haven't
    already been picked up by the chart watchlist.
    Uses cached data written by fundamentals_agent — no LLM call here.
    """
    from core.config import INDIA_WATCHLIST
    triggered = {}
    for sym_ns in INDIA_WATCHLIST:
        sym = sym_ns.replace(".NS", "")
        fund = state.read_fundamentals(sym) or {}
        overall = fund.get("overall_score", 0)
        if overall >= 7.0:
            chart = state.read_chart_data(market, sym_ns) or {}
            mkt_data = state.read_market_data(market, sym_ns) or {}
            triggered[sym_ns] = {
                "symbol": sym_ns,
                "technical_score": chart.get("technical_score", 0),
                "overall_bias": chart.get("overall_bias", "neutral"),
                "fundamental_score": overall,
                "trigger_source": "fundamental_quality",
            }
    if triggered:
        logger.info(f"  Fundamental trigger: {len(triggered)} stocks with score ≥7")
    return triggered


def _get_news_triggered(market: str) -> dict[str, dict]:
    """
    Path 3: Stocks mentioned in HIGH-impact news items < 2 hours old.
    Runs a debate even if technical_score is below the normal gate,
    because sudden events demand immediate analysis.
    """
    news = state.get("/news/feed") or []
    hot_news = [
        n for n in news
        if n.get("impact") == "HIGH" and float(n.get("age_hours", 99)) < 2.0
    ]
    if not hot_news:
        return {}

    from core.config import INDIA_WATCHLIST, CRYPTO_WATCHLIST
    watchlist = INDIA_WATCHLIST if market == "india" else CRYPTO_WATCHLIST

    triggered = {}
    for sym_raw in watchlist:
        sym_base = sym_raw.replace(".NS", "").replace("USDT", "")
        matching = [
            n for n in hot_news
            if sym_base.upper() in n.get("headline", "").upper()
            or sym_base.upper() in [t.upper() for t in n.get("tags", [])]
        ]
        if matching:
            chart = state.read_chart_data(market, sym_raw) or {}
            triggered[sym_raw] = {
                "symbol": sym_raw,
                "technical_score": chart.get("technical_score", 0),
                "overall_bias": chart.get("overall_bias", "neutral"),
                "trigger_source": "news_event",
                "news_headlines": [n.get("headline", "")[:120] for n in matching[:3]],
            }

    if triggered:
        logger.info(f"  News event trigger: {len(triggered)} stocks from HIGH-impact news")
    return triggered


# ─── Debate + Verdict for one instrument ─────────────────────────

async def _run_debate_and_verdict(sym_data: dict, market: str) -> dict:
    """Run Bull/Bear debate then produce verdict for one instrument."""
    async with _debate_semaphore:
        symbol     = sym_data.get("symbol", "?")
        session_id = f"{symbol}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}"

        # Check cache — don't re-debate if result is fresh
        cached = state.read_verdict(session_id)
        if cached:
            logger.debug(f"  Using cached verdict for {symbol}")
            return cached

        trigger = sym_data.get("trigger_source", "technical_breakout")
        news_ctx = sym_data.get("news_headlines", [])
        logger.info(f"  ⚡ Debating: {symbol} [{market}] via {trigger}")

        # Build context for agents — include trigger + MTF metadata
        ctx = state.get_full_context(market, symbol)
        ctx["trigger_source"]          = trigger
        ctx["trigger_news_headlines"]  = news_ctx
        # MTF alignment data (set by chart_pattern_agent MTF pass)
        ctx["mtf_data"] = state.get(f"/chart_mtf/{market}/{symbol}") or {}

        # Round 1
        bull_r1 = await _bull_agent(symbol, market, ctx, round_=1)
        bear_r1 = await _bear_agent(symbol, market, ctx, bull_r1, round_=1)
        state.write_debate(session_id, "bull_r1", bull_r1)
        state.write_debate(session_id, "bear_r1", bear_r1)

        # Round 2 (always — cost is low, quality improves significantly)
        bull_r2 = await _bull_agent(symbol, market, ctx, round_=2,
                                     bear_prev=bear_r1)
        bear_r2 = await _bear_agent(symbol, market, ctx, bull_r2, round_=2,
                                     bull_prev=bull_r1)
        state.write_debate(session_id, "bull_r2", bull_r2)
        state.write_debate(session_id, "bear_r2", bear_r2)

        # Verdict
        verdict = await _verdict_agent(
            symbol, market, ctx,
            bull_final=bull_r2, bear_final=bear_r2,
        )
        verdict["signal_id"]      = session_id
        verdict["timestamp"]       = datetime.now(timezone.utc).isoformat()
        verdict["trigger_source"]  = trigger
        if news_ctx:
            verdict["trigger_news"] = news_ctx

        state.write_verdict(session_id, verdict)
        return verdict


# ─── Bull Agent ───────────────────────────────────────────────────

async def _bull_agent(symbol: str, market: str, ctx: dict,
                       round_: int, bear_prev: dict = None) -> dict:
    """Build the strongest bull case using full technical + SMC context."""
    chart      = ctx.get("chart_data", {})
    mkt_data   = ctx.get("market_data", {})
    sentiment  = ctx.get("sentiment", {})
    funds      = ctx.get("fundamentals", {})
    indicators = chart.get("indicators", {})
    patterns   = chart.get("patterns_active", [])
    smc        = chart.get("smc", {})
    key_levels = chart.get("key_levels", {})

    currency = "₹" if market == "india" else "$"
    price    = float(mkt_data.get("ltp", 0) or mkt_data.get("close", 0))

    # Build SMC context block
    ob  = smc.get("nearest_bullish_ob")
    fvg = smc.get("nearest_fvg")
    _ob_str  = f"{currency}{ob['low']}–{ob['high']} ({ob['strength']})" if ob else "none"
    _fvg_str = f"{currency}{fvg['bottom']}–{fvg['top']}" if fvg else "none"
    _bob     = smc.get("nearest_bearish_ob")
    _bob_str = f"{currency}{_bob['low']}–{_bob['high']}" if _bob else "none"
    _ssl_note = " ← SELL-SIDE LIQUIDITY TAKEN (strong reversal signal)" if smc.get("liquidity_swept") == "sell_side" else ""
    smc_block = (
        f"SMC STRUCTURE: {smc.get('structure','N/A')} | Trend: {smc.get('trend','N/A')}\n"
        f"Discount zone: {'YES — below 50% fib, demand area' if smc.get('in_discount') else 'NO'}\n"
        f"Liquidity swept: {smc.get('liquidity_swept') or 'none'}{_ssl_note}\n"
        f"Bullish OB below price: {_ob_str}\n"
        f"Open FVG (demand imbalance): {_fvg_str}\n"
        f"Buy-side liquidity (BSL) targets: {smc.get('bsl', [])}\n"
        f"Sell-side liquidity (SSL) support: {smc.get('ssl', [])}\n"
        f"Nearest bearish OB (resistance/T1): {_bob_str}"
    )

    # Build S/R levels block
    sr_block = (
        f"S/R: support={key_levels.get('support', [])}, resistance={key_levels.get('resistance', [])}\n"
        f"Fib 38.2%={key_levels.get('fib_38')} | 61.8%={key_levels.get('fib_61')} | Ext 127.2%={key_levels.get('fib_ext_127')}"
    )

    rebuttal_section = ""
    if bear_prev:
        rebuttal_section = (
            f"\nROUND {round_} REBUTTAL REQUIRED — address specifically:\n"
            f"Bear primary risk: {bear_prev.get('primary_risk', 'N/A')}\n"
            f"Bear scenario: {bear_prev.get('bear_case_scenario', 'N/A')}\n"
            f"Bear adjusted stop: {bear_prev.get('adjusted_stop', 'N/A')}\n"
        )

    # Derive OB-anchored entry/stop if available
    ob_entry_hint = ""
    if ob:
        ob_entry_hint = (
            f"\nOB-ANCHORED SETUP HINT (use if structure confirms):\n"
            f"  Entry zone: {currency}{ob['low']}–{ob['high']} (inside the bullish OB)\n"
            f"  Stop: just below OB low {currency}{round(ob['low']*0.995,2)} (structure invalid if broken)\n"
            f"  T1: nearest bearish OB or resistance\n"
            f"  T2: highest BSL level {smc.get('bsl', [None])[-1] or 'N/A'}"
        )

    # News / trigger context for the agent prompt
    # MTF context block
    mtf          = ctx.get("mtf_data", {})
    mtf_summary  = mtf.get("mtf_summary", "")
    mtf_block    = ""
    if mtf_summary:
        entry_tf  = mtf.get("entry_tf", "1d")
        entry_ob  = mtf.get("entry_ob")
        entry_fvg = mtf.get("entry_fvg")
        e_ob_str  = (
            f"{currency}{entry_ob['low']}–{currency}{entry_ob['high']} "
            f"({entry_ob.get('strength','?')} OB)"
            if entry_ob else "not found"
        )
        e_fvg_str = (
            f"{currency}{entry_fvg['bottom']}–{currency}{entry_fvg['top']}"
            if entry_fvg else "not found"
        )
        ez = mtf.get("entry_zone")
        ez_str = f"{currency}{ez[0]}–{currency}{ez[1]}" if ez else "use 1D OB"
        mtf_block = (
            f"\n── MULTI-TIMEFRAME CASCADE ─────────────────────────────────\n"
            f"Alignment: {mtf_summary}\n"
            f"1D bias: {mtf.get('d1_bias','?')}  4H bias: {mtf.get('d4_bias','?')}  "
            f"1H bias: {mtf.get('d1h_bias','?')}  15m: {mtf.get('d15m_bias','?')}  "
            f"5m: {mtf.get('d5m_bias','?')}\n"
            f"Alignment score: {mtf.get('alignment_score',0):.2f} / 2.00\n"
            f"\nREFINED ENTRY (from {entry_tf.upper()} TF):\n"
            f"  {entry_tf.upper()} Bullish OB:  {e_ob_str}\n"
            f"  {entry_tf.upper()} FVG demand:  {e_fvg_str}\n"
            f"  Recommended entry zone: {ez_str}\n"
            f"\nINSTRUCTION: Use the {entry_tf.upper()} OB/FVG as the primary entry zone.\n"
            f"  Stop: just below {entry_tf.upper()} OB low (tighter R:R than 1D stop).\n"
            f"  Entry trigger: look for 3m/1m CHoCH or engulfing candle "
            f"inside the {entry_tf.upper()} OB zone."
        )

    trigger_src  = ctx.get("trigger_source", "technical_breakout")
    news_hls     = ctx.get("trigger_news_headlines", [])
    news_block   = ""
    if news_hls:
        news_block = "\n── NEWS EVENT TRIGGER ──────────────────────────────────────\n"
        news_block += "\n".join(f"  • {h}" for h in news_hls)
    # Fundamentals block (structured)
    funds_block  = ""
    if funds:
        funds_block = (
            f"\n── FUNDAMENTALS ───────────────────────────────────────────\n"
            f"Overall score: {funds.get('overall_score','?')}/10  "
            f"P/E: {funds.get('pe_ratio','?')}  ROE: {funds.get('roe','?')}%  "
            f"D/E: {funds.get('debt_equity','?')}\n"
            f"Revenue growth: {funds.get('revenue_growth_yoy','?')}%  "
            f"EPS growth: {funds.get('eps_growth_yoy','?')}%  "
            f"Net margin: {funds.get('net_profit_margin','?')}%\n"
            f"Key catalyst: {funds.get('key_catalyst','?')}\n"
            f"Key risk: {funds.get('key_risk','?')}"
        )

    prompt = f"""You are the Bull Research Agent for {market} markets. Round {round_}/2.
Build the STRONGEST possible case for a LONG position in {symbol}.
Trigger: {trigger_src} — weight your argument accordingly.
You MUST cite specific prices, percentages and indicator values. Vague claims are rejected.
Current price: {currency}{price}

── MARKET DATA ─────────────────────────────────────────────────
{json.dumps(mkt_data, default=str)[:400]}

── TECHNICAL INDICATORS ────────────────────────────────────────
Bias={chart.get('overall_bias')}  Score={chart.get('technical_score')}/10
RSI={indicators.get('rsi')} ({indicators.get('rsi_signal')}) | Divergence={indicators.get('rsi_divergence')}
MACD={indicators.get('macd_signal')} histogram {indicators.get('macd_histogram_direction')}
EMA alignment={indicators.get('ema_alignment')} | EMA20={indicators.get('ema20')} EMA50={indicators.get('ema50')} EMA200={indicators.get('ema200')}
ADX={indicators.get('adx')} ({indicators.get('trend_strength')}) | ATR={indicators.get('atr')}
BB position={indicators.get('bb_position')} | Volume signal={indicators.get('volume_signal')} ({indicators.get('volume_ratio')}×)
VWAP={indicators.get('vwap')} | Stochastic K/D (check overbought/oversold)
Active patterns: {[p['name']+' SR='+str(p['success_rate']) for p in patterns[:4]]}

── SMART MONEY CONCEPTS (SMC) ──────────────────────────────────
{smc_block}

── SUPPORT / RESISTANCE + FIBONACCI ────────────────────────────
{sr_block}
{ob_entry_hint}

── SENTIMENT ───────────────────────────────────────────────────
{json.dumps(sentiment, default=str)[:300]}
{funds_block}{news_block}{mtf_block}{rebuttal_section}

INSTRUCTIONS (TOP-DOWN MTF APPROACH):
1. Higher TF (1D/4H) determines the DIRECTION and major OB/FVG zones.
2. Lower TF (1H/15m) refines the ENTRY zone — use the OB/FVG listed above.
3. Entry trigger on 3m/1m: CHoCH or bullish engulfing inside the lower-TF OB.
4. Stop: just below the lower-TF OB low (maximises R:R vs 1D stop).
5. T1: nearest bearish OB or 4H resistance.  T2: BSL pool or fib extension.
6. R:R must be ≥ 2.0; aim for 3:1 or better using the refined entry zone.
7. For India: reference FII flows, promoter holding, sector rotation.
8. For Crypto: reference funding rate, open interest, fear & greed.

Respond ONLY as valid JSON (no markdown):
{{
  "thesis": "2-3 sentences citing specific prices + SMC/indicator confluence",
  "technical_argument": "pattern+success rate, indicator alignment, volume confirmation",
  "smc_argument": "structure (BOS/CHoCH), OB zone, FVG, liquidity sweep rationale",
  "fundamental_argument": "valuation metric or on-chain/cycle metric",
  "sentiment_argument": "news catalyst / FII flow (India) or F&G / funding (crypto)",
  "proposed_trade": {{
    "entry": {round(ob['low'] if ob else price, 2)},
    "entry_zone_low":  {round((ob['low'] if ob else price*0.99), 2)},
    "entry_zone_high": {round((ob['high'] if ob else price*1.005), 2)},
    "target_1": 0,
    "target_1_pct": "+X%",
    "target_2": 0,
    "target_2_pct": "+X%",
    "stop_loss": {round((ob['low']*0.995 if ob else price*0.92), 2)},
    "stop_loss_pct": "-X%",
    "stop_logic": "below OB low / below swept SSL / below swing low",
    "trailing_stop": "trail X% below highest close after T1 hit",
    "time_exit": "exit by DATE if price hasn't moved",
    "invalidation": "exit immediately if closes below LEVEL on daily",
    "max_hold_days": 60,
    "rr_ratio": 0.0
  }},
  "conviction_score": 7
}}"""

    raw = await deep_llm(prompt, max_tokens=1400)
    return _parse_json_response(raw, {
        "thesis": "Bull case",
        "conviction_score": 6,
        "smc_argument": "",
        "proposed_trade": {
            "entry": price,
            "entry_zone_low": round(price * 0.99, 2),
            "entry_zone_high": round(price * 1.005, 2),
            "stop_loss": round(ob["low"] * 0.995 if ob else price * 0.92, 2),
            "target_1": round(price * 1.25, 2),
            "target_2": round(price * 1.60, 2),
            "rr_ratio": 2.5,
            "stop_logic": "below bullish OB",
        },
    })


# ─── Bear Agent ───────────────────────────────────────────────────

async def _bear_agent(symbol: str, market: str, ctx: dict,
                       bull_latest: dict, round_: int,
                       bull_prev: dict = None) -> dict:
    """Stress-test the bull case with SMC-aware risk analysis."""
    chart      = ctx.get("chart_data", {})
    mkt_data   = ctx.get("market_data", {})
    key_levels = chart.get("key_levels", {})
    smc        = chart.get("smc", {})
    indicators = chart.get("indicators", {})
    india_vix  = state.get("/market/india_vix") or 15
    currency   = "₹" if market == "india" else "$"
    price      = float(mkt_data.get("ltp", 0) or mkt_data.get("close", 0))

    bear_ob = smc.get("nearest_bearish_ob")
    _bear_ob_str = (
        f"{currency}{bear_ob['low']}–{bear_ob['high']} ({bear_ob['strength']}) → likely cap on bull move"
        if bear_ob else "none identified"
    )
    _bsl_sweep_note = " ← BUY-SIDE SWEPT (bearish reversal — longs being trapped)" if smc.get("liquidity_swept") == "buy_side" else ""
    smc_risk_block = (
        f"SMC RISKS:\n"
        f"  Structure: {smc.get('structure','N/A')} | Trend: {smc.get('trend','N/A')}\n"
        f"  In PREMIUM zone: {'YES — price above 50% fib, supply area, longs risky' if smc.get('in_premium') else 'No'}\n"
        f"  Bearish OB above (supply zone): {_bear_ob_str}\n"
        f"  Bearish FVGs above (unfilled supply): {smc.get('bearish_fvgs', [])}\n"
        f"  BSL above (stop hunt risk): {smc.get('bsl', [])}\n"
        f"  SSL below (liquidation cascade risk): {smc.get('ssl', [])}\n"
        f"  Liquidity swept: {smc.get('liquidity_swept') or 'none'}{_bsl_sweep_note}"
    )

    r2_block = ""
    if bull_prev:
        r2_block = (
            f"\nROUND {round_} — also challenge the bull's rebuttal:\n"
            f"Bull round 1 SMC argument: {bull_prev.get('smc_argument','N/A')}\n"
            f"Bull round 1 entry zone: {bull_prev.get('proposed_trade',{}).get('entry_zone_low')} – {bull_prev.get('proposed_trade',{}).get('entry_zone_high')}\n"
        )

    # MTF divergence check
    mtf          = ctx.get("mtf_data", {})
    mtf_summary  = mtf.get("mtf_summary", "")
    mtf_risk_block = ""
    if mtf_summary:
        d1_bias  = mtf.get("d1_bias", "neutral")
        d4_bias  = mtf.get("d4_bias", "neutral")
        d1h_bias = mtf.get("d1h_bias", "neutral")
        diverged = (
            MTF_BIAS_VALUE.get(d1_bias, 0) >= 1.0 and
            MTF_BIAS_VALUE.get(d4_bias, 0) < 1.0
        )
        mtf_risk_block = (
            f"\n── MTF ALIGNMENT (BEAR RISK CHECK) ──────────────────────────\n"
            f"Cascade: {mtf_summary}\n"
            f"{'⚠️  WARNING: 1D bullish but 4H NOT bullish — structure divergence, higher reversal risk' if diverged else '1D+4H aligned — direction confirmed'}\n"
            f"1H bias: {d1h_bias}  "
            f"15m: {mtf.get('d15m_bias','?')}  5m: {mtf.get('d5m_bias','?')}\n"
            f"Alignment score: {mtf.get('alignment_score',0):.2f} / 2.00\n"
            f"\nBEAR CHALLENGE: Is the proposed entry OB on the lower TF already mitigated?\n"
            f"  Lower TF OB zone: {currency}{mtf.get('entry_zone', [0,0])[0] if mtf.get('entry_zone') else '?'} "
            f"– {currency}{mtf.get('entry_zone', [0,0])[-1] if mtf.get('entry_zone') else '?'}\n"
            f"  If price has already visited this OB, it is MITIGATED — bull entry is invalid."
        )

    prompt = f"""You are the Bear Research Agent for {market} markets. Round {round_}/2.
Rigorously stress-test this bull case for {symbol}. Your job is risk identification, not reflexive pessimism.

── BULL THESIS TO CHALLENGE ────────────────────────────────────
{bull_latest.get('thesis', 'N/A')}
Bull proposed trade: {json.dumps(bull_latest.get('proposed_trade', {}), default=str)[:400]}
Bull conviction: {bull_latest.get('conviction_score', 5)}/10
Bull SMC argument: {bull_latest.get('smc_argument', 'N/A')}

── CURRENT MARKET DATA ─────────────────────────────────────────
Price: {currency}{price}
RSI={indicators.get('rsi')} | MACD={indicators.get('macd_signal')} | Volume={indicators.get('volume_signal')}
ADX={indicators.get('adx')} ({indicators.get('trend_strength')}) | BB={indicators.get('bb_position')}
EMA alignment={indicators.get('ema_alignment')}
{"India VIX=" + str(india_vix) + (" ← ELEVATED — longs risky" if float(india_vix) > 18 else "") if market == "india" else ""}

── SMC / STRUCTURE RISKS ───────────────────────────────────────
{smc_risk_block}

── S/R RESISTANCE LEVELS ───────────────────────────────────────
Resistance above: {key_levels.get('resistance',[])}
Fib 61.8%={key_levels.get('fib_61')} | 78.6%={key_levels.get('fib_78')} (retracement resistance){r2_block}

{mtf_risk_block}
CHALLENGE CHECKLIST — address each:
1. Is the lower-TF OB or FVG entry valid, or has price already mitigated it?
2. Is there a bearish OB / supply zone that will cap the bull move before T1?
3. Does the 4H or 1H trend agree with the 1D direction, or is there divergence?
4. Is volume confirming the pattern, or is it a low-conviction move?
5. For India: earnings proximity, promoter pledge %, FII vs DII divergence, sector rotation?
6. For Crypto: funding rate direction, OI expanding or contracting, liquidation cascade below SSL?
7. What is a realistic R:R killer — i.e., what resistance kills T1 before it is reached?
8. Should the stop be tighter (below lower-TF OB low) or wider (avoiding stop hunts)?

Respond ONLY as valid JSON (no markdown):
{{
  "primary_risk": "single biggest structural risk in one sentence with a price level",
  "bear_case_scenario": "specific scenario: if price reaches X, expect Y — cite levels",
  "key_resistance_blocking_t1": {round(bear_ob['low'] if bear_ob else price * 1.10, 2)},
  "max_loss_estimate_pct": 12.0,
  "liquidation_cascade_level": null,
  "veto_recommendation": false,
  "veto_reason": "",
  "risk_score": 4,
  "adjusted_stop": {round(price * 0.92, 2)},
  "stop_hunt_risk": "price may wick to X before reversing — widen stop to Y or wait for confirmation",
  "exit_trigger": "exit immediately if closes below LEVEL on daily/4h",
  "hedge_recommendation": "OTM put / inverse ETF / reduce size / none"
}}"""

    raw = await deep_llm(prompt, max_tokens=900)
    return _parse_json_response(raw, {
        "primary_risk": "Market risk",
        "risk_score": 5,
        "veto_recommendation": False,
        "max_loss_estimate_pct": 12.0,
        "key_resistance_blocking_t1": round(bear_ob["low"] if bear_ob else price * 1.10, 2),
        "adjusted_stop": round(price * 0.92, 2),
        "hedge_recommendation": "none",
    })


# ─── Verdict Agent ────────────────────────────────────────────────

async def _verdict_agent(symbol: str, market: str, ctx: dict,
                          bull_final: dict, bear_final: dict) -> dict:
    """Compute VERDICT_SCORE and issue final signal."""
    chart     = ctx.get("chart_data", {})
    mkt_data  = ctx.get("market_data", {})
    sentiment = ctx.get("sentiment", {})
    funds     = ctx.get("fundamentals", {})

    # ── Raw scores ────────────────────────────────────────────────
    smc        = chart.get("smc", {})
    tech_score = float(chart.get("technical_score", 5))
    sent_raw   = float(sentiment.get("sentiment_score", 0))
    sent_score = (sent_raw + 1) / 2 * 10       # −1..+1 → 0..10
    fund_score = float(funds.get("fundamental_score", 5))
    best_pattern_sr = max(
        (p.get("success_rate", 0.5) for p in chart.get("patterns_active", [])),
        default=0.5,
    )
    vol_bonus  = 0.5 if chart.get("indicators", {}).get("volume_signal") == "high_conviction" else 0
    bear_risk  = float(bear_final.get("risk_score", 5))
    bull_conv  = float(bull_final.get("conviction_score", 5))

    # ── SMC score bonus (±1.5 max) ────────────────────────────────
    smc_bonus = 0.0
    smc_struct = smc.get("structure", "")
    if smc_struct in ("bullish_bos", "choch_bullish"):
        smc_bonus += 0.5
    elif smc_struct in ("bearish_bos", "choch_bearish"):
        smc_bonus -= 0.5
    if smc.get("in_discount"):
        smc_bonus += 0.3
    elif smc.get("in_premium"):
        smc_bonus -= 0.3
    if smc.get("liquidity_swept") == "sell_side":
        smc_bonus += 0.5
    elif smc.get("liquidity_swept") == "buy_side":
        smc_bonus -= 0.5
    if smc.get("nearest_bullish_ob"):
        smc_bonus += 0.2

    # ── MTF alignment bonus (±1.5 max) ───────────────────────────
    mtf_data      = ctx.get("mtf_data", {})
    mtf_align_raw = float(mtf_data.get("alignment_score", 0))  # -2 .. +2
    higher_tf_ok  = mtf_data.get("higher_tf_aligned", None)

    # Scale to ±1.5 contribution
    mtf_bonus = mtf_align_raw * 0.75

    # Extra +0.5 when both 1D and 4H are confirmed bullish
    if higher_tf_ok is True:
        mtf_bonus += 0.5
    # Penalty when 4H disagrees with 1D (structural divergence)
    elif higher_tf_ok is False:
        mtf_bonus -= 0.8

    # ── Regime multiplier ─────────────────────────────────────────
    india_vix = float(state.get("/market/india_vix") or 15)
    regime_mult = (
        2.0 if india_vix > 30 else
        1.5 if india_vix > 22 else
        0.8 if india_vix < 13 else
        1.0
    )

    # ── VERDICT_SCORE formula ─────────────────────────────────────
    # MTF alignment replaces the simple SMC bonus weight — it subsumes it
    score = (
        tech_score      * 0.25 +
        sent_score      * 0.10 +
        fund_score      * 0.10 +
        best_pattern_sr * 10 * 0.10 +
        vol_bonus       * 10 * 0.08 +
        smc_bonus       * 10 * 0.12 +
        mtf_bonus       * 10 * 0.25 -   # MTF alignment is the biggest weight
        bear_risk       * regime_mult
    )
    score = max(0, min(10, score))

    # ── Hard veto rules ───────────────────────────────────────────
    trade  = bull_final.get("proposed_trade", {})
    rr     = float(trade.get("rr_ratio", 0))
    veto_reasons = []

    if rr > 0 and rr < MIN_RR_RATIO:
        veto_reasons.append(f"R:R ratio {rr:.1f} < minimum {MIN_RR_RATIO}")
    if bear_final.get("veto_recommendation"):
        veto_reasons.append(f"Bear veto: {bear_final.get('veto_reason', 'risk too high')}")
    if bear_risk > 8:
        veto_reasons.append(f"Bear risk score {bear_risk}/10 exceeds max 8")
    if market == "india":
        earnings_days = ctx.get("sentiment", {}).get("earnings_next_days", 99)
        if earnings_days and earnings_days <= MIN_BEAR_DAYS_TO_EARNINGS:
            veto_reasons.append(f"Earnings in {earnings_days} days — binary event risk")
        if india_vix > MAX_INDIA_VIX_FOR_LONGS:
            veto_reasons.append(f"India VIX={india_vix:.1f} > {MAX_INDIA_VIX_FOR_LONGS}")

    if veto_reasons:
        verdict = "NO_GO"
        conviction = "VETO"
        logger.info(f"  🔴 VETO {symbol}: {'; '.join(veto_reasons)}")
    elif score >= 7:
        verdict = "GO"
        conviction = "HIGH"
    elif score >= 5.5:
        verdict = "GO"
        conviction = "MEDIUM"
    elif score >= 4.5:
        verdict = "WATCH"
        conviction = "LOW"
    else:
        verdict = "NO_GO"
        conviction = "LOW"

    # ── Build position sizing + MTF/SMC-anchored levels ──────────
    position_pct = 10.0 if (verdict == "GO" and conviction == "HIGH") else 5.0
    entry    = float(trade.get("entry", mkt_data.get("ltp", 0)))

    # Prefer lower-TF OB (from MTF analysis) — tighter stop, better R:R
    mtf_entry_ob  = mtf_data.get("entry_ob")
    mtf_entry_fvg = mtf_data.get("entry_fvg")
    mtf_entry_zone= mtf_data.get("entry_zone")  # [low, high]
    mtf_entry_tf  = mtf_data.get("entry_tf", "1d")

    # Prefer OB-anchored stop over generic % stop
    ob = mtf_entry_ob or smc.get("nearest_bullish_ob")
    if ob and ob["low"] < entry:
        stop = round(ob["low"] * 0.995, 2)   # just below OB low
    else:
        stop = float(trade.get("stop_loss", entry * 0.92))
    stop_pct = abs((stop - entry) / entry * 100) if entry > 0 else 8.0

    # Entry zone: prefer lower-TF MTF zone → 1D OB → LLM proposed zone
    if mtf_entry_zone and len(mtf_entry_zone) == 2:
        entry_zone = [round(float(mtf_entry_zone[0]), 2), round(float(mtf_entry_zone[1]), 2)]
    elif ob and ob["low"] < entry * 1.01:
        entry_zone = [ob["low"], ob["high"]]
    else:
        entry_zone = [
            round(float(trade.get("entry_zone_low",  entry * 0.99)),  2),
            round(float(trade.get("entry_zone_high", entry * 1.005)), 2),
        ]

    # Build smc_analysis for UI display
    bear_ob = smc.get("nearest_bearish_ob")
    fvg     = smc.get("nearest_fvg")
    bsl_lvl = smc.get("bsl", [None])[0]
    ssl_lvl = smc.get("ssl", [None])[0]

    confluence = []
    if smc_struct in ("bullish_bos", "choch_bullish"):
        confluence.append(smc_struct.replace("_", " ").upper())
    if ob:
        confluence.append(f"BULLISH OB  {entry_zone[0]}–{entry_zone[1]}")
    if smc.get("in_discount"):
        confluence.append("DISCOUNT ZONE")
    if smc.get("liquidity_swept") == "sell_side":
        confluence.append("SSL SWEPT ✓")
    if fvg:
        confluence.append(f"FVG  {fvg['bottom']}–{fvg['top']}")

    currency = "₹" if "india" in market else "$"

    if ob:
        entry_reason = f"Buy at Bullish OB {currency}{entry_zone[0]}–{entry_zone[1]}"
        if smc.get("liquidity_swept") == "sell_side":
            entry_reason += " — SSL swept, smart money reversal confirmed"
        if smc.get("in_discount"):
            entry_reason += " — discount zone (below 50% fib)"
    elif fvg:
        entry_reason = f"Fill demand FVG at {currency}{fvg['bottom']}–{fvg['top']}"
    else:
        entry_reason = bull_final.get("smc_argument") or bull_final.get("thesis", "")[:80]

    if ob:
        stop_reason = f"Below OB low {currency}{stop} — bullish structure invalidated"
    elif smc.get("swing_low"):
        stop_reason = f"Below swing low {currency}{smc['swing_low']}"
    else:
        stop_reason = f"Technical stop at {currency}{stop} ({stop_pct:.1f}% risk)"

    t1_val = float(trade.get("target_1", entry * 1.25))
    t2_val = float(trade.get("target_2", entry * 1.60))

    if bear_ob:
        t1_reason = f"Bearish OB supply {currency}{bear_ob['low']}–{bear_ob['high']} — expect selling pressure"
    elif smc.get("swing_high"):
        t1_reason = f"Prior swing high resistance {currency}{smc['swing_high']}"
    else:
        t1_reason = bear_final.get("key_resistance_blocking_t1") or "Next resistance level"

    if bsl_lvl:
        t2_reason = f"Buy-side liquidity pool {currency}{bsl_lvl} — equal highs above"
    elif smc.get("fib_ext_127"):
        t2_reason = f"Fib 127.2% extension {currency}{chart.get('key_levels',{}).get('fib_ext_127')}"
    else:
        t2_reason = "Extended bull target"

    smc_analysis = {
        "structure":        smc_struct or "ranging",
        "trend":            smc.get("trend", "ranging"),
        "in_discount":      bool(smc.get("in_discount")),
        "in_premium":       bool(smc.get("in_premium")),
        "liquidity_swept":  smc.get("liquidity_swept"),
        "entry_confluence": confluence,
        "entry_reason":     entry_reason,
        "stop_reason":      stop_reason,
        "target_1_reason":  str(t1_reason),
        "target_2_reason":  t2_reason,
        "ob_zone":          [ob["low"], ob["high"]] if ob else None,
        "fvg_zone":         [fvg["bottom"], fvg["top"]] if fvg else None,
        "ssl":              ssl_lvl,
        "bsl":              bsl_lvl,
        "swing_high":       smc.get("swing_high"),
        "swing_low":        smc.get("swing_low"),
    }

    # Ask LLM to write the narrative
    narrative = await _generate_narrative(symbol, market, bull_final, bear_final, score, smc_analysis)

    return {
        "signal_id":    "",   # filled by caller
        "timestamp":    "",
        "market":       f"{market}_stock" if market == "india" else "crypto_futures",
        "symbol":       symbol,
        "company_name": mkt_data.get("name", symbol),
        "verdict":      verdict,
        "conviction":   conviction,
        "strategy":     bull_final.get("thesis", "")[:80],
        "narrative":    narrative,
        "veto_reasons": veto_reasons,
        "smc_structure": smc_struct or "ranging",

        "TRADE SETUP": {
            "entry_price":  round(entry, 2),
            "entry_zone":   entry_zone,
            "timeframe":    "positional_1_3m",
            "leverage":     1.0,

            "EXIT RULES — MANDATORY": {
                "target_1":        round(t1_val, 2),
                "target_1_pct":    trade.get("target_1_pct", "+25%"),
                "target_1_action": "exit 50% of position",
                "target_2":        round(t2_val, 2),
                "target_2_pct":    trade.get("target_2_pct", "+60%"),
                "target_2_action": "exit remaining 50%",
                "stop_loss":       round(stop, 2),
                "stop_loss_pct":   f"-{stop_pct:.1f}%",
                "trailing_stop":   trade.get("trailing_stop", "trail 10% below highest close after T1"),
                "time_exit":       trade.get("time_exit", f"exit by {_date_in_days(90)}"),
                "invalidation":    trade.get("invalidation", "exit if closes below stop on daily"),
                "max_hold_days":   int(trade.get("max_hold_days", 90)),
            },
        },

        "RISK MANAGEMENT": {
            "position_size_pct":        position_pct,
            "max_loss_if_stop_hit_pct": round(stop_pct * position_pct / 100, 2),
            "hedge_recommendation":     bear_final.get("hedge_recommendation", "none"),
            "stop_hunt_warning":        bear_final.get("stop_hunt_risk", ""),
        },

        "SCORE CARD": {
            "technical":       round(tech_score, 1),
            "sentiment":       round(sent_score, 1),
            "fundamental":     round(fund_score, 1),
            "smc":             round(max(-10, min(10, smc_bonus * 10)), 1),
            "mtf_alignment":   round(mtf_align_raw, 2),
            "overall":         round(score, 1),
            "bull_conviction": int(bull_conv),
            "bear_risk":       int(bear_risk),
        },

        "smc_analysis": smc_analysis,
        "mtf_summary":  mtf_data.get("mtf_summary", ""),
        "entry_tf":     mtf_entry_tf,

        "debate_summary": (
            f"Bull: {bull_final.get('thesis', '')[:80]}... | "
            f"Bear: {bear_final.get('primary_risk', 'N/A')}"
        ),
    }


async def _generate_narrative(symbol: str, market: str,
                               bull: dict, bear: dict,
                               score: float, smc: dict | None = None) -> str:
    smc_ctx = ""
    if smc:
        smc_ctx = (
            f"SMC: {smc.get('structure','').replace('_',' ')} | "
            f"Entry: {smc.get('entry_reason','')[:60]} | "
        )
    prompt = (
        f"Write exactly 2 sentences explaining why {symbol} "
        f"is a {'strong' if score >= 7 else 'valid' if score >= 5.5 else 'marginal'} trade setup.\n"
        f"Sentence 1: the primary bull setup (cite price + SMC/indicator confluence).\n"
        f"Sentence 2: the key risk to manage.\n"
        f"{smc_ctx}"
        f"Bull thesis: {bull.get('thesis','')[:120]}\n"
        f"Bear risk: {bear.get('primary_risk','')[:80]}\n"
        f"Score: {score:.1f}/10"
    )
    return await fast_llm(prompt, max_tokens=140)


# ─── Spot trade big-move scanner ─────────────────────────────────

async def run_spot_trade_scanner() -> list[dict]:
    """
    Dedicated scanner for 40-100%+ move setups.
    Runs once daily in the evening.
    """
    logger.info("▶ Spot Trade Big-Move Scanner")
    candidates = []

    # India: check for multi-year breakouts, deep value reversals
    for sym in [s.replace(".NS", "") for s in
                __import__("core.config", fromlist=["INDIA_WATCHLIST"]).INDIA_WATCHLIST]:
        try:
            data  = state.read_market_data("india", sym) or {}
            chart = state.read_chart_data("india", sym) or {}

            price    = data.get("ltp", 0)
            high_52w = data.get("52w_high", 0)
            low_52w  = data.get("52w_low", 0)
            pct_from_high = data.get("pct_from_52w_high", 0)
            fund  = state.read_fundamentals(sym) or {}
            score = chart.get("technical_score", 0)

            # Pattern 1: Multi-year breakout (price near 52w high on volume)
            if (price > 0 and high_52w > 0 and
                    price >= high_52w * 0.98 and
                    chart.get("indicators", {}).get("volume_signal") == "high_conviction"):
                candidates.append({
                    "symbol": sym, "market": "india",
                    "pattern": "multi_year_breakout",
                    "score": score, "price": price,
                    "target_pct": "+50% to +150%",
                    "thesis": f"{sym} at 52-week high on high volume — breakout signal",
                })

            # Pattern 2: Deep value reversal (down 40%+ but fundamentals intact)
            elif (pct_from_high < -40 and
                  fund.get("fundamental_score", 0) >= 6 and
                  fund.get("quality_rating") in ("high", "medium") and
                  chart.get("indicators", {}).get("rsi_signal") == "oversold"):
                candidates.append({
                    "symbol": sym, "market": "india",
                    "pattern": "deep_value_reversal",
                    "score": score, "price": price,
                    "target_pct": "+50% to +100% recovery",
                    "thesis": (
                        f"{sym} down {abs(pct_from_high):.0f}% from high "
                        f"but fundamentals intact — deep value opportunity"
                    ),
                })
        except Exception as e:
            logger.debug(f"Spot scanner {sym}: {e}")

    # Crypto: check for altseason setup, accumulation breakout
    from data.delta_client import DELTA_PERPS
    for sym in DELTA_PERPS.values():
        try:
            data  = state.read_market_data("crypto", sym) or {}
            chart = state.read_chart_data("crypto", sym) or {}
            global_sent = state.read_sentiment("crypto", "global") or {}

            fg   = global_sent.get("fear_greed", 50)
            dom  = global_sent.get("btc_dominance_pct", 55)
            score = chart.get("technical_score", 0)

            # Altseason + oversold = big opportunity
            if (sym != "BTCUSD" and fg < 35 and dom > 58 and score >= 6):
                candidates.append({
                    "symbol": sym, "market": "crypto",
                    "pattern": "altseason_oversold",
                    "score": score, "price": data.get("ltp", 0),
                    "target_pct": "+80% to +200% in altseason",
                    "thesis": (
                        f"{sym} oversold (F&G={fg}) with BTC dominance peaking "
                        f"({dom}%) — altseason rotation setup"
                    ),
                })
        except Exception as e:
            logger.debug(f"Spot scanner crypto {sym}: {e}")

    # Sort by technical score and announce top 3
    candidates.sort(key=lambda x: x.get("score", 0), reverse=True)
    top3 = candidates[:3]

    if top3:
        from notifications.telegram import send_message
        msg = "🔍 <b>Big-Move Spot Scan — Evening Report</b>\n\n"
        for i, c in enumerate(top3, 1):
            msg += (
                f"{i}. <b>{c['symbol']}</b> [{c['market'].upper()}]\n"
                f"   Pattern: {c['pattern'].replace('_', ' ').title()}\n"
                f"   Target: {c['target_pct']}\n"
                f"   Score: {c['score']:.1f}/10\n"
                f"   📝 {c['thesis']}\n\n"
            )
        msg += "<i>Full signals generated for qualifying setups above.</i>"
        await send_message(msg)
        logger.info(f"✓ Big-move scanner: {len(candidates)} candidates, top 3 sent")

    return top3


# ─── Helpers ──────────────────────────────────────────────────────

def _parse_json_response(raw: str, fallback: dict) -> dict:
    """Parse LLM JSON response with fallback."""
    try:
        import re
        # Strip markdown code fences if present
        clean = re.sub(r"```(?:json)?", "", raw).strip()
        return json.loads(clean)
    except Exception:
        logger.debug(f"JSON parse failed for response: {raw[:200]}")
        return fallback


def _date_in_days(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%d-%b-%Y")
