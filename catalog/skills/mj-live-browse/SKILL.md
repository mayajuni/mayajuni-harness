---
name: mj-live-browse
description: |
  Control a real logged-in Chrome browser through a fixed-profile local CDP session and agent-browser. Use when the user asks to browse, inspect, click, type, upload, search, filter, or complete work in a website, including Korean triggers such as "브라우저로 해줘", "사이트에서 처리해줘", "클릭해줘", "입력해줘", "업로드해줘", or "페이지 봐줘". Automatically checks the browser runtime, prefers Chrome Beta with stable Chrome fallback, selects a suitable tab, and preserves the login session. Works in Codex and Claude Code.
---

# AI Live Browser Control

Operate the user's real logged-in browser with `agent-browser` through an explicit local CDP port. Continue autonomously for reversible browsing work; pause before sensitive or irreversible actions.

## Runtime Contract

- Fixed profile: `~/.chrome-beta-live-profile`
- Local CDP port: `9222`
- Compatibility-verified agent-browser: `0.33.2`
- Runtime requirement: Node.js `24+`
- Preferred browser: Google Chrome Beta
- macOS fallback: Google Chrome when Beta is not installed

Do not use a default/headless agent-browser session. Use `scripts/browser-runtime.mjs` from this skill for browser startup and every browser command. The wrapper preserves the explicit CDP port and uses exactly the compatibility-verified agent-browser version.

Supported overrides:

- `MJ_LIVE_BROWSE_CDP_PORT`
- `MJ_LIVE_BROWSE_PROFILE_DIR`
- `MJ_LIVE_BROWSE_AGENT_BROWSER_VERSION`
- `MJ_LIVE_BROWSE_CLOSE_ON_COMPLETE` (`tab` by default; set `none` to retain owned tabs)
- `MJ_LIVE_BROWSE_CHROME_APP` on macOS
- `MJ_LIVE_BROWSE_CHROME_PATH` on Windows/Linux

## Automatic Bootstrap

Resolve this skill directory to an absolute path. Run the read-only status check as its own command before launching anything:

```bash
node <skill-directory>/scripts/browser-runtime.mjs status
```

If `ready` is false, run:

```bash
node <skill-directory>/scripts/browser-runtime.mjs ensure
```

Then verify the real CDP browser:

```bash
node <skill-directory>/scripts/browser-runtime.mjs agent tab list
```

The runtime:

- reuses port `9222` when it is already ready;
- launches Chrome Beta with the fixed profile when available;
- falls back to stable Chrome without reusing the user's normal Chrome profile;
- binds remote debugging to `127.0.0.1`;
- does not add `--remote-allow-origins=*`;
- never deletes or moves `SingletonLock`, `SingletonSocket`, or `SingletonCookie`;
- blocks and reports `profile_lock_present` when the fixed profile is locked but CDP is unavailable.

If the user needs to see or configure the browser directly, bring it forward on macOS and leave it open:

```bash
node <skill-directory>/scripts/browser-runtime.mjs focus
```

If login, SSO, 2FA, CAPTCHA, or identity verification is required, ask the user to complete it in the fixed-profile browser. Never request, store, or type the user's password or recovery code.

## Tab Selection

After `tab list`, choose without asking unless the target is ambiguous:

1. Reuse a tab matching the user-provided URL or domain only when its existing state is relevant. Mark it not owned.
2. Otherwise generate a unique task ID and open a new owned tab, even when `about:blank` exists:

```bash
node <skill-directory>/scripts/browser-runtime.mjs task-tab open <task-id> "https://target.example"
```

3. Record the returned task ID and label in working state. Do not mark an existing or manually opened tab as owned.
4. Use the current tab without ownership only when the user explicitly asks to work in that exact tab.

Immediately verify title and URL:

```bash
node <skill-directory>/scripts/browser-runtime.mjs agent eval "document.title + ' | ' + location.href"
```

If the target is wrong, navigate again before interacting.

## Interaction Patterns

### Read data

Prefer targeted reads:

```bash
node <skill-directory>/scripts/browser-runtime.mjs agent get title
node <skill-directory>/scripts/browser-runtime.mjs agent get url
node <skill-directory>/scripts/browser-runtime.mjs agent eval "document.querySelector('#field')?.value"
node <skill-directory>/scripts/browser-runtime.mjs agent eval "document.body.innerText.substring(0, 2000)"
```

Use simple expressions. Split unrelated DOM mutations or reads into separate calls.

### Locate and interact

Use compact interactive snapshots when selectors are unknown:

```bash
node <skill-directory>/scripts/browser-runtime.mjs agent snapshot -i -c
node <skill-directory>/scripts/browser-runtime.mjs agent snapshot -i -c -s "form"
node <skill-directory>/scripts/browser-runtime.mjs agent click @e10
node <skill-directory>/scripts/browser-runtime.mjs agent fill @e37 "검색어"
node <skill-directory>/scripts/browser-runtime.mjs agent press Enter
```

Refresh the snapshot after navigation, modal changes, filtering, or any material DOM update. Refs are temporary.

Prefer ref-based user-like actions over `element.click()` because direct DOM clicks can produce untrusted events. If a controlled input remains disabled after `fill`, dispatch a bubbling `input` event and then `change` only when necessary. See `references/SPA-프레임워크-입력패턴.md`.

### Upload files

Resolve the file to an absolute path and use the native upload command against the file input ref:

```bash
node <skill-directory>/scripts/browser-runtime.mjs agent upload @e20 "/absolute/path/to/file"
```

Avoid opening or controlling the OS file chooser. For unusual framework/file-input cases, read `references/SPA-프레임워크-입력패턴.md`.

### Special surfaces

- iframe or modal boundary: read `references/iframe-모달-패턴.md`.
- Flutter/canvas UI with empty body text: read `references/Flutter-웹앱-패턴.md`.
- native alert/confirm behavior: read `references/native-dialog-주의사항.md`.
- external-service link transitions: read `references/외부서비스-링크전환-패턴.md`.
- command/token tradeoffs: read `references/토큰-최적화-실측데이터.md`.

Use screenshots only when visual state is necessary. Prefer text, accessibility snapshots, and targeted DOM reads for ordinary extraction.

## Safety Guards

Pause immediately before:

- final payment or purchase confirmation;
- account deletion, password change, or security-setting change;
- irreversible deletion or submission;
- sending a public message, email, application, or form when the user has not explicitly authorized sending;
- login, 2FA, CAPTCHA, identity verification, or recovery flow.

Continue without another confirmation for reversible navigation, search, filtering, pagination, drafting, form filling before submission, and read-only aggregation that matches the user's request.

Do not bypass security challenges, alter browser fingerprints, delete profile locks, or fall back to a hidden temporary browser when the fixed CDP session fails.

## Completion and Browser Lifetime

Report what was completed, what was not completed, and any user action still required.

Keep the fixed-profile browser process open so its login session remains available. After successful completion, close only a tab created through `task-tab open`:

```bash
node <skill-directory>/scripts/browser-runtime.mjs task-tab finish <task-id> complete
```

For partial, blocked, failed, user-intervention, CAPTCHA, login, or resumable work, finish with the actual non-complete status. The runtime retains the owned tab:

```bash
node <skill-directory>/scripts/browser-runtime.mjs task-tab finish <task-id> partial
node <skill-directory>/scripts/browser-runtime.mjs task-tab finish <task-id> blocked
```

If the user asks to keep the task tab open after success, add `--keep`. A reused existing tab has no ownership state, so `finish` closes nothing. Do not run `osascript ... quit`, `pkill -x`, or `close --all`; those can close unrelated browser windows or sessions.

Only when the user explicitly asks to close the live browser, close the browser attached to this skill's CDP endpoint:

```bash
node <skill-directory>/scripts/browser-runtime.mjs agent close
```

The runtime refuses `close --all`.

## Core Rules

1. Run the read-only `status` command before `ensure`.
2. Use the fixed profile and explicit CDP wrapper for every action.
3. Verify the selected tab's title and URL before work.
4. Prefer targeted reads; use `snapshot -i -c` for unknown controls.
5. Refresh refs after DOM changes.
6. Let the user handle login, 2FA, CAPTCHA, and identity checks.
7. Pause before sensitive, irreversible, or externally sent actions.
8. Never delete Chrome profile locks or use a temporary browser fallback.
9. On `complete`, close only a task-owned tab; retain reused tabs and all non-complete task tabs.
10. Never close unrelated browser sessions.
