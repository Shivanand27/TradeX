"""
backend/main.py — TradeX Terminal entry point

Usage:
  python main.py              # Start full scheduler
  python main.py --api        # Start API server only
  python main.py --test       # Connectivity test
  python main.py --scan       # One scan cycle
"""
import argparse
import asyncio
import sys
import uvicorn
from loguru import logger

def run_api():
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True, log_level="info")

def run_scheduler():
    from scheduler import main
    main()

def run_test():
    from data.groww_client import groww
    from data.delta_client import delta_rest, build_delta_snapshot
    print("\n=== TRADEX CONNECTIVITY TEST ===\n")
    print(f"Groww:  {'✓ Connected' if groww.is_connected else '⚠ Fallback (yfinance)'}")
    snap = build_delta_snapshot()
    tickers = snap.get("tickers", {})
    btc = tickers.get("BTCUSD", {})
    print(f"Delta:  {'✓ Connected' if tickers else '✗ Failed'}" + (f"  BTC=${btc.get('ltp',0):,.0f}" if btc else ""))
    print("\nRun 'python main.py' to start the full platform.")

async def run_scan():
    from data.delta_client import build_delta_snapshot
    from agents.chart_pattern_agent import run_chart_pattern_agent
    print("Running scan...")
    build_delta_snapshot()
    r1 = await run_chart_pattern_agent("india")
    r2 = await run_chart_pattern_agent("crypto")
    print(f"India: {len(r1)} symbols  |  Crypto: {len(r2)} symbols")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--api",   action="store_true")
    parser.add_argument("--test",  action="store_true")
    parser.add_argument("--scan",  action="store_true")
    args = parser.parse_args()

    if args.api:   run_api()
    elif args.test: run_test()
    elif args.scan: asyncio.run(run_scan())
    else:           run_scheduler()
