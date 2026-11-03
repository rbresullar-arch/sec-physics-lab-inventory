/**
 * Physics Laboratory Inventory — Google Apps Script backend
 *
 * The inventory lives in this spreadsheet ("Inventory" and "Photos" tabs).
 * Photos taken in the web app are saved to Google Drive:
 *   Physics Lab Inventory Photos / <No.> - <Item name> / <photo>.jpg
 *
 * Every request must carry the access key shown by  Physics Lab → Show access key.
 */

const INVENTORY_SHEET = 'Inventory';
const PHOTOS_SHEET = 'Photos';
const ROOT_FOLDER_NAME = 'Physics Lab Inventory Photos';

// [field key used by the web app, column header in the sheet]
const FIELDS = [
  ['id', 'No.'],
  ['item_name', 'Name of Item'],
  ['description', 'Description'],
  ['qty_previous', 'Qty. Previous (M/Y)'],
  ['qty_present', 'Qty. Present (M/Y)'],
  ['status', 'Status'],
  ['date_acquired', 'Date Acquired'],
  ['model_number', 'Model Number'],
  ['serial_number', 'Serial Number'],
  ['property_code', 'Property Code Number'],
  ['remarks', 'Remarks'],
];
const EDITABLE = FIELDS.map(f => f[0]).filter(k => k !== 'id');
const PHOTO_HEADERS = ['Photo ID', 'Item No.', 'File Name', 'Cover', 'Uploaded'];

// ------------------------------------------------------------------ menu & setup

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Physics Lab')
    .addItem('Set up / repair', 'setup')
    .addItem('Show access key', 'showAccessKey')
    .addItem('Show photos folder link', 'showFolderLink')
    .addToUi();
}

/** Run once: creates the tabs, the Drive photos folder and the access key. Safe to re-run. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  props.setProperty('SPREADSHEET_ID', ss.getId());

  ensureSheet_(ss, INVENTORY_SHEET, FIELDS.map(f => f[1]));
  ensureSheet_(ss, PHOTOS_SHEET, PHOTO_HEADERS);
  // Plain text keeps values like "23-00-651'" and "6 - Broken" exactly as typed
  ss.getSheetByName(INVENTORY_SHEET).getRange('A:K').setNumberFormat('@');
  ss.getSheetByName(PHOTOS_SHEET).getRange('A:E').setNumberFormat('@');

  if (!folderExists_(props.getProperty('FOLDER_ID'))) {
    props.setProperty('FOLDER_ID', DriveApp.createFolder(ROOT_FOLDER_NAME).getId());
  }
  if (!props.getProperty('ACCESS_KEY')) {
    props.setProperty('ACCESS_KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 10));
  }
  notify_('Setup complete.\n\nAccess key: ' + props.getProperty('ACCESS_KEY') +
          '\n\nPhotos folder: ' + rootFolder_().getUrl());
}

function showAccessKey() {
  notify_('Access key: ' + PropertiesService.getScriptProperties().getProperty('ACCESS_KEY'));
}

function showFolderLink() {
  notify_('Photos folder: ' + rootFolder_().getUrl());
}

// ------------------------------------------------------------------ web endpoints

function doGet() {
  return json_({ ok: true, message: 'Physics Lab Inventory API is running.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const key = PropertiesService.getScriptProperties().getProperty('ACCESS_KEY');
    if (!key) throw new Error('Run Physics Lab → Set up / repair in the spreadsheet first.');
    if (body.key !== key) throw new Error('Wrong access key.');

    const handler = ACTIONS[body.action];
    if (!handler) throw new Error('Unknown action: ' + body.action);

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      return json_({ ok: true, data: handler(body) });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

const ACTIONS = {
  list: function () {
    return { items: readItems_(), photos: readPhotos_(), folderUrl: rootFolder_().getUrl() };
  },

  addItem: function (body) {
    const sheet = sheet_(INVENTORY_SHEET);
    const items = readItems_();
    const item = { id: items.reduce((max, i) => Math.max(max, i.id), 0) + 1 };
    EDITABLE.forEach(k => item[k] = clean_(body.item && body.item[k]));
    if (!item.item_name) throw new Error('Name of Item is required.');
    sheet.appendRow(rowFor_(headers_(sheet), item, []));
    return item;
  },

  updateItem: function (body) {
    const sheet = sheet_(INVENTORY_SHEET);
    const found = findItemRow_(sheet, body.id);
    const item = found.item;
    EDITABLE.forEach(k => {
      if (body.changes && k in body.changes) item[k] = clean_(body.changes[k]);
    });
    if (!item.item_name) throw new Error('Name of Item is required.');
    sheet.getRange(found.row, 1, 1, found.values.length)
      .setValues([rowFor_(found.headers, item, found.values)]);
    return item;
  },

  deleteItem: function (body) {
    const sheet = sheet_(INVENTORY_SHEET);
    sheet.deleteRow(findItemRow_(sheet, body.id).row);
    // Photo records are removed; the image files stay in the Drive folder as a record
    deletePhotoRows_(p => p.itemId === Number(body.id));
    return { id: Number(body.id) };
  },

  uploadPhoto: function (body) {
    const item = findItemRow_(sheet_(INVENTORY_SHEET), body.itemId).item;
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmmss');
    const fileName = safeName_(item.item_name) + '_' + stamp + '.jpg';
    const blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.mimeType || 'image/jpeg', fileName);

    const file = itemFolder_(item).createFile(blob);
    try {
      // Lets the web app show the picture without a Google sign-in
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      console.warn('Could not share photo: ' + err);
    }

    const photo = {
      id: file.getId(), itemId: item.id, name: fileName, cover: false,
      uploaded: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    };
    sheet_(PHOTOS_SHEET).appendRow([photo.id, String(item.id), photo.name, '', photo.uploaded]);

    const hasCover = readPhotos_().some(p => p.itemId === item.id && p.cover);
    if (body.makeCover || !hasCover) {
      setCover_(item.id, photo.id);
      photo.cover = true;
    }
    return photo;
  },

  setCover: function (body) {
    setCover_(Number(body.itemId), body.photoId);
    return { itemId: Number(body.itemId), photoId: body.photoId };
  },

  deletePhoto: function (body) {
    try {
      DriveApp.getFileById(body.photoId).setTrashed(true); // recoverable from Drive trash
    } catch (err) {
      console.warn('Could not trash file: ' + err);
    }
    deletePhotoRows_(p => p.id === body.photoId);
    return { photoId: body.photoId };
  },
};

// ------------------------------------------------------------------ sheet helpers

function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Run Physics Lab → Set up / repair in the spreadsheet first.');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  const sheet = spreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('Missing "' + name + '" tab. Run Physics Lab → Set up / repair.');
  return sheet;
}

function ensureSheet_(ss, name, headers) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function headers_(sheet) {
  return sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1))
    .getDisplayValues()[0].map(h => String(h).trim());
}

function rowToItem_(headers, row) {
  const item = {};
  FIELDS.forEach(([key, header]) => {
    const col = headers.indexOf(header);
    item[key] = col >= 0 ? String(row[col]) : '';
  });
  item.id = Number(item.id);
  return item;
}

/** Builds a row in the sheet's own column order, keeping any extra columns untouched */
function rowFor_(headers, item, existing) {
  return headers.map((header, col) => {
    const field = FIELDS.find(f => f[1] === header);
    if (!field) return existing[col] !== undefined ? existing[col] : '';
    return field[0] === 'id' ? String(item.id) : item[field[0]] || '';
  });
}

function readItems_() {
  const values = sheet_(INVENTORY_SHEET).getDataRange().getDisplayValues();
  const headers = values.shift().map(h => String(h).trim());
  return values
    .filter(row => row.join('').trim() !== '')
    .map(row => rowToItem_(headers, row))
    .filter(item => item.id);
}

function findItemRow_(sheet, id) {
  const values = sheet.getDataRange().getDisplayValues();
  const headers = values[0].map(h => String(h).trim());
  const idCol = headers.indexOf('No.');
  for (let i = 1; i < values.length; i++) {
    if (Number(values[i][idCol]) === Number(id)) {
      return { row: i + 1, headers: headers, values: values[i], item: rowToItem_(headers, values[i]) };
    }
  }
  throw new Error('Item No. ' + id + ' not found. Someone may have deleted it — refresh the page.');
}

function readPhotos_() {
  const values = sheet_(PHOTOS_SHEET).getDataRange().getDisplayValues();
  values.shift();
  return values
    .filter(row => row[0])
    .map(row => ({
      id: row[0], itemId: Number(row[1]), name: row[2],
      cover: String(row[3]).toLowerCase() === 'yes', uploaded: row[4],
    }));
}

function setCover_(itemId, photoId) {
  const sheet = sheet_(PHOTOS_SHEET);
  const values = sheet.getDataRange().getDisplayValues();
  for (let i = 1; i < values.length; i++) {
    if (Number(values[i][1]) === itemId) {
      sheet.getRange(i + 1, 4).setValue(values[i][0] === photoId ? 'yes' : '');
    }
  }
}

function deletePhotoRows_(predicate) {
  const sheet = sheet_(PHOTOS_SHEET);
  const values = sheet.getDataRange().getDisplayValues();
  for (let i = values.length - 1; i >= 1; i--) {
    const photo = { id: values[i][0], itemId: Number(values[i][1]) };
    if (predicate(photo)) sheet.deleteRow(i + 1);
  }
}

// ------------------------------------------------------------------ drive helpers

function folderExists_(id) {
  if (!id) return false;
  try {
    return !DriveApp.getFolderById(id).isTrashed();
  } catch (err) {
    return false;
  }
}

function rootFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!folderExists_(id)) throw new Error('Photos folder missing. Run Physics Lab → Set up / repair.');
  return DriveApp.getFolderById(id);
}

/** One subfolder per item: "<No.> - <Item name>", remembered so renames don't create duplicates */
function itemFolder_(item) {
  const props = PropertiesService.getScriptProperties();
  const cacheKey = 'ITEM_FOLDER_' + item.id;
  const cached = props.getProperty(cacheKey);
  if (folderExists_(cached)) return DriveApp.getFolderById(cached);

  const root = rootFolder_();
  const prefix = item.id + ' - ';
  const folders = root.getFolders();
  let folder = null;
  while (folders.hasNext()) {
    const f = folders.next();
    if (f.getName().indexOf(prefix) === 0) { folder = f; break; }
  }
  folder = folder || root.createFolder(prefix + safeName_(item.item_name));
  props.setProperty(cacheKey, folder.getId());
  return folder;
}

// ------------------------------------------------------------------ misc

function clean_(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function safeName_(name) {
  return (String(name || 'item').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim() || 'item').slice(0, 60);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function notify_(message) {
  console.log(message);
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (err) {
    // Not running from the spreadsheet menu — the message is in the execution log
  }
}
