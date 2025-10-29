/**
 * Transaction intake pipeline for Alfred 5.0.
 * Handles normalization, deduplication, staging, and import session auditing.
 */
var Mod_Intake = (function () {
  'use strict';

  var STAGING_SHEET = 'Staging_Transactions';
  var IMPORT_SESSIONS_SHEET = 'Import_Sessions';
  var REQUIRED_FIELDS = ['date', 'amount'];

  /**
   * Imports an array of transaction-like objects into the staging table.
   * @param {Object} payload - {transactions: [], source: string, dryRun: boolean}
   * @return {Object} Summary of the import run.
   */
  function importTransactions(payload) {
    payload = payload || {};
    var rawTransactions = Array.isArray(payload.transactions) ? payload.transactions : [];
    var dryRun = payload.dryRun === true;
    var source = payload.source || 'manual';

    Logs.logEvent('INFO', 'Mod_Intake', 'Import invoked', {
      dryRun: dryRun,
      source: source,
      count: rawTransactions.length
    });

    if (!rawTransactions.length) {
      return {
        status: 'NO_DATA',
        dryRun: dryRun,
        source: source,
        totals: {
          received: 0,
          normalized: 0,
          staged: 0,
          duplicates: 0,
          invalid: 0
        }
      };
    }

    var config = Mod_Config.load();
    var context = {
      source: source,
      baseCurrency: config.baseCurrency || 'USD',
      defaultAccount: payload.defaultAccount || config.defaultAccount || '',
      importSessionId: payload.importSessionId || generateId_('imp')
    };

    var normalized = [];
    var invalid = [];

    for (var i = 0; i < rawTransactions.length; i++) {
      try {
        normalized.push(normalizeTransaction_(rawTransactions[i], i, context));
      } catch (err) {
        Logs.logEvent('WARN', 'Mod_Intake', 'Normalization failed', {
          index: i,
          error: err.message
        });
        invalid.push({
          index: i,
          error: err.message,
          sample: safeSample_(rawTransactions[i])
        });
      }
    }

    var dedupeResult = dedupeTransactions_(normalized, payload.skipDedup === true);
    var toStage = dedupeResult.toStage;
    var duplicates = dedupeResult.duplicates;

    var stagedCount = dryRun ? toStage.length : stageTransactions_(toStage, context);

    if (!payload.skipSessionLog) {
      recordImportSession_(context.importSessionId, source, rawTransactions.length, stagedCount, duplicates.length, invalid.length, dryRun ? 'DRY_RUN' : 'COMPLETED', dryRun ? 'Dry run - no rows committed' : null, dryRun);
    }

    return {
      status: dryRun ? 'DRY_RUN' : 'OK',
      dryRun: dryRun,
      source: source,
      importSessionId: context.importSessionId,
      totals: {
        received: rawTransactions.length,
        normalized: normalized.length,
        staged: stagedCount,
        duplicates: duplicates.length,
        invalid: invalid.length
      },
      duplicates: duplicates,
      invalid: invalid
    };
  }

  function normalizeTransaction_(raw, index, context) {
    if (!raw) {
      throw new Error('Missing transaction payload');
    }

    var normalized = {
      stagingId: raw.stagingId || generateId_('stg'),
      date: formatDate_(raw.date || raw.transactionDate || raw.postedDate),
      account: raw.account || raw.accountName || context.defaultAccount || 'Unassigned',
      payee: sanitizeString_(raw.payee || raw.counterparty || raw.description || 'Unknown'),
      description: sanitizeString_(raw.description || raw.memo || raw.note || ''),
      amount: parseAmount_(raw.amount, raw.debit, raw.credit),
      currency: (raw.currency || context.baseCurrency || 'USD').toString(),
      categorySuggested: raw.category || raw.categoryId || '',
      confidence: computeConfidence_(raw),
      source: context.source,
      rawPayload: truncateRaw_(raw),
      status: 'STAGED',
      fingerprint: raw.fingerprint || computeFingerprint_(raw, context),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      importSessionId: context.importSessionId
    };

    REQUIRED_FIELDS.forEach(function (field) {
      if (!normalized[field]) {
        throw new Error('Missing required field: ' + field + ' @ index ' + index);
      }
    });

    return normalized;
  }

  function dedupeTransactions_(transactions, skipDedup) {
    if (skipDedup) {
      return {
        toStage: transactions,
        duplicates: []
      };
    }

    var existingFingerprints = loadExistingFingerprints_();
    var toStage = [];
    var duplicates = [];
    var seen = {};

    transactions.forEach(function (txn) {
      var fp = txn.fingerprint;
      if (!fp) {
        toStage.push(txn);
        return;
      }
      if (existingFingerprints[fp] || seen[fp]) {
        duplicates.push({
          stagingId: txn.stagingId,
          fingerprint: fp,
          reason: existingFingerprints[fp] ? 'EXISTS' : 'BATCH_DUP',
          sample: safeSample_(txn)
        });
      } else {
        seen[fp] = true;
        toStage.push(txn);
      }
    });

    return {
      toStage: toStage,
      duplicates: duplicates
    };
  }

  function stageTransactions_(transactions, context) {
    if (!transactions.length) {
      return 0;
    }

    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      throw new Error('SpreadsheetApp unavailable - cannot stage transactions');
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STAGING_SHEET);
    if (!sheet) {
      throw new Error('Staging sheet missing: ' + STAGING_SHEET);
    }

    var headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 16);
    var headers = headerRange.getValues()[0];
    var headerMap = {};
    for (var h = 0; h < headers.length; h++) {
      headerMap[headers[h]] = h;
    }

    var rows = transactions.map(function (txn) {
      var row = new Array(headers.length);
      setRowValue_(row, headerMap, 'stagingId', txn.stagingId);
      setRowValue_(row, headerMap, 'date', txn.date);
      setRowValue_(row, headerMap, 'account', txn.account);
      setRowValue_(row, headerMap, 'payee', txn.payee);
      setRowValue_(row, headerMap, 'description', txn.description);
      setRowValue_(row, headerMap, 'amount', txn.amount);
      setRowValue_(row, headerMap, 'currency', txn.currency);
      setRowValue_(row, headerMap, 'categorySuggested', txn.categorySuggested);
      setRowValue_(row, headerMap, 'confidence', txn.confidence);
      setRowValue_(row, headerMap, 'source', txn.source);
      setRowValue_(row, headerMap, 'rawPayload', txn.rawPayload);
      setRowValue_(row, headerMap, 'status', txn.status);
      setRowValue_(row, headerMap, 'fingerprint', txn.fingerprint);
      setRowValue_(row, headerMap, 'createdAt', txn.createdAt);
      setRowValue_(row, headerMap, 'updatedAt', txn.updatedAt);
      setRowValue_(row, headerMap, 'importSessionId', txn.importSessionId);
      return row;
    });

    var appended = 0;
    var startRow = Math.max(sheet.getLastRow() + 1, 2);
    var headerLength = headers.length;

    Mod_Utils.chunkedProcess(rows, 50, function (chunk) {
      var range = sheet.getRange(startRow, 1, chunk.length, headerLength);
      range.setValues(chunk);
      startRow += chunk.length;
      appended += chunk.length;
    }, {
      sleepMs: 75
    });

    Logs.logEvent('INFO', 'Mod_Intake', 'Transactions staged', {
      count: appended,
      source: context.source
    });

    return appended;
  }

  function recordImportSession_(sessionId, source, received, staged, duplicateCount, invalidCount, status, notes, dryRun) {
    if (dryRun) {
      Logs.logEvent('INFO', 'Mod_Intake', 'Dry run session summary', {
        importSessionId: sessionId,
        source: source,
        received: received,
        staged: staged,
        duplicates: duplicateCount,
        invalid: invalidCount
      });
      return;
    }

    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return;
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(IMPORT_SESSIONS_SHEET);
    if (!sheet) {
      Logs.logEvent('WARN', 'Mod_Intake', 'Import session sheet missing', {
        sheet: IMPORT_SESSIONS_SHEET
      });
      return;
    }

    var lastColumn = sheet.getLastColumn() || 10;
    var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var headerMap = {};
    for (var h = 0; h < headers.length; h++) {
      headerMap[headers[h]] = h;
    }

    var row = new Array(headers.length);
    setRowValue_(row, headerMap, 'importSessionId', sessionId);
    setRowValue_(row, headerMap, 'source', source);
    setRowValue_(row, headerMap, 'startedAt', new Date().toISOString());
    setRowValue_(row, headerMap, 'completedAt', new Date().toISOString());
    setRowValue_(row, headerMap, 'status', status);
    setRowValue_(row, headerMap, 'totalRecords', received);
    setRowValue_(row, headerMap, 'stagedRecords', staged);
    setRowValue_(row, headerMap, 'skippedRecords', duplicateCount);
    setRowValue_(row, headerMap, 'errorCount', invalidCount);
    setRowValue_(row, headerMap, 'notes', notes || (dryRun ? 'Dry run summary' : ''));

    sheet.appendRow(row);
  }

  function loadExistingFingerprints_() {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return {};
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetNames = ['Transactions', STAGING_SHEET];
    var fingerprints = {};

    sheetNames.forEach(function (name) {
      var sheet = ss.getSheetByName(name);
      if (!sheet) {
        return;
      }
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) {
        return;
      }
      var lastColumn = sheet.getLastColumn();
      if (lastColumn === 0) {
        return;
      }
      var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
      var colIndex = headers.indexOf('fingerprint');
      if (colIndex === -1) {
        return;
      }
      var range = sheet.getRange(2, colIndex + 1, lastRow - 1, 1);
      var values = range.getValues();
      for (var i = 0; i < values.length; i++) {
        var val = values[i][0];
        if (val) {
          fingerprints[val] = true;
        }
      }
    });

    return fingerprints;
  }

  function setRowValue_(row, map, key, value) {
    if (!map.hasOwnProperty(key)) {
      return;
    }
    row[map[key]] = value;
  }

  function formatDate_(value) {
    if (!value) {
      return '';
    }
    var date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date: ' + value);
    }
    return date.toISOString().slice(0, 10);
  }

  function parseAmount_(amount, debit, credit) {
    if (typeof amount === 'number') {
      return amount;
    }
    if (typeof amount === 'string') {
      var normalized = amount.replace(/[,\s]/g, '');
      var parsed = parseFloat(normalized);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }
    if (typeof debit === 'number') {
      return debit * -1;
    }
    if (typeof credit === 'number') {
      return credit;
    }
    throw new Error('Amount could not be parsed');
  }

  function computeFingerprint_(raw, context) {
    var date = formatDate_(raw.date || raw.transactionDate || raw.postedDate);
    var amount = parseAmount_(raw.amount, raw.debit, raw.credit);
    var account = sanitizeString_(raw.account || raw.accountName || context.defaultAccount || '');
    var payee = sanitizeString_(raw.payee || raw.counterparty || raw.description || '');
    var seed = [date, amount, account, payee].join('|');
    if (seed.length > 120) {
      seed = seed.slice(0, 120);
    }
    return hashString_(seed);
  }

  function hashString_(value) {
    var hash = 0;
    if (!value) {
      return '';
    }
    for (var i = 0; i < value.length; i++) {
      hash = (hash << 5) - hash + value.charCodeAt(i);
      hash |= 0;
    }
    return 'fp_' + Math.abs(hash).toString(36);
  }

  function computeConfidence_(raw) {
    var score = 0;
    if (raw.date || raw.transactionDate || raw.postedDate) {
      score += 0.3;
    }
    if (raw.amount || typeof raw.amount === 'number') {
      score += 0.3;
    }
    if (raw.payee || raw.description || raw.counterparty) {
      score += 0.2;
    }
    if (raw.account || raw.accountName) {
      score += 0.2;
    }
    return Math.min(1, Math.max(0.1, score));
  }

  function sanitizeString_(value) {
    if (value === null || typeof value === 'undefined') {
      return '';
    }
    return value.toString().trim();
  }

  function truncateRaw_(raw) {
    try {
      var serialized = JSON.stringify(raw);
      if (serialized.length > 2000) {
        serialized = serialized.slice(0, 1997) + '…';
      }
      return serialized;
    } catch (err) {
      return '"[unserializable]"';
    }
  }

  function safeSample_(value) {
    if (value === null || typeof value === 'undefined') {
      return null;
    }
    try {
      return JSON.parse(truncateRaw_(value));
    } catch (err) {
      return value;
    }
  }

  function generateId_(prefix) {
    var id;
    try {
      if (typeof Utilities !== 'undefined' && Utilities.getUuid) {
        id = Utilities.getUuid();
      }
    } catch (err) {
      // ignore
    }
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now();
    }
    return prefix + '_' + id.replace(/[^a-zA-Z0-9_]/g, '');
  }

  return {
    importTransactions: importTransactions,
    computeFingerprint: computeFingerprint_
  };
})();
