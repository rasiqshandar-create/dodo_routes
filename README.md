# Dodo Driver Pay

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

1. **Upload.** Drop the CSV. Columns are detected automatically (Evermile export: `external_id`, `pickup_postcode`, `dropoff_postcode`, `carrier`, `delivery_status`…; weekly Dodo sheet: `Order ID`, `Agent_Name`, `Distance`…). The carrier filter defaults to **Dodo** and cancelled statuses are excluded. If the file contains several dates, pick one, or choose *All dates* to get one Sheets tab per date.
2. **Assign & price.** Tick deliveries (shift-click selects a range), type a driver name and click **Assign to selected**, or type the name directly in a row. Each row shows its distance, its source, and the fee calculation. Add an **Extra £** charge and a **Remark** per delivery if needed. You can overwrite any distance by hand.
3. **Routes & pay.** A route is one driver on one day. Open a route to see every drop's calculation. Add a route-level extra or deduction (negative number) with a reason. The driver summary shows the final payable amount. You can also download CSVs.
4. **Upload to Google Sheets.** This creates a tab named after the delivery date, e.g. `19-Oct-2026`, with three sections: Driver payment summary, Route totals, and Deliveries (with a per-row calculation column).
   - If the tab already exists, you're asked to **Update existing tab** or **Create "19-Oct-2026 (v2)"**.
   - On success you get a toast with a direct **Open tab ↗** link, and the upload is added to *Upload history*.
   - If you're offline, the upload is **queued** and syncs automatically when the connection comes back.

### Distances

| Source | Badge | When |
|---|---|---|
| CSV column | `CSV` | The export has a distance column (miles, or km, which is converted). **Most accurate.** |
| Road route | `road` | No distance column: postcodes are geocoded via postcodes.io and routed with OpenStreetMap (OSRM), pickup → drop-off. |
| Straight line | `est.` | Fallback if routing is unavailable. Multiplier is set in Settings. **Check these before paying.** |
| Manual | `manual` | You typed it. |

Road distances from OpenStreetMap can differ slightly from the distances Evermile shows. For exact parity, include the distance column in the export. Postcode and distance lookups are cached on the device, so repeat postcodes work offline.

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
sample-data.js        validation sample: 133 real Dodo distances from 16-Oct-2026, anonymised
sw.js                 offline cache
manifest.webmanifest  installable app metadata
apps-script/Code.gs   Google Sheets connector
tests/pricing.test.js node tests/pricing.test.js
```
