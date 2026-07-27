#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "skills.json");
const HINDSIGHT_INSTALLER = "hindsight-project";
const HINDSIGHT_INSTALL_DIR = path.join(".codex", "hindsight");
const HINDSIGHT_SECRETS_FILE = "secrets.json";
const HINDSIGHT_SECRETS_EXCLUDE = "/.codex/hindsight/secrets.json";
const HINDSIGHT_HOOK_MARKER = "/.codex/hindsight/scripts/";
const HINDSIGHT_RUNTIME_FILES = [
  "README.md",
  "scripts/session_start.py",
  "scripts/recall.py",
  "scripts/retain.py",
  "scripts/lib/__init__.py",
  "scripts/lib/bank.py",
  "scripts/lib/client.py",
  "scripts/lib/config.py",
  "scripts/lib/content.py",
  "scripts/lib/daemon.py",
  "scripts/lib/llm.py",
  "scripts/lib/state.py",
];

const TARGETS = {
  codex: {
    env: "HARNESS_CODEX_SKILLS_DIR",
    defaultDir: "~/.codex/skills",
    projectDir: ".agents/skills",
    entryFile: "SKILL.md",
  },
  claude: {
    env: "HARNESS_CLAUDE_SKILLS_DIR",
    defaultDir: "~/.claude/skills",
    projectDir: ".claude/skills",
    entryFile: "SKILL.md",
  },
};

const SCOPES = {
  global: {
    env: null,
    defaultDir: null,
  },
  project: {
    env: "HARNESS_PROJECT_SKILLS_DIR",
    defaultDir: ".harness/skills",
  },
};

async function main() {
  try {
    const args = process.argv.slice(2);
    const command = args[0] ?? "help";
    const rest = args.slice(1);

    switch (command) {
      case "list":
        return runList(rest);
      case "install":
        return await runInstall(rest);
      case "uninstall":
      case "remove":
        return await runUninstall(rest);
      case "validate":
        return runValidate(rest);
      case "help":
      case "--help":
      case "-h":
        return printHelp(0);
      default:
        console.error(`Unknown command: ${command}`);
        return printHelp(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function runList(args) {
  const options = parseFlags(args);
  const manifest = loadManifest();
  const rows = Object.entries(manifest.skills).map(([name, skill]) => ({
    name,
    description: skill.description,
    targets: Object.keys(skill.targets),
  }));

  if (options.flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  for (const row of rows) {
    console.log(`${row.name}`);
    console.log(`  ${row.description}`);
    console.log(`  targets: ${row.targets.join(", ")}`);
  }
}

async function runInstall(args) {
  const options = parseFlags(args);
  assertNoLegacyInstallModeFlags(options.flags);
  const manifest = loadManifest();
  const selection = await resolveSelection(manifest, options);
  const { selectedSkillNames, selectedTargets, scopeName } = selection;
  const hindsightSelected = selectedSkillNames.some(
    (skillName) =>
      manifest.skills[skillName]?.installer === HINDSIGHT_INSTALLER,
  );
  const hindsightApiUrl = hindsightSelected
    ? await resolveHindsightApiUrl(options.flags)
    : null;
  const hindsightBankId = hindsightSelected
    ? await resolveHindsightBankId(options.flags)
    : null;
  const hindsightApiToken =
    hindsightSelected && !options.flags["dry-run"]
      ? await resolveHindsightApiToken()
      : null;

  for (const skillName of selectedSkillNames) {
    const skill = manifest.skills[skillName];
    if (!skill) {
      throw new Error(`Unknown skill: ${skillName}`);
    }

    const targetNames =
      selectedTargets.length > 0
        ? selectedTargets
        : Object.keys(skill.targets);

    if (skill.installer === HINDSIGHT_INSTALLER) {
      installHindsightBundle({
        skillName,
        skill,
        targetNames,
        scopeName,
        bankId: hindsightBankId,
        apiUrl: hindsightApiUrl,
        apiToken: hindsightApiToken,
        flags: options.flags,
      });
      continue;
    }

    for (const targetName of targetNames) {
      const target = skill.targets[targetName];
      if (!target) {
        console.warn(`Skipping ${skillName}: no ${targetName} target.`);
        continue;
      }

      const sourceDir = path.join(REPO_ROOT, target.source);
      const installRoot = resolveTargetRoot(targetName, scopeName);
      const installDir = path.join(installRoot, skillName);

      if (options.flags["dry-run"]) {
        console.log(
          `[dry-run] ${scopeName} ${skillName}:${targetName} -> ${installDir}`,
        );
        continue;
      }

      ensureDirectory(installRoot);
      assertValidTargetSource(sourceDir, targetName, skill);

      if (fs.existsSync(installDir)) {
        if (!options.flags.force) {
          throw new Error(
            [
              `Target already exists: ${installDir}`,
              "Re-run with --force to replace it.",
            ].join(" "),
          );
        }

        fs.rmSync(installDir, { recursive: true, force: true });
      }

      copyDirectory(sourceDir, installDir);

      console.log(
        `Installed ${skillName}:${targetName} [${scopeName}] -> ${installDir}`,
      );
    }
  }
}

async function runUninstall(args) {
  const options = parseFlags(args);
  const manifest = loadManifest();
  const selection = await resolveSelection(manifest, options);
  const { selectedSkillNames, selectedTargets, scopeName } = selection;
  const targetsToRemove = [];

  for (const skillName of selectedSkillNames) {
    const skill = manifest.skills[skillName];
    if (!skill) {
      throw new Error(`Unknown skill: ${skillName}`);
    }

    const targetNames =
      selectedTargets.length > 0
        ? selectedTargets
        : Object.keys(skill.targets);

    if (skill.installer === HINDSIGHT_INSTALLER) {
      assertSupportedScope(skillName, skill, scopeName);
      const projectRoot = findProjectRoot(process.cwd());
      for (const targetName of targetNames) {
        if (!skill.targets[targetName]) {
          console.warn(`Skipping ${skillName}: no ${targetName} target.`);
          continue;
        }
        targetsToRemove.push({
          skillName,
          targetName,
          installDir: path.join(projectRoot, HINDSIGHT_INSTALL_DIR),
          installer: HINDSIGHT_INSTALLER,
        });
      }
      continue;
    }

    for (const targetName of targetNames) {
      const target = skill.targets[targetName];
      if (!target) {
        console.warn(`Skipping ${skillName}: no ${targetName} target.`);
        continue;
      }

      const installRoot = resolveTargetRoot(targetName, scopeName);
      const installDir = path.join(installRoot, skillName);
      targetsToRemove.push({
        skillName,
        targetName,
        installDir,
      });
    }
  }

  if (targetsToRemove.length === 0) {
    console.log("Nothing to uninstall.");
    return;
  }

  if (options.flags["dry-run"]) {
    for (const target of targetsToRemove) {
      console.log(
        `[dry-run] uninstall ${scopeName} ${target.skillName}:${target.targetName} -> ${target.installDir}`,
      );
    }
    return;
  }

  const shouldProceed =
    options.flags.yes ||
    !canPrompt() ||
    (await confirmUninstall(targetsToRemove, scopeName));

  if (!shouldProceed) {
    console.log("Uninstall cancelled.");
    return;
  }

  for (const target of targetsToRemove) {
    if (target.installer === HINDSIGHT_INSTALLER) {
      continue;
    }
    if (!fs.existsSync(target.installDir)) {
      console.warn(`Skipping missing install: ${target.installDir}`);
      continue;
    }

    fs.rmSync(target.installDir, { recursive: true, force: true });
    console.log(
      `Removed ${target.skillName}:${target.targetName} [${scopeName}] -> ${target.installDir}`,
    );
  }

  const hindsightTargets = targetsToRemove
    .filter((target) => target.installer === HINDSIGHT_INSTALLER)
    .map((target) => target.targetName);
  if (hindsightTargets.length > 0) {
    uninstallHindsightBundle({
      targetNames: hindsightTargets,
      scopeName,
    });
  }
}

async function resolveSelection(manifest, options) {
  const requestedSkills = options.positionals;
  const interactive = canPrompt();
  const scopeName = await resolveScopeName(options.flags, interactive);
  let selectedSkillNames = [];

  if (requestedSkills.length > 0) {
    selectedSkillNames = requestedSkills;
  } else if (options.flags.all) {
    selectedSkillNames = Object.keys(manifest.skills).filter((skillName) =>
      supportsScope(manifest.skills[skillName], scopeName),
    );
  } else if (interactive) {
    selectedSkillNames = await promptForSkills(manifest, scopeName);
  } else {
    selectedSkillNames = Object.keys(manifest.skills).filter((skillName) =>
      supportsScope(manifest.skills[skillName], scopeName),
    );
  }

  if (selectedSkillNames.length === 0) {
    throw new Error("No skills selected.");
  }

  for (const skillName of selectedSkillNames) {
    const skill = manifest.skills[skillName];
    if (!skill) {
      throw new Error(`Unknown skill: ${skillName}`);
    }
    assertSupportedScope(skillName, skill, scopeName);
  }

  let selectedTargets = selectTargets(options.flags);
  if (selectedTargets.length === 0 && interactive) {
    selectedTargets = await promptForTargets(manifest, selectedSkillNames);
  }

  if (selectedTargets.length === 0) {
    selectedTargets = collectTargetsForSkills(manifest, selectedSkillNames);
  }

  return { selectedSkillNames, selectedTargets, scopeName };
}

async function resolveScopeName(flags, interactive) {
  const explicitScope = getScopeFromFlags(flags);
  if (explicitScope) {
    return explicitScope;
  }

  if (!interactive) {
    return "global";
  }

  return await promptForScope();
}

function runValidate(args) {
  const options = parseFlags(args);
  const manifest = loadManifest();
  const requestedSkills = options.positionals;
  const selectedSkillNames =
    requestedSkills.length > 0
      ? requestedSkills
      : Object.keys(manifest.skills);
  const selectedTargets = selectTargets(options.flags);
  let hasError = false;

  for (const skillName of selectedSkillNames) {
    const skill = manifest.skills[skillName];
    if (!skill) {
      console.error(`Unknown skill: ${skillName}`);
      hasError = true;
      continue;
    }

    const targetNames =
      selectedTargets.length > 0
        ? selectedTargets
        : Object.keys(skill.targets);

    if (targetNames.length === 0) {
      console.error(`No targets selected for ${skillName}`);
      hasError = true;
      continue;
    }

    for (const targetName of targetNames) {
      const target = skill.targets[targetName];
      if (!target) {
        console.error(`Missing ${targetName} target for ${skillName}`);
        hasError = true;
        continue;
      }

      const sourceDir = path.join(REPO_ROOT, target.source);

      try {
        assertValidTargetSource(sourceDir, targetName, skill);
        console.log(`OK ${skillName}:${targetName}`);
      } catch (error) {
        console.error(
          `INVALID ${skillName}:${targetName} - ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        hasError = true;
      }
    }
  }

  if (hasError) {
    process.exitCode = 1;
  }
}

function assertNoLegacyInstallModeFlags(flags) {
  if (flags.link || flags.copy) {
    throw new Error(
      "Install mode flags are no longer supported. Installs always copy files.",
    );
  }
}

function parseFlags(args) {
  const flags = {};
  const positionals = [];

  for (const arg of args) {
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, rawValue] = arg.slice(2).split("=", 2);
    flags[rawKey] = rawValue ?? true;
  }

  return { flags, positionals };
}

function loadManifest() {
  const content = fs.readFileSync(MANIFEST_PATH, "utf8");
  return JSON.parse(content);
}

function selectTargets(flags) {
  return Object.keys(TARGETS).filter((targetName) => flags[targetName]);
}

function collectTargetsForSkills(manifest, selectedSkillNames) {
  return [
    ...new Set(
      selectedSkillNames.flatMap((skillName) =>
        Object.keys(manifest.skills[skillName]?.targets ?? {}),
      ),
    ),
  ];
}

function getScopeFromFlags(flags) {
  if (flags.scope) {
    const scopeName = String(flags.scope);
    if (!SCOPES[scopeName]) {
      throw new Error(`Unsupported scope: ${scopeName}`);
    }

    return scopeName;
  }

  if (flags.global) {
    return "global";
  }

  if (flags.project) {
    return "project";
  }

  return null;
}

function resolveTargetRoot(targetName, scopeName) {
  const target = TARGETS[targetName];
  if (!target) {
    throw new Error(`Unsupported target: ${targetName}`);
  }

  if (scopeName === "global") {
    const configured = process.env[target.env] || target.defaultDir;
    return expandHome(configured);
  }

  if (scopeName === "project") {
    const scope = SCOPES.project;
    const configured = process.env[scope.env];
    if (configured) {
      return resolveProjectPath(configured);
    }

    if (target.projectDir) {
      return resolveProjectPath(target.projectDir);
    }

    return path.join(resolveProjectPath(scope.defaultDir), targetName);
  }

  throw new Error(`Unsupported scope: ${scopeName}`);
}

function expandHome(value) {
  if (!value.startsWith("~")) {
    return value;
  }

  return path.join(os.homedir(), value.slice(2));
}

function resolveProjectPath(value) {
  const expanded = expandHome(value);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }

  return path.join(process.cwd(), expanded);
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing source directory: ${sourceDir}`);
  }

  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function assertValidTargetSource(sourceDir, targetName, skill) {
  const target = TARGETS[targetName];
  if (!target) {
    throw new Error(`Unsupported target: ${targetName}`);
  }

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing source directory: ${sourceDir}`);
  }

  if (skill?.installer === HINDSIGHT_INSTALLER) {
    for (const relativePath of HINDSIGHT_RUNTIME_FILES) {
      const runtimePath = path.join(sourceDir, relativePath);
      if (!fs.existsSync(runtimePath)) {
        throw new Error(`Missing required runtime file: ${runtimePath}`);
      }
    }
    return;
  }

  const entryPath = path.join(sourceDir, target.entryFile);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Missing required entry file: ${entryPath}`);
  }
}

function supportsScope(skill, scopeName) {
  const scopes = skill.scopes;
  return !Array.isArray(scopes) || scopes.includes(scopeName);
}

function assertSupportedScope(skillName, skill, scopeName) {
  if (supportsScope(skill, scopeName)) {
    return;
  }

  throw new Error(
    `${skillName} only supports scope: ${skill.scopes.join(", ")}. Re-run with --project.`,
  );
}

async function resolveHindsightBankId(flags) {
  const explicit = flags["bank-id"];
  if (explicit !== undefined && explicit !== true) {
    return validateHindsightBankId(String(explicit));
  }
  if (explicit === true) {
    throw new Error("--bank-id requires a value, for example --bank-id=my-project.");
  }

  if (!canPrompt()) {
    throw new Error(
      "hindsight requires --bank-id in non-interactive mode, for example --bank-id=my-project.",
    );
  }

  const suggested = suggestHindsightBankId(findProjectRoot(process.cwd()));
  const answer = await askInput(`Hindsight bank ID [${suggested}]:`);
  return validateHindsightBankId(answer || suggested);
}

function validateHindsightBankId(bankId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bankId)) {
    throw new Error(
      "Invalid Hindsight bank ID. Use 1-128 letters, numbers, dots, underscores, colons, or hyphens; start with a letter or number.",
    );
  }
  return bankId;
}

async function resolveHindsightApiUrl(flags) {
  const explicit = flags["api-url"];
  if (explicit !== undefined && explicit !== true) {
    return validateHindsightApiUrl(String(explicit));
  }
  if (explicit === true) {
    throw new Error(
      "--api-url requires a value, for example --api-url=https://hindsight.example.com.",
    );
  }

  if (!canPrompt()) {
    throw new Error(
      "hindsight requires --api-url in non-interactive mode, for example --api-url=https://hindsight.example.com.",
    );
  }

  const answer = await askInput("Hindsight API URL:");
  return validateHindsightApiUrl(answer);
}

function validateHindsightApiUrl(apiUrl) {
  const normalized = apiUrl.trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(
      "Invalid Hindsight API URL. Enter a complete http:// or https:// URL.",
    );
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "Invalid Hindsight API URL. Use http:// or https:// without embedded credentials.",
    );
  }

  return normalized;
}

async function resolveHindsightApiToken() {
  const projectRoot = findProjectRoot(process.cwd());
  const existingToken = readHindsightApiToken(projectRoot);
  const environmentToken = normalizeHindsightApiToken(
    process.env.HINDSIGHT_API_TOKEN,
  );

  if (!canPrompt()) {
    return existingToken || environmentToken;
  }

  const fallbackDescription = existingToken
    ? "press Enter to preserve the existing project token"
    : environmentToken
      ? "press Enter to store HINDSIGHT_API_TOKEN for this project"
      : "press Enter to use a runtime environment variable instead";
  const answer = await askSecret(
    `Hindsight API token (${fallbackDescription}):`,
  );
  return normalizeHindsightApiToken(answer) || existingToken || environmentToken;
}

function normalizeHindsightApiToken(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim() || null;
}

function suggestHindsightBankId(projectRoot) {
  return (
    path
      .basename(projectRoot)
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project-memory"
  );
}

function findProjectRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        "hindsight project install must be run inside a Git repository.",
      );
    }
    current = parent;
  }
}

function installHindsightBundle({
  skillName,
  skill,
  targetNames,
  scopeName,
  bankId,
  apiUrl,
  apiToken,
  flags,
}) {
  assertSupportedScope(skillName, skill, scopeName);
  const projectRoot = findProjectRoot(process.cwd());
  const installDir = path.join(projectRoot, HINDSIGHT_INSTALL_DIR);
  const sourceDir = path.join(REPO_ROOT, skill.targets[targetNames[0]].source);

  for (const targetName of targetNames) {
    if (!skill.targets[targetName]) {
      throw new Error(`Missing ${targetName} target for ${skillName}`);
    }
    assertValidTargetSource(
      path.join(REPO_ROOT, skill.targets[targetName].source),
      targetName,
      skill,
    );
  }

  if (flags["dry-run"]) {
    for (const targetName of targetNames) {
      console.log(
        `[dry-run] project ${skillName}:${targetName} api=${apiUrl} bank=${bankId} -> ${installDir}`,
      );
    }
    return;
  }

  const metadataPath = path.join(installDir, ".harness-install.json");
  const existingMetadata = readJsonFile(metadataPath, null);
  if (fs.existsSync(installDir) && !flags.force) {
    throw new Error(
      [
        `Target already exists: ${installDir}`,
        "Re-run with --force to replace the Hindsight runtime and merge hooks.",
      ].join(" "),
    );
  }

  const installedTargets = new Set(
    Array.isArray(existingMetadata?.targets)
      ? existingMetadata.targets
      : detectInstalledHindsightTargets(projectRoot),
  );
  for (const targetName of targetNames) {
    installedTargets.add(targetName);
  }

  if (fs.existsSync(installDir)) {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
  ensureDirectory(installDir);
  copyDirectory(
    path.join(sourceDir, "scripts"),
    path.join(installDir, "scripts"),
  );
  fs.copyFileSync(
    path.join(sourceDir, "README.md"),
    path.join(installDir, "README.md"),
  );
  writeJsonFile(
    path.join(installDir, "settings.json"),
    buildHindsightSettings(apiUrl, bankId, projectRoot),
  );
  writeJsonFile(metadataPath, {
    installer: HINDSIGHT_INSTALLER,
    bankId,
    targets: [...installedTargets].sort(),
  });
  if (apiToken) {
    writeHindsightSecrets(projectRoot, apiToken);
    ensureHindsightSecretsExcluded(projectRoot);
  }

  for (const targetName of targetNames) {
    const settingsPath = hindsightSettingsPath(projectRoot, targetName);
    mergeHindsightHooks(settingsPath, targetName, bankId);
    console.log(
      `Installed ${skillName}:${targetName} [project] bank=${bankId} -> ${installDir}`,
    );
  }
  if (!apiToken && !process.env.HINDSIGHT_API_TOKEN) {
    console.warn(
      "No project Hindsight API token was stored and HINDSIGHT_API_TOKEN is not set. The installed hooks will skip recall and retain until a token is available.",
    );
  }
}

function hindsightSecretsPath(projectRoot) {
  return path.join(
    projectRoot,
    HINDSIGHT_INSTALL_DIR,
    HINDSIGHT_SECRETS_FILE,
  );
}

function readHindsightApiToken(projectRoot) {
  const secrets = readJsonFile(hindsightSecretsPath(projectRoot), null);
  return normalizeHindsightApiToken(secrets?.hindsightApiToken);
}

function writeHindsightSecrets(projectRoot, apiToken) {
  const secretsPath = hindsightSecretsPath(projectRoot);
  ensureDirectory(path.dirname(secretsPath));
  fs.writeFileSync(
    secretsPath,
    `${JSON.stringify({ hindsightApiToken: apiToken }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(secretsPath, 0o600);
  console.log(`Stored project Hindsight API token -> ${secretsPath}`);
}

function ensureHindsightSecretsExcluded(projectRoot) {
  const rawExcludePath = execFileSync(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  ).trim();
  const excludePath = path.isAbsolute(rawExcludePath)
    ? rawExcludePath
    : path.resolve(projectRoot, rawExcludePath);
  ensureDirectory(path.dirname(excludePath));

  const existing = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, "utf8")
    : "";
  const lines = existing.split(/\r?\n/);
  if (lines.includes(HINDSIGHT_SECRETS_EXCLUDE)) {
    return;
  }

  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(
    excludePath,
    `${prefix}${HINDSIGHT_SECRETS_EXCLUDE}\n`,
  );
}

function uninstallHindsightBundle({ targetNames, scopeName }) {
  if (scopeName !== "project") {
    throw new Error("hindsight only supports project uninstall.");
  }

  const projectRoot = findProjectRoot(process.cwd());
  const installDir = path.join(projectRoot, HINDSIGHT_INSTALL_DIR);
  const metadataPath = path.join(installDir, ".harness-install.json");
  const metadata = readJsonFile(metadataPath, null);
  const detectedTargets = detectInstalledHindsightTargets(projectRoot);

  for (const targetName of targetNames) {
    const settingsPath = hindsightSettingsPath(projectRoot, targetName);
    removeHindsightHooks(settingsPath);
    console.log(
      `Removed hindsight:${targetName} hooks [project] -> ${settingsPath}`,
    );
  }

  const installedTargets = new Set(
    Array.isArray(metadata?.targets) ? metadata.targets : detectedTargets,
  );
  for (const targetName of targetNames) {
    installedTargets.delete(targetName);
  }

  if (installedTargets.size === 0) {
    if (fs.existsSync(installDir)) {
      fs.rmSync(installDir, { recursive: true, force: true });
      console.log(`Removed Hindsight runtime -> ${installDir}`);
    }
    return;
  }

  writeJsonFile(metadataPath, {
    ...metadata,
    targets: [...installedTargets].sort(),
  });
}

function buildHindsightSettings(apiUrl, bankId, projectRoot) {
  const projectName = path.basename(projectRoot);
  return {
    version: "0.3.3",
    hindsightApiUrl: apiUrl,
    bankId,
    bankMission: `You are a coding assistant working on the ${projectName} repository. Focus on project conventions, architecture, debugging outcomes, deployment workflows, provider integrations, recurring pitfalls, and user preferences that help future work in this repository.`,
    retainMission: `Extract durable technical knowledge for the ${projectName} repository: architecture decisions, code paths, debugging solutions, branch/deploy workflows, test commands, failed approaches, successful fixes, provider/API constraints, and user preferences. Ignore greetings, transient logs, secrets, credentials, and noisy one-off command output.`,
    autoRecall: true,
    autoRetain: true,
    recallTimeout: 7,
    recallTags: [`project:${bankId}`],
    recallTagsMatch: "any",
    recallBrowseFallback: true,
    recallBrowseMaxQueries: 6,
    recallBrowseLimit: 25,
    recallBrowseTimeout: 3,
    recallMaxResults: 4,
    recallContextMaxChars: 1200,
    recallMinLexicalScore: 6,
    recallRankMaxTerms: 16,
    recallContextTurns: 1,
    recallMaxQueryChars: 800,
    recallRoles: ["user", "assistant"],
    recallPromptPreamble: `Relevant memories from past ${projectName} conversations. Use only memories that directly help the current task; prioritize current repository files and live command output when they conflict:`,
    retainRoles: ["user", "assistant"],
    retainTags: [`project:${bankId}`, bankId, "{session_id}"],
    retainMetadata: {
      project: bankId,
      repo: projectName,
    },
    retainContext: "codex",
    dynamicBankId: false,
    agentName: "codex",
    debug: false,
    codex: {
      recallTypes: ["observation", "world"],
      recallBudget: "low",
      recallMaxTokens: 256,
      retainMode: "incremental",
      retainEveryNTurns: 3,
      retainToolCalls: false,
    },
    claudeCode: {
      recallTypes: ["observation", "world"],
      recallBudget: "low",
      recallMaxTokens: 256,
      retainMode: "incremental",
      retainEveryNTurns: 5,
      retainToolCalls: false,
      sessionEndFinalRetain: true,
    },
  };
}

function hindsightSettingsPath(projectRoot, targetName) {
  if (targetName === "codex") {
    return path.join(projectRoot, ".codex", "hooks.json");
  }
  if (targetName === "claude") {
    return path.join(projectRoot, ".claude", "settings.json");
  }
  throw new Error(`Unsupported Hindsight target: ${targetName}`);
}

function detectInstalledHindsightTargets(projectRoot) {
  return Object.keys(TARGETS).filter((targetName) => {
    const settingsPath = hindsightSettingsPath(projectRoot, targetName);
    if (!fs.existsSync(settingsPath)) {
      return false;
    }
    const content = fs.readFileSync(settingsPath, "utf8");
    return content.includes(HINDSIGHT_HOOK_MARKER);
  });
}

function mergeHindsightHooks(settingsPath, targetName, bankId) {
  const settings = readJsonFile(settingsPath, {});
  const hooks = normalizeHooks(settings.hooks);
  removeHindsightHandlers(hooks);

  const targetHooks = buildHindsightHooks(targetName, bankId);
  for (const [eventName, groups] of Object.entries(targetHooks)) {
    hooks[eventName] = [...(hooks[eventName] ?? []), ...groups];
  }

  writeJsonFile(settingsPath, {
    ...settings,
    hooks,
  });
}

function removeHindsightHooks(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return;
  }
  const settings = readJsonFile(settingsPath, {});
  const hooks = normalizeHooks(settings.hooks);
  removeHindsightHandlers(hooks);
  writeJsonFile(settingsPath, {
    ...settings,
    hooks,
  });
}

function normalizeHooks(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function removeHindsightHandlers(hooks) {
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    const remainingGroups = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        remainingGroups.push(group);
        continue;
      }
      const remainingHandlers = group.hooks.filter(
        (handler) =>
          typeof handler?.command !== "string" ||
          !handler.command.includes(HINDSIGHT_HOOK_MARKER),
      );
      if (remainingHandlers.length > 0) {
        remainingGroups.push({
          ...group,
          hooks: remainingHandlers,
        });
      }
    }
    if (remainingGroups.length > 0) {
      hooks[eventName] = remainingGroups;
    } else {
      delete hooks[eventName];
    }
  }
}

function buildHindsightHooks(targetName, bankId) {
  const agentPrefix =
    targetName === "claude" ? "HINDSIGHT_AGENT_NAME=claude-code " : "";
  const command = (scriptName) =>
    `test -n "$HINDSIGHT_API_TOKEN" || test -s "$(git rev-parse --show-toplevel)/.codex/hindsight/${HINDSIGHT_SECRETS_FILE}" || exit 0; PYTHONDONTWRITEBYTECODE=1 HINDSIGHT_BANK_ID=${bankId} HINDSIGHT_DYNAMIC_BANK_ID=false ${agentPrefix}python3 "$(git rev-parse --show-toplevel)/.codex/hindsight/scripts/${scriptName}"`;

  const hooks = {
    SessionStart: [
      {
        matcher: "startup|resume",
        hooks: [
          {
            type: "command",
            command: command("session_start.py"),
            timeout: 5,
            statusMessage: "Checking Hindsight project memory",
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: command("recall.py"),
            timeout: 20,
            statusMessage: "Loading scoped Hindsight project memory",
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: command("retain.py"),
            timeout: 30,
            statusMessage: "Saving Hindsight project memory",
          },
        ],
      },
    ],
  };

  if (targetName === "claude") {
    hooks.SessionEnd = [
      {
        hooks: [
          {
            type: "command",
            command: command("retain.py"),
            timeout: 30,
            statusMessage: "Saving final Hindsight project memory",
          },
        ],
      },
    ];
  }

  return hooks;
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJsonFile(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function canPrompt() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptForSkills(manifest, scopeName) {
  const skillNames = Object.keys(manifest.skills).filter((skillName) =>
    supportsScope(manifest.skills[skillName], scopeName),
  );
  if (skillNames.length === 0) {
    throw new Error("No skills found in manifest.");
  }

  console.log("");
  console.log("Available skills:");
  for (const [index, skillName] of skillNames.entries()) {
    const description = manifest.skills[skillName].description;
    console.log(`  ${index + 1}. ${skillName} - ${description}`);
  }

  const answer = await askInput(
    "Choose skills: use numbers/names separated by commas, or type 'all':",
  );
  if (answer.toLowerCase() === "all") {
    return skillNames;
  }

  const selected = parseSelectionList(answer, skillNames);
  if (selected.length === 0) {
    throw new Error("No valid skills selected.");
  }

  return selected;
}

async function promptForTargets(manifest, selectedSkillNames) {
  const availableTargets = collectTargetsForSkills(manifest, selectedSkillNames);

  if (availableTargets.length === 0) {
    throw new Error("Selected skills do not expose any targets.");
  }

  console.log("");
  console.log("Available tools:");
  for (const [index, targetName] of availableTargets.entries()) {
    console.log(`  ${index + 1}. ${targetName}`);
  }

  const answer = await askInput(
    "Choose tools: use numbers/names separated by commas, or type 'all':",
  );
  if (answer.toLowerCase() === "all") {
    return availableTargets;
  }

  const selected = parseSelectionList(answer, availableTargets);
  if (selected.length === 0) {
    throw new Error("No valid tools selected.");
  }

  return selected;
}

async function promptForScope() {
  return await askChoice(
    "Where should the skills be installed?",
    [
      {
        label: "Global scope (~/.codex/skills, ~/.claude/skills)",
        value: "global",
      },
      {
        label: "Project scope (Codex: ./.agents/skills, Claude: ./.claude/skills)",
        value: "project",
      },
    ],
  );
}

async function confirmUninstall(targetsToRemove, scopeName) {
  console.log("");
  console.log(`The following installs will be removed from ${scopeName} scope:`);
  for (const target of targetsToRemove) {
    console.log(`  - ${target.skillName}:${target.targetName}`);
  }

  const answer = await askInput("Proceed? [y/N]:");
  return ["y", "yes"].includes(answer.toLowerCase());
}

function parseSelectionList(input, allowedValues) {
  const indexMap = new Map(
    allowedValues.map((value, index) => [String(index + 1), value]),
  );
  const nameMap = new Map(allowedValues.map((value) => [value, value]));
  const picked = [];

  for (const token of input.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }

    const resolved = indexMap.get(trimmed) ?? nameMap.get(trimmed);
    if (!resolved || picked.includes(resolved)) {
      continue;
    }

    picked.push(resolved);
  }

  return picked;
}

async function askChoice(prompt, choices) {
  console.log("");
  console.log(prompt);
  for (const [index, choice] of choices.entries()) {
    console.log(`  ${index + 1}. ${choice.label}`);
  }

  while (true) {
    const answer = await askInput("Select a number:");
    const choice = choices[Number(answer) - 1];
    if (choice) {
      return choice.value;
    }

    console.log("Invalid selection. Try again.");
  }
}

async function askInput(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${prompt} `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function askSecret(prompt) {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "A TTY is required for hidden token input. Set HINDSIGHT_API_TOKEN for non-interactive installation.",
    );
  }

  output.write(`${prompt} `);
  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);
  input.resume();

  return await new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
    };

    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Input cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    input.on("data", onData);
  });
}

function printHelp(exitCode) {
  console.log(`
mhs

Commands:
  mhs list [--json]
  mhs install [skill...] [--all] [--scope=global|project] [--global] [--project] [--codex] [--claude] [--api-url=url] [--bank-id=id] [--dry-run] [--force]
  mhs uninstall [skill...] [--all] [--scope=global|project] [--global] [--project] [--codex] [--claude] [--dry-run] [--yes]
  mhs validate [skill...] [--codex] [--claude]

Environment:
  HARNESS_CODEX_SKILLS_DIR   Override Codex install root (default: ~/.codex/skills)
  HARNESS_CLAUDE_SKILLS_DIR  Override Claude install root (default: ~/.claude/skills)
  HARNESS_PROJECT_SKILLS_DIR Override project install root (default: native project paths)

Hindsight:
  Project-only hook bundle. Interactive install prompts for an API URL, bank ID, and hidden project token.
  Non-interactive installs store HINDSIGHT_API_TOKEN when it is set.
  Non-interactive example: mhs install hindsight --project --codex --claude --api-url=https://hindsight.example.com --bank-id=my-project
`);
  process.exitCode = exitCode;
}

await main();
