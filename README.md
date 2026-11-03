# Dodo Routes

A web app for Dodo Delivery × Evermile. It turns the day's **Tookan route export** and **Retool order export** into **one branded route sheet per driver**. Each sheet follows the exact Tookan stop sequence, with parcels, instructions and driver pay from Retool. Print them all as **one PDF** (one route per page), send the day to Google Sheets in one click, and **work on it live with 2–3 teammates**. It runs in the browser and works offline.

**Three steps:** ① upload the two exports → ② check the drivers and pay (the *Checks* box tells you if anything needs attention) → ③ **Print driver sheets** and **Send to Google Sheets**.

## Working together (live)

When the tool is connected to the Dodo Routes sheet (via the one-click connect link), everyone using that link shares **one live workspace**:

- **Files:** one person uploads the files and everyone sees them.
- **Edits:** extras, remarks, route deductions and column matching appear on everyone's screen within about 4 seconds, with a note of who changed what (e.g. *"Ravish set extra £3.00 on #30533"*). Driver tiles show *"Edited by …"*.
- **Presence:** the header shows who is in (avatars, *"Live · 3 here"*).
- **Simultaneous edits:** these merge field by field, so two people changing different orders never overwrite each other. If two people change the *same* box, the later change wins for everyone.
- **Typing is never interrupted:** a teammate's update keeps your cursor and half-typed text.
- **Offline:** changes made offline are saved on your device and sync when you're back online.
- **Start a new day (clear)** in the ⋯ menu clears the workspace for everyone.

How it works: the workspace is stored in a hidden `_live` tab of the Dodo Routes spreadsheet, through the same Apps Script that does the Sheets upload. Each open tab checks for changes every 4 seconds (every 20 seconds when the tab is in the background). Those checks answer from a cache, so they're light on the Apps Script quota.

Without a connection, the tool works exactly the same for one person ("Just you" in the header).

## Branding

The header and every printed route sheet carry the **Dodo** logo and **"Delivered with Evermile"**, with a navy rule. The page footer shows the route totals and "Dodo Delivery × Evermile". Logos are in `brand/`.

## Inputs

| Upload | What it provides | Key columns |
|---|---|---|
| **1 · Tookan route export** | Routes and stop **sequence**, one row per task (Pick-up / Delivery) | Route ID, Date, Task ID, Service Type, Agent ID, Agent Name, Order ID, Customer Name, Address, Phone Number, Time, Estimated Time (MINs), Estimated Distance (KMS) |
| **2 · Retool order export** | Parcels, instructions, **driver cost**, one row per order | Order ref, Merchant name, DP, Order/Delivery status, **DP cost**, Parcel count, Distance miles, Delivery instructions, Driver name… |

Either file can go in either box: the app recognises which export it is from the headers. Columns are auto-matched; check **Column matching** if a header was renamed.

## How the two files are joined

- **Join key:** Tookan `Order ID` = Retool `Order ref`. Retool's `Order ID` is a UUID and is never used.
- **Duplicate refs in Retool:** the row whose `Driver name` matches the Tookan `Agent Name` wins (trimmed, case-insensitive). Ties go to `DP` = Dodo / Evermile Own Fleet, then to a non-cancelled row.
- **Only orders on the Tookan routes are used.** Every other Retool row (other DPs, other days) is ignored.
- **Tookan orders with no Retool match are skipped** from the route sheet and listed in **Checks for Ops**.
- **Orders with only a Delivery task, or only a Pickup task,** are kept and flagged.

## Sequence (Tookan is the source of truth)

Stops keep the Tookan row order within each Route ID and are numbered 1…N. Nothing is re-sorted or grouped, so the interleaved pickup/delivery order is preserved.

## Driver pay (Retool is the source of truth)

```
Order pay   = Retool DP cost (+ optional extra £)
Driver pay  = Σ order pay over the route, each order counted once (not per pickup + delivery row)
            + optional route extra / deduction
```

- **Fallback:** the Dodo card is used only when an order has no Retool DP cost:
  `max(£10, £8 + £0.40 × Retool "Distance miles" rounded up to the next 0.5 mi)`.
- **Reconciliation:** every order shows a small **card £x** warning when the Retool DP cost and the card differ by more than £0.01. The *Pay & reconciliation* section lists Retool vs card vs difference per order.
- **Placement:** order pay is printed on the order's **DELIVERY** row (or on its pickup row if it has no delivery).

Card validation: `tests/pricing.test.js` checks every band in the pricing sheet (0–30 mi).

## The route sheet (screen and PDF)

Header (all from Tookan):
- **Dodo Delivery**, Date
- `Driver ID : … Driver Name : …`
- **Route ID** badge, Estimated Time, Estimated Distance

Plus **Driver pay** (Retool) next to the header.

| Seq | Service Type | Order ID | Customer / Merchant | Address | Phone | Time | Parcels | Instructions | Pay | Signature |
|---|---|---|---|---|---|---|---|---|---|---|

- Parcels, Instructions and Pay come from Retool. Everything else comes from Tookan. The Signature column is left blank for sign-off.
- **Print / Save PDF** prints every route into one PDF, each route starting on a new page (A4 landscape, table header repeated on continuation pages). **Print** on a single route prints just that driver.
- Screen-only extras (left out of the PDF): the *Pay & reconciliation* table (Retool vs card, extra £ and remark per order, route extra/deduction) and the optional *Pickup & delivery summaries*.
- Phones: the leading apostrophe from Retool/Excel is stripped. UK numbers are shown as `+44 7xxx xxxxxx` / `+44 20 xxxx xxxx` and are tap-to-call. Addresses keep their postcodes.

## CSV export and Google Sheets (weekly-sheet format)

**Download CSV** and **Upload to Google Sheets** both produce exactly the columns of the *Dodo Deliveries Data* weekly sheets, with one row per order and the header in row 1:

| S. No. | Order ID | Agent_Name | Merchant | Customer Name | Delivery Before | Actual | Delivery | OTD | Price | Refund | Driver Cost | Remarks | Weekly | Weekly |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

| Column | Filled from |
|---|---|
| S. No. | 1…N, routes in Tookan order, orders in delivery sequence |
| Order ID | Tookan Order ID (= Retool Order ref). Stored as text in Sheets so leading zeros stay |
| Agent_Name | Tookan Agent Name |
| Merchant, Customer Name | Retool |
| Delivery Before | Retool *Dropoff end* (London time, `MM/DD/YYYY HH:mm`). Falls back to the end of the delivery slot |
| Actual / Delivery | Retool *Delivered at*: date `MM/DD/YYYY` / time `H:mm`. Blank if not delivered yet |
| OTD | `Yes` when delivered on or before the Delivery Before day (same rule as the weekly sheet). Otherwise `N mins late` |
| Price | Retool *Platform price* (**export/Sheets only, never on the driver PDF or route sheet**) |
| Refund, Weekly, Weekly | left blank |
| Driver Cost | order pay = Retool DP cost (card only as fallback) + any extra £ |
| Remarks | the per-order remark |

A route extra/deduction is added as its own row (`Order ID` = `ROUTE <id>`, Driver Cost = the amount, Remarks = the reason).

The upload creates one tab per delivery date (e.g. `02-Nov-2026`). If the tab exists you choose **Update** or **New version**, and offline uploads queue and sync automatically. Reconciliation details (Retool vs card, unmatched orders) stay in the app's *Checks for Ops* and *Pay & reconciliation* panels.

## One-time setup (about 5 minutes, two parts)

### A. Host the tool (Netlify)
Live at **https://dodo-delivery-routes.netlify.app/**. To update it, drag a zip of the site files (`index.html app.js merge.js pricing.js sample-data.js sw.js manifest.webmanifest icon.svg brand/`) onto the site's **Deploys** page in Netlify. If you move hosts, change `APP_URL` at the top of `apps-script/Code.gs`.

### B. Connect the Dodo Routes sheet
1. Open **Dodo Routes**: <https://docs.google.com/spreadsheets/d/1qvQiAPmlhssIxpGLTEWQhyGm78kYOgcUFHeZ_3BlwXk/edit>
2. **Extensions → Apps Script**. Delete what's there, paste in [`apps-script/Code.gs`](apps-script/Code.gs), then press **Save**.
3. **Deploy → New deployment →** ⚙ **Web app**. Set *Execute as*: **Me** and *Who has access*: **Anyone**, then **Deploy** and **Authorise access** (choose your Google account → *Advanced* → *Go to project* → *Allow*).
4. In the editor's function dropdown pick **`setup`**, then click **Run**.
5. Open **View → Execution log** and click the **ONE-CLICK CONNECT LINK**. The tool opens already connected. Bookmark it, and share it with anyone who should be able to upload.

`setup()` creates the secret upload token automatically, so only people with the link can write to the sheet. If you change `Code.gs` later, use **Deploy → Manage deployments → Edit → Version: New version** so the URL stays the same. To revoke access, delete the `UPLOAD_TOKEN` script property and run `setup` again.

You can also connect by hand: **Settings** in the tool → paste the Web app URL and token → **Test connection**.

## Offline use

Once opened over https, the app is cached for offline use. In Chrome/Edge you can **Install** it (address-bar icon) so it opens like a desktop or phone app. Opening `index.html` directly from a downloaded copy also works.

## Data and privacy

- Both CSVs are processed in the browser and never sent to a server.
- The only outbound calls go to **your** Apps Script: the Upload, and (when connected) the live workspace sync.
- With live sharing on, the day's two exports (including customer names, addresses and phones) are stored in the hidden `_live` tab of the Dodo Routes spreadsheet, so only people with access to that spreadsheet or the connect link can see them. **Start a new day (clear)** removes them.
- Session data, queue and history live in the browser's local storage on that device.
- The bundled sample (`samples/`, `sample-data.js`) is fictional. Don't commit real exports: they contain customer names, addresses and phone numbers.

## Files

```
index.html             UI (steps, upload boxes, driver tiles, route sheets, print layout)
brand/                 Dodo and Evermile logos
app.js                 app logic (upload, rendering, PDF/print, live team sync, Sheets upload)
merge.js               Tookan ⨝ Retool join, sequencing, pay (shared with tests)
pricing.js             Dodo card (fallback pricing)
sample-data.js         fictional two-file sample (embedded for "Try with sample data")
samples/               the same sample as CSV files
sw.js                  offline cache
manifest.webmanifest   installable app metadata
apps-script/Code.gs    Google Sheets connector + live shared workspace
tests/                 npm test  (pricing + merge; real-file acceptance via DODO_TOOKAN / DODO_RETOOL)
```
