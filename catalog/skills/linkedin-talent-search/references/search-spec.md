# SearchSpec

Create the intent portion before opening LinkedIn, then finalize UI mapping from the profile-scoped filter schema initialized from the live surface. Preserve the user's language in `source_request`; normalize values only when a confirmed current control requires it.

## Schema

```json
{
  "source_request": "Original job post or candidate description",
  "scope": {
    "mode": "all_available",
    "max_candidates": null
  },
  "target": {
    "job_titles": [],
    "locations": [],
    "seniority": [],
    "years_experience": { "min": null, "max": null },
    "skills": [],
    "industries": [],
    "company_sizes": [],
    "current_companies": [],
    "past_companies": [],
    "schools": [],
    "languages": [],
    "keywords": []
  },
  "requirements": {
    "must_have": [],
    "nice_to_have": [],
    "exclude": []
  },
  "assumptions": []
}
```

Do not put guessed UI control names in this file. Write live mappings to `filter-plan.json`.

## Rules

- Default to `scope.mode: all_available` and `max_candidates: null`.
- If the user says “50명만”, “첫 페이지만”, or an equivalent bound, set a finite limit.
- Generate role synonyms and technology aliases as candidates for later live mapping.
- Do not convert “experienced” into a numeric year threshold without user evidence.
- Do not convert a company location into a candidate location.
- Treat remote/hybrid/on-site conditions as ranking-only unless the candidate search UI exposes a reliable matching filter.
- Keep visa, compensation, availability, protected attributes, and subjective culture-fit claims out of inferred filters.
- If a job post contains conflicting conditions, add them to `ambiguous` and ask before searching when the conflict changes who qualifies.

## Live FilterPlan

After loading the initialized filter schema, write:

```json
{
  "observed_at": "2026-08-05T14:00:00+09:00",
  "page_url": "https://www.linkedin.com/sales/search/people...",
  "filter_schema": {
    "fingerprint": "sha256 fingerprint",
    "cache_hit": true,
    "url_verified": true,
    "resolved_values": []
  },
  "inventory": {
    "keyword_controls": ["Search keywords"],
    "filter_controls": ["Function", "Current job title", "Geography", "Profile language"]
  },
  "primary": [
    {
      "requirement": "developer role",
      "priority": "must_have",
      "observed_control": "Current job title",
      "values": ["Software Engineer", "Software Developer"],
      "mode": "include",
      "reason": "Observed title control expresses the required role more precisely than Function"
    }
  ],
  "secondary_searches": [
    {
      "requirement": "AI agent experience",
      "priority": "nice_to_have",
      "observed_control": "Search keywords",
      "query_terms": ["AI agent", "agentic AI", "LLM"],
      "reason": "Search separately to preserve recall in the primary result set"
    }
  ],
  "ranking_only": [],
  "unsupported": [],
  "ambiguous": [],
  "applied": []
}
```

### Mapping rules

- Use only control labels recorded by the current profile-scoped schema in `observed_control`.
- Inventory the full live filter surface during `init` or `refresh`; on a normal cache hit, expand only controls needed for missing values or failed verification.
- Do not mark a requirement `ranking_only` or `unsupported` before checking both the relevant structured filters and the global keyword control.
- Prefer exact role controls such as `Current job title` over broad functions. Use a function filter alone only when the title control cannot represent the request or when deliberately running a broad recall pass.
- Apply all must-have conditions that the live UI can express reliably.
- Put an expressible nice-to-have in a secondary search when applying it to the primary search would exclude otherwise qualified candidates.
- Map every requirement exactly once at planning time. If one requirement needs both a filter and later verification, record the filter in a search plan and the verification limitation in `ambiguous` or `ranking_only`.
- After each application, append the observed chip/value, query-state evidence, URL verification result, and result estimate to `applied`.

## Filter mapping order

Prefer the narrowest evidence-backed filters first:

1. Geography/location
2. Current or past job title
3. Seniority or explicit experience band
4. Industry and company characteristics
5. Current/past company or school when explicitly required
6. Skills and domain keywords
7. Exclusions supported by the visible UI

Requirements that cannot be represented reliably after live inspection remain in `ranking_only` and are evaluated against collected card evidence.

## Example

Input:

> 서울에서 근무할 수 있고 B2B SaaS 경험이 있는 5년 이상 Kotlin 백엔드 개발자를 찾아줘. AWS 경험은 우대해.

Normalized intent:

```json
{
  "scope": { "mode": "all_available", "max_candidates": null },
  "target": {
    "job_titles": ["Backend Engineer", "Backend Developer", "Software Engineer"],
    "locations": ["Seoul, South Korea"],
    "years_experience": { "min": 5, "max": null },
    "skills": ["Kotlin"],
    "keywords": ["B2B SaaS", "Kotlin"]
  },
  "requirements": {
    "must_have": ["backend role", "5+ years", "Kotlin", "B2B SaaS"],
    "nice_to_have": ["AWS"],
    "exclude": []
  }
}
```

If total years or B2B SaaS history is not visible on cards, retain those requirements as `unknown` during ranking instead of rejecting or confirming the candidate.
