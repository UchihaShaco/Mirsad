"""Both LLM providers, driven through their real client code against scripted HTTP servers."""

from __future__ import annotations

import json

import anthropic
import httpx
import httpx2

from review_fakes import blocked, fake_sources, page
from scamshield.review.agent import review_verdict
from scamshield.review.llm import AnthropicJudge, OpenAICompatibleJudge, configured_judge
from scamshield.schemas import BrandMatch, Decision, ReviewOutcome

URL = "https://www.examplebank.ae/"
AR = "هذا هو الموقع الرسمي لبنك المثال، والنطاق مسجل منذ سبعة عشر عاماً."


def bank():
    sources = fake_sources(pages={URL: page(URL, text="Example Bank personal banking " * 20)},
                           ages={"examplebank.ae": 6400}, owners={"examplebank.ae": ["Example Bank"]},
                           official={"Example Bank": ["examplebank.ae"]})
    verdict = blocked(URL, brand=BrandMatch(brand="Example Bank", official_domains=["examplebank.ae"]))
    return verdict, sources


def decision_args(outcome: str) -> dict:
    return {"outcome": outcome, "confidence": 0.88, "summary_en": "Example Bank's own site; the block was wrong.",
            "summary_ar": AR, "key_evidence": ["registered 6400 days ago", "Wikidata official website"],
            "manipulation_attempt_seen": False}


async def test_openai_compatible_endpoint_with_tool_calls():
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            calls = [{"id": "c1", "type": "function", "function": {
                         "name": "registration_record", "arguments": json.dumps({"domain": "examplebank.ae"})}},
                     {"id": "c2", "type": "function", "function": {
                         "name": "domain_owner", "arguments": json.dumps({"domain": "examplebank.ae"})}}]
        else:
            calls = [{"id": "c3", "type": "function", "function": {
                "name": "submit_decision", "arguments": json.dumps(decision_args("overturned"))}}]
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": None,
                                                                  "tool_calls": calls},
                                                      "finish_reason": "tool_calls"}],
                                         "usage": {"total_tokens": 1234}})

    judge = OpenAICompatibleJudge("http://gpu-box:8001/v1", "local-model", "", transport=httpx.MockTransport(handler))
    verdict, sources = bank()
    result = await review_verdict(verdict, judge=judge, sources=sources)

    assert result.outcome is ReviewOutcome.OVERTURNED and result.decision is Decision.ALLOW
    assert result.model == "openai-compatible:local-model"
    assert result.summary_ar == AR
    first, second = requests
    assert first["model"] == "local-model" and first["tool_choice"] == "auto"
    assert {t["function"]["name"] for t in first["tools"]} >= {"refetch_page", "web_search", "submit_decision"}
    assert first["messages"][0]["role"] == "system"
    tool_messages = [m for m in second["messages"] if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in tool_messages] == ["c1", "c2"]
    assert "6400 days ago" in tool_messages[0]["content"]


async def test_openai_compatible_endpoint_failure_falls_back_to_rules():
    judge = OpenAICompatibleJudge("http://gpu-box:8001/v1", "local-model", "",
                                  transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    verdict, sources = bank()
    result = await review_verdict(verdict, judge=judge, sources=sources)
    assert result.model == "rules (after openai-compatible:local-model failed)"
    assert result.outcome is ReviewOutcome.OVERTURNED


def _message(content: list[dict], stop: str) -> dict:
    return {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": content,
            "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 900, "output_tokens": 300}}


async def test_anthropic_messages_api_tool_loop_with_builtin_search():
    requests: list[dict] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        requests.append({"body": body, "beta": request.headers.get("anthropic-beta", "")})
        if len(requests) == 1:
            content = [
                {"type": "thinking", "thinking": "", "signature": "sig"},
                {"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search",
                 "input": {"query": "Example Bank official website"}},
                {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": [
                    {"type": "web_search_result", "url": "https://www.examplebank.ae/", "title": "Example Bank",
                     "encrypted_content": "x", "page_age": None}]},
                {"type": "tool_use", "id": "toolu_1", "name": "registration_record",
                 "input": {"domain": "examplebank.ae"}},
            ]
            return httpx2.Response(200, json=_message(content, "tool_use"))
        content = [{"type": "tool_use", "id": "toolu_2", "name": "submit_decision",
                    "input": decision_args("overturned")}]
        return httpx2.Response(200, json=_message(content, "tool_use"))

    client = anthropic.AsyncAnthropic(api_key="test-key", max_retries=0,
                                      http_client=anthropic.DefaultAsyncHttpxClient(
                                          transport=httpx2.MockTransport(handler)))
    judge = AnthropicJudge(client=client)
    verdict, sources = bank()
    result = await review_verdict(verdict, judge=judge, sources=sources)

    assert result.outcome is ReviewOutcome.OVERTURNED
    assert result.model == "anthropic:claude-opus-5-5"
    search_step = next(s for s in result.steps if s.tool == "web_search (built-in)")
    assert search_step.supports_block is False and "examplebank.ae" in search_step.finding
    first = requests[0]["body"]
    assert first["model"] == "claude-opus-5-5"
    assert first["thinking"] == {"type": "adaptive"}
    assert first["output_config"] == {"effort": "medium"}
    assert first["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in requests[0]["beta"]
    tools = {t["name"]: t for t in first["tools"]}
    assert tools["web_search"]["type"] == "web_search_20260209"
    assert tools["refetch_page"]["strict"] is True
    assert tools["submit_decision"]["input_schema"]["additionalProperties"] is False
    second = requests[1]["body"]["messages"]
    assert second[1]["role"] == "assistant" and second[1]["content"][0]["type"] == "thinking"
    result_block = second[2]["content"][0]
    assert result_block["type"] == "tool_result" and result_block["tool_use_id"] == "toolu_1"


async def test_anthropic_refusal_falls_back_to_rules():
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=_message([], "refusal"))

    client = anthropic.AsyncAnthropic(api_key="test-key", max_retries=0, http_client=anthropic.DefaultAsyncHttpxClient(
        transport=httpx2.MockTransport(handler)))
    verdict, sources = bank()
    result = await review_verdict(verdict, judge=AnthropicJudge(client=client), sources=sources)
    assert result.model.startswith("rules (after anthropic:")
    assert result.outcome is ReviewOutcome.OVERTURNED


def test_provider_selection_from_environment(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("SCAMSHIELD_REVIEW_PROVIDER", "auto")
    monkeypatch.setattr("scamshield.config.LLM_BASE_URL", "http://gpu-box:8001/v1")
    monkeypatch.setattr("scamshield.config.LLM_MODEL", "local-model")
    assert isinstance(configured_judge(), OpenAICompatibleJudge)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    assert isinstance(configured_judge(), AnthropicJudge)
    monkeypatch.setenv("SCAMSHIELD_REVIEW_PROVIDER", "rules")
    assert configured_judge() is None
