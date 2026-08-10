import { execFile } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
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

async function listenOnLoopback(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  server.close();
  await once(server, "close");
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

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
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
    assert.ok(
      fs.existsSync(
        path.join(tmp, "mj-live-browse", "scripts", "browser-runtime.mjs"),
      ),
      "expected browser runtime to be copied",
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
    assert.ok(
      fs.existsSync(
        path.join(tmp, "mj-live-browse", "scripts", "browser-runtime.mjs"),
      ),
      "expected shared browser runtime for claude",
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

test("linkedin-talent-search installs the shared Codex and Claude payload", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const codexRoot = path.join(tmp, "codex");
  const claudeRoot = path.join(tmp, "claude");
  const env = {
    ...process.env,
    HARNESS_CODEX_SKILLS_DIR: codexRoot,
    HARNESS_CLAUDE_SKILLS_DIR: claudeRoot,
  };

  try {
    await runCli(
      [
        "install",
        "linkedin-talent-search",
        "--global",
        "--codex",
        "--claude",
        "--force",
      ],
      { env },
    );

    for (const root of [codexRoot, claudeRoot]) {
      const skillDir = path.join(root, "linkedin-talent-search");
      assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")));
      assert.ok(
        fs.existsSync(path.join(skillDir, "agents", "openai.yaml")),
      );
      assert.ok(
        fs.existsSync(
          path.join(skillDir, "scripts", "browser-runtime.mjs"),
        ),
      );
      assert.ok(
        fs.existsSync(
          path.join(skillDir, "scripts", "filter-schema.mjs"),
        ),
      );
      assert.ok(
        fs.existsSync(
          path.join(skillDir, "references", "result-contract.md"),
        ),
      );
      assert.ok(
        fs.existsSync(
          path.join(skillDir, "references", "filter-schema.md"),
        ),
      );
      assert.match(
        fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"),
        /Resolve the filter-schema state/,
      );
      assert.match(
        fs.readFileSync(
          path.join(skillDir, "references", "search-spec.md"),
          "utf8",
        ),
        /Live FilterPlan/,
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        [path.join(skillDir, "scripts", "browser-runtime.mjs"), "--help"],
        { env },
      );
      assert.match(stdout, /LinkedIn Talent Search browser runtime/);
      assert.match(stdout, /default: 0\.33\.2/);
      assert.match(stdout, /CLOSE_ON_COMPLETE \(tab\|none, default: tab\)/);

      const { stdout: filterHelp } = await execFileAsync(
        process.execPath,
        [path.join(skillDir, "scripts", "filter-schema.mjs"), "--help"],
        { env },
      );
      assert.match(filterHelp, /filter schema cache/);
      assert.match(filterHelp, /build-url/);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test(
  "browser runtimes execute a compatible direct agent-browser only once",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
    const binDir = path.join(tmp, "bin");
    const callLog = path.join(tmp, "calls.log");
    fs.mkdirSync(binDir, { recursive: true });
    writeExecutable(
      path.join(binDir, "agent-browser"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agent-browser 0.33.2"
  exit 0
fi
echo "direct" >> "$HARNESS_CALL_LOG"
`,
    );
    writeExecutable(
      path.join(binDir, "npm"),
      `#!/bin/sh
echo "npm-fallback" >> "$HARNESS_CALL_LOG"
`,
    );

    try {
      for (const skillName of ["linkedin-talent-search", "mj-live-browse"]) {
        fs.writeFileSync(callLog, "");
        const runtime = path.join(
          REPO_ROOT,
          "catalog",
          "skills",
          skillName,
          "scripts",
          "browser-runtime.mjs",
        );
        await execFileAsync(process.execPath, [runtime, "agent", "tab", "list"], {
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            HARNESS_CALL_LOG: callLog,
          },
        });
        assert.equal(
          fs.readFileSync(callLog, "utf8"),
          "direct\n",
          `${skillName} should not fall through to npm after direct execution`,
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "browser runtimes close only owned task tabs after complete status",
  { skip: process.platform === "win32" },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
    const binDir = path.join(tmp, "bin");
    const callLog = path.join(tmp, "calls.log");
    fs.mkdirSync(binDir, { recursive: true });
    writeExecutable(
      path.join(binDir, "agent-browser"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agent-browser 0.33.2"
  exit 0
fi
echo "$*" >> "$HARNESS_CALL_LOG"
`,
    );
    writeExecutable(
      path.join(binDir, "npm"),
      `#!/bin/sh
echo "npm-fallback $*" >> "$HARNESS_CALL_LOG"
`,
    );

    const cases = [
      {
        skillName: "linkedin-talent-search",
        profileEnv: "LINKEDIN_TALENT_PROFILE_DIR",
        closeEnv: "LINKEDIN_TALENT_CLOSE_ON_COMPLETE",
        port: 9223,
        labelPrefix: "linkedin-talent",
      },
      {
        skillName: "mj-live-browse",
        profileEnv: "MJ_LIVE_BROWSE_PROFILE_DIR",
        closeEnv: "MJ_LIVE_BROWSE_CLOSE_ON_COMPLETE",
        port: 9222,
        labelPrefix: "mj-live",
      },
    ];

    try {
      for (const runtimeCase of cases) {
        fs.writeFileSync(callLog, "");
        const profileDir = path.join(tmp, `${runtimeCase.skillName}-profile`);
        const runtime = path.join(
          REPO_ROOT,
          "catalog",
          "skills",
          runtimeCase.skillName,
          "scripts",
          "browser-runtime.mjs",
        );
        const taskId = "run+001";
        const label = `${runtimeCase.labelPrefix}-${taskId}`;
        const statePath = path.join(
          profileDir,
          ".harness-task-tabs",
          `${label}.json`,
        );
        const env = {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          HARNESS_CALL_LOG: callLog,
          [runtimeCase.profileEnv]: profileDir,
          [runtimeCase.closeEnv]: "tab",
        };

        const opened = JSON.parse(
          (
            await execFileAsync(
              process.execPath,
              [runtime, "task-tab", "open", taskId, "https://example.com"],
              { env },
            )
          ).stdout,
        );
        assert.equal(opened.owned, true);
        assert.equal(opened.created, true);
        assert.equal(opened.label, label);
        assert.equal(fs.existsSync(statePath), true);

        const partial = JSON.parse(
          (
            await execFileAsync(
              process.execPath,
              [runtime, "task-tab", "finish", taskId, "partial"],
              { env },
            )
          ).stdout,
        );
        assert.equal(partial.retained, true);
        assert.equal(fs.existsSync(statePath), true);

        const reopened = JSON.parse(
          (
            await execFileAsync(
              process.execPath,
              [runtime, "task-tab", "open", taskId, "https://example.com"],
              { env },
            )
          ).stdout,
        );
        assert.equal(reopened.reused, true);

        const completed = JSON.parse(
          (
            await execFileAsync(
              process.execPath,
              [runtime, "task-tab", "finish", taskId, "complete"],
              { env },
            )
          ).stdout,
        );
        assert.equal(completed.closed, true);
        assert.equal(fs.existsSync(statePath), false);
        assert.equal(
          fs.readFileSync(callLog, "utf8"),
          `--cdp ${runtimeCase.port} tab new --label ${label} https://example.com\n` +
            `--cdp ${runtimeCase.port} tab close ${label}\n`,
        );

        const existing = JSON.parse(
          (
            await execFileAsync(
              process.execPath,
              [runtime, "task-tab", "finish", "existing-tab", "complete"],
              { env },
            )
          ).stdout,
        );
        assert.equal(existing.owned, false);
        assert.equal(existing.closed, false);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test("linkedin browser runtime reuses an existing dedicated CDP endpoint", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const runtime = path.join(
    REPO_ROOT,
    "catalog",
    "skills",
    "linkedin-talent-search",
    "scripts",
    "browser-runtime.mjs",
  );
  const server = http.createServer((request, response) => {
    if (request.url === "/json/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Browser: "Test Chrome" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    const port = await listenOnLoopback(server);
    const profileDir = path.join(tmp, "profile");
    const { stdout } = await execFileAsync(process.execPath, [runtime, "ensure"], {
      env: {
        ...process.env,
        LINKEDIN_TALENT_CDP_PORT: String(port),
        LINKEDIN_TALENT_PROFILE_DIR: profileDir,
      },
    });
    const status = JSON.parse(stdout);
    assert.equal(status.ready, true);
    assert.equal(status.launched, false);
    assert.equal(status.browser, "Test Chrome");
    assert.equal(fs.existsSync(profileDir), false);
  } finally {
    await closeServer(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("linkedin browser runtime preserves profile locks and blocks startup", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const runtime = path.join(
    REPO_ROOT,
    "catalog",
    "skills",
    "linkedin-talent-search",
    "scripts",
    "browser-runtime.mjs",
  );
  const probe = http.createServer();
  const port = await listenOnLoopback(probe);
  await closeServer(probe);
  const profileDir = path.join(tmp, "profile");
  const lockPath = path.join(profileDir, "SingletonLock");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(lockPath, "preserve-me");

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [runtime, "ensure"], {
        env: {
          ...process.env,
          LINKEDIN_TALENT_CDP_PORT: String(port),
          LINKEDIN_TALENT_PROFILE_DIR: profileDir,
        },
      }),
      (error) => {
        assert.match(error.stderr, /profile_lock_present/);
        return true;
      },
    );
    assert.equal(fs.readFileSync(lockPath, "utf8"), "preserve-me");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mj-live-browse runtime preserves profile locks and blocks startup", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  const runtime = path.join(
    REPO_ROOT,
    "catalog",
    "skills",
    "mj-live-browse",
    "scripts",
    "browser-runtime.mjs",
  );
  const probe = http.createServer();
  const port = await listenOnLoopback(probe);
  await closeServer(probe);
  const profileDir = path.join(tmp, "profile");
  const lockPath = path.join(profileDir, "SingletonLock");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(lockPath, "preserve-me");

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [runtime, "ensure"], {
        env: {
          ...process.env,
          MJ_LIVE_BROWSE_CDP_PORT: String(port),
          MJ_LIVE_BROWSE_PROFILE_DIR: profileDir,
        },
      }),
      (error) => {
        assert.match(error.stderr, /profile_lock_present/);
        return true;
      },
    );
    assert.equal(fs.readFileSync(lockPath, "utf8"), "preserve-me");
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
