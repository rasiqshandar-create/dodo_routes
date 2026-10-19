# Dodo Routes

A standalone web app that calculates Dodo driver payments from a delivery export, then uploads the results to Google Sheets in one click. It runs fully in the browser with no server and no dependencies, and works offline.

**Flow:** upload CSV → assign drivers → fees calculate automatically → review route totals → **Upload to Google Sheets**.

## Pricing formula (Dodo)

Taken from *Dodo pricing for claude.xlsx*:

```
Fee per drop = max( £10.00 , £8.00 + £0.40 × distance rounded UP to the next 0.5 mi )
Route total  = Σ drop fees + Σ per-drop extra charges + route adjustment
Driver pay   = Σ route totals for that driver
```

| Distance | Band charged | Calculation | Fee |
|---|---|---|---|
| 3.10 mi | 3.5 mi | £8 + 3.5 × £0.40 = £9.40 → below minimum | **£10.00** |
| 5.00 mi | 5.0 mi | £8 + 5.0 × £0.40 | **£10.00** |
| 5.01 mi | 5.5 mi | £8 + 5.5 × £0.40 | **£10.20** |
| 8.20 mi | 8.5 mi | £8 + 8.5 × £0.40 | **£11.40** |

Validation:
- `tests/pricing.test.js` checks every band in the pricing sheet (0–30 mi) plus live examples.
- Against the 385 live orders from 15 Oct onwards (`Dodo_Driver_Cost_Gap_Review`), 55 of the 60 system-calculated (non-round) Evermile costs match to the penny. Three are 1p lower upstream (e.g. £10.19 vs £10.20) and two use a different rate. The round-pound amounts are the manual/old-rate payments already flagged in the Gap Review.

Base, per-mile, minimum and band size can be edited in **Settings → Pricing** (locked by default). There is also an optional "extra per additional drop" fee, which is **off (£0)** because the current card has no per-drop element.

## Using it

1. **Upload** the day's assigned-orders CSV. Columns are matched automatically. Check **Column matching** if anything looks off.
2. Each **driver** gets their own card. Use the chips at the top to view one driver at a time.
   - **1 · Pickup details**: Order IDs, merchant (address and phone), total parcels to collect, pickup slot. Grouped by merchant and slot.
   - **2 · Delivery details**: stop #, Order ID, customer, address, tap-to-call phone, delivery slot, parcels, instructions. In stop-sequence order (or by slot).
   - **£ Pay calculation** (collapsed): per-order miles → band → fee, an optional **Extra £** and **Remark** per order, and a route-level extra or deduction with a reason.
3. Orders without a driver appear under **Unassigned**. Type a name to assign them.
4. **Print** gives one page per driver (or just the selected driver). **Download CSV** exports everything.
5. **Upload to Google Sheets** creates a tab for the date (e.g. `19-Oct-2026`) containing the driver payment summary, then each driver's Pickup and Delivery tables, then the per-order pay calculation. If the tab exists you choose **Update** or **New version**. When offline, uploads queue and sync automatically.

## CSV format

Download the template from the app (**Download CSV template**) or use [`templates/dodo-routes-template.csv`](templates/dodo-routes-template.csv). One row per order:

| Column | Required | Notes |
|---|---|---|
| Delivery Date | **Yes** | `19/10/2026` or `2026-10-19`. Names the Sheets tab and the pay day. |
| Order ID | **Yes** | Unique per order. |
| Merchant Name | Yes | Pickup grouping. |
| Merchant Phone | Optional | Shown on the pickup list so the driver can call the store. |
| Pickup Address | Yes | Include the postcode. |
| Pickup Slot | Yes | e.g. `08:00-09:00`. |
| Customer Name | Yes | |
| Customer Phone | Yes | Keep as text so the leading 0 isn't lost (or use `+44…`). |
| Customer Address | Yes | Include the postcode. |
| Delivery Slot | Yes | e.g. `10:00-12:00`. |
| Delivery Instructions | Optional | |
| Parcel Count | Yes | Defaults to 1 if blank. |
| Driver Name | Yes | Spell names the same way every day so pay totals group correctly. |
| Vehicle Type | Optional | Shown on the card. Pricing is currently the same for all vehicles. |
| Distance (Miles) | **Yes for pay** | Pickup → drop-off miles per order. This drives the fee. If blank, it's estimated from the postcodes (flagged for checking). |
| Stop Sequence | Optional | 1, 2, 3… delivery order on the route. Otherwise sorted by slot. |
| Extra Charge (£) | Optional | Pre-fills the per-order extra (waiting time, parking…). |
| Remarks | Optional | Reason for the extra charge. |

## One-time setup (about 5 minutes, two parts)

### A. Put the tool online (GitHub Pages)
1. In this repo, open **Settings → Pages**.
2. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **`main`**, folder to **`/ (root)`**, then **Save**.
3. After about a minute the tool is live at **https://rasiqshandar-create.github.io/dodo_routes/**.

> Pages on a **private** repo needs GitHub Pro or Team. On the free plan, either make the repo public (it contains no secrets or customer data) or drag the folder onto <https://app.netlify.com/drop>. If you host elsewhere, change `APP_URL` at the top of `apps-script/Code.gs`.

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

- Uploaded CSVs are processed in the browser and never sent to a server.
- The only outbound calls are postcodes to postcodes.io / OSRM (for distance lookup), and results to **your** Apps Script when you click Upload.
- Session data, driver roster, queue and history live in the browser's local storage on that device.

## Files

```
index.html            UI
app.js                app logic (CSV, mapping, distances, assignment, queue, Sheets upload)
pricing.js            pricing engine (shared with tests)
sample-data.js        fictional sample orders + CSV template
templates/            CSV template
sw.js                 offline cache
manifest.webmanifest  installable app metadata
apps-script/Code.gs   Google Sheets connector
tests/pricing.test.js node tests/pricing.test.js
```
