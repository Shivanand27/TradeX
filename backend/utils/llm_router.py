"""
utils/llm_router.py
─────────────────────────────────────────────────────
Two-tier LLM routing:

TIER 1 (Primary):  Azure OpenAI — gpt-4o deployment
TIER 2 (Fallback): Ollama       — local server, no internet required
"""
from __future__ import annotations
import asyncio
import json
import urllib.request
from loguru import logger

from core.config import (
    AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_API_VERSION, AZURE_OPENAI_DEPLOYMENT,
    OLLAMA_BASE_URL, OLLAMA_MODEL,
)
from core.state_store import state

# ─── Warn at import if Azure credentials are absent ──────────────
if not AZURE_OPENAI_API_KEY or not AZURE_OPENAI_ENDPOINT:
    logger.warning(
        "AZURE_OPENAI_API_KEY or AZURE_OPENAI_ENDPOINT not set. "
        "All LLM calls will fall through to Ollama."
    )

# ─── Azure OpenAI async client (lazy-initialised) ────────────────
_azure_client = None


def _get_azure():
    global _azure_client
    if _azure_client is None and AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT:
        try:
            from openai import AsyncAzureOpenAI
            _azure_client = AsyncAzureOpenAI(
                api_key=AZURE_OPENAI_API_KEY,
                azure_endpoint=AZURE_OPENAI_ENDPOINT,
                api_version=AZURE_OPENAI_API_VERSION,
            )
        except ImportError:
            logger.warning("openai package not installed. Run: pip install openai")
    return _azure_client


# ─── Public API ───────────────────────────────────────────────────

async def fast_llm(prompt: str, system: str = "",
                   max_tokens: int = 1024) -> str:
    """Fast call — uses Azure OpenAI primary, Ollama fallback."""
    return await _call_with_fallback(prompt, system, max_tokens, "fast_task")


async def deep_llm(prompt: str, system: str = "",
                   max_tokens: int = 2048) -> str:
    """Deep reasoning call — uses Azure OpenAI primary, Ollama fallback."""
    return await _call_with_fallback(prompt, system, max_tokens, "deep_reasoning")


# ─── Internal routing ─────────────────────────────────────────────

async def _call_with_fallback(prompt: str, system: str,
                               max_tokens: int, purpose: str) -> str:
    try:
        return await _call_azure(prompt, system, max_tokens, purpose)
    except Exception as e:
        logger.warning(f"Azure OpenAI failed ({e}). Falling back to Ollama...")
        try:
            return await _call_ollama(prompt, system, max_tokens, purpose + "_ollama")
        except Exception as e2:
            logger.error(f"Ollama fallback also failed: {e2}")
            return ""


async def _call_azure(prompt: str, system: str,
                      max_tokens: int, purpose: str) -> str:
    """Call Azure OpenAI deployment."""
    client = _get_azure()
    if not client:
        raise RuntimeError("Azure OpenAI not configured")

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    resp = await client.chat.completions.create(
        model=AZURE_OPENAI_DEPLOYMENT,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.3,
    )
    text = resp.choices[0].message.content or ""

    in_tok  = resp.usage.prompt_tokens     if resp.usage else len(prompt) // 4
    out_tok = resp.usage.completion_tokens if resp.usage else len(text)   // 4
    _track_cost("azure:" + AZURE_OPENAI_DEPLOYMENT, in_tok, out_tok, purpose)
    logger.debug(f"Azure OpenAI ({AZURE_OPENAI_DEPLOYMENT}): {in_tok}+{out_tok} tokens")
    return text


async def _call_ollama(prompt: str, system: str,
                       max_tokens: int, purpose: str) -> str:
    """Call local Ollama server (fallback, free, no internet required)."""
    _OLLAMA_TIMEOUT = 120
    _OLLAMA_MAX_TOKENS = 512

    safe_tokens = min(max_tokens, _OLLAMA_MAX_TOKENS)

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = json.dumps({
        "model":    OLLAMA_MODEL,
        "messages": messages,
        "stream":   False,
        "options":  {"num_predict": safe_tokens, "temperature": 0.3},
    }).encode()

    def _sync_call() -> str:
        req = urllib.request.Request(
            f"{OLLAMA_BASE_URL}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=_OLLAMA_TIMEOUT) as r:
            data = json.loads(r.read())
        return data.get("message", {}).get("content", "")

    text = await asyncio.to_thread(_sync_call)
    _track_cost(f"ollama:{OLLAMA_MODEL}", len(prompt) // 4, len(text) // 4, purpose)
    logger.info(f"Ollama ({OLLAMA_MODEL}) responded ({len(text)} chars)")
    return text


def _track_cost(model: str, in_tok: int, out_tok: int,
                purpose: str, cost_inr: float = 0.0) -> None:
    state.add_llm_spend(cost_inr)
    try:
        from core.database import track_llm_cost
        track_llm_cost(model, purpose, in_tok, out_tok, cost_inr)
    except Exception:
        pass


# ─── Convenience wrappers ─────────────────────────────────────────

async def classify_sentiment(text: str, context: str = "India stocks") -> str:
    """Quick sentiment classification — returns 'bullish'|'bearish'|'neutral'."""
    prompt = (
        f"Classify the sentiment of this {context} text as exactly one of: "
        f"bullish, bearish, or neutral.\n"
        f"Reply with ONLY the single word.\n\nText: {text}"
    )
    result = await fast_llm(prompt, max_tokens=10)
    result = result.strip().lower()
    return result if result in ("bullish", "bearish", "neutral") else "neutral"


async def summarise_for_agent(data: dict, role: str) -> str:
    """Convert a data dict into a concise agent-readable summary."""
    prompt = (
        f"You are a {role} for an Indian trading platform.\n"
        f"Summarise this market data in 3-5 bullet points:\n{data}\n"
        f"Be specific with numbers. No fluff."
    )
    return await fast_llm(prompt, max_tokens=512)
