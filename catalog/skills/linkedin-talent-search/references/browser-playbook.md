# Browser Collection Playbook

Use this playbook for Sales Navigator result collection. LinkedIn UI and DOM structures can change; verify visible labels and current page structure instead of relying on old selectors.

## Command pattern

Resolve the installed skill directory, then run all commands through the runtime wrapper:

```bash
node <skill-directory>/scripts/browser-runtime.mjs agent eval "document.title + ' | ' + location.href"
node <skill-directory>/scripts/browser-runtime.mjs agent snapshot -i -c
node <skill-directory>/scripts/browser-runtime.mjs agent batch --bail "click @e10" "wait --fn \"document.body.innerText.includes('Expected label')\""
```

Use compact interactive snapshots for controls. Use targeted DOM reads for repeated card fields after verifying the current structure. Do not take full-page snapshots for every scroll step.

## Fast interaction rules

- Capture one untruncated compact snapshot for the initial live filter inventory. Afterward, use targeted snapshots or `diff snapshot`; do not repeatedly dump the full page.
- Do not pipe the initial filter inventory through `head`. Missing a later filter such as Current job title or Keywords invalidates the FilterPlan.
- Use `agent batch --bail` when refs are already known and the steps do not require an intermediate LLM decision.
- Prefer `wait --fn`, `wait --text`, `wait <selector>`, or `wait --load` over fixed multi-second sleeps.
- When no observable condition exists, start with 500–800 ms and increase only if the visible state did not change. Do not default every action to 2500–4000 ms.
- Extract all currently rendered candidate cards in one targeted `eval`; do not invoke one browser command per card.
- Take a screenshot only when the snapshot and targeted DOM read are insufficient or when preserving evidence of a blocked state.
- Do not rerun command help or rediscover stable selectors during the same run unless the UI changed.

Refs expire after UI changes. Batch only actions whose refs and expected state are already known; otherwise stop the batch, refresh the snapshot, and continue.

## Virtualized list collection

Sales Navigator can render only the currently visible subset of a result page. A single DOM read may therefore miss candidates.

For each result page:

1. Read the initially rendered cards and add new identities to the page accumulator.
2. Scroll approximately one card group or 400–600 pixels.
3. Wait for the visible candidate identity set or page state to change. Prefer a state-based wait; otherwise poll with a short 500–800 ms delay and increase only when needed.
4. Read the newly rendered cards and merge them into the page accumulator.
5. Continue until the visible list no longer advances and the page range/card count is stable.
6. Scroll to the page navigation area and verify the current page number before using Next.

If the visible set changes without increasing the accumulator, inspect whether the identity selector is wrong before continuing.

## Candidate fields

Collect fields only when visible or directly represented in the current card:

- stable result/member/lead identity used internally for deduplication;
- name;
- normalized profile path or visible profile link when available;
- location;
- headline/title;
- current role;
- current company;
- card summary/about text;
- page number and position;
- source search identifier;
- observed timestamp;
- missing-field list.

Do not preserve analytics event tracking IDs in exported candidate data. Do not download profile image binaries.

## Per-page checkpoint

Before Next:

- persist all distinct candidates found on the page;
- record the page range and visible count;
- record the cumulative unique count;
- record missing fields and extraction warnings;
- record the current URL/query state or a safe search-state hash;
- record `next_available` and the evidence used to determine it.

## Health check

Inspect visible text, title, URL, and request/error state for:

- CAPTCHA or security verification;
- identity confirmation or repeated login;
- temporary search/account restriction;
- empty or shrunken results inconsistent with the prior page;
- persistent loading, response failure, or unusually repeated page content.

Stop and mark the run partial or blocked when any signal appears. Do not retry through a restriction.

## End-of-results proof

Accept a terminal page when all of the following hold:

- the current page was fully traversed;
- the Next control is absent or visibly disabled, or navigation reports an explicit last page;
- one final stability check yields no unseen candidate identity;
- the latest checkpoint is durable.

Displayed totals can be approximate or capped. A mismatch between displayed total and accessible unique candidates must be reported, not hidden.

## Resume

On resume:

1. Load the SearchSpec and run log.
2. Re-establish the same filters and verify them visibly.
3. Navigate to the last completed page if the UI permits.
4. Re-read the boundary page and deduplicate against existing identities.
5. Continue from the first uncompleted page.

If the result ordering changed materially, record a new run segment and do not claim a perfectly continuous snapshot.
