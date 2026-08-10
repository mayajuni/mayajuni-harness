---
name: linkedin-talent-search
description: |
  Search LinkedIn Sales Navigator from a dedicated logged-in browser session using a hiring post, job description, or natural-language candidate persona; initialize and cache the live All filters schema, build verified search URLs from that profile-scoped cache, collect every accessible result page by default, and deduplicate, rank, and export candidates with evidence and completion status. Use for candidate sourcing and for explicit cache commands such as "linkedin-talent-search init", "status", "refresh", or "reset", including Korean requests such as "채용공고에 맞는 인재 찾아줘", "원하는 인재상으로 링크드인 검색해줘", "후보를 전부 가져와", or "링크드인 인재 추천해줘". This self-contained skill works in Codex and Claude Code and does not require mj-live-browse.
---

# LinkedIn Talent Search

Turn a hiring request into an auditable LinkedIn Sales Navigator search, collect all results accessible to the current account by default, and rank candidates only from observed evidence.

## Core Contract

- Default `scope` to `all_available` unless the user gives a smaller limit.
- Define `all_available` as every result page the current logged-in account can actually reach for the finalized search, not every LinkedIn member.
- Never report completion from an estimated result count alone. Require an observed end-of-results condition.
- Return partial data with an explicit stop reason when collection cannot finish.
- Treat candidate-card matching as preliminary. Do not invent experience, skills, availability, or intent that is not visible.
- Initialize mappings from the current Sales Navigator `All filters` surface and keep them in the dedicated browser profile. Never treat model memory as the cache.
- Construct search URLs only from confirmed cached query types and value IDs. Never cache or replay `sessionId` or `recentSearchParam.id`.
- Verify constructed URLs from current query state and visible filter chips. Do not require an exact displayed result count because it can change over time.
- Account for every user requirement as `primary`, `secondary`, `ranking_only`, `unsupported`, or `ambiguous` before collecting results.
- Use only an account and browser session the user is authorized to operate.

Read these references before the corresponding phase:

- Read `references/search-spec.md` before translating the hiring request or applying filters.
- Read `references/filter-schema.md` before running `init`, `status`, `refresh`, `reset`, resolving a missing filter value, or constructing a search URL.
- Read `references/browser-playbook.md` before controlling LinkedIn or paginating.
- Read `references/result-contract.md` before writing checkpoints or final outputs.

## Commands

Interpret these as skill subcommands in both Codex and Claude Code:

- `linkedin-talent-search init`: inspect every visible `All filters` control, learn confirmed URL mappings, cache fixed values, and save the first profile-scoped schema.
- `linkedin-talent-search status`: report cache state without opening or changing LinkedIn.
- `linkedin-talent-search refresh`: repeat the full live inventory and replace the schema while preserving a previous copy.
- `linkedin-talent-search reset`: reset only the filter schema cache to a recoverable backup. Do not touch the Chrome profile, login, cookies, task-tab state, or search outputs.
- Any hiring request: use the cache automatically. If it is absent, run `init` once and continue the search without asking the user to invoke a second command.

## Workflow

### 1. Normalize intent, not UI controls

Accept a pasted job description, hiring post, or natural-language candidate persona. Produce the intent portion of the SearchSpec described in `references/search-spec.md`.

- Preserve explicit must-have, preferred, and exclusion conditions separately.
- Do not silently invent a location, seniority, employer, degree, or years-of-experience requirement.
- Ask one concise clarification only when an unresolved field would materially change the search. Otherwise run a broader search and record the uncertainty.
- Generate role and technology synonyms as search candidates, but do not claim that a UI filter supports them before observing the current page.

Show a compact intent summary before browser work. If the user invoked this skill without a limit, state that the scope is `all_available`; do not ask for an additional quantity confirmation. Label this as intent, not the finalized filter plan.

### 2. Start the dedicated browser

Resolve this skill directory to an absolute path, then run:

```bash
node <skill-directory>/scripts/browser-runtime.mjs ensure
node <skill-directory>/scripts/browser-runtime.mjs agent tab list
```

The runtime uses:

- Dedicated profile: `~/.linkedin-talent-search-profile`
- Dedicated local CDP port: `9223`
- Compatibility-verified agent-browser: `0.33.2`
- Runtime requirement: Node.js `24+`
- Overrides: `LINKEDIN_TALENT_PROFILE_DIR`, `LINKEDIN_TALENT_CDP_PORT`, and `LINKEDIN_TALENT_AGENT_BROWSER_VERSION`
- Completion policy: close only a task-owned tab by default; override with `LINKEDIN_TALENT_CLOSE_ON_COMPLETE=none`

Do not reuse the `mj-live-browse` profile or port. Do not delete or move Chrome `Singleton*` lock files. If the dedicated profile is locked while its CDP endpoint is unavailable, report the block and ask the user to close or recover that browser manually.

Use `browser-runtime.mjs agent ...` for every browser command so the explicit CDP port is always preserved. The wrapper uses an installed `agent-browser` only when its version exactly matches the compatibility-verified version; otherwise it uses the pinned npm-exec version.

### 3. Resolve the filter-schema state

Run the deterministic cache helper before browser filter work:

```bash
node <skill-directory>/scripts/filter-schema.mjs status
```

- For `status`, report its result and stop. Do not start the browser merely to make the status live.
- For `reset`, run `filter-schema.mjs reset`, report the recoverable backup path, and stop.
- For explicit `init`, require an uninitialized cache. If already initialized, report `status` and explain that `refresh` is the update command.
- For explicit `refresh`, require an existing cache and perform the same full live discovery as `init`.
- For a normal search with no cache, announce the one-time automatic initialization, complete it, and continue the original request.
- For a normal search with a cache, do not reopen and traverse `All filters` before every search. Build the URL first, then use query/chip verification to detect drift. Run `refresh` only after a schema mismatch, missing control, or failed URL verification indicates that the live surface changed.

Follow `references/filter-schema.md` for full inventory, manifest validation, URL construction, missing typeahead values, and refresh behavior.

### 4. Establish the authenticated search surface

List tabs first. Reuse an existing LinkedIn people-search tab only when it already contains relevant state that should be preserved. A reused tab is not owned and must never be closed automatically.

Otherwise create a new owned tab using the run ID as `task-id`:

```bash
node <skill-directory>/scripts/browser-runtime.mjs task-tab open <run-id> "https://www.linkedin.com/sales/search/people"
node <skill-directory>/scripts/browser-runtime.mjs agent eval "document.title + ' | ' + location.href"
```

The runtime records only the generated task-tab label and ownership metadata under the dedicated profile. Record `task_id`, `owned_tab`, and the returned label in `run-log.json`. Do not treat an existing or manually opened tab as owned.

If login, SSO, 2FA, CAPTCHA, identity verification, or a security challenge appears, stop automation and ask the user to complete it in the dedicated browser. Keep the browser and task tab open and resume only after the user confirms completion. Never ask for or type account credentials.

### 5. Initialize or refresh the live filter schema when required

For `init`, `refresh`, or automatic first-run initialization:

- Create a dedicated owned task tab and open the current people-search `All filters` surface.
- Capture one complete, untruncated inventory containing every visible filter control and the keyword control.
- Account for every observed control in the schema, including controls whose URL mapping remains `unresolved` or `ui_only`.
- Determine input type, multi-select support, exclusion support, confirmed URL query type, and values observed from the resulting URL state.
- Enumerate fixed visible option lists when feasible. For typeahead taxonomies such as geography, job title, company, and school, learn the URL rule and cache only values actually selected.
- Write the observed manifest to a temporary JSON file, then run `filter-schema.mjs init --input <file>` or `refresh --input <file>`.
- Finish a successful owned init tab as `complete`; retain it on login, verification, restriction, or other blocked state.

Never claim full initialization when a visible filter control is omitted. It is acceptable for a control to be present with `urlState: unresolved` when no safe representative selection or stable URL mapping is available.

### 6. Build a FilterPlan from intent and cached capabilities

- Let the LLM map each must-have, nice-to-have, and exclusion to controls recorded in the initialized schema.
- Expand the live control only when a required typeahead value is absent from cache or the cached mapping fails verification.
- Prefer a visible `Current job title` or equivalent title control for role requirements. A broad `Function` such as Engineering is a fallback or recall aid, not a substitute when a usable title control exists.
- Check the cached keyword capability before moving a domain or technology requirement to `ranking_only` or `unsupported`.
- Treat language/profile-language controls as proxies when they do not prove spoken proficiency, and keep the verification gap explicit.
- Create and persist `filter-plan.json` using `references/search-spec.md`. Every request clause must have an observed control or an explicit disposition before proceeding.
- For a searchable nice-to-have that would over-narrow the required candidate pool, plan a secondary search instead of adding it as a hard primary filter. Union and deduplicate the primary and secondary results before ranking.
- Do not call undocumented/private APIs directly to bypass the UI or retrieve results the account cannot display.

Show a compact finalized filter plan before applying it. Do not ask for confirmation unless ambiguity would materially change who qualifies.

### 7. Construct, apply, and verify the live FilterPlan

- Write a compact URL plan containing cached control names, requested value labels, inclusion/exclusion mode, optional keywords, and page number.
- Run `filter-schema.mjs build-url --input <plan-file>`. When the control mapping is unresolved, confirm its URL query type through the live UI and save it with `record-control`. When it reports a missing typeahead value, resolve only that value in the live UI, record its observed ID with `record-value`, and rebuild.
- Navigate directly to the constructed URL. LinkedIn may add a new `sessionId`; do not persist it.
- Sanitize the resulting URL by deleting `sessionId` before passing it to `filter-schema.mjs verify-url`.
- Verify the query state and visible filter chips. Require the planned filter types, value IDs, modes, and expected filter count; treat the result estimate only as a sanity observation.
- If verification fails, invalidate the affected assumption, resolve it through the current UI, update the cache, rebuild, and verify once more. If the second attempt fails, retain the task tab and report the run blocked rather than collecting the wrong search.
- Use ref-based click/fill actions only for uncached values or UI fallback, and refresh refs after material UI changes.
- Record the exact observed UI label, selected value, inclusion/exclusion mode, and resulting estimate in `filter-plan.json`.
- If a planned control or value is unavailable at application time, remap from the current screen and record the change. Do not silently replace a title requirement with a broad function.

Capture the displayed result estimate when available. Treat it as an estimate, not proof of the final accessible count.

### 8. Collect all accessible pages and planned search passes

Follow `references/browser-playbook.md` exactly.

Run the primary search and each justified secondary search. For each page:

1. Record the page number, URL/query state, displayed range, and start time.
2. Traverse the virtualized result list slowly enough for new cards to render.
3. Extract each distinct visible card before scrolling further.
4. Preserve missing fields as `null`; never fill them from inference.
5. Deduplicate by stable profile/result identity. Keep normalized profile paths or member/lead references; do not expose analytics tracking tokens in final output.
6. Write a checkpoint before clicking Next.
7. Check for CAPTCHA, security verification, throttling, result shrinkage, repeated login, account restriction, or abnormal response state.
8. Continue until an observed terminal page, an explicit user limit, or a stop condition.

Do not use random delays or browser-fingerprint modification as a claim of safety. Pagination and result exposure remain visible to the service.

### 9. Stop safely

Stop immediately on:

- CAPTCHA, security verification, identity verification, or repeated login;
- search/account restriction, unexplained result disappearance, or persistent request failure;
- a repeated page with no new candidate identities;
- missing permission or unavailable Sales Navigator access;
- an explicit user stop request.

Do not automatically message, connect with, save, follow, or open every candidate profile. Do not rotate accounts, alter fingerprints, defeat challenges, or continue through a restriction. Keep the dedicated browser open when user intervention or later resume is needed.

### 10. Rank from evidence

Rank only after collection or after a partial stop.

- Evaluate must-have conditions first.
- Score preferred conditions only when supported by visible evidence.
- Attach evidence text/fields to every positive or negative match.
- Mark unknown requirements as `unknown`, not failed.
- Keep extraction completeness separate from candidate fit.
- Describe candidates as `preliminary_match` unless the evidence includes enough detail for a stronger label.

### 11. Produce outputs

If the user does not provide a path, create `./linkedin-talent-results/<run-id>/` in the active workspace. Follow `references/result-contract.md` and produce:

- `search-spec.json`
- `filter-plan.json`
- `candidates.jsonl`
- `candidates.csv`
- `run-log.json`
- `summary.md`

For large runs, checkpoint after every page so the task can resume without recollecting completed pages. Minimize personal data: do not download profile images or preserve unrelated analytics identifiers. Do not retain browser cookies, tokens, or captured credentials in result files.

Report:

- requested and applied search conditions;
- observed filter controls and primary/secondary search plans;
- estimated and collected unique candidate counts;
- completed and attempted pages;
- `complete`, `partial`, or `blocked` status;
- exact stop reason and resume point;
- top preliminary matches with evidence and unknowns;
- output paths.

Only use `complete` when the terminal-page proof in `references/result-contract.md` is satisfied.

After every required output is durable, finish the tab lifecycle using the actual run status:

```bash
node <skill-directory>/scripts/browser-runtime.mjs task-tab finish <run-id> complete
node <skill-directory>/scripts/browser-runtime.mjs task-tab finish <run-id> partial
node <skill-directory>/scripts/browser-runtime.mjs task-tab finish <run-id> blocked
```

`complete` closes only the tab created by `task-tab open`. `partial`, `blocked`, and any other non-complete status retain it for resume. If the user asks to keep the tab open even after success, add `--keep`. When the run reused an existing tab, `finish` reports `no_owned_tab` and closes nothing. Never close Chrome as part of automatic completion.
