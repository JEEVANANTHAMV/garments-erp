# C-ONE UI v1.1 implementation notes

The complete 16-section developer specification and its embedded 1536 × 1024 reference were reviewed alongside both Tamil audio transcripts. This change implements the presentation request in the existing React 19/Tailwind application. The repository uses Express APIs; the specification's MUI/Laravel/SQL Server stack description does not match this checkout. No framework migration, server/schema changes or print-template redesign is included.

## Shared presentation

- Central palette, semantic colors, chart colors, type scale and font stack live in `web/src/theme/designTokens.js`.
- Font (client Audio 2): Inter is self-hosted via `@fontsource-variable/inter` (SIL OFL) so every PC renders the same clear face; 72 / Segoe UI / Arial remain fallbacks only. The Google Fonts link was removed.
- Font consistency (client Audio 1): screens no longer use `font-mono` (codes and numbers use the theme font with `tabular-nums`; only `<pre>` / `<code>` / raw JSON stay monospace). Hard-coded px sizes map to rem tokens `micro 10 · caption 11 · small 12 · body 13 · body-lg 14 · title 15 · title-lg 16 · page 24`, so the A− / A / A+ control scales every screen. `font-black` / `font-extrabold` became `font-bold`. Dedicated print layouts (JobWorkInvoicePrint, BomPrint, PackingListPrint, InvoiceDocument) are untouched until print formats are finalised. `web/src/theme/typography.test.mjs` guards all three rules.
- Light 224 px navigation, 62 px header, blue selected menu, consistent scalable menu type, wrapping menu/group labels, retained section order, favourites, recents, permissions and menu visibility rules.
- Header screen search uses the same permitted navigation items. Desktop navigation can be hidden; smaller screens retain the navigation drawer. Existing notification, user, company and text-size controls remain available.
- Shared cards, buttons, fields, table cells and status badges use the new tokens. Small pending/warning/progress labels have darker accessible variants of the specified accent colors; backgrounds retain the approved colors.
- Inputs typed as text but used for quantities (`inputMode` numeric/decimal or right-aligned) get the same minimum width as number fields. DataTable text columns have a 6.5rem minimum so dates and names do not break word-per-line; dashboard name cells wrap so quantity columns stay visible.
- Numeric entry fields reserve room for digits, decimals, padding and native number controls. Editable table cells expand rather than squeeze values. Numeric display cells do not ellipsize; dashboard tables and unusually long KPI values can scroll horizontally. These sizing rules are screen-only.

## Live dashboard mapping

The dashboard uses six compact KPI positions, a three-panel chart row, two operational panels, then three stock/purchase/gate panels. Widgets requiring module permissions are omitted for users without access. Existing additional insights remain under “More operational insights”. No example names, counts, trend percentages or decorative activity values are used as live data.

| Widget | Existing API and interpretation |
| --- | --- |
| Sales orders / production jobs / order status | `/dashboard/summary`; status means approval state, not inferred delivery risk. |
| Purchase orders | `/purchase-orders`; count is all records, recent table displays value/currency because list responses do not contain item quantities. |
| Today output | `/daily-outputs` filtered to the India business date; good pieces recorded across stages, not unique finished garments. |
| Production / style charts | All pages of `/daily-outputs` for this month to date or the previous calendar month. Actual stage/style names and good output; both period selectors control the same date window. No output is inferred from an empty source. |
| Dispatches | `/dispatches` pagination total, all time. |
| Fabric stock | `/inventory/stock?material_type=FABRIC`; combine bins by fabric and unit; preserve separate unit totals. Received/issued are lifetime movements. Opening stock for a period is not supplied and is not invented. |
| Recent production jobs | `/production-orders`; shows linked sales order in place of buyer, which is absent from this response. |
| Pending TNA | `/dashboard/tna-alerts`; upcoming/overdue tasks and their linked sales order. |
| Today's gate counts | Date-filtered `/gate-inwards` and `/gate-outwards` totals. Visitor/contractor metrics are omitted because these sources do not supply them. |

Queries use existing auth/company context and independently expose loading, empty and retry states. Output aggregation reads every page at the API's supported 200-row page size and honours query cancellation. Header search is explicitly screen search; no record-search endpoint, messaging service or nonfunctional app-launcher control was invented.

## Validation

- `npm --prefix web run build`
- `node --test web/src/pages/dashboard/model.test.mjs web/src/theme/designTokens.test.mjs`
- `git diff --check`

Aggregation tests cover India date rollover, month/year/leap boundaries, stage/style totals, empty data, and separate inventory units. Contrast checks cover navigation, primary controls and small status labels.

BrowserOS tools were unavailable in this session. A signed-in visual comparison at 1536 × 1024, tablet/mobile widths, and representative entry grids remains pending; live API/CRUD and keyboard interaction tests were not run. Existing Vite configuration and large-bundle warnings also occur on the baseline build.
