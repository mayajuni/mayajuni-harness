#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_PORT = 9222;
const DEFAULT_AGENT_BROWSER_VERSION = "0.33.2";
const MINIMUM_NODE_MAJOR = 24;
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".chrome-beta-live-profile");
const DEFAULT_CLOSE_ON_COMPLETE = "tab";
const TASK_TAB_PREFIX = "mj-live";

const command = process.argv[2] ?? "help";
const commandArgs = process.argv.slice(3);
const port = parsePort(process.env.MJ_LIVE_BROWSE_CDP_PORT ?? DEFAULT_PORT);
const profileDir = path.resolve(
  process.env.MJ_LIVE_BROWSE_PROFILE_DIR ?? DEFAULT_PROFILE_DIR,
);
const agentBrowserVersion =
  process.env.MJ_LIVE_BROWSE_AGENT_BROWSER_VERSION ??
  DEFAULT_AGENT_BROWSER_VERSION;
const closeOnComplete = parseClosePolicy(
  process.env.MJ_LIVE_BROWSE_CLOSE_ON_COMPLETE ?? DEFAULT_CLOSE_ON_COMPLETE,
);

await main();

async function main() {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "config":
      printJson({
        port,
        profileDir,
        endpoint: endpointFor(port),
        agentBrowserVersion,
        minimumNodeMajor: MINIMUM_NODE_MAJOR,
        browser: detectBrowser(),
        closeOnComplete,
      });
      return;
    case "status":
      await printStatus();
      return;
    case "ensure":
      assertCompatibleNode();
      await ensureBrowser();
      return;
    case "focus":
      focusBrowser();
      return;
    case "agent":
      runAgentBrowser(commandArgs);
      return;
    case "task-tab":
      manageTaskTab(commandArgs);
      return;
    default:
      fail(`Unknown command: ${command}`, 1);
  }
}

function printHelp() {
  process.stdout.write("mj-live-browse browser runtime\n\n");
  process.stdout.write("Usage:\n");
  process.stdout.write("  browser-runtime.mjs config\n");
  process.stdout.write("  browser-runtime.mjs status\n");
  process.stdout.write("  browser-runtime.mjs ensure\n");
  process.stdout.write("  browser-runtime.mjs focus\n");
  process.stdout.write("  browser-runtime.mjs task-tab open <task-id> <url>\n");
  process.stdout.write(
    "  browser-runtime.mjs task-tab finish <task-id> <status> [--keep]\n",
  );
  process.stdout.write("  browser-runtime.mjs agent <agent-browser arguments...>\n\n");
  process.stdout.write("Environment:\n");
  process.stdout.write(`  MJ_LIVE_BROWSE_CDP_PORT (default: ${DEFAULT_PORT})\n`);
  process.stdout.write(
    `  MJ_LIVE_BROWSE_PROFILE_DIR (default: ${DEFAULT_PROFILE_DIR})\n`,
  );
  process.stdout.write(
    `  MJ_LIVE_BROWSE_AGENT_BROWSER_VERSION (default: ${DEFAULT_AGENT_BROWSER_VERSION})\n`,
  );
  process.stdout.write(
    `  MJ_LIVE_BROWSE_CLOSE_ON_COMPLETE (tab|none, default: ${DEFAULT_CLOSE_ON_COMPLETE})\n`,
  );
  process.stdout.write("  MJ_LIVE_BROWSE_CHROME_APP (macOS app override)\n");
  process.stdout.write("  MJ_LIVE_BROWSE_CHROME_PATH (Windows/Linux executable override)\n");
}

async function printStatus() {
  const version = await readCdpVersion();
  printJson({
    ready: Boolean(version),
    port,
    profileDir,
    endpoint: endpointFor(port),
    browser: version?.Browser ?? null,
  });
}

async function ensureBrowser() {
  const existing = await readCdpVersion();
  if (existing) {
    printJson({
      ready: true,
      launched: false,
      endpoint: endpointFor(port),
      profileDir,
      browser: existing.Browser ?? null,
      note: "Reused the existing CDP endpoint.",
    });
    return;
  }

  const locks = findProfileLocks(profileDir);
  if (locks.length > 0) {
    failJson(
      {
        ready: false,
        blocked: true,
        reason: "profile_lock_present",
        profileDir,
        locks,
        message:
          "The fixed profile is locked while its CDP endpoint is unavailable. Close or recover that browser manually; lock files were not changed.",
      },
      2,
    );
  }

  fs.mkdirSync(profileDir, { recursive: true });
  const launchedBrowser = launchChrome();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const version = await readCdpVersion();
    if (version) {
      printJson({
        ready: true,
        launched: true,
        launchedBrowser,
        endpoint: endpointFor(port),
        profileDir,
        browser: version.Browser ?? null,
      });
      return;
    }
    await wait(500);
  }

  failJson(
    {
      ready: false,
      blocked: true,
      reason: "cdp_start_timeout",
      endpoint: endpointFor(port),
      profileDir,
      message: "Chrome did not expose the fixed-profile CDP endpoint within 15 seconds.",
    },
    2,
  );
}

function launchChrome() {
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const browser = detectBrowser();
  if (!browser) {
    fail(
      "Chrome Beta, Google Chrome, or Chromium was not found. Install one or set the browser override environment variable.",
      2,
    );
  }

  if (browser.kind === "mac-app") {
    detach("/usr/bin/open", ["-na", browser.value, "--args", ...chromeArgs]);
    return browser.value;
  }

  detach(browser.value, chromeArgs);
  return browser.value;
}

function focusBrowser() {
  if (process.platform !== "darwin") {
    printJson({ focused: false, reason: "focus_is_only_needed_on_macos" });
    return;
  }
  const browser = detectBrowser();
  if (!browser || browser.kind !== "mac-app") {
    fail("No supported macOS Chrome application was found.", 2);
  }
  const result = spawnSync("/usr/bin/open", ["-a", browser.value], {
    stdio: "inherit",
  });
  exitFrom(result);
}

function detectBrowser() {
  if (process.platform === "darwin") {
    const override = process.env.MJ_LIVE_BROWSE_CHROME_APP;
    if (override) return { kind: "mac-app", value: override };
    if (fs.existsSync("/Applications/Google Chrome Beta.app")) {
      return { kind: "mac-app", value: "Google Chrome Beta" };
    }
    if (fs.existsSync("/Applications/Google Chrome.app")) {
      return { kind: "mac-app", value: "Google Chrome" };
    }
    return null;
  }

  const override = process.env.MJ_LIVE_BROWSE_CHROME_PATH;
  if (override && fs.existsSync(override)) {
    return { kind: "executable", value: override };
  }

  if (process.platform === "win32") {
    const executable = findWindowsChrome();
    return executable ? { kind: "executable", value: executable } : null;
  }

  const executable =
    findOnPath("google-chrome-beta") ??
    findOnPath("google-chrome") ??
    findOnPath("chromium-browser") ??
    findOnPath("chromium");
  return executable ? { kind: "executable", value: executable } : null;
}

function runAgentBrowser(args) {
  exitFrom(invokeAgentBrowser(args));
}

function invokeAgentBrowser(args) {
  assertCompatibleNode();
  if (args.length === 0) {
    fail("The agent command requires agent-browser arguments.", 1);
  }
  if (args[0] === "close" && args.includes("--all")) {
    fail("Refusing agent-browser close --all; it can close unrelated sessions.", 2);
  }

  const direct =
    findOnPath(process.platform === "win32" ? "agent-browser.cmd" : "agent-browser") ??
    findOnPath("agent-browser");
  const cdpArgs = ["--cdp", String(port), ...args];

  if (direct && readAgentBrowserVersion(direct) === agentBrowserVersion) {
    return spawnSync(direct, cdpArgs, { stdio: "inherit" });
  }

  const npm =
    findOnPath(process.platform === "win32" ? "npm.cmd" : "npm") ?? findOnPath("npm");
  if (!npm) {
    fail("agent-browser is unavailable and npm was not found for the fallback.", 2);
  }

  return spawnSync(
    npm,
    [
      "exec",
      "--yes",
      `--package=agent-browser@${agentBrowserVersion}`,
      "--",
      "agent-browser",
      ...cdpArgs,
    ],
    { stdio: "inherit" },
  );
}

function manageTaskTab(args) {
  const [operation, rawTaskId, ...rest] = args;
  const taskId = parseTaskId(rawTaskId);

  if (operation === "open") {
    openOwnedTaskTab(taskId, rest[0]);
    return;
  }
  if (operation === "finish") {
    finishOwnedTaskTab(taskId, rest[0], rest.includes("--keep"));
    return;
  }
  fail("task-tab requires open or finish.", 1);
}

function openOwnedTaskTab(taskId, url) {
  if (!url) fail("task-tab open requires a URL.", 1);
  const statePath = taskTabStatePath(taskId);
  const label = taskTabLabel(taskId);

  if (fs.existsSync(statePath)) {
    const state = readTaskTabState(statePath, taskId);
    printJson({ owned: true, created: false, reused: true, taskId, label: state.label });
    return;
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const result = invokeAgentBrowser(["tab", "new", "--label", label, url]);
  assertAgentBrowserSucceeded(result, "Could not create the owned task tab.");
  writeTaskTabState(statePath, {
    version: 1,
    owned: true,
    taskId,
    label,
    createdAt: new Date().toISOString(),
  });
  printJson({ owned: true, created: true, reused: false, taskId, label });
}

function finishOwnedTaskTab(taskId, rawStatus, keepOpen) {
  const status = parseTaskStatus(rawStatus);
  const statePath = taskTabStatePath(taskId);
  if (!fs.existsSync(statePath)) {
    printJson({ owned: false, closed: false, taskId, status, reason: "no_owned_tab" });
    return;
  }

  const state = readTaskTabState(statePath, taskId);
  if (status !== "complete") {
    printJson({
      owned: true,
      closed: false,
      retained: true,
      taskId,
      label: state.label,
      status,
      reason: "resume_may_be_needed",
    });
    return;
  }
  if (keepOpen || closeOnComplete === "none") {
    printJson({
      owned: true,
      closed: false,
      retained: true,
      taskId,
      label: state.label,
      status,
      reason: keepOpen ? "keep_requested" : "close_policy_none",
    });
    return;
  }

  const result = invokeAgentBrowser(["tab", "close", state.label]);
  assertAgentBrowserSucceeded(result, "Could not close the owned task tab.");
  fs.unlinkSync(statePath);
  printJson({ owned: true, closed: true, taskId, label: state.label, status });
}

function taskTabStatePath(taskId) {
  return path.join(profileDir, ".harness-task-tabs", `${TASK_TAB_PREFIX}-${taskId}.json`);
}

function taskTabLabel(taskId) {
  return `${TASK_TAB_PREFIX}-${taskId}`;
}

function readTaskTabState(statePath, taskId) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    fail(`Invalid task-tab state: ${error.message}`, 2);
  }
  if (
    state?.version !== 1 ||
    state?.owned !== true ||
    state?.taskId !== taskId ||
    state?.label !== taskTabLabel(taskId)
  ) {
    fail("Refusing an invalid or mismatched task-tab state file.", 2);
  }
  return state;
}

function writeTaskTabState(statePath, state) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, statePath);
}

function assertAgentBrowserSucceeded(result, message) {
  if (result.error) fail(result.error.message, 2);
  if (result.status !== 0) fail(message, result.status ?? 2);
}

function assertCompatibleNode() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < MINIMUM_NODE_MAJOR) {
    fail(
      `agent-browser ${agentBrowserVersion} requires Node.js ${MINIMUM_NODE_MAJOR} or newer; current Node.js is ${process.versions.node}.`,
      2,
    );
  }
}

function readAgentBrowserVersion(executable) {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout.match(/agent-browser\s+([^\s]+)/)?.[1] ?? null;
}

function exitFrom(result) {
  if (result.error) fail(result.error.message, 2);
  process.exitCode = result.status ?? 1;
}

function detach(executable, args) {
  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.on("error", (error) => fail(error.message, 2));
  child.unref();
}

function findWindowsChrome() {
  const candidates = [
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Google", "Chrome Beta", "Application", "chrome.exe"),
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, "Google", "Chrome Beta", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] &&
      path.join(
        process.env["PROGRAMFILES(X86)"],
        "Google",
        "Chrome Beta",
        "Application",
        "chrome.exe",
      ),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function findOnPath(name) {
  if (name.includes(path.sep) && fs.existsSync(name)) return name;
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findProfileLocks(directory) {
  return ["SingletonLock", "SingletonSocket", "SingletonCookie"]
    .map((name) => path.join(directory, name))
    .filter((lockPath) => {
      try {
        fs.lstatSync(lockPath);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    });
}

async function readCdpVersion() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`${endpointFor(port)}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function endpointFor(value) {
  return `http://127.0.0.1:${value}`;
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    fail(`Invalid MJ_LIVE_BROWSE_CDP_PORT: ${value}`, 1);
  }
  return parsed;
}

function parseClosePolicy(value) {
  if (value !== "tab" && value !== "none") {
    fail(`Invalid MJ_LIVE_BROWSE_CLOSE_ON_COMPLETE: ${value}`, 1);
  }
  return value;
}

function parseTaskId(value) {
  if (!value || !/^[A-Za-z0-9._+-]{1,80}$/.test(value)) {
    fail(
      "task-id must use 1-80 letters, digits, dots, underscores, pluses, or hyphens.",
      1,
    );
  }
  return value;
}

function parseTaskStatus(value) {
  if (!value || !/^[a-z][a-z0-9_-]{0,40}$/.test(value)) {
    fail("task status must be a lowercase status token.", 1);
  }
  return value;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function failJson(value, exitCode) {
  process.stderr.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(exitCode);
}

function fail(message, exitCode) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}
