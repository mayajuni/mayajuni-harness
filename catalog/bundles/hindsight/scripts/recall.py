#!/usr/bin/env python3
"""Auto-recall hook for UserPromptSubmit.

Fires before each user prompt. Retrieves relevant memories from Hindsight
and injects them into the Codex context via hookSpecificOutput.additionalContext.

Flow:
  1. Read hook input from stdin (session_id, transcript_path, prompt/user_prompt)
  2. Resolve API URL
  3. Derive bank ID and ensure mission
  4. Compose multi-turn query if recallContextTurns > 1
  5. Truncate to recallMaxQueryChars
  6. Run bounded semantic recall and fast lexical browsing in parallel
  7. Rank candidates locally and discard unrelated memories
  8. Format memories and output hookSpecificOutput.additionalContext

Exit codes:
  0 — always (graceful degradation on any error)
"""

import io
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.bank import derive_bank_id, ensure_bank_mission
from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.content import (
    compose_recall_query,
    format_current_time,
    format_memories,
    read_transcript,
    truncate_recall_query,
)
from lib.daemon import get_api_url
from lib.state import write_state

LAST_RECALL_STATE = "last_recall.json"

TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/+-]*|[가-힣]{2,}")
KOREAN_SUFFIXES = (
    "해주세요",
    "에서",
    "으로",
    "하고",
    "하는",
    "되는",
    "해줘",
    "에게",
    "할",
    "한",
    "된",
    "을",
    "를",
    "은",
    "는",
    "이",
    "가",
    "로",
    "과",
    "와",
)
STOP_TERMS = {
    "the",
    "this",
    "that",
    "with",
    "from",
    "about",
    "please",
    "최근",
    "최근에",
    "관련",
    "대한",
    "어떻게",
    "무엇",
    "뭐가",
    "알려줘",
    "다시",
    "확인",
    "검토",
    "수정",
    "코드",
    "기능",
    "구현",
    "맥락",
    "ai",
    "세무사",
}
GENERIC_ASCII_TERMS = {
    "agent",
    "tool",
    "status",
    "history",
    "config",
    "code",
    "project",
    "file",
    "ai",
}
TERM_ALIASES = {
    "이미지": ("image",),
    "첨부": ("attachment", "file"),
    "업로드": ("upload",),
    "배포": ("deployment", "deploy"),
    "브랜치": ("branch",),
    "워크플로": ("workflow",),
    "히스토리": ("history",),
    "기억": ("memory",),
    "메모리": ("memory",),
    "설정": ("config", "configuration"),
    "중단": ("interrupt", "interruption"),
    "스트리밍": ("streaming",),
    "도구": ("tool",),
    "법령": ("statute", "law"),
    "판례": ("precedent", "case"),
    "비용": ("cost",),
    "모델": ("model",),
    "구조": ("architecture", "infra", "storage"),
}


def _normalize_term(term: str) -> str:
    term = term.casefold().strip("._:/+-")
    if not term or not re.fullmatch(r"[가-힣]+", term):
        return term
    for suffix in KOREAN_SUFFIXES:
        if term.endswith(suffix) and len(term) - len(suffix) >= 2:
            return term[: -len(suffix)]
    return term


def extract_recall_terms(query: str, max_queries: int = 6) -> list[str]:
    """Extract a small set of lexical probes, including common Korean/English aliases."""
    seen = set()
    base_terms = []
    for raw in TOKEN_RE.findall(query):
        term = _normalize_term(raw)
        if len(term) < 2 or term.isdigit() or term in STOP_TERMS or term in seen:
            continue
        seen.add(term)
        base_terms.append(term)

    base_terms.sort(
        key=lambda term: (
            term in TERM_ALIASES,
            term.isascii() and term not in GENERIC_ASCII_TERMS,
            len(term),
        ),
        reverse=True,
    )

    limit = max(1, max_queries)
    selected_bases = base_terms[: min(4, limit)]
    terms = list(selected_bases)
    alias_index = 0
    while len(terms) < limit:
        added_alias = False
        for term in selected_bases:
            aliases = TERM_ALIASES.get(term, ())
            if alias_index >= len(aliases):
                continue
            alias = aliases[alias_index]
            if alias not in terms:
                terms.append(alias)
                added_alias = True
            if len(terms) >= limit:
                return terms
        if not added_alias:
            break
        alias_index += 1
    for term in base_terms[len(selected_bases) :]:
        if term not in terms:
            terms.append(term)
        if len(terms) >= limit:
            return terms
    return terms


def _term_weight(term: str) -> int:
    if term.isascii():
        return 2 if term in GENERIC_ASCII_TERMS else 4
    return 2 if len(term) >= 3 else 1


def extract_direct_ascii_anchors(query: str) -> list[str]:
    """Return explicit technical identifiers that every accepted result should preserve."""
    anchors = []
    for raw in TOKEN_RE.findall(query):
        term = _normalize_term(raw)
        if (
            term.isascii()
            and len(term) >= 3
            and term not in STOP_TERMS
            and term not in GENERIC_ASCII_TERMS
            and term not in anchors
        ):
            anchors.append(term)
    return anchors


def _contains_term(corpus: str, term: str) -> bool:
    if term.isascii() and re.fullmatch(r"[a-z0-9._:+/-]+", term):
        return re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", corpus) is not None
    return term in corpus


def rank_memory_candidates(query: str, candidates: list[dict], config: dict) -> list[dict]:
    """Keep only candidates with an explicit lexical connection to the prompt."""
    terms = extract_recall_terms(query, config.get("recallRankMaxTerms", 16))
    anchors = extract_direct_ascii_anchors(query)
    if not terms:
        return []

    ranked = []
    seen_ids = set()
    for result in candidates:
        text = (result.get("text") or "").strip()
        if not text:
            continue
        memory_id = result.get("id")
        if memory_id and memory_id in seen_ids:
            continue
        canonical_text = text.split(" | ", 1)[0].casefold().strip()[:240]

        tags = " ".join(str(tag) for tag in (result.get("tags") or [])).casefold()
        corpus = f"{text.casefold()} {tags}"
        if anchors and not any(_contains_term(corpus, anchor) for anchor in anchors):
            continue
        matched = [term for term in terms if _contains_term(corpus, term)]
        score = sum(_term_weight(term) for term in matched)
        score += sum(_term_weight(term) for term in matched if _contains_term(tags, term))
        if score < max(1, int(config.get("recallMinLexicalScore", 6))):
            continue

        normalized = dict(result)
        memory_type = normalized.get("fact_type") or normalized.get("type") or ""
        normalized["type"] = memory_type
        type_bonus = {"observation": 2, "world": 1, "experience": 0}.get(memory_type, 0)
        ranked.append(
            (score, len(matched), type_bonus, normalized.get("mentioned_at") or "", canonical_text, normalized)
        )
        if memory_id:
            seen_ids.add(memory_id)

    ranked.sort(key=lambda item: item[:4], reverse=True)
    max_results = max(1, int(config.get("recallMaxResults", 4)))
    deduplicated = []
    seen_texts = set()
    for item in ranked:
        canonical_text = item[-2]
        if canonical_text in seen_texts:
            continue
        seen_texts.add(canonical_text)
        deduplicated.append(item[-1])
        if len(deduplicated) >= max_results:
            break
    return deduplicated


def trim_results_to_char_budget(results: list[dict], max_chars: int) -> list[dict]:
    """Bound locally browsed content so it cannot bypass recallMaxTokens indefinitely."""
    budget = max(200, int(max_chars))
    trimmed = []
    used = 0
    for result in results:
        text = (result.get("text") or "").strip()
        remaining = budget - used
        if remaining < 80:
            break
        if len(text) > remaining:
            text = text[: max(77, remaining - 3)].rstrip() + "..."
        copy = dict(result)
        copy["text"] = text
        trimmed.append(copy)
        used += len(text)
    return trimmed


def collect_memory_candidates(client, bank_id: str, query: str, config: dict) -> list[dict]:
    """Run semantic recall and fast lexical probes concurrently."""
    terms = extract_recall_terms(query, config.get("recallBrowseMaxQueries", 6))
    browse_enabled = config.get("recallBrowseFallback", True) and bool(terms)
    max_workers = 1 + (len(terms) if browse_enabled else 0)
    candidates = []

    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as executor:
        futures = {
            executor.submit(
                client.recall,
                bank_id=bank_id,
                query=query,
                max_tokens=config.get("recallMaxTokens", 1024),
                budget=config.get("recallBudget", "mid"),
                types=config.get("recallTypes"),
                tags=config.get("recallTags"),
                tags_match=config.get("recallTagsMatch", "any"),
                timeout=config.get("recallTimeout", 10),
            ): "semantic"
        }
        if browse_enabled:
            for term in terms:
                futures[
                    executor.submit(
                        client.list_memories,
                        bank_id=bank_id,
                        query=term,
                        limit=config.get("recallBrowseLimit", 25),
                        timeout=config.get("recallBrowseTimeout", 3),
                    )
                ] = f"browse:{term}"

        for future in as_completed(futures):
            source = futures[future]
            try:
                response = future.result()
            except Exception as e:
                debug_log(config, f"{source} recall failed: {e}")
                continue
            if source == "semantic":
                semantic = response.get("results", [])
                candidates.extend(filter_by_min_scores(semantic, config.get("recallMinScores") or {}, config))
            else:
                candidates.extend(response.get("items", []))

    return candidates


def filter_by_min_scores(results: list[dict], min_scores: dict, config: dict) -> list[dict]:
    """Drop recall results whose numeric scores are below configured floors."""
    if not min_scores:
        return results

    floors = {}
    for field, floor in min_scores.items():
        try:
            floors[field] = float(floor)
        except (TypeError, ValueError):
            debug_log(config, f"Ignoring invalid recallMinScores floor for '{field}': {floor!r}")
    if not floors:
        return results

    def passes_floors(result: dict) -> bool:
        scores = result.get("scores") or {}
        for field, floor in floors.items():
            value = scores.get(field)
            # Missing/None scores pass (fail-open): BM25-only hits lack semantic
            # scores, and passthrough rerankers report null.
            if isinstance(value, (int, float)) and value < floor:
                return False
        return True

    before_count = len(results)
    filtered = [result for result in results if passes_floors(result)]
    dropped_count = before_count - len(filtered)
    debug_log(config, f"Score floors dropped {dropped_count}/{before_count} results")
    return filtered


def main():
    if sys.platform == "win32":
        sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8', errors='replace')
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

    config = load_config()

    if not config.get("autoRecall"):
        debug_log(config, "Auto-recall disabled, exiting")
        return

    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        print("[Hindsight] Failed to read hook input", file=sys.stderr)
        return

    debug_log(config, f"Hook input keys: {list(hook_input.keys())}")

    # Extract user query — accept both "prompt" and "user_prompt" defensively
    prompt = (hook_input.get("prompt") or hook_input.get("user_prompt") or "").strip()
    if not prompt or len(prompt) < 5:
        debug_log(config, "Prompt too short for recall, skipping")
        return

    def _dbg(*a):
        debug_log(config, *a)

    try:
        api_url = get_api_url(config, debug_fn=_dbg, allow_daemon_start=False)
    except RuntimeError as e:
        print(f"[Hindsight] {e}", file=sys.stderr)
        return

    api_token = config.get("hindsightApiToken")
    try:
        client = HindsightClient(api_url, api_token)
    except ValueError as e:
        print(f"[Hindsight] Invalid API URL: {e}", file=sys.stderr)
        return

    bank_id = derive_bank_id(hook_input, config)
    ensure_bank_mission(client, bank_id, config, debug_fn=_dbg)

    # Multi-turn query composition
    recall_context_turns = config.get("recallContextTurns", 1)
    recall_max_query_chars = config.get("recallMaxQueryChars", 800)
    recall_roles = config.get("recallRoles", ["user", "assistant"])

    if recall_context_turns > 1:
        transcript_path = hook_input.get("transcript_path", "")
        messages = read_transcript(transcript_path)
        debug_log(config, f"Multi-turn context: {recall_context_turns} turns, {len(messages)} messages")
        query = compose_recall_query(prompt, messages, recall_context_turns, recall_roles)
    else:
        query = prompt

    query = truncate_recall_query(query, prompt, recall_max_query_chars)
    if len(query) > recall_max_query_chars:
        query = query[:recall_max_query_chars]

    query = query.encode('utf-8', errors='ignore').decode('utf-8')

    current_time = format_current_time()
    preamble = config.get("recallPromptPreamble", "")
    recall_timeout = config.get("recallTimeout", 10)
    recall_tags = config.get("recallTags")

    debug_log(
        config,
        f"Recalling from bank '{bank_id}', query length: {len(query)}, timeout: {recall_timeout}, tags: {recall_tags}",
    )
    candidates = collect_memory_candidates(client, bank_id, query, config)
    results = rank_memory_candidates(query, candidates, config)
    results = trim_results_to_char_budget(results, config.get("recallContextMaxChars", 1200))

    if not results:
        debug_log(config, f"No relevant memories found among {len(candidates)} candidates")
        return

    debug_log(config, f"Injecting {len(results)} relevant memories from {len(candidates)} candidates")

    memories_formatted = format_memories(results)

    context_message = (
        f"<hindsight_memories>\n"
        f"{preamble}\n"
        f"Current time - {current_time}\n\n"
        f"{memories_formatted}\n"
        f"</hindsight_memories>"
    )

    write_state(
        LAST_RECALL_STATE,
        {
            "context": context_message,
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "bank_id": bank_id,
            "result_count": len(results),
        },
    )

    # Output JSON for Codex hook system
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context_message,
        }
    }
    json.dump(output, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[Hindsight] Unexpected error in recall: {e}", file=sys.stderr)
        try:
            from lib.config import load_config

            sys.exit(2 if load_config().get("debug") else 0)
        except Exception:
            sys.exit(0)
