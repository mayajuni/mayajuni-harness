#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SCHEMA_VERSION = 2;
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".linkedin-talent-search-profile");
const DEFAULT_STATE_DIR = ".harness-linkedin-talent";
const DEFAULT_SCHEMA_FILE = "filter-schema.json";
const SEARCH_URL = "https://www.linkedin.com/sales/search/people";

const command = process.argv[2] ?? "help";
const commandArgs = process.argv.slice(3);
const profileDir = path.resolve(
  process.env.LINKEDIN_TALENT_PROFILE_DIR ?? DEFAULT_PROFILE_DIR,
);
const schemaPath = path.resolve(
  process.env.LINKEDIN_TALENT_FILTER_SCHEMA_PATH ??
    path.join(profileDir, DEFAULT_STATE_DIR, DEFAULT_SCHEMA_FILE),
);

function main() {
  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return;
      case "path":
        printJson({ schemaPath, profileDir });
        return;
      case "status":
        printStatus();
        return;
      case "show":
        printJson(readSchema());
        return;
      case "init":
        writeFromInput("init", commandArgs);
        return;
      case "refresh":
        writeFromInput("refresh", commandArgs);
        return;
      case "record-value":
        recordValue(commandArgs);
        return;
      case "record-control":
        recordControl(commandArgs);
        return;
      case "build-url":
        buildUrlCommand(commandArgs);
        return;
      case "inspect-url":
        inspectUrlCommand(commandArgs);
        return;
      case "verify-url":
        verifyUrlCommand(commandArgs);
        return;
      case "reset":
        resetSchema();
        return;
      default:
        fail(`Unknown command: ${command}`, 1);
    }
  } catch (error) {
    if (error instanceof CliError) {
      fail(error.message, error.exitCode);
    }
    fail(error instanceof Error ? error.message : String(error), 2);
  }
}

function printHelp() {
  process.stdout.write(`LinkedIn Talent Search filter schema cache\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  filter-schema.mjs status\n`);
  process.stdout.write(`  filter-schema.mjs show\n`);
  process.stdout.write(`  filter-schema.mjs init --input <schema.json>\n`);
  process.stdout.write(`  filter-schema.mjs refresh --input <schema.json>\n`);
  process.stdout.write(
    `  filter-schema.mjs record-value --control <name> --label <text> --id <id> [--selection-type INCLUDED|EXCLUDED]\n`,
  );
  process.stdout.write(
    `  filter-schema.mjs record-control --control <name> --query-type <URL_TYPE> [--input-type <type>] [--multiple true|false] [--supports-exclude true|false]\n`,
  );
  process.stdout.write(`  filter-schema.mjs build-url --input <filter-plan.json>\n`);
  process.stdout.write(`  filter-schema.mjs inspect-url --url <url>\n`);
  process.stdout.write(
    `  filter-schema.mjs verify-url --input <filter-plan.json> --url <url>\n`,
  );
  process.stdout.write(`  filter-schema.mjs reset\n`);
  process.stdout.write(`  filter-schema.mjs path\n\n`);
  process.stdout.write(`Environment:\n`);
  process.stdout.write(
    `  LINKEDIN_TALENT_PROFILE_DIR (default: ${DEFAULT_PROFILE_DIR})\n`,
  );
  process.stdout.write(`  LINKEDIN_TALENT_FILTER_SCHEMA_PATH (optional exact path)\n`);
}

function printStatus() {
  if (!fs.existsSync(schemaPath)) {
    printJson({
      initialized: false,
      schemaPath,
      profileDir,
      nextAction: "init",
    });
    return;
  }

  const schema = readSchema();
  const confirmed = schema.filters.filter(
    (filter) => filter.urlState === "confirmed" && filter.queryType,
  );
  const unresolved = schema.filters
    .filter(
      (filter) =>
        filter.urlState === "unresolved" ||
        (!filter.queryType && filter.urlState !== "ui_only"),
    )
    .map((filter) => filter.control);
  const uiOnly = schema.filters
    .filter((filter) => filter.urlState === "ui_only")
    .map((filter) => filter.control);
  const cachedValueCount = schema.filters.reduce(
    (sum, filter) => sum + filter.values.length,
    0,
  );

  printJson({
    initialized: true,
    schemaPath,
    profileDir,
    surface: schema.surface,
    locale: schema.locale,
    inventoryComplete: schema.inventoryComplete,
    fingerprint: schema.fingerprint,
    filterCount: schema.filters.length,
    confirmedUrlFilterCount: confirmed.length,
    cachedValueCount,
    keywordSupported: schema.keyword.supported,
    keywordBooleanSyntax: schema.keyword.booleanSyntax,
    unresolvedControls: unresolved,
    uiOnlyControls: uiOnly,
    observedAt: schema.observedAt,
    lastVerifiedAt: schema.lastVerifiedAt,
    updatedAt: schema.updatedAt,
  });
}

function writeFromInput(mode, args) {
  const options = parseOptions(args);
  const inputPath = requiredPathOption(options, "input");
  const exists = fs.existsSync(schemaPath);

  if (mode === "init" && exists) {
    throw new CliError(
      `Filter schema is already initialized at ${schemaPath}. Use status or refresh.`,
      2,
    );
  }
  if (mode === "refresh" && !exists) {
    throw new CliError(
      `Filter schema is not initialized at ${schemaPath}. Use init first.`,
      2,
    );
  }

  const input = readJsonFile(inputPath);
  const previous = exists ? readJsonFile(schemaPath) : null;
  const now = new Date().toISOString();
  const schema = normalizeSchema(input, {
    createdAt:
      typeof previous?.createdAt === "string" && previous.createdAt.trim()
        ? previous.createdAt.trim()
        : now,
    updatedAt: now,
    lastVerifiedAt: input.lastVerifiedAt ?? input.observedAt ?? now,
  });
  if (!schema.inventoryComplete) {
    throw new CliError(
      `${mode} requires a complete All filters inventory. Account for every visible control before saving.`,
      2,
    );
  }

  if (previous) {
    const previousPath = path.join(path.dirname(schemaPath), "filter-schema.previous.json");
    fs.copyFileSync(schemaPath, previousPath);
  }
  writeJsonAtomic(schemaPath, schema);

  printJson({
    initialized: true,
    operation: mode,
    schemaPath,
    fingerprint: schema.fingerprint,
    filterCount: schema.filters.length,
    confirmedUrlFilterCount: schema.filters.filter(
      (filter) => filter.urlState === "confirmed" && filter.queryType,
    ).length,
    cachedValueCount: schema.filters.reduce(
      (sum, filter) => sum + filter.values.length,
      0,
    ),
  });
}

function recordValue(args) {
  const options = parseOptions(args);
  const control = requiredStringOption(options, "control");
  const label = requiredStringOption(options, "label");
  const id = requiredStringOption(options, "id");
  const selectionType = normalizeSelectionType(
    options["selection-type"] ?? "INCLUDED",
  );
  const schema = readSchema();
  const filter = findFilter(schema, control);

  if (!filter.queryType || filter.urlState !== "confirmed") {
    throw new CliError(
      `Control ${filter.control} does not have a confirmed URL query type. Refresh the schema first.`,
      2,
    );
  }

  const normalizedLabel = normalizeLookup(label);
  const existingIndex = filter.values.findIndex(
    (value) => normalizeLookup(value.label) === normalizedLabel,
  );
  const value = {
    id,
    label,
    selectionType,
    source: "observed_ui_url",
    lastVerifiedAt: new Date().toISOString(),
  };
  if (existingIndex >= 0) filter.values[existingIndex] = value;
  else filter.values.push(value);
  filter.values.sort((a, b) => a.label.localeCompare(b.label));
  schema.updatedAt = new Date().toISOString();
  schema.lastVerifiedAt = schema.updatedAt;
  writeJsonAtomic(schemaPath, schema);

  printJson({
    recorded: true,
    control: filter.control,
    queryType: filter.queryType,
    value,
    cachedValueCount: filter.values.length,
  });
}

function recordControl(args) {
  const options = parseOptions(args);
  const control = requiredStringOption(options, "control");
  const queryType = normalizeQueryType(
    requiredStringOption(options, "query-type"),
    "record-control",
  );
  const schema = readSchema();
  const filter = findFilter(schema, control);
  filter.queryType = queryType;
  filter.urlState = "confirmed";
  if (options["input-type"] !== undefined) {
    filter.inputType = normalizeToken(
      options["input-type"],
      "record-control.input-type",
    );
  }
  if (options.multiple !== undefined) {
    filter.multiple = parseBooleanOption(options.multiple, "multiple");
  }
  if (options["supports-exclude"] !== undefined) {
    filter.supportsExclude = parseBooleanOption(
      options["supports-exclude"],
      "supports-exclude",
    );
  }
  schema.updatedAt = new Date().toISOString();
  schema.lastVerifiedAt = schema.updatedAt;
  schema.fingerprint = fingerprintFor(schema);
  writeJsonAtomic(schemaPath, schema);

  printJson({
    recorded: true,
    control: filter.control,
    controlKey: filter.controlKey,
    queryType: filter.queryType,
    inputType: filter.inputType,
    multiple: filter.multiple,
    supportsExclude: filter.supportsExclude,
    fingerprint: schema.fingerprint,
  });
}

function buildUrlCommand(args) {
  const options = parseOptions(args);
  const inputPath = requiredPathOption(options, "input");
  const schema = readSchema();
  const plan = readJsonFile(inputPath);
  printJson(buildUrl(schema, plan));
}

function inspectUrlCommand(args) {
  const options = parseOptions(args);
  const url = requiredStringOption(options, "url");
  printJson(inspectUrl(url));
}

function verifyUrlCommand(args) {
  const options = parseOptions(args);
  const inputPath = requiredPathOption(options, "input");
  const actualUrl = requiredStringOption(options, "url");
  const schema = readSchema();
  const expectedBuild = buildUrl(schema, readJsonFile(inputPath));
  const expected = inspectUrl(expectedBuild.url);
  const actual = inspectUrl(actualUrl);
  const expectedEntries = canonicalFilterEntries(expected.filters);
  const actualEntries = canonicalFilterEntries(actual.filters);
  const missing = expectedEntries.filter((entry) => !actualEntries.includes(entry));
  const unexpected = actualEntries.filter((entry) => !expectedEntries.includes(entry));
  const keywordsMatch = expected.keywords === actual.keywords;
  const pageMatch = expected.page === actual.page;
  const matches =
    missing.length === 0 &&
    unexpected.length === 0 &&
    keywordsMatch &&
    pageMatch;

  printJson({
    matches,
    missing,
    unexpected,
    keywordsMatch,
    pageMatch,
    expected: {
      filterCount: expected.filters.length,
      keywords: expected.keywords,
      page: expected.page,
    },
    actual: {
      filterCount: actual.filters.length,
      keywords: actual.keywords,
      page: actual.page,
      hasTransientSession: actual.hasTransientSession,
      hasRecentSearchParam: actual.hasRecentSearchParam,
    },
  });

  if (!matches) process.exitCode = 4;
}

function resetSchema() {
  if (!fs.existsSync(schemaPath)) {
    printJson({ reset: false, initialized: false, schemaPath, reason: "not_initialized" });
    return;
  }

  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    path.dirname(schemaPath),
    `filter-schema.reset-${suffix}.json`,
  );
  fs.renameSync(schemaPath, backupPath);
  printJson({
    reset: true,
    initialized: false,
    schemaPath,
    recoverableBackup: backupPath,
  });
}

function normalizeSchema(input, timestamps) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CliError("Schema input must be a JSON object.", 2);
  }
  const surface = nonEmptyString(input.surface, "surface");
  const locale = nonEmptyString(input.locale ?? "unknown", "locale");
  const inventoryComplete = normalizeBoolean(
    input.inventoryComplete ?? false,
    "inventoryComplete",
  );
  const observedAt = nonEmptyString(
    input.observedAt ?? timestamps.lastVerifiedAt,
    "observedAt",
  );
  if (!Array.isArray(input.filters) || input.filters.length === 0) {
    throw new CliError("Schema filters must be a non-empty array.", 2);
  }
  const keyword = normalizeKeyword(input.keyword);

  const seenControls = new Set();
  const filters = input.filters.map((rawFilter, index) => {
    if (!rawFilter || typeof rawFilter !== "object" || Array.isArray(rawFilter)) {
      throw new CliError(`filters[${index}] must be an object.`, 2);
    }
    const control = nonEmptyString(rawFilter.control, `filters[${index}].control`);
    const controlLookupKey = normalizeLookup(control);
    if (seenControls.has(controlLookupKey)) {
      throw new CliError(`Duplicate filter control: ${control}`, 2);
    }
    seenControls.add(controlLookupKey);

    const inputType = normalizeToken(
      rawFilter.inputType ?? "unknown",
      `filters[${index}].inputType`,
    );
    const controlKey = normalizeControlKey(rawFilter.controlKey, index);
    const queryType = normalizeQueryType(rawFilter.queryType, index);
    const urlState = normalizeUrlState(
      rawFilter.urlState ?? (queryType ? "confirmed" : "unresolved"),
      index,
    );
    if (urlState === "confirmed" && !queryType) {
      throw new CliError(
        `filters[${index}] cannot be confirmed without queryType.`,
        2,
      );
    }
    const values = normalizeValues(rawFilter.values ?? [], index);
    return {
      control,
      controlKey,
      queryType,
      inputType,
      multiple: normalizeBoolean(
        rawFilter.multiple ?? false,
        `filters[${index}].multiple`,
      ),
      supportsExclude: normalizeBoolean(
        rawFilter.supportsExclude ?? false,
        `filters[${index}].supportsExclude`,
      ),
      urlState,
      values,
      notes:
        typeof rawFilter.notes === "string" && rawFilter.notes.trim()
          ? rawFilter.notes.trim()
          : null,
    };
  });

  const fingerprint = fingerprintFor({
    surface,
    locale,
    inventoryComplete,
    keyword,
    filters,
  });
  if (input.fingerprint && input.fingerprint !== fingerprint) {
    throw new CliError(
      `Schema fingerprint mismatch. Expected ${fingerprint}, received ${input.fingerprint}.`,
      2,
    );
  }

  return {
    version: SCHEMA_VERSION,
    surface,
    locale,
    inventoryComplete,
    profileScope: "browser_profile",
    observedAt,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    lastVerifiedAt: timestamps.lastVerifiedAt,
    fingerprint,
    keyword,
    filters,
  };
}

function normalizeValues(rawValues, filterIndex) {
  if (!Array.isArray(rawValues)) {
    throw new CliError(`filters[${filterIndex}].values must be an array.`, 2);
  }
  const seenLabels = new Set();
  return rawValues.map((rawValue, valueIndex) => {
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      throw new CliError(
        `filters[${filterIndex}].values[${valueIndex}] must be an object.`,
        2,
      );
    }
    const label = nonEmptyString(
      rawValue.label ?? rawValue.text,
      `filters[${filterIndex}].values[${valueIndex}].label`,
    );
    const labelKey = normalizeLookup(label);
    if (seenLabels.has(labelKey)) {
      throw new CliError(
        `Duplicate value label for filter ${filterIndex}: ${label}`,
        2,
      );
    }
    seenLabels.add(labelKey);
    return {
      id: nonEmptyString(
        String(rawValue.id ?? ""),
        `filters[${filterIndex}].values[${valueIndex}].id`,
      ),
      label,
      selectionType: normalizeSelectionType(
        rawValue.selectionType ?? "INCLUDED",
      ),
      source:
        typeof rawValue.source === "string" && rawValue.source.trim()
          ? rawValue.source.trim()
          : "observed_ui_url",
      lastVerifiedAt:
        typeof rawValue.lastVerifiedAt === "string" && rawValue.lastVerifiedAt.trim()
          ? rawValue.lastVerifiedAt.trim()
          : null,
    };
  });
}

function readSchema() {
  if (!fs.existsSync(schemaPath)) {
    throw new CliError(
      `Filter schema is not initialized at ${schemaPath}. Run init first.`,
      3,
    );
  }
  const raw = readJsonFile(schemaPath);
  if (raw.version !== SCHEMA_VERSION) {
    throw new CliError(
      `Unsupported filter schema version ${raw.version}; expected ${SCHEMA_VERSION}. Run refresh.`,
      2,
    );
  }
  return normalizeSchema(raw, {
    createdAt: nonEmptyString(raw.createdAt, "createdAt"),
    updatedAt: nonEmptyString(raw.updatedAt, "updatedAt"),
    lastVerifiedAt: nonEmptyString(raw.lastVerifiedAt, "lastVerifiedAt"),
  });
}

function buildUrl(schema, plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new CliError("Filter plan must be a JSON object.", 2);
  }
  if (!Array.isArray(plan.filters) || plan.filters.length === 0) {
    throw new CliError("Filter plan filters must be a non-empty array.", 2);
  }

  const missing = [];
  const builtFilters = plan.filters.map((rawFilter, filterIndex) => {
    if (!rawFilter || typeof rawFilter !== "object" || Array.isArray(rawFilter)) {
      throw new CliError(`Plan filters[${filterIndex}] must be an object.`, 2);
    }
    const requestedControl = nonEmptyString(
      rawFilter.control,
      `plan.filters[${filterIndex}].control`,
    );
    const schemaFilter = findFilter(schema, requestedControl);
    if (!schemaFilter.queryType || schemaFilter.urlState !== "confirmed") {
      printJson({
        ready: false,
        reason:
          schemaFilter.urlState === "ui_only"
            ? "ui_only_control"
            : "unresolved_control",
        control: schemaFilter.control,
        controlKey: schemaFilter.controlKey,
        inputType: schemaFilter.inputType,
        nextAction:
          schemaFilter.urlState === "ui_only"
            ? "apply_and_verify_in_live_ui"
            : "resolve_query_type_in_ui_then_record_control",
      });
      process.exit(3);
    }
    const requestedValues = Array.isArray(rawFilter.values)
      ? rawFilter.values
      : rawFilter.value !== undefined
        ? [rawFilter.value]
        : [];
    if (requestedValues.length === 0) {
      throw new CliError(
        `Plan filter ${schemaFilter.control} requires at least one value.`,
        2,
      );
    }
    if (!schemaFilter.multiple && requestedValues.length > 1) {
      throw new CliError(
        `Plan filter ${schemaFilter.control} does not support multiple values.`,
        2,
      );
    }

    const mode = normalizePlanMode(rawFilter.mode ?? "include");
    if (mode === "exclude" && !schemaFilter.supportsExclude) {
      throw new CliError(
        `Plan filter ${schemaFilter.control} does not support exclusion.`,
        2,
      );
    }
    const selectionType = mode === "exclude" ? "EXCLUDED" : "INCLUDED";
    const values = requestedValues.map((requestedValue) => {
      const label =
        typeof requestedValue === "string"
          ? requestedValue
          : requestedValue && typeof requestedValue === "object"
            ? requestedValue.label ?? requestedValue.text
            : null;
      if (typeof label !== "string" || !label.trim()) {
        throw new CliError(
          `Plan filter ${schemaFilter.control} contains an invalid value label.`,
          2,
        );
      }
      const cached = schemaFilter.values.find(
        (value) => normalizeLookup(value.label) === normalizeLookup(label),
      );
      if (!cached) {
        // Some Sales Navigator typeahead controls (for example CURRENT_TITLE)
        // accept a text-only value with no taxonomy id. Emit one only when the
        // plan opts in explicitly, so ids are never invented for a control that
        // genuinely requires them.
        const freeTextRequested =
          requestedValue !== null &&
          typeof requestedValue === "object" &&
          requestedValue.freeText === true;
        if (freeTextRequested && schemaFilter.inputType === "typeahead") {
          return { id: null, label: label.trim(), selectionType };
        }
        missing.push({
          control: schemaFilter.control,
          queryType: schemaFilter.queryType,
          label: label.trim(),
          inputType: schemaFilter.inputType,
          freeTextEligible: schemaFilter.inputType === "typeahead",
        });
        return null;
      }
      return {
        id: cached.id,
        label: cached.label,
        selectionType,
      };
    });

    return {
      control: schemaFilter.control,
      queryType: schemaFilter.queryType,
      values,
    };
  });

  if (missing.length > 0) {
    printJson({
      ready: false,
      reason: "missing_cached_values",
      missing,
      nextAction: "resolve_missing_values_in_ui_then_record_value",
      alternativeAction:
        "For an entry marked freeTextEligible, set freeText:true on the plan value to emit a text-only value with no id, then verify the resulting chip in the live UI.",
    });
    process.exit(3);
  }

  const page = normalizePage(plan.page ?? 1);
  const keywords =
    typeof plan.keywords === "string" && plan.keywords.trim()
      ? plan.keywords.trim()
      : null;
  if (keywords && !schema.keyword.supported) {
    throw new CliError(
      "The initialized schema does not confirm a URL-capable keyword control.",
      3,
    );
  }
  const filterQuery = builtFilters
    .map((filter) => {
      const values = filter.values
        .map((value) =>
          value.id === null || value.id === undefined
            ? `(text:${encodeInner(value.label)},selectionType:${value.selectionType})`
            : `(id:${encodeInner(value.id)},text:${encodeInner(value.label)},selectionType:${value.selectionType})`,
        )
        .join(",");
      return `(type:${filter.queryType},values:List(${values}))`;
    })
    .join(",");
  const queryFields = [`filters:List(${filterQuery})`];
  if (keywords) queryFields.push(`keywords:${encodeInner(keywords)}`);
  const rawQuery = `(${queryFields.join(",")})`;
  const query = encodeURIComponent(rawQuery);
  const pageParameter = page > 1 ? `page=${page}&` : "";
  const url = `${SEARCH_URL}?${pageParameter}query=${query}`;

  return {
    ready: true,
    url,
    page,
    keywords,
    filters: builtFilters,
    omittedTransientState: ["sessionId", "recentSearchParam.id"],
  };
}

function inspectUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CliError("Invalid URL.", 2);
  }
  if (url.origin !== "https://www.linkedin.com" || url.pathname !== "/sales/search/people") {
    throw new CliError("URL must be a LinkedIn Sales Navigator people-search URL.", 2);
  }
  const query = url.searchParams.get("query");
  if (!query) throw new CliError("URL does not contain a query parameter.", 2);
  const fields = splitTopLevel(stripOuterParens(query), ",");
  const filtersField = fields.find((field) => field.startsWith("filters:List("));
  if (!filtersField) throw new CliError("URL query does not contain filters:List.", 2);
  const filterList = extractList(filtersField, "filters:List(");
  const filterSegments = parenthesizedSegments(filterList);
  const filters = filterSegments.map(parseFilterSegment);
  const keywordsField = fields.find((field) => field.startsWith("keywords:"));
  const recentSearchField = fields.find((field) =>
    field.startsWith("recentSearchParam:"),
  );

  return {
    page: normalizePage(url.searchParams.get("page") ?? 1),
    keywords: keywordsField
      ? decodeInner(keywordsField.slice("keywords:".length))
      : null,
    filters,
    hasTransientSession: url.searchParams.has("sessionId"),
    hasRecentSearchParam: Boolean(recentSearchField),
  };
}

function parseFilterSegment(segment) {
  const fields = splitTopLevel(segment, ",");
  const typeField = fields.find((field) => field.startsWith("type:"));
  const valuesField = fields.find((field) => field.startsWith("values:List("));
  if (!typeField || !valuesField) {
    throw new CliError(`Unsupported filter query segment: ${segment}`, 2);
  }
  const queryType = typeField.slice("type:".length);
  const valueSegments = parenthesizedSegments(extractList(valuesField, "values:List("));
  const values = valueSegments.map((valueSegment) => {
    const valueFields = splitTopLevel(valueSegment, ",");
    // `id` is absent for text-only values on free-text typeahead controls.
    const id = optionalFieldValue(valueFields, "id");
    const text = fieldValue(valueFields, "text");
    const selectionType = normalizeSelectionType(
      fieldValue(valueFields, "selectionType"),
    );
    return {
      id: id === null ? null : decodeInner(id),
      label: decodeInner(text),
      selectionType,
    };
  });
  return { queryType, values };
}

function canonicalFilterEntries(filters) {
  return filters
    .flatMap((filter) =>
      // Text-only values have no id, so compare them by their label instead.
      filter.values.map(
        (value) =>
          `${filter.queryType}|${value.id ?? `text:${normalizeLookup(value.label)}`}|${value.selectionType}`,
      ),
    )
    .sort();
}

function findFilter(schema, requestedControl) {
  const key = normalizeLookup(requestedControl);
  const controlMatch = schema.filters.find(
    (candidate) => normalizeLookup(candidate.control) === key,
  );
  if (controlMatch) return controlMatch;
  const queryTypeMatches = schema.filters.filter(
    (candidate) => normalizeLookup(candidate.queryType ?? "") === key,
  );
  if (queryTypeMatches.length === 1) return queryTypeMatches[0];
  if (queryTypeMatches.length > 1) {
    throw new CliError(
      `Ambiguous query type ${requestedControl}; use an exact control label.`,
      3,
    );
  }
  if (queryTypeMatches.length === 0) {
    throw new CliError(`Unknown filter control: ${requestedControl}`, 3);
  }
  return queryTypeMatches[0];
}

function fingerprintFor({ surface, locale, inventoryComplete, keyword, filters }) {
  const inventory = filters
    .map((filter) => ({
      control: filter.control,
      controlKey: filter.controlKey,
      inputType: filter.inputType,
      queryType: filter.queryType,
      urlState: filter.urlState,
    }))
    .sort((a, b) => a.control.localeCompare(b.control));
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({ surface, locale, inventoryComplete, keyword, inventory }),
    )
    .digest("hex");
}

function extractList(value, prefix) {
  if (!value.startsWith(prefix) || !value.endsWith(")")) {
    throw new CliError(`Invalid list expression: ${value}`, 2);
  }
  return value.slice(prefix.length, -1);
}

function parenthesizedSegments(value) {
  const segments = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") {
      if (depth === 0) start = index + 1;
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new CliError("Unbalanced query parentheses.", 2);
      if (depth === 0 && start >= 0) {
        segments.push(value.slice(start, index));
        start = -1;
      }
    } else if (depth === 0 && !/[\s,]/.test(character)) {
      throw new CliError(`Unexpected list content near: ${value.slice(index)}`, 2);
    }
  }
  if (depth !== 0) throw new CliError("Unbalanced query parentheses.", 2);
  return segments;
}

function splitTopLevel(value, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
    if (depth < 0) throw new CliError("Unbalanced query parentheses.", 2);
  }
  if (depth !== 0) throw new CliError("Unbalanced query parentheses.", 2);
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function stripOuterParens(value) {
  if (!value.startsWith("(") || !value.endsWith(")")) {
    throw new CliError("LinkedIn query must be wrapped in parentheses.", 2);
  }
  return value.slice(1, -1);
}

function fieldValue(fields, name) {
  const prefix = `${name}:`;
  const field = fields.find((candidate) => candidate.startsWith(prefix));
  if (!field) throw new CliError(`Missing ${name} in query value.`, 2);
  return field.slice(prefix.length);
}

function optionalFieldValue(fields, name) {
  const prefix = `${name}:`;
  const field = fields.find((candidate) => candidate.startsWith(prefix));
  return field ? field.slice(prefix.length) : null;
}

function encodeInner(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodeInner(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CliError(`Invalid encoded query value: ${value}`, 2);
  }
}

function normalizeLookup(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeQueryType(value, filterIndex) {
  if (value === null || value === undefined || value === "") return null;
  const queryType = String(value).trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(queryType)) {
    throw new CliError(`Invalid filters[${filterIndex}].queryType: ${value}`, 2);
  }
  return queryType;
}

function normalizeKeyword(value) {
  if (value === null || value === undefined) {
    return {
      control: null,
      supported: false,
      booleanSyntax: "unverified",
      notes: null,
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("keyword must be an object.", 2);
  }
  const supported = normalizeBoolean(value.supported ?? false, "keyword.supported");
  const control = supported
    ? nonEmptyString(value.control, "keyword.control")
    : typeof value.control === "string" && value.control.trim()
      ? value.control.trim()
      : null;
  const booleanSyntax = normalizeToken(
    value.booleanSyntax ?? "unverified",
    "keyword.booleanSyntax",
  );
  if (!["confirmed", "unverified", "unsupported"].includes(booleanSyntax)) {
    throw new CliError(
      "keyword.booleanSyntax must be confirmed, unverified, or unsupported.",
      2,
    );
  }
  return {
    control,
    supported,
    booleanSyntax,
    notes:
      typeof value.notes === "string" && value.notes.trim()
        ? value.notes.trim()
        : null,
  };
}

function normalizeControlKey(value, filterIndex) {
  if (value === null || value === undefined || value === "") return null;
  const controlKey = String(value).trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(controlKey)) {
    throw new CliError(`Invalid filters[${filterIndex}].controlKey: ${value}`, 2);
  }
  return controlKey;
}

function normalizeUrlState(value, filterIndex) {
  const normalized = String(value).trim().toLowerCase();
  if (!["confirmed", "unresolved", "ui_only"].includes(normalized)) {
    throw new CliError(`Invalid filters[${filterIndex}].urlState: ${value}`, 2);
  }
  return normalized;
}

function normalizeSelectionType(value) {
  const normalized = String(value).trim().toUpperCase();
  if (!["INCLUDED", "EXCLUDED"].includes(normalized)) {
    throw new CliError(`Invalid selectionType: ${value}`, 2);
  }
  return normalized;
}

function normalizePlanMode(value) {
  const normalized = String(value).trim().toLowerCase();
  if (!["include", "exclude"].includes(normalized)) {
    throw new CliError(`Invalid filter mode: ${value}`, 2);
  }
  return normalized;
}

function normalizePage(value) {
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1 || page > 1000) {
    throw new CliError(`Invalid page: ${value}`, 2);
  }
  return page;
}

function normalizeToken(value, fieldName) {
  const normalized = String(value).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(normalized)) {
    throw new CliError(`Invalid ${fieldName}: ${value}`, 2);
  }
  return normalized;
}

function normalizeBoolean(value, fieldName) {
  if (typeof value !== "boolean") {
    throw new CliError(`${fieldName} must be a boolean.`, 2);
  }
  return value;
}

function parseBooleanOption(value, fieldName) {
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new CliError(`--${fieldName} must be true or false.`, 1);
}

function nonEmptyString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CliError(`${fieldName} must be a non-empty string.`, 2);
  }
  return value.trim();
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new CliError(`Unexpected argument: ${argument}`, 1);
    }
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex > 2) {
      options[argument.slice(2, equalsIndex)] = argument.slice(equalsIndex + 1);
      continue;
    }
    const key = argument.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function requiredStringOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new CliError(`--${name} is required.`, 1);
  }
  return value.trim();
}

function requiredPathOption(options, name) {
  return path.resolve(requiredStringOption(options, name));
}

function readJsonFile(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new CliError(`Could not read ${filePath}: ${error.message}`, 2);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new CliError(`Invalid JSON in ${filePath}: ${error.message}`, 2);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, exitCode) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

main();
