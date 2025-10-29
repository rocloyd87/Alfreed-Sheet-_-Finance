// File: code.gs - Cascade Ledger Backend (ENHANCED VERSION with Smart OCR)

/** Configuration Constants */
const CONFIG = {
  SHEET_BATCH: 'Bulk Entry',
  SHEET_SETTINGS: 'Settings',
  RECEIPT_FOLDER: 'Ledger Receipts',
  RECEIPT_UPLOAD_FOLDER_ID: '1nnvsrNpbiQV6diSXAJ4C5hqdpX5VFc5n',
  CACHE_DURATION: 600,
  BATCH_SIZE: 100,
  MAX_RETRIES: 3,
  ADMIN_PASSWORD_KEY: 'ADMIN_PASSWORD',
  VISION_API_KEY: 'VISION_API_KEY',
  CLAUDE_API_KEY: 'CLAUDE_API_KEY'
};

/** Required headers for batch sheet */
const REQUIRED_HEADERS = [
  'Timestamp', 'Property', 'Date', 'Expense Type', 'Category', 'Description',
  'Supplier', 'Unit', 'Price Per Unit', 'Total No. of Unit', 'Amount',
  'Source', 'Receipt URL', 'Notes'
];

/** Default fallback values */
const DEFAULTS = {
  property: 'Cascade Hideaway_Bria',
  adminPassword: 'admin123',
  categories: {
    recurring: [
      'Utilities – Internet',
      'Utilities – Electricity', 
      'Utilities – Water',
      'Utilities – Pag-IBIG Mortgage',
      'Utilities – Laundry',
      'Services – HOA Fee',
      'Services – Cleaning Fee',
      'Services – Commission Fee',
      'Services – Management Fee',
      'Services – Repairs',
      'Subscriptions – Netflix',
      'Subscriptions – Tapo CCTV',
      'Subscriptions – TTLock',
      'Subscriptions – ChatGPT Go',
      'Subscriptions – PriceLabs',
      'Subscriptions – Other'
    ],
    variable: [
      'Services',
      'Consumables',
      'Repairs',
      'Incentives / Salary',
      'Refunds',
      'Supplies – Coffee',
      'Supplies – Tea',
      'Supplies – Bottled Water',
      'Supplies – Dishwashing Soap',
      'Supplies – Hand Soap',
      'Supplies – Shampoo',
      'Supplies – Body Wash',
      'Supplies – Detergent',
      'Supplies – Bleach',
      'Supplies – Paper Towels',
      'Supplies – Tissue',
      'Supplies – Toiletries',
      'Supplies – Kitchen Items',
      'Supplies – Cleaning Supplies',
      'Materials – Linens',
      'Materials – Bed Sheets',
      'Materials – Pillows',
      'Materials – Duvet',
      'Materials – Duvet Covers',
      'Materials – Towels',
      'Materials – Bath Mats',
      'Materials – Curtains',
      'Materials – Paint',
      'Materials – Furniture',
      'Materials – Appliances',
      'Materials – Decorations',
      'Materials – Other Equipment',
      'Maintenance – Plumbing',
      'Maintenance – Electrical',
      'Maintenance – HVAC',
      'Maintenance – Pest Control',
      'Maintenance – Gardening',
      'Maintenance – General'
    ]
  },
  units: [
    'pcs', 'packs', 'bottles', 'boxes', 'bags', 'rolls', 'sets', 'pairs',
    'ml', 'liters', 'kg', 'grams', 'meters', 'services', 'units', 
    'hours', 'days', 'months'
  ]
};

/** Smart categorization patterns */
const CATEGORY_PATTERNS = {
  // Utilities
  'Utilities – Electricity': ['meralco', 'electric', 'electricity', 'power bill', 'kwh'],
  'Utilities – Water': ['water bill', 'maynilad', 'manila water', 'water district', 'cubic meter', 'm3'],
  'Utilities – Internet': ['pldt', 'globe', 'converge', 'internet', 'broadband', 'wifi', 'fiber'],
  'Utilities – Laundry': ['laundry', 'wash', 'dry clean', 'fabcon'],
  
  // Services
  'Services – HOA Fee': ['hoa', 'homeowners', 'association fee', 'association dues'],
  'Services – Cleaning Fee': ['cleaning', 'housekeeping', 'maid service', 'janitor'],
  'Services – Repairs': ['repair', 'fix', 'maintenance', 'technician'],
  
  // Subscriptions
  'Subscriptions – Netflix': ['netflix'],
  'Subscriptions – Other': ['subscription', 'monthly fee', 'annual fee'],
  
  // Supplies - Beverages
  'Supplies – Coffee': ['coffee', 'nescafe', 'kopiko', 'great taste', 'bear brand'],
  'Supplies – Tea': ['tea', 'lipton', 'twinings'],
  'Supplies – Bottled Water': ['water', 'mineral water', 'distilled', 'purified water', 'absolute', 'summit', 'wilkins'],
  
  // Supplies - Cleaning
  'Supplies – Dishwashing Soap': ['dishwashing', 'joy', 'palmolive', 'dish soap'],
  'Supplies – Hand Soap': ['hand soap', 'safeguard', 'dove soap'],
  'Supplies – Detergent': ['detergent', 'tide', 'ariel', 'surf', 'breeze'],
  'Supplies – Bleach': ['bleach', 'zonrox', 'clorox'],
  'Supplies – Cleaning Supplies': ['cleaning', 'lysol', 'domex', 'mr. clean', 'wipes', 'sponge', 'scrub'],
  
  // Supplies - Personal Care
  'Supplies – Shampoo': ['shampoo', 'head & shoulders', 'palmolive shampoo', 'sunsilk', 'dove shampoo'],
  'Supplies – Body Wash': ['body wash', 'shower gel', 'dove body', 'nivea body'],
  'Supplies – Toiletries': ['tissue', 'toilet paper', 'toothpaste', 'toothbrush', 'soap', 'shampoo'],
  
  // Supplies - Paper Products
  'Supplies – Paper Towels': ['paper towel', 'bounty', 'scott towel'],
  'Supplies – Tissue': ['tissue', 'kleenex', 'facial tissue', 'toilet paper'],
  
  // Materials
  'Materials – Linens': ['linen', 'bedding', 'bed linen'],
  'Materials – Bed Sheets': ['bed sheet', 'bedsheet', 'fitted sheet'],
  'Materials – Towels': ['towel', 'bath towel', 'hand towel'],
  'Materials – Furniture': ['furniture', 'chair', 'table', 'cabinet', 'sofa', 'bed frame'],
  'Materials – Appliances': ['appliance', 'refrigerator', 'aircon', 'washing machine', 'microwave', 'oven'],
  
  // Maintenance
  'Maintenance – Plumbing': ['plumber', 'plumbing', 'pipe', 'faucet', 'toilet', 'drain', 'leak'],
  'Maintenance – Electrical': ['electrician', 'electrical', 'wiring', 'outlet', 'breaker', 'light'],
  'Maintenance – HVAC': ['aircon', 'air conditioning', 'hvac', 'ac service', 'freon'],
  'Maintenance – Pest Control': ['pest', 'termite', 'exterminator', 'fumigation'],
  
  // General
  'Services': ['service fee', 'labor', 'professional fee'],
  'Consumables': ['consumable', 'supplies'],
  'Repairs': ['repair', 'fix', 'broken']
};

/** Unit detection patterns */
const UNIT_PATTERNS = {
  'pcs': ['pc', 'pcs', 'piece', 'pieces', 'unit', 'units'],
  'bottles': ['bottle', 'bottles', 'btl'],
  'packs': ['pack', 'packs', 'packet', 'packets'],
  'boxes': ['box', 'boxes'],
  'bags': ['bag', 'bags', 'sack', 'sacks'],
  'liters': ['liter', 'liters', 'l', 'lt'],
  'kg': ['kg', 'kilo', 'kilogram', 'kilograms'],
  'rolls': ['roll', 'rolls'],
  'sets': ['set', 'sets'],
  'pairs': ['pair', 'pairs']
};

/** Pre-compiled regex patterns */
const REGEX = {
  money: /(?:TOTAL|GRAND\s*TOTAL|AMOUNT\s*DUE|AMOUNT|PRICE)\s*[:\-]?\s*₱?\s*([0-9]{1,3}(?:[, ][0-9]{3})*(?:\.[0-9]{2})?|\d+(?:\.\d{2})?)/i,
  anyMoney: /₱?\s*([0-9]{1,3}(?:[, ][0-9]{3})*(?:\.[0-9]{2})?|\d+\.\d{2})/g,
  date: /\b(20\d{2}[-\/.](0?[1-9]|1[0-2])[-\/.](0?[1-9]|[12]\d|3[01])|(0?[1-9]|1[0-2])[-\/.](0?[1-9]|[12]\d|3[01])[-\/.](20\d{2}))\b/,
  supplierNoise: /^\d|^TOTAL|^AMOUNT|^INVOICE|^RECEIPT|^PRICE/i,
  moneyClean: /[^\d.]/g,
  quantity: /(?:QTY|QUANTITY|QTY\.)\s*[:\-]?\s*(\d+\.?\d*)/i,
  unit: /(\d+\.?\d*)\s*(pc|pcs|bottle|bottles|pack|packs|box|boxes|bag|bags|liter|liters|kg|kilo|roll|rolls|set|sets|pair|pairs)/i
};

/** Cache manager */
const CacheManager = {
  get(key) {
    try {
      const cache = CacheService.getScriptCache();
      const cached = cache.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (e) {
      Logger.log(`Cache get error for ${key}: ${e}`);
      return null;
    }
  },
  
  set(key, value, expiration = CONFIG.CACHE_DURATION) {
    try {
      const cache = CacheService.getScriptCache();
      cache.put(key, JSON.stringify(value), expiration);
      return true;
    } catch (e) {
      Logger.log(`Cache set error for ${key}: ${e}`);
      return false;
    }
  },
  
  remove(key) {
    try {
      CacheService.getScriptCache().remove(key);
      return true;
    } catch (e) {
      Logger.log(`Cache remove error for ${key}: ${e}`);
      return false;
    }
  },
  
  invalidate() {
    try {
      CacheService.getScriptCache().removeAll(['settings', 'headers', 'receiptFolder']);
      return true;
    } catch (e) {
      Logger.log(`Cache invalidate error: ${e}`);
      return false;
    }
  }
};

/** Error handling wrapper */
function withRetry(fn, maxRetries = CONFIG.MAX_RETRIES) {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      return fn();
    } catch (e) {
      attempts++;
      if (attempts >= maxRetries) throw e;
      Utilities.sleep(Math.pow(2, attempts) * 100);
    }
  }
}

/** Serve the UI */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Cascade Ledger')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Get settings with caching */
function getSettings() {
  const cached = CacheManager.get('settings');
  if (cached) return cached;
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET_SETTINGS);
  
  if (!sh) {
    return {
      propertyName: DEFAULTS.property,
      categories: DEFAULTS.categories,
      units: DEFAULTS.units
    };
  }
  
  try {
    const data = sh.getDataRange().getValues();
    const settings = {
      propertyName: data[1]?.[0] || DEFAULTS.property,
      categories: {
        recurring: [],
        variable: []
      },
      units: DEFAULTS.units
    };
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][1]) settings.categories.recurring.push(String(data[i][1]));
      if (data[i][2]) settings.categories.variable.push(String(data[i][2]));
    }
    
    if (!settings.categories.recurring.length) {
      settings.categories.recurring = DEFAULTS.categories.recurring.slice();
    }
    if (!settings.categories.variable.length) {
      settings.categories.variable = DEFAULTS.categories.variable.slice();
    }
    
    CacheManager.set('settings', settings);
    return settings;
  } catch (e) {
    Logger.log(`getSettings error: ${e}`);
    return {
      propertyName: DEFAULTS.property,
      categories: DEFAULTS.categories,
      units: DEFAULTS.units
    };
  }
}

/** Upload receipt to Google Drive folder */
function uploadReceiptToFolder(fileData) {
  try {
    const { fileName, mimeType, base64Data } = fileData;
    
    if (!fileName || !base64Data) {
      return { success: false, message: 'Missing file data' };
    }
    
    // Get the target folder
    const folder = DriveApp.getFolderById(CONFIG.RECEIPT_UPLOAD_FOLDER_ID);
    
    // Decode base64 and create blob
    const blob = Utilities.newBlob(
      Utilities.base64Decode(base64Data),
      mimeType || 'application/octet-stream',
      fileName
    );
    
    // Upload to folder
    const file = folder.createFile(blob);
    const fileUrl = file.getUrl();
    
    return {
      success: true,
      message: 'Receipt uploaded successfully',
      fileUrl: fileUrl,
      fileId: file.getId(),
      fileName: file.getName()
    };
  } catch (e) {
    Logger.log(`uploadReceiptToFolder error: ${e}`);
    return {
      success: false,
      message: `Upload failed: ${e.message}`
    };
  }
}

/** Process Smart OCR (existing function - unchanged) */
function processSmartOCR(data) {
  try {
    if (!data) {
      return { success: false, message: 'No data provided' };
    }
    
    let extractedText = '';
    
    if (data.text) {
      extractedText = data.text;
    } else if (data.imageBase64) {
      const visionApiKey = PropertiesService.getScriptProperties().getProperty(CONFIG.VISION_API_KEY);
      if (!visionApiKey) {
        return { success: false, message: 'Vision API key not configured' };
      }
      
      const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${visionApiKey}`;
      const payload = {
        requests: [{
          image: { content: data.imageBase64 },
          features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
        }]
      };
      
      const options = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };
      
      const response = UrlFetchApp.fetch(visionUrl, options);
      const result = JSON.parse(response.getContentText());
      
      if (result.responses && result.responses[0] && result.responses[0].textAnnotations) {
        extractedText = result.responses[0].textAnnotations[0].description;
      } else {
        return { success: false, message: 'No text found in image' };
      }
    } else {
      return { success: false, message: 'No text or image provided' };
    }
    
    if (!extractedText) {
      return { success: false, message: 'No text extracted' };
    }
    
    const parsed = parseReceiptText_(extractedText);
    
    return {
      success: true,
      ...parsed,
      rawText: extractedText
    };
  } catch (e) {
    Logger.log(`processSmartOCR error: ${e}`);
    return {
      success: false,
      message: `Processing error: ${e.message}`
    };
  }
}

/** Parse receipt text (existing function - unchanged) */
function parseReceiptText_(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  
  let amount = '';
  const moneyMatch = text.match(REGEX.money);
  if (moneyMatch) {
    amount = moneyMatch[1].replace(REGEX.moneyClean, '');
  } else {
    const anyMatches = text.match(REGEX.anyMoney);
    if (anyMatches && anyMatches.length) {
      const values = anyMatches.map(m => parseFloat(m.replace(REGEX.moneyClean, '')));
      amount = Math.max(...values).toFixed(2);
    }
  }
  
  const dateMatch = text.match(REGEX.date);
  let date = '';
  if (dateMatch) {
    try {
      const d = new Date(dateMatch[0]);
      if (!isNaN(d.getTime())) {
        date = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
    } catch (e) {
      date = '';
    }
  }
  
  let supplier = '';
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i];
    if (line.length > 3 && line.length < 50 && !REGEX.supplierNoise.test(line)) {
      supplier = line;
      break;
    }
  }
  
  let category = '';
  const lowerText = text.toLowerCase();
  for (const [cat, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some(p => lowerText.includes(p))) {
      category = cat;
      break;
    }
  }
  
  let unit = 'pcs';
  const unitMatch = text.match(REGEX.unit);
  if (unitMatch) {
    const foundUnit = unitMatch[2].toLowerCase();
    for (const [standardUnit, patterns] of Object.entries(UNIT_PATTERNS)) {
      if (patterns.includes(foundUnit)) {
        unit = standardUnit;
        break;
      }
    }
  }
  
  let quantity = '1';
  const qtyMatch = text.match(REGEX.quantity);
  if (qtyMatch) {
    quantity = qtyMatch[1];
  } else if (unitMatch) {
    quantity = unitMatch[1];
  }
  
  const expenseType = category && DEFAULTS.categories.recurring.includes(category) 
    ? 'Recurring Expense' 
    : 'Variable Expense';
  
  return {
    date: date || new Date().toISOString().split('T')[0],
    expenseType: expenseType,
    category: category,
    description: supplier || 'Receipt',
    supplier: supplier,
    amount: amount,
    unit: unit,
    quantity: quantity,
    pricePerUnit: quantity && amount ? (parseFloat(amount) / parseFloat(quantity)).toFixed(2) : amount
  };
}

/** Ensure batch sheet with headers */
function ensureBatchSheetAndHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET_BATCH);
  
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET_BATCH);
    sh.getRange(1, 1, 1, REQUIRED_HEADERS.length).setValues([REQUIRED_HEADERS]);
    formatHeaderRow_(sh);
    const idx = headerIndex_(REQUIRED_HEADERS);
    CacheManager.set('headers', idx);
    return idx;
  }
  
  const cached = CacheManager.get('headers');
  if (cached) return cached;
  
  const maxCol = sh.getLastColumn() || 1;
  const headers = sh.getRange(1, 1, 1, maxCol).getValues()[0].map(String);
  
  const toAdd = REQUIRED_HEADERS.filter(h => !headers.includes(h));
  if (toAdd.length) {
    const newHeaders = [...headers, ...toAdd];
    sh.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
    formatHeaderRow_(sh);
    const idx = headerIndex_(newHeaders);
    CacheManager.set('headers', idx);
    return idx;
  }
  
  const idx = headerIndex_(headers);
  CacheManager.set('headers', idx);
  return idx;
}

/** Format header row */
function formatHeaderRow_(sheet) {
  const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  headerRange.setFontWeight('bold')
    .setBackground('#4a5568')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');
}

/** Create header index map */
function headerIndex_(headers) {
  const idx = {};
  headers.forEach((h, i) => { if (h) idx[h] = i; });
  return idx;
}

/** Get current headers */
function getCurrentHeaders_() {
  const cached = CacheManager.get('headers');
  if (cached) return Object.keys(cached);
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CONFIG.SHEET_BATCH);
  if (!sh) return REQUIRED_HEADERS.slice();
  
  const maxCol = sh.getLastColumn() || REQUIRED_HEADERS.length;
  return sh.getRange(1, 1, 1, maxCol).getValues()[0].map(String);
}

/** Process batch expenses */
function processBatchExpenses(items) {
  if (!Array.isArray(items) || !items.length) {
    return { success: false, message: 'No items provided' };
  }
  
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(CONFIG.SHEET_BATCH);
    
    const headerIdx = ensureBatchSheetAndHeaders();
    const headers = getCurrentHeaders_();
    const timestamp = new Date();
    
    const rows = items.map(item => buildRow_(item, headers, headerIdx, timestamp));
    
    const startRow = Math.max(2, sh.getLastRow() + 1);
    const range = sh.getRange(startRow, 1, rows.length, headers.length);
    range.setValues(rows);
    
    const amountCol = headerIdx['Amount'];
    if (amountCol !== undefined) {
      const amountRange = sh.getRange(startRow, amountCol + 1, rows.length, 1);
      amountRange.setNumberFormat('₱#,##0.00');
    }
    
    CacheManager.invalidate();
    
    return { 
      success: true, 
      message: `Successfully added ${items.length} expense(s)`,
      rowsAdded: items.length
    };
  } catch (e) {
    Logger.log(`processBatchExpenses error: ${e}`);
    return { 
      success: false, 
      message: `Error: ${e.message || e}` 
    };
  }
}

/** Build individual row */
function buildRow_(item, headers, headerIdx, timestamp) {
  const row = new Array(headers.length).fill('');
  const put = (h, v) => {
    const i = headerIdx[h];
    if (i !== undefined) row[i] = v;
  };
  
  const isRecurring = item.expenseType === 'Recurring Expense';
  
  put('Timestamp', timestamp);
  put('Property', item.property || DEFAULTS.property);
  put('Date', parseDate_(item.date));
  put('Expense Type', item.expenseType || '');
  put('Category', item.category || '');
  put('Description', item.description || '');
  put('Supplier', item.supplier || '');
  
  if (isRecurring) {
    put('Unit', '');
    put('Price Per Unit', '');
    put('Total No. of Unit', '');
    put('Amount', num_(item.amount));
  } else {
    const ppu = num_(item.pricePerUnit);
    const units = num_(item.totalNoOfUnit || 1);
    const computed = (typeof ppu === 'number' && typeof units === 'number') ? ppu * units : '';
    const amt = item.amount !== undefined && item.amount !== '' && !isNaN(Number(item.amount)) 
      ? num_(item.amount) 
      : computed;
    
    put('Unit', item.unit || '');
    put('Price Per Unit', ppu);
    put('Total No. of Unit', units);
    put('Amount', amt);
  }
  
  put('Source', item.source || 'Manual');
  put('Receipt URL', item.receiptUrl || '');
  put('Notes', item.notes || '');
  
  return row;
}

/** Safe date parsing */
function parseDate_(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    return !isNaN(d.getTime()) ? d : s;
  } catch (e) {
    return s;
  }
}

/** Safe numeric conversion */
function num_(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return isFinite(n) ? n : '';
}

/** Ensure receipt folder exists */
function ensureReceiptFolder_() {
  const cached = CacheManager.get('receiptFolder');
  if (cached) {
    try {
      return DriveApp.getFolderById(cached);
    } catch (e) {
      CacheManager.remove('receiptFolder');
    }
  }
  
  return withRetry(() => {
    const ss = SpreadsheetApp.getActive();
    const file = DriveApp.getFileById(ss.getId());
    const parent = file.getParents().hasNext() 
      ? file.getParents().next() 
      : DriveApp.getRootFolder();
    
    const it = parent.getFoldersByName(CONFIG.RECEIPT_FOLDER);
    const folder = it.hasNext() ? it.next() : parent.createFolder(CONFIG.RECEIPT_FOLDER);
    
    CacheManager.set('receiptFolder', folder.getId(), 3600);
    return folder;
  });
}

/** Health check */
function healthCheck() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const batch = ss.getSheetByName(CONFIG.SHEET_BATCH);
    const settings = ss.getSheetByName(CONFIG.SHEET_SETTINGS);
    
    return {
      success: true,
      timestamp: new Date().toISOString(),
      sheets: {
        batch: !!batch,
        settings: !!settings
      },
      cache: {
        settings: !!CacheManager.get('settings'),
        headers: !!CacheManager.get('headers')
      }
    };
  } catch (e) {
    return {
      success: false,
      error: e.message
    };
  }
}

/** Clear all caches */
function clearAllCaches() {
  CacheManager.invalidate();
  return { success: true, message: 'All caches cleared. Please reload the web app.' };
}

/** Create Settings sheet template */
function createSettingsSheetTemplate() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let settings = ss.getSheetByName(CONFIG.SHEET_SETTINGS);
  
  if (!settings) {
    settings = ss.insertSheet(CONFIG.SHEET_SETTINGS);
  }
  
  settings.getRange(1, 1, 1, 3).setValues([['Property Name', 'Recurring Categories', 'Variable Categories']]);
  settings.getRange(2, 1).setValue(DEFAULTS.property);
  
  const recurringData = DEFAULTS.categories.recurring.map(cat => [cat]);
  settings.getRange(2, 2, recurringData.length, 1).setValues(recurringData);
  
  const variableData = DEFAULTS.categories.variable.map(cat => [cat]);
  settings.getRange(2, 3, variableData.length, 1).setValues(variableData);
  
  settings.getRange(1, 1, 1, 3)
    .setFontWeight('bold')
    .setBackground('#4a5568')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');
  
  settings.setFrozenRows(1);
  settings.autoResizeColumns(1, 3);
  
  return { success: true, message: 'Settings sheet created with default values' };
}