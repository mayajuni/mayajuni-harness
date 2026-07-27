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
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "skills.json"), "utf8"),
);

function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    ...options,
  });
}

async function initGitRepo(dir) {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
}

function countHindsightHandlers(settings) {
  return Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((group) => group.hooks ?? [])
    .filter(
      (handler) =>
        typeof handler.command === "string" &&
        handler.command.includes("/.codex/hindsight/scripts/"),
    ).length;
}

test("list --json returns manifest entries", async () => {
  const { stdout } = await runCli(["list", "--json"]);
  const parsed = JSON.parse(stdout);
  const names = parsed.map((row) => row.name);
  assert.deepEqual(names, Object.keys(MANIFEST.skills));
});

test("validate exits 0 for the shipped catalog", async () => {
  const { stdout } = await runCli(["validate"]);
  for (const [skillName, skill] of Object.entries(MANIFEST.skills)) {
    for (const targetName of Object.keys(skill.targets)) {
      assert.match(stdout, new RegExp(`OK ${skillName}:${targetName}`));
    }
  }
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

test("api-site-mapper installs its capture script and references", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const env = {
    ...process.env,
    HARNESS_CODEX_SKILLS_DIR: tmp,
  };
  try {
    await runCli(
      ["install", "api-site-mapper", "--global", "--codex", "--force"],
      { env },
    );
    const installed = path.join(tmp, "api-site-mapper", "SKILL.md");
    assert.ok(fs.existsSync(installed), "expected SKILL.md after install");
    const captureScript = path.join(
      tmp,
      "api-site-mapper",
      "scripts",
      "cdp_api_capture.mjs",
    );
    assert.ok(
      fs.existsSync(captureScript),
      "expected cdp_api_capture.mjs to be copied",
    );
    const outputReference = path.join(
      tmp,
      "api-site-mapper",
      "references",
      "output-format.md",
    );
    assert.ok(
      fs.existsSync(outputReference),
      "expected output-format.md to be copied",
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

test("hindsight project bundle installs both hook targets with an explicit API URL and bank", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  try {
    await initGitRepo(tmp);
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".codex", "hooks.json"),
      JSON.stringify({
        description: "keep me",
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo existing-codex" }],
            },
          ],
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmp, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(git status)"] },
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "echo existing-claude" }],
            },
          ],
        },
      }),
    );

    const projectToken = "test-project-token-do-not-log";
    const { stdout } = await runCli(
      [
        "install",
        "hindsight",
        "--project",
        "--codex",
        "--claude",
        "--api-url=https://hindsight.example.com/",
        "--bank-id=test-bank",
      ],
      {
        cwd: tmp,
        env: {
          ...process.env,
          HINDSIGHT_API_TOKEN: projectToken,
        },
      },
    );
    assert.match(stdout, /Installed hindsight:codex/);
    assert.match(stdout, /Installed hindsight:claude/);
    assert.match(stdout, /bank=test-bank/);
    assert.doesNotMatch(stdout, new RegExp(projectToken));

    const installDir = path.join(tmp, ".codex", "hindsight");
    const secretsPath = path.join(installDir, "secrets.json");
    const settings = JSON.parse(
      fs.readFileSync(path.join(installDir, "settings.json"), "utf8"),
    );
    const metadata = JSON.parse(
      fs.readFileSync(path.join(installDir, ".harness-install.json"), "utf8"),
    );
    const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
    const installedReadme = fs.readFileSync(
      path.join(installDir, "README.md"),
      "utf8",
    );
    assert.match(installedReadme, /HINDSIGHT_API_TOKEN/);
    assert.match(installedReadme, /\.claude\/settings\.json/);
    assert.equal(
      settings.hindsightApiUrl,
      "https://hindsight.example.com",
    );
    assert.equal(settings.bankId, "test-bank");
    assert.equal(secrets.hindsightApiToken, projectToken);
    assert.equal(fs.statSync(secretsPath).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(settings), new RegExp(projectToken));
    assert.doesNotMatch(JSON.stringify(metadata), new RegExp(projectToken));
    await execFileAsync(
      "git",
      ["check-ignore", "-q", ".codex/hindsight/secrets.json"],
      { cwd: tmp },
    );
    assert.equal(settings.autoRecall, true);
    assert.equal(settings.autoRetain, true);
    assert.equal(settings.codex.retainMode, "incremental");
    assert.equal(settings.codex.retainEveryNTurns, 3);
    assert.equal(settings.claudeCode.retainEveryNTurns, 5);
    assert.equal(settings.claudeCode.sessionEndFinalRetain, true);
    assert.equal(
      fs.existsSync(path.join(tmp, ".codex", "config.toml")),
      false,
      "MCP/config.toml should not be installed",
    );

    const codexHooksPath = path.join(tmp, ".codex", "hooks.json");
    const claudeSettingsPath = path.join(tmp, ".claude", "settings.json");
    let codexHooks = JSON.parse(fs.readFileSync(codexHooksPath, "utf8"));
    let claudeSettings = JSON.parse(
      fs.readFileSync(claudeSettingsPath, "utf8"),
    );
    assert.equal(codexHooks.description, "keep me");
    assert.equal(countHindsightHandlers(codexHooks), 3);
    assert.match(JSON.stringify(codexHooks), /HINDSIGHT_BANK_ID=test-bank/);
    assert.doesNotMatch(JSON.stringify(codexHooks), /HINDSIGHT_API_URL=/);
    assert.equal(claudeSettings.permissions.allow[0], "Bash(git status)");
    assert.equal(countHindsightHandlers(claudeSettings), 4);
    assert.match(
      JSON.stringify(claudeSettings),
      /HINDSIGHT_AGENT_NAME=claude-code/,
    );

    const { stdout: forceStdout } = await runCli(
      [
        "install",
        "hindsight",
        "--project",
        "--codex",
        "--claude",
        "--api-url=https://hindsight.example.com",
        "--bank-id=test-bank",
        "--force",
      ],
      {
        cwd: tmp,
        env: {
          ...process.env,
          HINDSIGHT_API_TOKEN: "different-environment-token",
        },
      },
    );
    assert.doesNotMatch(forceStdout, new RegExp(projectToken));
    assert.equal(
      JSON.parse(fs.readFileSync(secretsPath, "utf8")).hindsightApiToken,
      projectToken,
      "expected --force to preserve the existing project token",
    );
    assert.equal(fs.statSync(secretsPath).mode & 0o777, 0o600);
    codexHooks = JSON.parse(fs.readFileSync(codexHooksPath, "utf8"));
    claudeSettings = JSON.parse(
      fs.readFileSync(claudeSettingsPath, "utf8"),
    );
    assert.equal(countHindsightHandlers(codexHooks), 3);
    assert.equal(countHindsightHandlers(claudeSettings), 4);

    const bundledTests = path.join(
      REPO_ROOT,
      "catalog",
      "bundles",
      "hindsight",
      "tests",
    );
    fs.cpSync(bundledTests, path.join(installDir, "tests"), {
      recursive: true,
    });
    const { stderr: pythonStderr } = await execFileAsync(
      "python3",
      [
        "-m",
        "unittest",
        "discover",
        "-s",
        path.join(installDir, "tests"),
        "-v",
      ],
      {
        cwd: tmp,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    assert.match(pythonStderr, /Ran 18 tests/);
    assert.match(pythonStderr, /OK/);

    await runCli(
      ["uninstall", "hindsight", "--project", "--codex", "--yes"],
      { cwd: tmp },
    );
    assert.equal(fs.existsSync(installDir), true);
    assert.equal(fs.existsSync(secretsPath), true);
    codexHooks = JSON.parse(fs.readFileSync(codexHooksPath, "utf8"));
    claudeSettings = JSON.parse(
      fs.readFileSync(claudeSettingsPath, "utf8"),
    );
    assert.equal(countHindsightHandlers(codexHooks), 0);
    assert.equal(countHindsightHandlers(claudeSettings), 4);

    await runCli(
      ["uninstall", "hindsight", "--project", "--claude", "--yes"],
      { cwd: tmp },
    );
    assert.equal(fs.existsSync(installDir), false);
    claudeSettings = JSON.parse(
      fs.readFileSync(claudeSettingsPath, "utf8"),
    );
    assert.equal(countHindsightHandlers(claudeSettings), 0);
    assert.equal(
      claudeSettings.hooks.Stop[0].hooks[0].command,
      "echo existing-claude",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("hindsight requires project scope, an API URL, and a bank ID in non-interactive mode", async () => {
  await assert.rejects(
    runCli([
      "install",
      "hindsight",
      "--global",
      "--codex",
      "--api-url=https://hindsight.example.com",
      "--bank-id=test",
    ]),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /only supports scope: project/);
      return true;
    },
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  try {
    await initGitRepo(tmp);
    await assert.rejects(
      runCli(
        [
          "install",
          "hindsight",
          "--project",
          "--codex",
          "--api-url=https://hindsight.example.com",
        ],
        { cwd: tmp },
      ),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /requires --bank-id/);
        return true;
      },
    );

    await assert.rejects(
      runCli(
        [
          "install",
          "hindsight",
          "--project",
          "--codex",
          "--bank-id=test-bank",
        ],
        { cwd: tmp },
      ),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /requires --api-url/);
        return true;
      },
    );

    await assert.rejects(
      runCli(
        [
          "install",
          "hindsight",
          "--project",
          "--codex",
          "--api-url=not-a-url",
          "--bank-id=test-bank",
        ],
        { cwd: tmp },
      ),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /Invalid Hindsight API URL/);
        return true;
      },
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
