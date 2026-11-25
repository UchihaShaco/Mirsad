"""LLM judges with tool use, behind one small interface.

* `AnthropicJudge` - Claude through the Anthropic Messages API (manual tool loop, adaptive thinking,
  optional built-in web search). Used when `ANTHROPIC_API_KEY` is set.
* `OpenAICompatibleJudge` - any OpenAI-compatible `/chat/completions` endpoint with function calling
  (`SCAMSHIELD_LLM_BASE_URL` / `SCAMSHIELD_LLM_MODEL` / `SCAMSHIELD_LLM_API_KEY`), e.g. a local model server.

The judge owns the provider-specific conversation; the agent loop only sees `Turn`s.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from scamshield import config

ANTHROPIC_MODEL = os.environ.get("SCAMSHIELD_REVIEW_MODEL", "claude-opus-5-5")
ANTHROPIC_EFFORT = os.environ.get("SCAMSHIELD_REVIEW_EFFORT", "medium")
NATIVE_SEARCH = os.environ.get("SCAMSHIELD_REVIEW_NATIVE_SEARCH", "1") not in ("0", "false", "no", "")
NATIVE_SEARCH_MAX_USES = int(os.environ.get("SCAMSHIELD_REVIEW_NATIVE_SEARCH_USES", "4"))
# Models that accept the server-side refusal fallback (`fallbacks: "default"`).
_FALLBACK_MODELS = ("claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1", "claude-opus-5")


class JudgeError(RuntimeError):
    """The provider failed or declined; the review falls back to the rule-based checklist."""


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class ServerSearch:
    """A web search the provider ran itself (built-in tool); recorded as a review step."""

    query: str
    results: list[dict[str, str]]
    error: Optional[str] = None


@dataclass
class Turn:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    searches: list[ServerSearch] = field(default_factory=list)
    tokens: int = 0
    stop: str = ""


class Judge:
    name = "rules"
    native_search = False

    def start(self, system: str, user: str, tools: list[dict[str, Any]]) -> None:
        raise NotImplementedError

    async def step(self, max_tokens: int, timeout: float) -> Turn:
        raise NotImplementedError

    def add_results(self, results: list[tuple[ToolCall, str]]) -> None:
        raise NotImplementedError

    def add_user(self, text: str) -> None:
        raise NotImplementedError


class AnthropicJudge(Judge):
    def __init__(self, model: str = ANTHROPIC_MODEL, effort: str = ANTHROPIC_EFFORT,
                 native_search: bool = NATIVE_SEARCH, client: Any = None):
        import anthropic

        self._anthropic = anthropic
        self.client = client or anthropic.AsyncAnthropic(max_retries=1)
        self.model = model
        self.name = f"anthropic:{model}"
        self.effort = effort
        self.native_search = native_search
        self.system = ""
        self.tools: list[dict[str, Any]] = []
        self.messages: list[dict[str, Any]] = []

    def start(self, system: str, user: str, tools: list[dict[str, Any]]) -> None:
        self.system = system
        self.tools = [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"],
                       "strict": True}
                      for t in tools if not (self.native_search and t["name"] == "web_search")]
        if self.native_search:
            self.tools.append({"type": "web_search_20260209", "name": "web_search",
                               "max_uses": NATIVE_SEARCH_MAX_USES})
        self.messages = [{"role": "user", "content": user}]

    async def step(self, max_tokens: int, timeout: float) -> Turn:
        kwargs: dict[str, Any] = {}
        if self.model in _FALLBACK_MODELS:
            kwargs = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
        try:
            response = await self.client.with_options(timeout=timeout).beta.messages.create(
                model=self.model, max_tokens=max_tokens, system=self.system, tools=self.tools,
                messages=self.messages, thinking={"type": "adaptive"}, output_config={"effort": self.effort},
                **kwargs)
        except self._anthropic.APIStatusError as exc:
            raise JudgeError(f"Anthropic API HTTP {exc.status_code}") from exc
        except self._anthropic.APIConnectionError as exc:
            raise JudgeError(f"Anthropic API unreachable: {exc.__class__.__name__}") from exc
        if response.stop_reason == "refusal":
            raise JudgeError("the model declined the request")
        self.messages.append({"role": "assistant", "content": response.content})
        turn = Turn(stop=response.stop_reason or "",
                    tokens=(response.usage.input_tokens or 0) + (response.usage.output_tokens or 0))
        queries: dict[str, str] = {}
        for block in response.content:
            kind = getattr(block, "type", "")
            if kind == "text":
                turn.text += block.text
            elif kind == "tool_use":
                turn.tool_calls.append(ToolCall(block.id, block.name, dict(block.input or {})))
            elif kind == "server_tool_use":
                queries[block.id] = str((block.input or {}).get("query", ""))
            elif kind == "web_search_tool_result":
                content = block.content
                if isinstance(content, list):
                    results = [{"title": getattr(r, "title", "") or "", "url": getattr(r, "url", "") or "",
                                "snippet": ""} for r in content]
                    turn.searches.append(ServerSearch(queries.get(block.tool_use_id, ""), results))
                else:
                    turn.searches.append(ServerSearch(queries.get(block.tool_use_id, ""), [],
                                                      str(getattr(content, "error_code", "error"))))
        return turn

    def add_results(self, results: list[tuple[ToolCall, str]]) -> None:
        self.messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": call.id, "content": text} for call, text in results]})

    def add_user(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})


class OpenAICompatibleJudge(Judge):
    def __init__(self, base_url: Optional[str] = None, model: Optional[str] = None, api_key: Optional[str] = None,
                 transport: Optional[httpx.AsyncBaseTransport] = None):
        self.base_url = (config.LLM_BASE_URL if base_url is None else base_url).rstrip("/")
        self.model = config.LLM_MODEL if model is None else model
        self.name = f"openai-compatible:{self.model}"
        self.api_key = config.LLM_API_KEY if api_key is None else api_key
        # Server-specific request fields, e.g. {"chat_template_kwargs": {"enable_thinking": false}} for vLLM.
        self.extra_body = json.loads(os.environ.get("SCAMSHIELD_REVIEW_LLM_EXTRA_BODY", "{}") or "{}")
        self.transport = transport
        self.tools: list[dict[str, Any]] = []
        self.messages: list[dict[str, Any]] = []

    def start(self, system: str, user: str, tools: list[dict[str, Any]]) -> None:
        self.tools = [{"type": "function", "function": t} for t in tools]
        self.messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]

    async def step(self, max_tokens: int, timeout: float) -> Turn:
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        body = {"model": self.model, "messages": self.messages, "tools": self.tools, "tool_choice": "auto",
                "max_tokens": max_tokens, "temperature": 0, **self.extra_body}
        url = self.base_url if self.base_url.endswith("/chat/completions") else f"{self.base_url}/chat/completions"
        try:
            async with httpx.AsyncClient(timeout=timeout, transport=self.transport) as client:
                response = await client.post(url, json=body, headers=headers)
            response.raise_for_status()
            data = response.json()
            message = data["choices"][0]["message"]
        except httpx.HTTPStatusError as exc:
            raise JudgeError(f"LLM endpoint HTTP {exc.response.status_code}") from exc
        except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
            raise JudgeError(f"LLM endpoint failed: {exc.__class__.__name__}") from exc
        calls = []
        for raw in message.get("tool_calls") or []:
            fn = raw.get("function", {})
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args) if args.strip() else {}
                except ValueError:
                    args = {"_unparsed": args[:500]}
            calls.append(ToolCall(raw.get("id") or f"call_{len(calls)}", fn.get("name", ""),
                                  args if isinstance(args, dict) else {}))
        self.messages.append({"role": "assistant", "content": message.get("content") or "",
                              **({"tool_calls": message["tool_calls"]} if message.get("tool_calls") else {})})
        usage = data.get("usage") or {}
        return Turn(text=message.get("content") or "", tool_calls=calls,
                    tokens=int(usage.get("total_tokens") or 0), stop=data["choices"][0].get("finish_reason") or "")

    def add_results(self, results: list[tuple[ToolCall, str]]) -> None:
        for call, text in results:
            self.messages.append({"role": "tool", "tool_call_id": call.id, "content": text})

    def add_user(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})


def configured_judge() -> Optional[Judge]:
    """The judge the environment configures, or None for the rule-based review.

    `SCAMSHIELD_REVIEW_PROVIDER` = auto (default) | anthropic | openai | rules.
    """
    choice = os.environ.get("SCAMSHIELD_REVIEW_PROVIDER", "auto").lower()
    if choice in ("rules", "none", "off"):
        return None
    if choice in ("auto", "anthropic") and os.environ.get("ANTHROPIC_API_KEY"):
        try:
            return AnthropicJudge()
        except ImportError:
            if choice == "anthropic":
                return None
    if choice in ("auto", "openai") and config.LLM_BASE_URL and config.LLM_MODEL:
        return OpenAICompatibleJudge()
    return None
