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
  assert.ok(names.includes("starter-workflow"));
  assert.ok(names.includes("release-checklist"));
});

test("validate exits 0 for the shipped catalog", async () => {
  const { stdout } = await runCli(["validate"]);
  assert.match(stdout, /OK starter-workflow:codex/);
  assert.match(stdout, /OK starter-workflow:claude/);
  assert.match(stdout, /OK release-checklist:codex/);
});

test("install --dry-run reports targets without writing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  try {
    const { stdout } = await runCli(
      ["install", "starter-workflow", "--global", "--codex", "--copy", "--dry-run"],
      {
        env: {
          ...process.env,
          HARNESS_CODEX_SKILLS_DIR: tmp,
        },
      },
    );
    assert.match(stdout, /\[dry-run\] global copy starter-workflow:codex/);
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
      ["install", "starter-workflow", "--global", "--codex", "--copy", "--force"],
      { env },
    );
    const installed = path.join(tmp, "starter-workflow", "SKILL.md");
    assert.ok(fs.existsSync(installed), "expected SKILL.md after install");

    await runCli(
      ["uninstall", "starter-workflow", "--global", "--codex", "--yes"],
      { env },
    );
    assert.ok(
      !fs.existsSync(path.join(tmp, "starter-workflow")),
      "expected skill dir to be removed",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("unknown command exits non-zero", async () => {
  await assert.rejects(runCli(["does-not-exist"]), (err) => {
    assert.equal(err.code, 1);
    return true;
  });
});
