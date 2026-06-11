#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const STATIC_RESOURCE_TYPES = new Set([
  "Image",
  "Media",
  "Font",
  "Stylesheet",
  "Script",
  "Manifest",
]);

const SECRET_KEY_PATTERN =
  /(authorization|cookie|token|secret|password|passwd|session|csrf|xsrf|api[-_]?key|refresh|access[-_]?token|id[-_]?token)/i;

const DEFAULT_CDP = "http://127.0.0.1:9222";

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (typeof WebSocket !== "function") {
    throw new Error("This script requires a Node.js runtime with global WebSocket support.");
  }

  const startedAt = new Date();
  const cdpBase = options.cdp ?? DEFAULT_CDP;
  const target = await resolveTarget(cdpBase, options);
  const outDir = path.resolve(options.out ?? defaultOutDir(startedAt));
  fs.mkdirSync(outDir, { recursive: true });

  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();

  const state = {
    options,
    startedAt: startedAt.toISOString(),
    target,
    pageEvents: [],
    requests: new Map(),
    domSnapshots: [],
  };

  attachNetworkHandlers(client, state);
  attachPageHandlers(client, state);

  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable", {
    maxTotalBufferSize: 100000000,
    maxResourceBufferSize: 5000000,
  });

  if (options.url) {
    await client.send("Page.navigate", { url: options.url });
  }

  await sleep(Number(options.warmupMs ?? 1500));
  await collectDomSnapshot(client, state, "start");

  const seconds = Number(options.seconds ?? 120);
  console.log(`Capturing ${seconds}s from ${target.url || options.url || "current tab"}...`);
  console.log(`Output: ${outDir}`);
  await sleep(seconds * 1000);

  await collectDomSnapshot(client, state, "end");
  await client.close();

  const raw = buildRawCapture(state);
  const catalog = buildCatalog(raw);
  const dictionary = buildDataDictionary(catalog);

  writeJson(path.join(outDir, "raw-network.json"), raw);
  writeJson(path.join(outDir, "api-catalog.json"), catalog);
  fs.writeFileSync(path.join(outDir, "api-inventory.md"), renderInventory(catalog), "utf8");
  fs.writeFileSync(path.join(outDir, "data-dictionary.md"), renderDictionary(dictionary), "utf8");

  console.log(`Captured ${raw.requests.length} requests across ${catalog.endpoints.length} endpoints.`);
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, rawValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (rawValue !== undefined) {
      options[key] = rawValue;
    } else if (args[index + 1] && !args[index + 1].startsWith("--")) {
      options[key] = args[index + 1];
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

async function resolveTarget(cdpBase, options) {
  const tabs = await fetchJson(`${cdpBase}/json/list`);
  const pages = tabs.filter((tab) => tab.type === "page" && tab.webSocketDebuggerUrl);
  const match = options.match ?? options.url;
  if (match) {
    const matched = pages.find((tab) => tab.url?.includes(match) || tab.title?.includes(match));
    if (matched) {
      return matched;
    }
  }

  if (options.url) {
    const created = await createTab(cdpBase, options.url);
    if (created?.webSocketDebuggerUrl) {
      return created;
    }
  }

  const active = pages.find((tab) => tab.url && !tab.url.startsWith("devtools://"));
  if (!active) {
    throw new Error(`No debuggable Chrome page found at ${cdpBase}. Start Chrome with remote debugging first.`);
  }
  return active;
}

async function createTab(cdpBase, url) {
  const endpoint = `${cdpBase}/json/new?${encodeURIComponent(url)}`;
  for (const method of ["PUT", "GET"]) {
    try {
      const response = await fetch(endpoint, { method });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Try the next method.
    }
  }
  return null;
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  async close() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  on(method, listener) {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }
      }, 10000).unref?.();
    });
  }

  handleMessage(data) {
    const message = JSON.parse(data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const listeners = this.listeners.get(message.method) ?? [];
    for (const listener of listeners) {
      listener(message.params ?? {});
    }
  }
}

function attachNetworkHandlers(client, state) {
  client.on("Network.requestWillBeSent", (event) => {
    const request = event.request ?? {};
    if (!shouldCaptureRequest(request.url, event.type, state.options)) {
      return;
    }

    state.requests.set(event.requestId, {
      requestId: event.requestId,
      timestamp: event.timestamp,
      wallTime: event.wallTime,
      frameId: event.frameId,
      loaderId: event.loaderId,
      type: event.type,
      documentURL: event.documentURL,
      initiator: summarizeInitiator(event.initiator),
      request: {
        method: request.method,
        url: request.url,
        headers: sanitizeObject(request.headers ?? {}),
        postData: sanitizeBody(request.postData),
      },
      response: null,
      responseBody: null,
      errorText: null,
    });
  });

  client.on("Network.responseReceived", (event) => {
    const entry = state.requests.get(event.requestId);
    if (!entry) {
      return;
    }

    const response = event.response ?? {};
    entry.response = {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      mimeType: response.mimeType,
      headers: sanitizeObject(response.headers ?? {}),
      fromDiskCache: response.fromDiskCache,
      fromServiceWorker: response.fromServiceWorker,
      encodedDataLength: response.encodedDataLength,
    };
  });

  client.on("Network.loadingFinished", async (event) => {
    const entry = state.requests.get(event.requestId);
    if (!entry || !shouldCaptureBody(entry, state.options)) {
      return;
    }

    try {
      const body = await client.send("Network.getResponseBody", {
        requestId: event.requestId,
      });
      entry.responseBody = summarizeBody(body, state.options);
    } catch (error) {
      entry.responseBody = {
        omitted: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  client.on("Network.loadingFailed", (event) => {
    const entry = state.requests.get(event.requestId);
    if (entry) {
      entry.errorText = event.errorText;
    }
  });
}

function attachPageHandlers(client, state) {
  client.on("Page.frameNavigated", (event) => {
    if (event.frame) {
      state.pageEvents.push({
        type: "frameNavigated",
        url: event.frame.url,
        name: event.frame.name,
        timestamp: new Date().toISOString(),
      });
    }
  });
}

async function collectDomSnapshot(client, state, label) {
  const expression = `(() => {
    const trim = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const options = Array.from(document.querySelectorAll("select")).map((select) => ({
      name: select.name || select.id || select.getAttribute("aria-label") || "",
      text: trim(select.innerText).slice(0, 300),
      options: Array.from(select.options).slice(0, 200).map((option) => ({
        value: option.value,
        label: trim(option.textContent)
      }))
    }));
    const controls = Array.from(document.querySelectorAll("a,button,input,textarea,[role=button],[role=tab]"))
      .slice(0, 500)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || el.id || "",
        text: trim(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title")).slice(0, 160),
        href: el.href || ""
      }))
      .filter((item) => item.text || item.href || item.name);
    return {
      title: document.title,
      url: location.href,
      bodyText: trim(document.body?.innerText || "").slice(0, 12000),
      storage: {
        localStorage: Object.keys(localStorage).slice(0, 200),
        sessionStorage: Object.keys(sessionStorage).slice(0, 200)
      },
      selects: options,
      controls
    };
  })()`;

  try {
    const result = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    state.domSnapshots.push({
      label,
      capturedAt: new Date().toISOString(),
      value: sanitizeObject(result.result?.value ?? {}),
    });
  } catch (error) {
    state.domSnapshots.push({
      label,
      capturedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function shouldCaptureRequest(url, resourceType, options) {
  if (!url || /^(data|blob|chrome|devtools):/i.test(url)) {
    return false;
  }

  if (options.sameOrigin && options.url) {
    try {
      if (new URL(url).origin !== new URL(options.url).origin) {
        return false;
      }
    } catch {
      return false;
    }
  }

  if (!options.includeAssets && STATIC_RESOURCE_TYPES.has(resourceType)) {
    return false;
  }

  return true;
}

function shouldCaptureBody(entry, options) {
  const mime = entry.response?.mimeType ?? "";
  if (/json|text|xml|graphql|javascript|form/i.test(mime)) {
    return true;
  }
  const url = entry.request?.url ?? "";
  return /\/(api|graphql|rest|rpc|ajax|v[0-9])\b/i.test(new URL(url).pathname);
}

function summarizeBody(body, options) {
  if (body.base64Encoded) {
    return { omitted: true, reason: "base64 response body" };
  }

  const maxBody = Number(options.maxBody ?? 200000);
  const text = body.body.length > maxBody ? `${body.body.slice(0, maxBody)}...[truncated]` : body.body;
  return {
    text: sanitizeText(text),
    json: tryParseJson(text),
    truncated: body.body.length > maxBody,
  };
}

function buildRawCapture(state) {
  return {
    generatedAt: new Date().toISOString(),
    startedAt: state.startedAt,
    startUrl: state.options.url ?? null,
    target: {
      id: state.target.id,
      title: state.target.title,
      url: state.target.url,
    },
    pageEvents: state.pageEvents,
    domSnapshots: state.domSnapshots,
    requests: [...state.requests.values()].map((entry) => sanitizeObject(entry)),
  };
}

function buildCatalog(raw) {
  const groups = new Map();

  for (const entry of raw.requests) {
    const requestUrl = entry.request?.url;
    if (!requestUrl) {
      continue;
    }

    const url = new URL(requestUrl);
    const method = entry.request.method ?? "GET";
    const pathPattern = normalizePath(url.pathname);
    const key = `${method} ${url.origin}${pathPattern}`;
    const group = groups.get(key) ?? {
      method,
      origin: url.origin,
      pathPattern,
      observedUrls: [],
      resourceTypes: new Set(),
      statusCodes: new Set(),
      contentTypes: new Set(),
      queryParameters: new Map(),
      bodyFields: new Map(),
      requestHeaders: new Set(),
      responseSchema: null,
      responseFields: new Map(),
      codeCandidates: new Map(),
      calledFrom: new Set(),
      samples: [],
      confidence: "confirmed",
    };

    group.observedUrls.push(requestUrl);
    group.resourceTypes.add(entry.type);
    if (entry.response?.status) {
      group.statusCodes.add(entry.response.status);
    }
    if (entry.response?.mimeType) {
      group.contentTypes.add(entry.response.mimeType);
    }
    for (const [name, value] of url.searchParams.entries()) {
      addParam(group.queryParameters, name, value);
      addCodeCandidate(group.codeCandidates, name, value, "query");
    }
    for (const headerName of Object.keys(entry.request?.headers ?? {})) {
      group.requestHeaders.add(headerName);
    }

    const parsedBody = parseRequestBody(entry.request?.postData);
    for (const field of flattenValue(parsedBody)) {
      addParam(group.bodyFields, field.path, field.example, field.type);
      addCodeCandidate(group.codeCandidates, field.path, field.example, "body");
    }

    const responseJson = entry.responseBody?.json;
    if (responseJson !== null && responseJson !== undefined) {
      group.responseSchema = mergeSchema(group.responseSchema, inferSchema(responseJson));
      for (const field of flattenValue(responseJson)) {
        addParam(group.responseFields, field.path, field.example, field.type);
        addCodeCandidate(group.codeCandidates, field.path, field.example, "response");
      }
    }

    if (entry.documentURL) {
      group.calledFrom.add(entry.documentURL);
    }
    if (group.samples.length < 3) {
      group.samples.push({
        url: requestUrl,
        status: entry.response?.status ?? null,
        requestBody: parsedBody,
        responseBody: responseJson ?? null,
      });
    }

    groups.set(key, group);
  }

  const endpoints = [...groups.values()].map((group) => ({
    method: group.method,
    origin: group.origin,
    pathPattern: group.pathPattern,
    observedUrls: unique(group.observedUrls).slice(0, 20),
    resourceTypes: [...group.resourceTypes],
    statusCodes: [...group.statusCodes],
    contentTypes: [...group.contentTypes],
    requestHeaders: [...group.requestHeaders].sort(),
    queryParameters: paramsToArray(group.queryParameters),
    bodyFields: paramsToArray(group.bodyFields),
    responseSchema: group.responseSchema,
    responseFields: paramsToArray(group.responseFields),
    codeCandidates: paramsToArray(group.codeCandidates),
    calledFrom: [...group.calledFrom].slice(0, 20),
    samples: group.samples,
    confidence: group.confidence,
  }));

  return {
    generatedAt: raw.generatedAt,
    startUrl: raw.startUrl,
    target: raw.target,
    coverage: {
      pagesObserved: unique(raw.pageEvents.map((event) => event.url).filter(Boolean)),
      domSnapshots: raw.domSnapshots.map((snapshot) => ({
        label: snapshot.label,
        url: snapshot.value?.url,
        title: snapshot.value?.title,
        storageKeys: snapshot.value?.storage,
        selectCount: snapshot.value?.selects?.length ?? 0,
        controlCount: snapshot.value?.controls?.length ?? 0,
      })),
    },
    endpoints,
    uiMappings: extractUiMappings(raw.domSnapshots),
  };
}

function buildDataDictionary(catalog) {
  const rows = [];
  for (const endpoint of catalog.endpoints) {
    for (const field of endpoint.responseFields ?? []) {
      rows.push({
        endpoint: `${endpoint.method} ${endpoint.pathPattern}`,
        field: field.name,
        type: field.types.join(" | "),
        examples: field.examples,
        confidence: "confirmed",
      });
    }
  }
  return { generatedAt: catalog.generatedAt, rows, uiMappings: catalog.uiMappings };
}

function renderInventory(catalog) {
  const lines = [];
  lines.push("# API Inventory");
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push(`- Start URL: ${catalog.startUrl ?? ""}`);
  lines.push(`- Target: ${catalog.target?.title ?? ""} (${catalog.target?.url ?? ""})`);
  lines.push(`- Generated at: ${catalog.generatedAt}`);
  lines.push(`- Endpoints observed: ${catalog.endpoints.length}`);
  lines.push("");
  lines.push("## Page Map");
  lines.push("");
  lines.push("| URL | Evidence |");
  lines.push("|---|---|");
  for (const url of catalog.coverage.pagesObserved) {
    lines.push(`| ${escapeMd(url)} | confirmed |`);
  }
  lines.push("");
  lines.push("## Endpoint Inventory");
  lines.push("");

  for (const endpoint of catalog.endpoints) {
    lines.push(`### ${endpoint.method} ${endpoint.pathPattern}`);
    lines.push("");
    lines.push(`Evidence: ${endpoint.confidence}`);
    lines.push("");
    lines.push(`- Origin: ${endpoint.origin}`);
    lines.push(`- Status: ${endpoint.statusCodes.join(", ") || ""}`);
    lines.push(`- Content type: ${endpoint.contentTypes.join(", ") || ""}`);
    lines.push(`- Called from: ${(endpoint.calledFrom ?? []).slice(0, 3).map(escapeMd).join(", ")}`);
    lines.push("");
    lines.push("Parameters:");
    lines.push("");
    lines.push("| Name | Location | Type | Examples | Evidence |");
    lines.push("|---|---|---|---|---|");
    for (const param of endpoint.queryParameters) {
      lines.push(`| ${escapeMd(param.name)} | query | ${escapeMd(param.types.join(" | "))} | ${escapeMd(param.examples.join(", "))} | confirmed |`);
    }
    for (const param of endpoint.bodyFields) {
      lines.push(`| ${escapeMd(param.name)} | body | ${escapeMd(param.types.join(" | "))} | ${escapeMd(param.examples.join(", "))} | confirmed |`);
    }
    if (endpoint.queryParameters.length === 0 && endpoint.bodyFields.length === 0) {
      lines.push("|  |  |  |  | needs_sample |");
    }
    lines.push("");
    lines.push("Response fields:");
    lines.push("");
    lines.push("| Field | Type | Examples | Evidence |");
    lines.push("|---|---|---|---|");
    for (const field of endpoint.responseFields.slice(0, 80)) {
      lines.push(`| ${escapeMd(field.name)} | ${escapeMd(field.types.join(" | "))} | ${escapeMd(field.examples.join(", "))} | confirmed |`);
    }
    if (endpoint.responseFields.length === 0) {
      lines.push("|  |  |  | needs_sample |");
    }
    lines.push("");
    lines.push("Code candidates:");
    lines.push("");
    lines.push("| Field | Values | Evidence |");
    lines.push("|---|---|---|");
    for (const candidate of endpoint.codeCandidates.slice(0, 40)) {
      lines.push(`| ${escapeMd(candidate.name)} | ${escapeMd(candidate.examples.join(", "))} | inferred |`);
    }
    if (endpoint.codeCandidates.length === 0) {
      lines.push("|  |  | needs_sample |");
    }
    lines.push("");
  }

  if (catalog.uiMappings.length > 0) {
    lines.push("## UI Option Mappings");
    lines.push("");
    lines.push("| Control | UI label | API/DOM value | Evidence |");
    lines.push("|---|---|---|---|");
    for (const mapping of catalog.uiMappings) {
      lines.push(`| ${escapeMd(mapping.control)} | ${escapeMd(mapping.label)} | ${escapeMd(mapping.value)} | confirmed |`);
    }
    lines.push("");
  }

  lines.push("## Coverage Notes");
  lines.push("");
  lines.push("- This inventory is based on observed browser traffic, not a complete server-side API specification.");
  lines.push("- Mark unvisited menus, missing permissions, 2FA/CAPTCHA, and stopped destructive actions as blocked in follow-up notes.");
  return `${lines.join("\n")}\n`;
}

function renderDictionary(dictionary) {
  const lines = [];
  lines.push("# Data Dictionary");
  lines.push("");
  lines.push("## Fields");
  lines.push("");
  lines.push("| Endpoint | Field path | Type | Examples | Confidence |");
  lines.push("|---|---|---|---|---|");
  for (const row of dictionary.rows) {
    lines.push(`| ${escapeMd(row.endpoint)} | ${escapeMd(row.field)} | ${escapeMd(row.type)} | ${escapeMd(row.examples.join(", "))} | ${row.confidence} |`);
  }
  if (dictionary.rows.length === 0) {
    lines.push("|  |  |  |  | needs_sample |");
  }
  lines.push("");
  lines.push("## UI Code Values");
  lines.push("");
  lines.push("| Control | Code | UI label | Confidence |");
  lines.push("|---|---|---|---|");
  for (const mapping of dictionary.uiMappings) {
    lines.push(`| ${escapeMd(mapping.control)} | ${escapeMd(mapping.value)} | ${escapeMd(mapping.label)} | confirmed |`);
  }
  if (dictionary.uiMappings.length === 0) {
    lines.push("|  |  |  | needs_sample |");
  }
  return `${lines.join("\n")}\n`;
}

function normalizePath(pathname) {
  return pathname
    .split("/")
    .map((part) => {
      if (/^[0-9]+$/.test(part)) {
        return "{id}";
      }
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(part)) {
        return "{uuid}";
      }
      if (/^[A-Za-z0-9_-]{18,}$/.test(part) && /[0-9]/.test(part)) {
        return "{token}";
      }
      return part;
    })
    .join("/");
}

function parseRequestBody(postData) {
  if (!postData) {
    return null;
  }
  const json = tryParseJson(postData);
  if (json !== null) {
    return json;
  }
  if (postData.includes("=") && postData.includes("&")) {
    return Object.fromEntries(new URLSearchParams(postData));
  }
  return sanitizeText(postData);
}

function inferSchema(value) {
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.slice(0, 5).reduce((schema, item) => mergeSchema(schema, inferSchema(item)), null),
    };
  }
  if (value && typeof value === "object") {
    const properties = {};
    for (const [key, child] of Object.entries(value)) {
      properties[key] = inferSchema(child);
    }
    return { type: "object", properties };
  }
  return { type: value === null ? "null" : typeof value };
}

function mergeSchema(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  if (left.type !== right.type) {
    return { type: unique([left.type, right.type]).join(" | ") };
  }
  if (left.type === "object") {
    const properties = { ...(left.properties ?? {}) };
    for (const [key, value] of Object.entries(right.properties ?? {})) {
      properties[key] = mergeSchema(properties[key], value);
    }
    return { type: "object", properties };
  }
  if (left.type === "array") {
    return { type: "array", items: mergeSchema(left.items, right.items) };
  }
  return left;
}

function flattenValue(value, prefix = "") {
  if (value === null || value === undefined) {
    return prefix ? [{ path: prefix, type: "null", example: "null" }] : [];
  }
  if (Array.isArray(value)) {
    const rows = prefix ? [{ path: prefix, type: "array", example: `[${value.length}]` }] : [];
    for (const item of value.slice(0, 5)) {
      rows.push(...flattenValue(item, `${prefix}[]`));
    }
    return rows;
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      flattenValue(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [{ path: prefix, type: typeof value, example: String(value).slice(0, 120) }];
}

function addParam(map, name, value, type = null) {
  const entry = map.get(name) ?? { name, types: new Set(), examples: new Set() };
  entry.types.add(type ?? inferPrimitiveType(value));
  if (value !== undefined && value !== null && entry.examples.size < 8) {
    entry.examples.add(String(value).slice(0, 120));
  }
  map.set(name, entry);
}

function addCodeCandidate(map, name, value, source) {
  if (typeof value !== "string") {
    return;
  }
  if (!/^[A-Z0-9_:-]{2,}$/.test(value) && !/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(value)) {
    return;
  }
  const entry = map.get(name) ?? { name, types: new Set(), examples: new Set(), sources: new Set() };
  entry.types.add("string");
  entry.examples.add(value.slice(0, 120));
  entry.sources.add(source);
  map.set(name, entry);
}

function paramsToArray(map) {
  return [...map.values()].map((entry) => ({
    name: entry.name,
    types: [...entry.types].sort(),
    examples: [...entry.examples].slice(0, 8),
    sources: entry.sources ? [...entry.sources].sort() : undefined,
  }));
}

function extractUiMappings(domSnapshots) {
  const mappings = [];
  for (const snapshot of domSnapshots) {
    for (const select of snapshot.value?.selects ?? []) {
      for (const option of select.options ?? []) {
        if (!option.value || !option.label || option.value === option.label) {
          continue;
        }
        mappings.push({
          control: select.name || select.text || "select",
          value: String(option.value),
          label: String(option.label),
        });
      }
    }
  }
  return uniqueBy(mappings, (item) => `${item.control}\0${item.value}\0${item.label}`);
}

function summarizeInitiator(initiator) {
  if (!initiator) {
    return null;
  }
  return {
    type: initiator.type,
    url: initiator.url,
    lineNumber: initiator.lineNumber,
    columnNumber: initiator.columnNumber,
  };
}

function sanitizeObject(value, key = "") {
  if (SECRET_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObject(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeObject(childValue, childKey),
      ]),
    );
  }
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  return value;
}

function sanitizeBody(value) {
  if (!value) {
    return value;
  }
  const parsed = tryParseJson(value);
  if (parsed !== null) {
    return JSON.stringify(sanitizeObject(parsed));
  }
  return sanitizeText(value);
}

function sanitizeText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|access_token|refresh_token|api_key|session)=)[^&]+/gi, "$1[REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]");
}

function tryParseJson(value) {
  if (typeof value !== "string") {
    return value ?? null;
  }
  try {
    return sanitizeObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function inferPrimitiveType(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (value === "true" || value === "false") {
    return "boolean";
  }
  if (/^-?\d+(\.\d+)?$/.test(String(value))) {
    return "number";
  }
  return typeof value;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return await response.json();
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueBy(values, getKey) {
  const seen = new Set();
  return values.filter((value) => {
    const key = getKey(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function defaultOutDir(date) {
  return `api-site-map-${date.toISOString().replace(/[:.]/g, "-")}`;
}

function escapeMd(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
