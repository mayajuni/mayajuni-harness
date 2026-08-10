import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(
  REPO_ROOT,
  "catalog",
  "skills",
  "linkedin-talent-search",
  "scripts",
  "filter-schema.mjs",
);

test("filter schema initializes, builds verified URLs, records values, and resets", async () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "linkedin-filter-schema-"),
  );
  const schemaPath = path.join(temporaryDirectory, "state", "filter-schema.json");
  const manifestPath = path.join(temporaryDirectory, "manifest.json");
  const planPath = path.join(temporaryDirectory, "plan.json");
  const aiPlanPath = path.join(temporaryDirectory, "ai-plan.json");
  const freeTextPlanPath = path.join(temporaryDirectory, "free-text-plan.json");
  const unresolvedPlanPath = path.join(temporaryDirectory, "unresolved-plan.json");
  const environment = {
    ...process.env,
    LINKEDIN_TALENT_FILTER_SCHEMA_PATH: schemaPath,
    LINKEDIN_TALENT_PROFILE_DIR: path.join(temporaryDirectory, "profile"),
  };

  const manifest = {
    surface: "linkedin-sales-navigator-people-search",
    locale: "en-US",
    inventoryComplete: true,
    observedAt: "2026-08-05T15:00:00+09:00",
    keyword: {
      control: "Search keywords",
      supported: true,
      booleanSyntax: "confirmed",
    },
    filters: [
      {
        control: "Geography",
        controlKey: "GEOGRAPHY",
        queryType: "REGION",
        inputType: "typeahead",
        multiple: true,
        supportsExclude: true,
        urlState: "confirmed",
        values: [
          {
            id: "90000070",
            label: "New York City Metropolitan Area",
            selectionType: "INCLUDED",
          },
        ],
      },
      {
        control: "Current job title",
        controlKey: "CURRENT_TITLE",
        queryType: "CURRENT_TITLE",
        inputType: "typeahead",
        multiple: true,
        supportsExclude: true,
        urlState: "confirmed",
        values: [
          {
            id: "9",
            label: "Software Engineer",
            selectionType: "INCLUDED",
          },
        ],
      },
      {
        control: "Profile language",
        controlKey: "PROFILE_LANGUAGE",
        queryType: "PROFILE_LANGUAGE",
        inputType: "enum",
        multiple: true,
        supportsExclude: true,
        urlState: "confirmed",
        values: [
          {
            id: "ko",
            label: "Korean",
            selectionType: "INCLUDED",
          },
        ],
      },
      {
        control: "Seniority level",
        controlKey: "SENIORITY_LEVEL",
        queryType: null,
        inputType: "enum",
        multiple: true,
        supportsExclude: true,
        urlState: "unresolved",
        values: [],
      },
      {
        control: "People in CRM",
        controlKey: "LEADS_IN_CRM",
        queryType: null,
        inputType: "toggle",
        multiple: false,
        supportsExclude: false,
        urlState: "ui_only",
        values: [],
      },
    ],
  };
  const plan = {
    page: 2,
    filters: [
      {
        control: "Geography",
        values: ["New York City Metropolitan Area"],
        mode: "include",
      },
      {
        control: "Current job title",
        values: ["Software Engineer"],
        mode: "include",
      },
      {
        control: "Profile language",
        values: ["Korean"],
        mode: "include",
      },
    ],
    keywords: "agentic OR \"AI agent\"",
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  try {
    const before = await runJson(["status"], environment);
    assert.equal(before.initialized, false);
    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, "show"], { env: environment }),
      (error) => {
        assert.equal(error.code, 3);
        assert.match(error.stderr, /not initialized/);
        assert.doesNotMatch(error.stderr, /before initialization/);
        return true;
      },
    );

    const initialized = await runJson(
      ["init", "--input", manifestPath],
      environment,
    );
    assert.equal(initialized.filterCount, 5);
    assert.equal(initialized.confirmedUrlFilterCount, 3);
    assert.equal(initialized.cachedValueCount, 3);
    assert.ok(fs.existsSync(schemaPath));
    assert.equal(fs.statSync(schemaPath).mode & 0o777, 0o600);

    fs.writeFileSync(
      unresolvedPlanPath,
      `${JSON.stringify({
        filters: [
          {
            control: "Seniority level",
            values: ["Senior"],
            mode: "include",
          },
        ],
      })}\n`,
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [SCRIPT, "build-url", "--input", unresolvedPlanPath],
        { env: environment },
      ),
      (error) => {
        assert.equal(error.code, 3);
        const result = JSON.parse(error.stdout);
        assert.equal(result.reason, "unresolved_control");
        assert.equal(result.nextAction, "resolve_query_type_in_ui_then_record_control");
        return true;
      },
    );

    const built = await runJson(
      ["build-url", "--input", planPath],
      environment,
    );
    assert.equal(built.ready, true);
    assert.equal(built.page, 2);
    assert.doesNotMatch(built.url, /sessionId|recentSearchParam/);
    assert.match(built.url, /page=2&query=/);

    const inspected = await runJson(
      ["inspect-url", "--url", built.url],
      environment,
    );
    assert.equal(inspected.page, 2);
    assert.equal(inspected.keywords, 'agentic OR "AI agent"');
    assert.deepEqual(
      inspected.filters.map((filter) => filter.queryType),
      ["REGION", "CURRENT_TITLE", "PROFILE_LANGUAGE"],
    );

    const verified = await runJson(
      [
        "verify-url",
        "--input",
        planPath,
        "--url",
        `${built.url}&sessionId=transient`,
      ],
      environment,
    );
    assert.equal(verified.matches, true);
    assert.equal(verified.actual.hasTransientSession, true);

    fs.writeFileSync(
      aiPlanPath,
      `${JSON.stringify({
        filters: [
          {
            control: "Current job title",
            values: ["AI Engineer"],
            mode: "include",
          },
        ],
      })}\n`,
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [SCRIPT, "build-url", "--input", aiPlanPath],
        { env: environment },
      ),
      (error) => {
        assert.equal(error.code, 3);
        const result = JSON.parse(error.stdout);
        assert.equal(result.reason, "missing_cached_values");
        assert.equal(result.missing[0].freeTextEligible, true);
        assert.match(result.alternativeAction, /freeText:true/);
        return true;
      },
    );

    fs.writeFileSync(
      freeTextPlanPath,
      `${JSON.stringify({
        filters: [
          {
            control: "Current job title",
            values: [{ label: "AI Engineer", freeText: true }],
            mode: "include",
          },
        ],
      })}\n`,
    );
    const freeTextBuilt = await runJson(
      ["build-url", "--input", freeTextPlanPath],
      environment,
    );
    assert.equal(freeTextBuilt.filters[0].values[0].id, null);
    const freeTextInspected = await runJson(
      ["inspect-url", "--url", freeTextBuilt.url],
      environment,
    );
    assert.deepEqual(freeTextInspected.filters[0].values[0], {
      id: null,
      label: "AI Engineer",
      selectionType: "INCLUDED",
    });
    const freeTextVerified = await runJson(
      [
        "verify-url",
        "--input",
        freeTextPlanPath,
        "--url",
        freeTextBuilt.url,
      ],
      environment,
    );
    assert.equal(freeTextVerified.matches, true);

    const recorded = await runJson(
      [
        "record-value",
        "--control",
        "Current job title",
        "--label",
        "AI Engineer",
        "--id",
        "12345",
      ],
      environment,
    );
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.cachedValueCount, 2);

    const recordedControl = await runJson(
      [
        "record-control",
        "--control",
        "Seniority level",
        "--query-type",
        "SENIORITY_LEVEL",
        "--input-type",
        "enum",
        "--multiple",
        "true",
        "--supports-exclude",
        "true",
      ],
      environment,
    );
    assert.equal(recordedControl.recorded, true);
    assert.equal(recordedControl.queryType, "SENIORITY_LEVEL");

    const aiBuilt = await runJson(
      ["build-url", "--input", aiPlanPath],
      environment,
    );
    assert.match(aiBuilt.url, /12345/);

    const refreshed = await runJson(
      ["refresh", "--input", manifestPath],
      environment,
    );
    assert.equal(refreshed.operation, "refresh");
    assert.ok(
      fs.existsSync(path.join(path.dirname(schemaPath), "filter-schema.previous.json")),
    );

    const reset = await runJson(["reset"], environment);
    assert.equal(reset.reset, true);
    assert.equal(fs.existsSync(schemaPath), false);
    assert.ok(fs.existsSync(reset.recoverableBackup));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

async function runJson(args, env) {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
    env,
  });
  return JSON.parse(stdout);
}
