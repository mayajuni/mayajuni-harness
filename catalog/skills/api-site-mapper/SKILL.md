---
name: api-site-mapper
description: |
  Map a logged-in web application from a starting URL by using the mj-live-browse Chrome Beta CDP pattern plus API capture to explore reachable menus and capture real API traffic, request parameters, response shapes, code-label mappings, storage keys, and page-to-endpoint relationships. Use when the user asks to inventory a website's APIs/data, reverse-map visible UI labels to API code values, document parameters, create a data dictionary, or produce an API catalog from an authenticated browser session. This skill is self-contained for Codex and Claude Code: if mj-live-browse is available, follow it; otherwise bootstrap Chrome Beta CDP/agent-browser directly from the commands in this skill.
---

# API Site Mapper

Create a fact-based API and data inventory for a web app from a URL and an authenticated browser session.

This skill documents only what can be observed from the browser: pages the current account can reach, API calls the frontend actually makes, request parameters produced by UI actions, response shapes, storage keys, and UI label to code-value evidence. Separate confirmed facts from inference.

## Core Rule

Do not claim a complete server API specification. Claim a browser-observed API inventory.

Use these evidence labels:

- `confirmed`: directly observed in a request, response, DOM option value, or repeated UI/API correlation.
- `inferred`: likely based on route shape, field name, sample value, or frontend bundle evidence.
- `needs_sample`: not enough UI states, permissions, or sample rows to confirm.
- `blocked`: login, 2FA, CAPTCHA, authorization, destructive action, or technical limitation stopped collection.

## Workflow

1. Confirm scope and permission.
   - The user must own the system or have permission to inspect it.
   - The user must log in manually when login, 2FA, CAPTCHA, or SSO is required.
   - Stop before final payment, deletion, password/account changes, or irreversible writes.

2. Start the live browser.
   - Use the Live Browser Bootstrap below. It mirrors `$mj-live-browse`, so the user can invoke only `$api-site-mapper`.
   - Keep every browser command on the explicit CDP port, usually `--cdp 9222`.
   - If a capture is incomplete because login is missing, ask the user to log in to the fixed Chrome Beta profile and resume.

3. Start network capture.
   - Use `scripts/cdp_api_capture.mjs` in a long-running terminal while exploring.
   - Capture before navigating or clicking menus so initial bootstrap APIs are included.

4. Explore reachable UI safely.
   - Build a menu/page map first from links, sidebar items, tabs, buttons, and route changes.
   - Visit each menu, tab, list, detail page, modal, filter, sort, pagination, and export/download entry where safe.
   - For forms, inspect generated payloads when possible, but do not submit destructive or irreversible actions.

5. Exercise parameter surfaces.
   - Change filters, date ranges, search fields, dropdowns, checkboxes, page size, sort columns, tabs, and row details.
   - For each action, note the visible UI state and the new request parameters or body fields.
   - Use stable sample values such as `test`, current month ranges, first visible row, and non-destructive filters.

6. Map visible labels to API values.
   - Prefer DOM `select option` text/value pairs and request values produced by selecting visible labels.
   - Correlate table/detail text with response rows.
   - Search common code endpoints such as `/codes`, `/common-code`, `/lookup`, `/enum`, `/meta`, `/options`.
   - If no code API exists, inspect frontend bundle text only as supporting evidence.

7. Build a UI semantic mapping pass.
   - For each list/detail page, capture visible filter labels, placeholders, table headers, tab labels, column labels, and dropdown labels.
   - Correlate response row fields to visible table cells using non-sensitive evidence; do not preserve real row data in final reports.
   - Extract common-code responses such as `groupCode`, `code`, and `codeName`, plus DOM option text/value pairs.
   - Record field-to-label mappings with `confirmed`, `inferred`, or `needs_sample` evidence.

8. Produce deliverables.
   - `api-inventory.md`: human-readable page/API summary.
   - `api-catalog.json`: machine-readable endpoint catalog.
   - `data-dictionary.md`: fields, types, sample values, code candidates.
   - `semantic-data-dictionary.md`: Korean field meanings and endpoint purposes, separated from raw examples.
   - `ui-field-mapping.md`: screen labels, table headers, and representative API field-to-label evidence.
   - `code-value-mapping.md`: observed code groups and code-label mappings.
   - `raw-network.json`: sanitized captured evidence.
   - Add a short `coverage` section: what was explored, not explored, and why.

## Live Browser Bootstrap

Use this section automatically before capture when a real logged-in browser session is needed.

Rules:

- Fixed Chrome profile: `$HOME/.chrome-beta-live-profile`.
- CDP port: `9222`.
- Do not ask for username/password. The user logs in manually in Chrome Beta.
- Login, 2FA, CAPTCHA, and SSO must be handled by the user.
- Use `agent-browser --cdp 9222 ...` for all browser commands.
- If `$mj-live-browse` is installed and available in the agent context, follow its full rules. If not, use the commands here.

Bootstrap:

```bash
if ! command -v agent-browser >/dev/null 2>&1; then
  npm i -g agent-browser
fi

if ! curl -s --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  lock="$HOME/.chrome-beta-live-profile/SingletonLock"
  if [ -L "$lock" ]; then
    lock_target="$(readlink "$lock" 2>/dev/null || true)"
    lock_pid="${lock_target##*-}"
    if [ -n "$lock_pid" ] && ! ps -p "$lock_pid" >/dev/null 2>&1; then
      rm -f "$HOME/.chrome-beta-live-profile/SingletonLock" \
            "$HOME/.chrome-beta-live-profile/SingletonSocket" \
            "$HOME/.chrome-beta-live-profile/SingletonCookie"
    fi
  fi

  /usr/bin/open -na "Google Chrome Beta" --args \
    --remote-debugging-port=9222 \
    "--remote-allow-origins=*" \
    "--user-data-dir=$HOME/.chrome-beta-live-profile" \
    --no-first-run \
    --no-default-browser-check

  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

agent-browser --cdp 9222 tab list
```

Tab selection:

1. If the user gave a URL/domain and a matching tab exists, use that tab.
2. Else reuse `about:blank`.
3. Else if only one tab exists, use it.
4. Else open a new tab with the target URL.
5. Immediately verify:

```bash
agent-browser --cdp 9222 eval "document.title + ' | ' + location.href"
```

If login is required, stop and ask the user to log in inside Chrome Beta. Keep the browser open and resume after the user says login is complete.

Close Chrome Beta after a completed capture/report unless login, 2FA, CAPTCHA, or user confirmation is still pending:

```bash
osascript -e 'tell application "Google Chrome Beta" to quit' || true
sleep 2
if pgrep -x "Google Chrome Beta" >/dev/null || curl -s --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  pkill -x "Google Chrome Beta" || true
fi
```

## Capture Script

Run from the skill directory or pass the absolute path:

```bash
node scripts/cdp_api_capture.mjs \
  --url "https://example.com/app" \
  --seconds 180 \
  --out ./api-map-example
```

Useful options:

- `--cdp http://127.0.0.1:9222`: Chrome DevTools endpoint.
- `--url URL`: open or attach to a tab for the URL.
- `--match TEXT`: attach to a tab whose URL contains this text.
- `--seconds N`: capture duration.
- `--out DIR`: output directory.
- `--same-origin`: only include requests from the starting origin.
- `--include-assets`: include images, CSS, fonts, and other static assets.
- `--max-body BYTES`: response/request body capture cap.

Keep the script running while using `agent-browser` or manual browser actions. When the timer ends, read the generated Markdown/JSON files and continue with another capture if a menu area was missed.

## Browser Commands

Use the live browser rules above for actual UI work. Common commands:

```bash
agent-browser --cdp 9222 eval "document.title + ' | ' + location.href"
agent-browser --cdp 9222 snapshot -i -c
agent-browser --cdp 9222 click e10
agent-browser --cdp 9222 fill e37 "test"
agent-browser --cdp 9222 press Enter
```

Avoid full snapshots unless absolutely necessary. Prefer interactive compact snapshots and targeted `eval` reads.

## Analysis Checklist

For each page/menu, record:

- Page name, URL/route, access state, and navigation path.
- APIs triggered on load and after each interaction.
- Request method, normalized path, query keys, path parameters, body fields, headers that affect behavior.
- Response status, content type, response schema, pagination envelope, and error shape if observed.
- UI text to API code mapping with evidence.
- UI semantic mapping: table headers, filter labels, placeholders, dropdown option text/value pairs, row cell-to-response-field evidence, and mapping confidence.
- localStorage/sessionStorage keys that appear to affect auth, tenant, locale, feature flags, or filters.
- Risk notes: PII, tokens, tenant identifiers, destructive actions, permission gaps.

For each endpoint, record:

- Observed pages and actions that called it.
- Parameters with examples, required/optional status if supported by evidence.
- Response fields with types and sample values.
- Code/enumeration candidates and label mappings.
- Confidence label: `confirmed`, `inferred`, `needs_sample`, or `blocked`.

## References

- `references/output-format.md`: expected Markdown/JSON sections and table shapes.
- `references/exploration-playbook.md`: safe page exploration and UI-to-API mapping tactics.
