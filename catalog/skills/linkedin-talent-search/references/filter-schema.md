# Filter Schema Cache and URL Builder

Use this reference for `init`, `status`, `refresh`, `reset`, cache misses, and direct Sales Navigator people-search URL construction.

## Storage contract

The helper stores one schema inside the dedicated LinkedIn browser profile:

```text
~/.linkedin-talent-search-profile/.harness-linkedin-talent/filter-schema.json
```

`LINKEDIN_TALENT_PROFILE_DIR` changes the profile and therefore the cache scope. `LINKEDIN_TALENT_FILTER_SCHEMA_PATH` overrides only the schema path for tests or advanced operation.

The cache may contain filter labels, query types, option labels, and option IDs. It must not contain cookies, credentials, candidate data, `sessionId`, `recentSearchParam.id`, analytics identifiers, or captured request headers.

The same dedicated LinkedIn profile can reuse one cache from Codex and Claude Code. Different browser profiles or LinkedIn accounts must initialize independently because available Sales Navigator controls can differ.

## User commands

### `init`

Use for an explicit first-time prewarm or automatically before a normal search when `status` reports `initialized: false`.

1. Start the dedicated browser and create an owned init tab.
2. Stop for login, SSO, 2FA, CAPTCHA, identity verification, or account restriction.
3. Open `All filters` and capture one complete, untruncated interactive inventory.
4. Record every visible filter control, including disabled and account-specific controls.
5. Classify each control and learn its URL behavior as described below.
6. Write the manifest to a temporary JSON file.
7. Run `filter-schema.mjs init --input <manifest.json>`.
8. Report filter count, confirmed URL filter count, cached value count, unresolved controls, and fingerprint.
9. Close only the owned init tab on success.

If a cache already exists, do not overwrite it with `init`; use `status` or `refresh`.

### `status`

Run:

```bash
node <skill-directory>/scripts/filter-schema.mjs status
```

Report cache state only. Do not open LinkedIn for an ordinary status request. `lastVerifiedAt` describes the saved schema; it is not a live check.

### `refresh`

Repeat the full `init` inventory against the current live surface, then run:

```bash
node <skill-directory>/scripts/filter-schema.mjs refresh --input <manifest.json>
```

The helper preserves the previous schema as `filter-schema.previous.json`. Use `refresh` after a visible filter inventory change, a cached query type disappears, or URL verification fails twice.

### `reset`

Run:

```bash
node <skill-directory>/scripts/filter-schema.mjs reset
```

This moves only the schema to a timestamped recoverable backup. Never remove the Chrome profile, login data, cookies, task-tab state, or result files as part of reset.

## Full inventory procedure

Account for every control shown by `All filters`; do not inspect only the controls needed by the current hiring request.

For each control record:

- exact visible `control` label;
- current DOM `controlKey` when exposed by the filter container;
- `inputType`: for example `enum`, `typeahead`, `range`, `toggle`, `account-list`, `lead-list`, or `unknown`;
- whether multiple values can be selected;
- whether exclusion is available;
- URL `queryType`, if confirmed from the resulting query state;
- `urlState`: `confirmed`, `unresolved`, or `ui_only`;
- fixed values and IDs that were actually observed;
- a short note when behavior is account-dependent, disabled, or ambiguous.

Use a separate owned init tab so representative selections do not alter a user's existing search tab. Clear each representative selection before testing the next control.

Determine mappings from the URL produced after a ref-based UI selection. Do not assume a DOM `controlKey` is the URL `queryType`; for example, the live container can expose `GEOGRAPHY` while the selected URL uses `REGION`. A mapping is `confirmed` only when the selected value, selection mode, and resulting URL state agree.

### Fixed options

For controls whose visible options are a finite list, enumerate all options that the current account exposes when feasible. Cache only IDs observed from current query state or stable visible values; do not manufacture sequential IDs.

Examples can include profile language, function, seniority, company headcount, years bands, and boolean-style signals. Treat this list as illustrative because the live surface decides the actual controls.

### Searchable taxonomies

For geography, current/past title, company, school, industry, groups, and similar typeahead taxonomies:

- confirm the control's query type with one representative selection;
- set `inputType` to `typeahead`;
- cache only values actually selected and verified;
- retain multiple suggestions when the same user text is ambiguous;
- resolve a new value lazily during a future search and add it with `record-value`.

Do not attempt to enumerate a global typeahead taxonomy during `init`.

### UI-only or unresolved controls

Record the control even when direct URL construction is not proven:

```json
{
  "control": "People in CRM",
  "controlKey": "LEADS_IN_CRM",
  "queryType": null,
  "inputType": "toggle",
  "multiple": false,
  "supportsExclude": false,
  "urlState": "ui_only",
  "values": [],
  "notes": "Disabled for the current account"
}
```

This preserves a complete inventory without falsely claiming URL support.

## Manifest format

Example input for `init` or `refresh`:

```json
{
  "surface": "linkedin-sales-navigator-people-search",
  "locale": "en-US",
  "inventoryComplete": true,
  "observedAt": "2026-08-05T15:00:00+09:00",
  "keyword": {
    "control": "Search keywords",
    "supported": true,
    "booleanSyntax": "unverified"
  },
  "filters": [
    {
      "control": "Geography",
      "controlKey": "GEOGRAPHY",
      "queryType": "REGION",
      "inputType": "typeahead",
      "multiple": true,
      "supportsExclude": true,
      "urlState": "confirmed",
      "values": [
        {
          "id": "90000070",
          "label": "New York City Metropolitan Area",
          "selectionType": "INCLUDED",
          "source": "observed_ui_url"
        }
      ]
    },
    {
      "control": "Profile language",
      "controlKey": "PROFILE_LANGUAGE",
      "queryType": "PROFILE_LANGUAGE",
      "inputType": "enum",
      "multiple": true,
      "supportsExclude": true,
      "urlState": "confirmed",
      "values": [
        {
          "id": "ko",
          "label": "Korean",
          "selectionType": "INCLUDED",
          "source": "observed_ui_url"
        }
      ]
    }
  ]
}
```

The helper requires `inventoryComplete: true`, validates unique control labels, normalizes the keyword capability and filter mappings, computes a SHA-256 fingerprint, and writes the manifest atomically with file mode `0600`. `inventoryComplete` means every visible control was accounted for; it does not mean every global typeahead value was enumerated. Set `keyword.booleanSyntax` to `confirmed` only after paired live searches demonstrate the intended boolean behavior; URL presence alone is not enough.

## Normal search fast path

1. Run `status`.
2. If uninitialized, run the full automatic `init` and continue.
3. Map the request only to controls present in the saved schema.
4. Write a compact URL plan.
5. Run `build-url`.
6. Resolve only reported missing cached values through the live UI.
7. Navigate directly to the returned URL.
8. Verify sanitized URL state and visible chips.
9. Collect results only after verification passes.

Example URL plan:

```json
{
  "page": 1,
  "filters": [
    {
      "control": "Geography",
      "values": ["New York City Metropolitan Area"],
      "mode": "include"
    },
    {
      "control": "Current job title",
      "values": ["Software Engineer"],
      "mode": "include"
    },
    {
      "control": "Profile language",
      "values": ["Korean"],
      "mode": "include"
    }
  ],
  "keywords": "agentic OR \"AI agent\""
}
```

Build it with:

```bash
node <skill-directory>/scripts/filter-schema.mjs build-url --input <url-plan.json>
```

The output deliberately omits `sessionId` and `recentSearchParam.id`. LinkedIn can add new transient state after navigation.

## Missing value resolution

When `build-url` returns `reason: missing_cached_values`:

1. Open only the named live control.
2. Use typeahead and inspect all relevant suggestions.
3. Select the user-intended canonical value through a current ref.
4. Verify the resulting control type, value ID, label, and selection mode from the query state.
5. Record it:

```bash
node <skill-directory>/scripts/filter-schema.mjs record-value \
  --control "Current job title" \
  --label "AI Engineer" \
  --id "observed-id" \
  --selection-type INCLUDED
```

6. Clear the temporary UI selection if it was made in a resolver tab.
7. Rebuild the intended URL from the plan.

Do not silently choose the first suggestion when multiple regions, titles, schools, or companies share similar labels.

When the control exists but its `urlState` is `unresolved`, select one representative value through the live UI, confirm the URL query type, and promote the control before recording the value:

```bash
node <skill-directory>/scripts/filter-schema.mjs record-control \
  --control "Seniority level" \
  --query-type SENIORITY_LEVEL \
  --input-type enum \
  --multiple true \
  --supports-exclude true
```

Use the URL query type actually observed after selection, not the DOM control key or an inferred label conversion.

## URL verification

After navigation, remove `sessionId` from a copy of the current URL before passing it to the helper. Do not modify the live page solely to sanitize the string.

```bash
node <skill-directory>/scripts/filter-schema.mjs verify-url \
  --input <url-plan.json> \
  --url <sanitized-current-url>
```

Require:

- `matches: true` from query-state verification;
- the expected number of visible filter chips or an equivalent selected-value view;
- the expected visible labels for must-have filters;
- no login, verification, restriction, or abnormal empty state.

Do not require the displayed result estimate to equal a previously cached count. Counts can change as profiles and account visibility change.

If query verification or visible chips fail, use the current UI to repair the affected mapping and update the cache. After a second failed attempt, stop before collection and retain the task tab for diagnosis.

## Pagination URL fast path

The URL builder accepts `page`. Direct `page=N` navigation can avoid repeated pagination button discovery, but it does not remove virtual-list traversal or end-of-results proof.

For each direct page navigation:

- wait for the expected `Page N` state and result list identity change;
- fully traverse the virtualized cards;
- checkpoint before advancing;
- stop if the page repeats, renders abnormally, or produces restriction signals;
- verify the terminal page from the disabled/absent Next state, not only from an estimated page count.
