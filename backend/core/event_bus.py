"""
core/event_bus.py
Thread-safe bridge between background WebSocket streams (Delta, Binance)
and the FastAPI event loop that serves frontend clients.

Usage:
  - Call register() once from the FastAPI lifespan to install the loop + broadcast fn.
  - Call emit_ticker() from any thread (Delta WS, Binance WS) to push a price tick
    to all connected frontend WebSocket clients without blocking the caller's thread.
"""
from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

_main_loop: asyncio.AbstractEventLoop | None = None
_broadcast_fn: Callable[[dict], Awaitable[None]] | None = None


def register(
    loop: asyncio.AbstractEventLoop,
    broadcast: Callable[[dict], Awaitable[None]],
) -> None:
    """Called once at startup from the FastAPI lifespan."""
    global _main_loop, _broadcast_fn
    _main_loop = loop
    _broadcast_fn = broadcast


def emit_ticker(symbol: str, price: float | str, change_pct: float) -> None:
    """
    Thread-safe: schedule a ticker broadcast on the main FastAPI event loop.
    Safe to call from Binance/Delta WS threads or any non-async context.
    """
    if not _main_loop or not _broadcast_fn or _main_loop.is_closed():
        return
    payload: dict = {
        "type":   "ticker",
        "symbol": symbol,
        "data": {
            "price":  price,
            "change": f"{change_pct:+.2f}%",
        },
    }
    asyncio.run_coroutine_threadsafe(_broadcast_fn(payload), _main_loop)


def emit_rf_signal(symbol: str, data: dict) -> None:
    """Thread-safe: push an RF [DW] signal update to all clients."""
    if not _main_loop or not _broadcast_fn or _main_loop.is_closed():
        return
    payload: dict = {"type": "rf_signal", "symbol": symbol, "data": data}
    asyncio.run_coroutine_threadsafe(_broadcast_fn(payload), _main_loop)