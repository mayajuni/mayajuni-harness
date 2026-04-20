#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "skills.json");

const TARGETS = {
  codex: {
    env: "HARNESS_CODEX_SKILLS_DIR",
    defaultDir: "~/.codex/skills",
    entryFile: "SKILL.md",
  },
  claude: {
    env: "HARNESS_CLAUDE_SKILLS_DIR",
    defaultDir: "~/.claude/skills",
    entryFile: "CLAUDE.md",
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
  const manifest = loadManifest();
  const selection = await resolveSelection(manifest, options, {
    includeInstallMode: true,
  });
  const { selectedSkillNames, selectedTargets, installMode, scopeName } =
    selection;

  for (const skillName of selectedSkillNames) {
    const skill = manifest.skills[skillName];
    if (!skill) {
      throw new Error(`Unknown skill: ${skillName}`);
    }

    const targetNames =
      selectedTargets.length > 0
        ? selectedTargets
        : Object.keys(skill.targets);

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
          `[dry-run] ${scopeName} ${installMode} ${skillName}:${targetName} -> ${installDir}`,
        );
        continue;
      }

      ensureDirectory(installRoot);
      assertValidTargetSource(sourceDir, targetName);

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

      if (installMode === "link") {
        linkDirectory(sourceDir, installDir);
      } else {
        copyDirectory(sourceDir, installDir);
      }

      console.log(
        `Installed ${skillName}:${targetName} [${scopeName}, ${installMode}] -> ${installDir}`,
      );
    }
  }
}

async function runUninstall(args) {
  const options = parseFlags(args);
  const manifest = loadManifest();
  const selection = await resolveSelection(manifest, options, {
    includeInstallMode: false,
  });
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
    options.flags.yes || !(canPrompt()) || (await confirmUninstall(targetsToRemove, scopeName));

  if (!shouldProceed) {
    console.log("Uninstall cancelled.");
    return;
  }

  for (const target of targetsToRemove) {
    if (!fs.existsSync(target.installDir)) {
      console.warn(`Skipping missing install: ${target.installDir}`);
      continue;
    }

    fs.rmSync(target.installDir, { recursive: true, force: true });
    console.log(
      `Removed ${target.skillName}:${target.targetName} [${scopeName}] -> ${target.installDir}`,
    );
  }
}

async function resolveSelection(manifest, options, config) {
  const requestedSkills = options.positionals;
  const interactive = canPrompt();
  const scopeName = await resolveScopeName(options.flags, interactive);
  let selectedSkillNames = [];

  if (requestedSkills.length > 0) {
    selectedSkillNames = requestedSkills;
  } else if (options.flags.all) {
    selectedSkillNames = Object.keys(manifest.skills);
  } else if (interactive) {
    selectedSkillNames = await promptForSkills(manifest);
  } else {
    selectedSkillNames = Object.keys(manifest.skills);
  }

  if (selectedSkillNames.length === 0) {
    throw new Error("No skills selected.");
  }

  let selectedTargets = selectTargets(options.flags);
  if (selectedTargets.length === 0 && interactive) {
    selectedTargets = await promptForTargets(manifest, selectedSkillNames);
  }

  if (selectedTargets.length === 0) {
    selectedTargets = collectTargetsForSkills(manifest, selectedSkillNames);
  }

  const installMode = config.includeInstallMode
    ? await resolveInstallMode(options.flags, interactive)
    : null;
  return { selectedSkillNames, selectedTargets, installMode, scopeName };
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

async function resolveInstallMode(flags, interactive) {
  if (flags.link) {
    return "link";
  }

  if (flags.copy) {
    return "copy";
  }

  if (!interactive) {
    return "copy";
  }

  return await promptForInstallMode();
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
        assertValidTargetSource(sourceDir, targetName);
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
    const configured = process.env[scope.env] || scope.defaultDir;
    const projectBase = resolveProjectPath(configured);
    return path.join(projectBase, targetName);
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

function linkDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing source directory: ${sourceDir}`);
  }

  fs.symlinkSync(sourceDir, targetDir, "dir");
}

function assertValidTargetSource(sourceDir, targetName) {
  const target = TARGETS[targetName];
  if (!target) {
    throw new Error(`Unsupported target: ${targetName}`);
  }

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing source directory: ${sourceDir}`);
  }

  const entryPath = path.join(sourceDir, target.entryFile);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Missing required entry file: ${entryPath}`);
  }
}

function canPrompt() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptForSkills(manifest) {
  const skillNames = Object.keys(manifest.skills);
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
        label: "Project scope (./.harness/skills/<tool>)",
        value: "project",
      },
    ],
  );
}

async function promptForInstallMode() {
  return await askChoice(
    "How should the skill be installed?",
    [
      { label: "Copy files", value: "copy" },
      { label: "Link to source for live editing", value: "link" },
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

function printHelp(exitCode) {
  console.log(`
harness-skills

Commands:
  harness-skills list [--json]
  harness-skills install [skill...] [--all] [--scope=global|project] [--global] [--project] [--codex] [--claude] [--copy] [--link] [--dry-run] [--force]
  harness-skills uninstall [skill...] [--all] [--scope=global|project] [--global] [--project] [--codex] [--claude] [--dry-run] [--yes]
  harness-skills validate [skill...] [--codex] [--claude]

Environment:
  HARNESS_CODEX_SKILLS_DIR   Override Codex install root (default: ~/.codex/skills)
  HARNESS_CLAUDE_SKILLS_DIR  Override Claude install root (default: ~/.claude/skills)
  HARNESS_PROJECT_SKILLS_DIR Override project install root (default: ./.harness/skills)
`);
  process.exitCode = exitCode;
}

await main();
