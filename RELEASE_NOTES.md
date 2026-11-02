# Dodo Routes: Release Notes

## Version 2.0 · 2 November 2026: One document per driver

**Drivers now get a single route sheet that replaces both the Tookan Route PDF and the old Dodo Routes PDF.**

### What's new

**Two uploads instead of one**
- **1 · Tookan route export**: the route and the stop **sequence**.
- **2 · Retool order export**: parcels, delivery instructions and **driver cost (DP cost)**.
- Drop each file in its box. The app recognises which export is which, so a file in the wrong box is moved automatically. You can also drop both at once.

**Route sheet in the exact Tookan order**
- Same header as the Tookan PDF: *Dodo Delivery*, date, Driver ID, Driver Name, Route ID badge, Estimated Time and Estimated Distance.
- Stops are numbered 1…N in Tookan's order, with pickups and deliveries interleaved exactly as planned. Nothing is re-sorted or grouped.
- Columns: **Seq · Service Type · Order ID · Customer/Merchant · Address · Phone · Time · Parcels · Instructions · Pay · Signature**.
- Parcels and Instructions are filled in from Retool. The Signature column stays blank for sign-off.

**Driver pay from Retool, not the card**
- Each order is paid its **Retool DP cost**, counted once per order even though it has a pickup and a delivery row.
- The driver total sits next to the header, and each order's pay is on its delivery row.
- The **Dodo card** (£8 + £0.40/mi, rounded up to 0.5 mi, £10 minimum) is now only a **fallback** when Retool has no DP cost.
- When Retool and the card differ by more than 1p, a small **"card £x"** badge appears on that order (screen only). The *Pay & reconciliation* table shows Retool vs card vs difference for every order.
- Per-order extras, remarks and route extras/deductions still work and are added on top.

**One PDF for all drivers**
- **Print / Save PDF** produces one document with one route per page: A4 landscape, with the table header repeated if a route runs over two pages.
- **Print** on a single route prints just that driver.

**Checks for Ops panel** (screen and Google Sheets) lists:
- Tookan orders with **no Retool match**. These are **left off the route sheet**, so check this list before sending.
- Orders where the Retool driver differs from the Tookan agent, or the Retool row is cancelled.
- Orders with no DP cost (card used), or with no cost and no miles.
- Orders with only a pickup or only a delivery task.
- Every order where Retool ≠ card.

**Google Sheets tab** (e.g. `02-Nov-2026`):
1. Route & driver pay summary.
2. Each route's sequence, exactly as printed.
3. Per-order pay reconciliation.
4. Checks for Ops.

### How the join works
- **Join key:** Tookan **Order ID** = Retool **Order ref**. Retool's "Order ID" is a UUID and is ignored.
- **Duplicate refs in Retool:** the row whose **Driver name** matches the Tookan **Agent Name** is chosen (ignoring case and extra spaces). Ties go to **DP = Dodo / Evermile Own Fleet**, then to a non-cancelled row.
- **Unrelated rows:** everything in Retool that isn't on an uploaded Tookan route is ignored.

### Checked against 02 Nov 2026
Using the real exports (4 routes, 72 stops, 36 orders):
- **Route 48043 · Fahad Rehman**: 18 stops in Tookan order, starting *1 · PICKUP · #30533 · KIPFERL*.
- **Fahad's parcels** all come from Retool.
- **Fahad's pay = £99.34** (sum of Retool DP cost). The card would give £104.20 for his 70.34 mi. Three orders are flagged where Retool and card differ (#FT84215, #FT84250, #FT84238).
- **Duplicate ref 000101779** on Salman Dosri's route resolves to his delivered row (£14.99), not the cancelled one.
- **Every Tookan order** matched a Retool row.

### Retained from 1.0
Google Sheets upload (update / new version prompt, direct link), offline queue with auto-sync, column auto-matching, CSV download, tap-to-call phones, postcodes kept in addresses, edits saved on the device, mobile layout.

### Removed
- **Single-CSV mode** (one file with a Driver Name column) and its CSV template. The two exports replace it.
- **Postcode distance look-ups.** Miles now come from Retool "Distance miles".
- **The "per extra drop" pricing option.**

### What to redeploy
1. **Netlify:** upload the new site zip to *dodo-delivery-routes* → **Deploys** (drag and drop). Files: `index.html`, `app.js`, `merge.js` *(new)*, `pricing.js`, `sample-data.js`, `sw.js`, `manifest.webmanifest`, `icon.svg`. Open the site once online so the offline copy updates.
2. **Apps Script** (Dodo Routes sheet → Extensions → Apps Script): replace `Code.gs`. It now writes the new sections and its connect link points to Netlify. Then go to **Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy**. The Web App URL and token stay the same, so nobody needs to reconnect.
3. If you haven't connected yet: run **`setup`** once and use the connect link from the execution log.

---

## Version 1.0 · 19 October 2026 (superseded by 2.0)

### What it is

Dodo Routes turns the day's assigned-orders CSV into a **clear sheet for each driver**, showing what to pick up and what to deliver. It also works out **what each driver is owed** using the Dodo pricing card. When you're done, one click saves everything to the **Dodo Routes** Google Sheet as a new tab for that date.

It runs in any web browser (laptop, tablet or phone) and keeps working without an internet connection.

**The daily flow:** upload the CSV → check each driver's card → (optional) add extras or remarks → **Upload to Google Sheets**.

---

### What it does

#### 1. Reads your CSV
- Drag the file onto the page, or click to choose it.
- Columns are recognised automatically. If a heading is named differently, fix it under **Column matching**.
- The delivery date is taken from the file and used to name the Sheets tab (e.g. `19-Oct-2026`).
- If the file is a full Evermile export, non-Dodo and cancelled orders are skipped automatically, and the tool says how many.

#### 2. Gives every driver their own card
Use the buttons at the top to see **All drivers** or one driver at a time. Each card shows the driver's vehicle, number of orders, parcels, miles and **pay**, followed by:

**① Pickup details**: what to collect, where and when.

| Order ID(s) | Merchant (with address and phone) | Parcels to collect | Pickup slot |
|---|---|---|---|

Orders from the same merchant and slot are grouped together, so the driver sees one line per stop with a total parcel count.

**② Delivery details**: where to go, in order.

| # | Order ID | Customer | Address | Phone (tap to call) | Delivery slot | Parcels | Instructions |
|---|---|---|---|---|---|---|---|

Deliveries are listed in **Stop Sequence** order. If there's no sequence, they're sorted by delivery slot.

**£ Pay calculation** is collapsed under each card. It shows how every fee was worked out and is where you add extras.

#### 3. Calculates driver pay using the Dodo card

> **Fee per delivery = £8.00 + £0.40 × miles, with miles rounded _up_ to the next 0.5 mile. The minimum fee is £10.00.**

| Distance | Charged as | Working | Fee |
|---|---|---|---|
| 3.1 mi | 3.5 mi | £8 + 3.5 × £0.40 = £9.40 → below minimum | **£10.00** |
| 5.0 mi | 5.0 mi | £8 + 5.0 × £0.40 | **£10.00** |
| 8.2 mi | 8.5 mi | £8 + 8.5 × £0.40 | **£11.40** |
| 12.65 mi | 13.0 mi | £8 + 13.0 × £0.40 | **£13.20** |

- **Driver pay** = all delivery fees + per-order extras + any route extra or deduction.
- **Extra charge per order** (waiting time, parking…) with a **remark**. This can come straight from the CSV or be typed in.
- **Route extra / deduction** per driver per day, with a reason. Use a minus number for deductions.
- The formula was checked against every band in the pricing sheet (0–30 miles) and against live Evermile costs.

#### 4. Handles gaps
- **No driver on an order?** It appears under **Unassigned**. Type a name to assign it.
- **No distance on an order?** The tool estimates it from the postcodes and flags it for checking. You can also type the miles in yourself.
- Warnings at the top tell you exactly what needs attention before paying.

#### 5. Uploads to Google Sheets in one click
**Upload to Google Sheets** creates a new tab in *Dodo Routes* named after the delivery date, containing:
1. **Driver payment summary**: one line per driver (orders, parcels, miles, fees, extras, final payable) and a total.
2. **Each driver's Pickup details and Delivery details** tables.
3. **Payment calculation**: every order with its miles, band, fee, extra, remark and the working.

- **Tab already exists?** You're asked whether to **Update existing tab** or **Create a new version** (e.g. `19-Oct-2026 (v2)`), so nothing is overwritten by accident.
- **Done?** A confirmation appears with a direct **Open tab ↗** link.
- **Offline?** The upload is queued and sends itself automatically when the connection returns. The header shows "1 waiting to upload" until then.

#### 6. Also included
- **Print**: one page per driver, or just the driver you're viewing. Hand it over or save it as a PDF.
- **Download CSV**: a full export of orders, drivers and pay.
- **Remembers your work**: closing the page or losing signal doesn't lose edits.
- **Works on phones**: tables turn into easy-to-read cards.
- **Private**: the CSV stays on your device. Data only leaves when you press Upload, and it goes only to your Google Sheet.

---

### CSV format

One row per order. Download the template from the app's start screen, or use [`templates/dodo-routes-template.csv`](templates/dodo-routes-template.csv).

| Column | Needed? | Tips |
|---|---|---|
| Delivery Date | **Required** | `19/10/2026`. Names the Sheets tab. |
| Order ID | **Required** | Must be unique. |
| Merchant Name | Required | |
| Merchant Phone | Optional | Lets the driver call the store. |
| Pickup Address | Required | Include the postcode. |
| Pickup Slot | Required | e.g. `08:00-09:00` |
| Customer Name | Required | |
| Customer Phone | Required | Keep as text so the leading 0 stays. |
| Customer Address | Required | Include the postcode. |
| Delivery Slot | Required | e.g. `10:00-12:00` |
| Delivery Instructions | Optional | |
| Parcel Count | Required | Blank counts as 1. |
| Driver Name | Required | Spell it the same every day. |
| Vehicle Type | Optional | Shown on the card. |
| Distance (Miles) | **Required for pay** | Pickup → drop-off, per order. |
| Stop Sequence | Optional | 1, 2, 3… delivery order. |
| Extra Charge (£) | Optional | Pre-fills the extra. |
| Remarks | Optional | Reason for the extra. |

---

### Getting started (one-time setup)

**A. Open the tool.** It's hosted on Netlify. Bookmark the link, or use **Install** in Chrome/Edge to add it like an app.

**B. Connect the Google Sheet** (sheet owner, about 5 minutes):
1. Open **Dodo Routes** → **Extensions → Apps Script**. Paste in `apps-script/Code.gs` and **Save**.
2. **Deploy → New deployment → Web app**. Set *Execute as*: **Me** and *Who has access*: **Anyone**, then **Deploy → Allow**.
3. Choose **`setup`** in the function list and click **Run**.
4. Open **View → Execution log** and click the **one-click connect link**. The tool is now connected.
5. Share that link with anyone who should be able to upload. Only people with the link can write to the sheet.

---

### Known limitations
- **Same rate for every vehicle.** Vehicle type is shown but not used in pricing yet. Send the bike/van rates if they differ.
- **Estimated distances** (when the CSV has none) come from map routing and can differ slightly from Evermile's figures. Always include **Distance (Miles)** for exact pay.
- **Driver names must match exactly**, or "Ali K" and "Ali Khan" are paid as two different drivers.

### Support
Code and setup guide: <https://github.com/rasiqshandar-create/dodo_routes>. See the README for full details.
