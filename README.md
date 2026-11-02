# Dodo Routes

A standalone web app that turns the day's **Tookan route export** and **Retool order export** into **one route sheet per driver**. Each sheet follows the exact Tookan stop sequence and is enriched with parcels, delivery instructions and driver pay from Retool. Print them all as **one PDF** (one route per page) and upload everything to Google Sheets in one click. It runs fully in the browser (no server, no dependencies) and works offline.

**Flow:** drop the Tookan CSV + the Retool CSV → check the route sheets and the *Checks for Ops* panel → **Print / Save PDF** for drivers → **Upload to Google Sheets**.

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

## Google Sheets

**Upload to Google Sheets** creates one tab per date (e.g. `02-Nov-2026`) containing:
1. **Route & driver pay summary**: Route ID, driver, stops, orders, parcels, est. time/distance, Retool DP cost, card, difference, extras, final payable.
2. **Each route's sequence**, exactly as on the PDF.
3. **Pay reconciliation** per order.
4. **Checks for Ops**: unmatched orders and other warnings.

If the tab exists you choose **Update** or **New version**. Offline uploads queue and sync automatically.

## One-time setup (about 5 minutes, two parts)

### A. Host the tool (Netlify)
Live at **https://dodo-delivery-routes.netlify.app/**. To update it, drag a zip of the site files (`index.html app.js merge.js pricing.js sample-data.js sw.js manifest.webmanifest icon.svg`) onto the site's **Deploys** page in Netlify. If you move hosts, change `APP_URL` at the top of `apps-script/Code.gs`.

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
- The only outbound call is to **your** Apps Script when you click Upload.
- Session data, queue and history live in the browser's local storage on that device.
- The bundled sample (`samples/`, `sample-data.js`) is fictional. Don't commit real exports: they contain customer names, addresses and phone numbers.

## Files

```
index.html             UI (two upload zones, route sheets, print layout)
app.js                 app logic (upload, rendering, PDF/print, queue, Sheets upload)
merge.js               Tookan ⨝ Retool join, sequencing, pay (shared with tests)
pricing.js             Dodo card (fallback pricing)
sample-data.js         fictional two-file sample (embedded for "Try with sample data")
samples/               the same sample as CSV files
sw.js                  offline cache
manifest.webmanifest   installable app metadata
apps-script/Code.gs    Google Sheets connector
tests/                 npm test  (pricing + merge; real-file acceptance via DODO_TOOKAN / DODO_RETOOL)
```
