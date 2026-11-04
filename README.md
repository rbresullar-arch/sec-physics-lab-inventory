# SEC Physics Lab Inventory — Web App

A phone-friendly version of the Physics Laboratory inventory catalog.

- **Inventory** is kept in a **Google Sheet**.
- **Photos** you take on your phone are saved to **Google Drive**, one subfolder per item:
  `Physics Lab Inventory Photos / 12 - Ceiling Fan / Ceiling Fan_2026-11-03_141500.jpg`
- **The website** is hosted free on **GitHub Pages**; **Google Apps Script** connects it to the Sheet and Drive.

```
Phone / PC browser ──► GitHub Pages (docs/)  ──►  Apps Script web app  ──►  Google Sheet  (Inventory, Photos tabs)
                                                                       └─►  Google Drive  (photo folders)
```

## Folder contents

| Path | What it is |
|---|---|
| `docs/` | The website (upload to GitHub; Pages serves this folder) |
| `apps-script/Code.gs` | The backend code you paste into Apps Script |
| `inventory_for_google_sheet.csv` | Your current 198 items, exported from the desktop app |

---

## Setup (about 15 minutes, once)

### 1. Create the Google Sheet and backend

1. Go to <https://sheets.new> and name the sheet **Physics Lab Inventory**.
2. **Extensions → Apps Script**. Delete what's in `Code.gs`, paste the whole contents of
   `apps-script/Code.gs`, and click **Save** (💾).
3. Go back to the Sheet and **reload the page**. A **Physics Lab** menu appears.
4. **Physics Lab → Set up / repair**. Google asks for permission (Sheets + Drive) — allow it.
   If you see "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**; it's your own script.
   When it finishes it shows your **access key** and creates the **Physics Lab Inventory Photos** folder in your Drive.

### 2. Bring in your existing inventory

1. Open the **Inventory** tab.
2. **File → Import → Upload** → choose `inventory_for_google_sheet.csv`.
3. Import location: **Replace current sheet**. **Untick** "Convert text to numbers, dates, and formulas".
4. Click **Import data**.

### 3. Deploy the backend as a web app

1. In Apps Script: **Deploy → New deployment** → gear ⚙ → **Web app**.
2. **Execute as:** *Me*. **Who has access:** *Anyone*.
3. **Deploy**, then copy the **Web app URL** (ends in `/exec`).

> "Anyone" means anyone with the URL can reach the API, but every request also needs the access key,
> so keep the key private. To change it: Apps Script → ⚙ Project Settings → Script properties → `ACCESS_KEY`.

### 4. Publish the website on GitHub Pages

1. Create a GitHub repository, e.g. **sec-physics-lab-inventory** (Public, so Pages is free).
2. **Add file → Upload files** → drag in the whole `docs` folder (and this README if you like) → **Commit**.
3. **Settings → Pages** → Source: **Deploy from a branch** → Branch **main**, folder **/docs** → **Save**.
4. After a minute your site is live at `https://<your-username>.github.io/sec-physics-lab-inventory/`.

Optional: put the web app URL in `docs/config.js` (`API_URL: 'https://script.google.com/…/exec'`)
so devices only need the access key.

### 5. Connect each phone / computer

Open the site → paste the **Web app URL** and **access key** → **Connect**. The device remembers them.
On a phone, use **Share → Add to Home Screen** to get an app icon.

---

## Using it

| Do this | What happens |
|---|---|
| Tap a card's **photo** | No photo yet: opens the camera, and the picture becomes the item's cover. Has a photo: opens its **Photos** window |
| Tap anywhere else on a card | Mini window: **Quantity → Status → Remarks** (swipe, ◀ ▶, or ← → keys) |
| **Edit** | Full form with all fields |
| **Photos** | All photos for the item: take more, choose files, set ★ cover, open in Drive, delete |
| **+ Add Item** | New item, optionally with a photo |
| On a PC | Drag an image onto a card's photo to upload it |

Photos are shrunk to 240p (320×240 JPEG, about 8–15 KB) before upload, so they send
quickly over mobile data. The site loads them through the Apps Script, so they show even if your
Google account doesn't allow "anyone with the link" sharing (common on school accounts).
Deleting a photo moves it to the Drive trash (recoverable). Deleting an item keeps its photo folder in Drive.

## Updating the backend later

After changing `Code.gs`: **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy**.
The URL stays the same.

## Notes

- The desktop app (`PhysicsLabInventory.exe`) and this web app keep **separate** data: the desktop app uses
  `physics_lab_inventory.db`, the web app uses the Google Sheet.
- Each photo also appears in the Sheet's **Photos** tab (Drive file ID, item number, file name, cover flag, date).
