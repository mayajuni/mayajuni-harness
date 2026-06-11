# API Site Mapper Output Format

Use these files as the default deliverables. Keep secrets redacted.

## api-inventory.md

```md
# API Inventory

## Scope

- Start URL:
- Account/role:
- Capture window:
- Evidence source:
- Coverage:

## Page Map

| Page/Menu | Route | Navigation path | Main APIs | Status | Notes |
|---|---|---|---|---|---|

## Endpoint Inventory

### GET /api/orders

Evidence: confirmed

Called from:

| Page | UI action | Example URL |
|---|---|---|

Parameters:

| Name | Location | Type | Example | Required | Meaning | Evidence |
|---|---|---|---|---|---|---|

Response:

| Field | Type | Example | Meaning | Evidence |
|---|---|---|---|---|

Code mappings:

| UI label | API field | API value | Evidence |
|---|---|---|---|

Notes:

- Pagination:
- Sorting:
- Auth/tenant headers:
- Risks:
```

## data-dictionary.md

```md
# Data Dictionary

## Entities

| Entity | Source endpoints | Description | Confidence |
|---|---|---|---|

## Fields

| Entity/Endpoint | Field path | Type | Example | Meaning | Confidence |
|---|---|---|---|---|---|

## Code Values

| Field | Code | UI label | Source | Confidence |
|---|---|---|---|---|
```

## api-catalog.json

Keep it machine-readable:

```json
{
  "generatedAt": "ISO timestamp",
  "startUrl": "https://example.com/app",
  "coverage": {
    "pagesVisited": [],
    "blockedAreas": []
  },
  "endpoints": [
    {
      "method": "GET",
      "pathPattern": "/api/orders",
      "observedUrls": [],
      "queryParameters": [],
      "bodyFields": [],
      "responseSchema": {},
      "calledFrom": [],
      "codeCandidates": [],
      "confidence": "confirmed"
    }
  ]
}
```

## Evidence Rules

- Use `confirmed` only when the value was observed directly.
- Use `inferred` for route IDs, optionality, or meanings derived from naming and samples.
- Use `needs_sample` when one sample is not enough to know all enum values or optional fields.
- Use `blocked` when login, permissions, CAPTCHA, destructive actions, or missing data stopped verification.
