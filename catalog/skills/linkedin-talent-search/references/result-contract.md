# Result Contract

Write durable, auditable outputs. A successful browser command or nonzero candidate count is not proof of complete collection.

Keep `search-spec.json` as the user's normalized intent. Keep the live filter inventory, primary and secondary searches, applied values, and query-state evidence in `filter-plan.json`. The final summary must distinguish requested intent from filters actually applied.

## Run status

Use exactly one status:

- `complete`: observed the terminal page and completed its checkpoint.
- `partial`: collected one or more candidates but stopped before terminal proof.
- `blocked`: could not collect candidates because authentication, access, security, or technical state blocked the run.

Recommended `run-log.json` shape:

```json
{
  "run_id": "20260805T101500+0900-example",
  "status": "partial",
  "requested_scope": "all_available",
  "estimated_total": 1000,
  "collected_unique": 375,
  "pages_completed": 15,
  "last_completed_page": 15,
  "terminal_page_observed": false,
  "stop_reason": "security_verification_detected",
  "filter_schema": {
    "fingerprint": "sha256 fingerprint",
    "cache_hit": true,
    "missing_values_resolved": [],
    "url_verified": true
  },
  "browser": {
    "task_id": "20260805T101500+0900-example",
    "owned_tab": true,
    "tab_label": "linkedin-talent-20260805T101500+0900-example",
    "close_on_complete": "tab",
    "tab_closed": false
  },
  "resume": {
    "possible": true,
    "next_page": 16
  },
  "started_at": "2026-08-05T10:15:00+09:00",
  "finished_at": "2026-08-05T10:42:00+09:00",
  "page_checkpoints": []
}
```

`stop_reason` examples:

- `end_of_results`
- `user_limit_reached`
- `user_stopped`
- `login_required`
- `captcha_detected`
- `security_verification_detected`
- `account_or_search_restriction`
- `sales_navigator_unavailable`
- `repeated_page_without_new_ids`
- `persistent_browser_or_response_failure`

## Candidate record

Write one JSON object per line in `candidates.jsonl`:

```json
{
  "candidate_id": "stable-normalized-reference",
  "name": "Visible name",
  "profile_path": "/sales/lead/...",
  "location": "Seoul, South Korea",
  "headline": "Senior Backend Engineer",
  "current_role": "Backend Engineer",
  "current_company": "Example Co",
  "summary": "Visible card summary",
  "source": {
    "search_id": "safe-search-id",
    "page": 3,
    "position": 7,
    "observed_at": "2026-08-05T10:21:00+09:00"
  },
  "missing_fields": [],
  "match": {
    "label": "preliminary_match",
    "score": 78,
    "must_have": [],
    "nice_to_have": [],
    "unknown": [],
    "evidence": []
  }
}
```

## Deduplication

Prefer, in order:

1. stable normalized LinkedIn member/lead reference;
2. normalized profile path;
3. a documented fallback composite such as normalized name + current company + current role.

Never merge two candidates solely because they share a name. Record fallback-key collisions as warnings.

## CSV

Include stable review columns:

- `candidate_id`
- `name`
- `profile_path`
- `location`
- `headline`
- `current_role`
- `current_company`
- `summary`
- `source_page`
- `source_position`
- `match_score`
- `match_label`
- `match_evidence`
- `unknown_requirements`
- `missing_fields`

## Summary

Lead `summary.md` with:

1. completion status and exact collected count;
2. requested intent versus live filters actually applied;
3. primary and secondary searches, including deduplication counts;
4. pages completed and stop reason;
5. top preliminary matches with evidence;
6. unknown or unavailable information;
7. output file links or paths.

Do not use “전체 수집 완료” unless `terminal_page_observed` is true and the terminal page checkpoint was written successfully.

After durable output generation, run the task-tab finish command with the final status. Update `browser.tab_closed` from its result. A non-complete run must retain an owned tab for resume; a complete run closes it unless the user requested `--keep` or configured the close policy as `none`.
