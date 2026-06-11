# Exploration Playbook

## Order of Operations

1. Start network capture before page load.
2. Record title, URL, role/account if visible, and storage key names.
3. Collect sidebar/menu/tab labels with compact snapshots or targeted DOM reads.
4. Visit every safe page reachable from the main navigation.
5. On list pages, exercise search, filters, sort, page size, pagination, and one safe detail row.
6. On detail pages, open safe tabs and modals; stop before save/delete/payment/password actions.
7. Repeat capture for flows that require a fresh page load.

## Parameter Discovery

Trigger these surfaces deliberately:

- Search input -> `keyword`, `q`, `search`, or body filter field.
- Date picker -> `from`, `to`, `startDate`, `endDate`, or range object.
- Dropdown -> code value in query/body; capture text/value pair.
- Checkbox/toggle -> boolean or array values.
- Table sort -> `sort`, `orderBy`, `direction`, `desc`.
- Pagination -> `page`, `size`, `limit`, `offset`, `cursor`.
- Detail row -> path IDs such as `/users/{id}` or query IDs.

## UI Label to API Code Mapping

Evidence strength from strongest to weakest:

1. DOM option text/value pair: `<option value="APPROVED">승인완료</option>`.
2. Selecting a visible label produces a request parameter/body value.
3. Same row/detail screen shows a visible label while the response row has a code value.
4. Common-code/lookup API returns code and label together.
5. Frontend bundle contains a static mapping.

Mark weak matches as `inferred` or `needs_sample`.

## Common Patterns

- REST list endpoints often share a pagination envelope: `items`, `content`, `rows`, `total`, `page`.
- GraphQL requests need `operationName`, query name, and variables summarized separately.
- Multi-tenant apps often use headers or storage keys for company, branch, division, tenant, locale, or role.
- BFF endpoints may hide upstream API names; document the BFF endpoint as observed.
- File downloads may return blob/binary responses; record content type, filename headers, and triggering UI action.

## Stop Conditions

Do not execute final actions for:

- payment or purchase completion
- account deletion or withdrawal
- password/email/security setting changes
- irreversible deletes
- production data mutation unless the user explicitly confirms that exact action

When blocked, record the button/page, the payload if safely visible, and the reason collection stopped.
