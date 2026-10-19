# Dodo Routes: Release Notes

**Version 1.0 · 19 October 2026**

## What it is

Dodo Routes turns the day's assigned-orders CSV into a **clear sheet for each driver**, showing what to pick up and what to deliver. It also works out **what each driver is owed** using the Dodo pricing card. When you're done, one click saves everything to the **Dodo Routes** Google Sheet as a new tab for that date.

It runs in any web browser (laptop, tablet or phone) and keeps working without an internet connection.

**The daily flow:** upload the CSV → check each driver's card → (optional) add extras or remarks → **Upload to Google Sheets**.

---

## What it does

### 1. Reads your CSV
- Drag the file onto the page, or click to choose it.
- Columns are recognised automatically. If a heading is named differently, fix it under **Column matching**.
- The delivery date is taken from the file and used to name the Sheets tab (e.g. `19-Oct-2026`).
- If the file is a full Evermile export, non-Dodo and cancelled orders are skipped automatically, and the tool says how many.

### 2. Gives every driver their own card
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

### 3. Calculates driver pay using the Dodo card

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

### 4. Handles gaps
- **No driver on an order?** It appears under **Unassigned**. Type a name to assign it.
- **No distance on an order?** The tool estimates it from the postcodes and flags it for checking. You can also type the miles in yourself.
- Warnings at the top tell you exactly what needs attention before paying.

### 5. Uploads to Google Sheets in one click
**Upload to Google Sheets** creates a new tab in *Dodo Routes* named after the delivery date, containing:
1. **Driver payment summary**: one line per driver (orders, parcels, miles, fees, extras, final payable) and a total.
2. **Each driver's Pickup details and Delivery details** tables.
3. **Payment calculation**: every order with its miles, band, fee, extra, remark and the working.

- **Tab already exists?** You're asked whether to **Update existing tab** or **Create a new version** (e.g. `19-Oct-2026 (v2)`), so nothing is overwritten by accident.
- **Done?** A confirmation appears with a direct **Open tab ↗** link.
- **Offline?** The upload is queued and sends itself automatically when the connection returns. The header shows "1 waiting to upload" until then.

### 6. Also included
- **Print**: one page per driver, or just the driver you're viewing. Hand it over or save it as a PDF.
- **Download CSV**: a full export of orders, drivers and pay.
- **Remembers your work**: closing the page or losing signal doesn't lose edits.
- **Works on phones**: tables turn into easy-to-read cards.
- **Private**: the CSV stays on your device. Data only leaves when you press Upload, and it goes only to your Google Sheet.

---

## CSV format

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

## Getting started (one-time setup)

**A. Open the tool.** It's hosted on Netlify. Bookmark the link, or use **Install** in Chrome/Edge to add it like an app.

**B. Connect the Google Sheet** (sheet owner, about 5 minutes):
1. Open **Dodo Routes** → **Extensions → Apps Script**. Paste in `apps-script/Code.gs` and **Save**.
2. **Deploy → New deployment → Web app**. Set *Execute as*: **Me** and *Who has access*: **Anyone**, then **Deploy → Allow**.
3. Choose **`setup`** in the function list and click **Run**.
4. Open **View → Execution log** and click the **one-click connect link**. The tool is now connected.
5. Share that link with anyone who should be able to upload. Only people with the link can write to the sheet.

---

## Known limitations
- **Same rate for every vehicle.** Vehicle type is shown but not used in pricing yet. Send the bike/van rates if they differ.
- **Estimated distances** (when the CSV has none) come from map routing and can differ slightly from Evermile's figures. Always include **Distance (Miles)** for exact pay.
- **Driver names must match exactly**, or "Ali K" and "Ali Khan" are paid as two different drivers.

## Support
Code and setup guide: <https://github.com/rasiqshandar-create/dodo_routes>. See the README for full details.
