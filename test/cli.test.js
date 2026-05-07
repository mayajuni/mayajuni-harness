import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO_ROOT, "bin", "harness-skills.js");

function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    ...options,
  });
}

test("list --json returns manifest entries", async () => {
  const { stdout } = await runCli(["list", "--json"]);
  const parsed = JSON.parse(stdout);
  const names = parsed.map((row) => row.name);
  assert.deepEqual(names, ["mj-live-browse", "video-highlight", "media-highlight"]);
});

test("validate exits 0 for the shipped catalog", async () => {
  const { stdout } = await runCli(["validate"]);
  assert.match(stdout, /OK mj-live-browse:codex/);
  assert.match(stdout, /OK mj-live-browse:claude/);
  assert.match(stdout, /OK video-highlight:codex/);
  assert.match(stdout, /OK video-highlight:claude/);
  assert.match(stdout, /OK media-highlight:codex/);
  assert.match(stdout, /OK media-highlight:claude/);
});

test("install --dry-run reports targets without writing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  try {
    const { stdout } = await runCli(
      ["install", "mj-live-browse", "--global", "--codex", "--dry-run"],
      {
        env: {
          ...process.env,
          HARNESS_CODEX_SKILLS_DIR: tmp,
        },
      },
    );
    assert.match(stdout, /\[dry-run\] global mj-live-browse:codex/);
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("install then uninstall round-trips into a scratch dir", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const env = {
    ...process.env,
    HARNESS_CODEX_SKILLS_DIR: tmp,
  };
  try {
    await runCli(
      ["install", "mj-live-browse", "--global", "--codex", "--force"],
      { env },
    );
    const installed = path.join(tmp, "mj-live-browse", "SKILL.md");
    assert.ok(fs.existsSync(installed), "expected SKILL.md after install");
    const referencesDir = path.join(tmp, "mj-live-browse", "references");
    assert.ok(
      fs.existsSync(referencesDir),
      "expected references/ to be copied",
    );

    await runCli(
      ["uninstall", "mj-live-browse", "--global", "--codex", "--yes"],
      { env },
    );
    assert.ok(
      !fs.existsSync(path.join(tmp, "mj-live-browse")),
      "expected skill dir to be removed",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude target installs the SKILL.md payload", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const env = {
    ...process.env,
    HARNESS_CLAUDE_SKILLS_DIR: tmp,
  };
  try {
    await runCli(
      ["install", "mj-live-browse", "--global", "--claude", "--force"],
      { env },
    );
    const installed = path.join(tmp, "mj-live-browse", "SKILL.md");
    assert.ok(fs.existsSync(installed), "expected SKILL.md after install");
    const referencesDir = path.join(tmp, "mj-live-browse", "references");
    assert.ok(
      fs.existsSync(referencesDir),
      "expected shared references/ to be copied for claude",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("video-highlight installs its helper scripts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const env = {
    ...process.env,
    HARNESS_CODEX_SKILLS_DIR: tmp,
  };
  try {
    await runCli(
      ["install", "video-highlight", "--global", "--codex", "--force"],
      { env },
    );
    const installed = path.join(tmp, "video-highlight", "SKILL.md");
    assert.ok(fs.existsSync(installed), "expected SKILL.md after install");
    const createScript = path.join(
      tmp,
      "video-highlight",
      "scripts",
      "create_highlight.py",
    );
    assert.ok(
      fs.existsSync(createScript),
      "expected create_highlight.py to be copied",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("media-highlight installs its analysis and render scripts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const env = {
    ...process.env,
    HARNESS_CODEX_SKILLS_DIR: tmp,
  };
  try {
    await runCli(
      ["install", "media-highlight", "--global", "--codex", "--force"],
      { env },
    );
    const installed = path.join(tmp, "media-highlight", "SKILL.md");
    assert.ok(fs.existsSync(installed), "expected SKILL.md after install");
    const analyzeScript = path.join(
      tmp,
      "media-highlight",
      "scripts",
      "analyze_media.py",
    );
    assert.ok(
      fs.existsSync(analyzeScript),
      "expected analyze_media.py to be copied",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("codex project scope defaults to .agents/skills", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  try {
    const { stdout } = await runCli(
      ["install", "mj-live-browse", "--project", "--codex", "--dry-run"],
      { cwd: tmp },
    );
    assert.match(stdout, /\[dry-run\] project mj-live-browse:codex/);
    assert.match(
      stdout,
      new RegExp(
        `${path.join(tmp, ".agents", "skills", "mj-live-browse").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude project scope defaults to .claude/skills", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  try {
    const { stdout } = await runCli(
      ["install", "mj-live-browse", "--project", "--claude", "--dry-run"],
      { cwd: tmp },
    );
    assert.match(stdout, /\[dry-run\] project mj-live-browse:claude/);
    assert.match(
      stdout,
      new RegExp(
        `${path.join(tmp, ".claude", "skills", "mj-live-browse").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("legacy install mode flags are rejected", async () => {
  await assert.rejects(
    runCli(["install", "mj-live-browse", "--global", "--codex", "--link"]),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(
        err.stderr,
        /Install mode flags are no longer supported\. Installs always copy files\./,
      );
      return true;
    },
  );
});

test("unsupported target flags are ignored when not defined in the manifest", async () => {
  const { stdout } = await runCli(["list", "--json"]);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed[0].targets, ["codex", "claude"]);
});

test("unknown command exits non-zero", async () => {
  await assert.rejects(runCli(["does-not-exist"]), (err) => {
    assert.equal(err.code, 1);
    return true;
  });
});
