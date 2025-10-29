/**
 * Sync module committing staged transactions into the ledger with integrity checks.
 */
var Mod_Sync = (function () {
  'use strict';

  var DEFAULT_READY_STATUSES = ['READY_SYNC'];
  var STAGING_SHEET = 'Staging_Transactions';
  var TRANSACTIONS_SHEET = 'Transactions';

  /**
   * Commits staged transactions that are ready for sync.
   * @param {Object=} options - {dryRun:boolean, limit:number, statusFilter:Array<string>, importSessionId:string}
   * @return {Object} Summary of the sync run.
   */
  function commitTransactions(options) {
    options = options || {};
    var dryRun = options.dryRun === true;
    var limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : null;
    var statusFilter = Array.isArray(options.statusFilter) && options.statusFilter.length
      ? options.statusFilter
      : DEFAULT_READY_STATUSES;
    var sessionId = options.importSessionId || null;

    Logs.logEvent('INFO', 'Mod_Sync', 'Sync commit invoked', {
      dryRun: dryRun,
      limit: limit,
      statusFilter: statusFilter,
      importSessionId: sessionId
    });

    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      throw new Error('SpreadsheetApp unavailable - cannot sync transactions');
    }

    var config = Mod_Config.load();
    var stagingSheetName = options.stagingSheet || STAGING_SHEET;
    var ledgerSheetName = options.transactionsSheet || config.transactionsSheet || TRANSACTIONS_SHEET;

    var stagingSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(stagingSheetName);
    if (!stagingSheet) {
      throw new Error('Staging sheet not found: ' + stagingSheetName);
    }

    var ledgerSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ledgerSheetName);
    if (!ledgerSheet) {
      throw new Error('Ledger sheet not found: ' + ledgerSheetName);
    }

    var stagingRows = loadEligibleStaging_(stagingSheet, statusFilter, sessionId, limit);
    if (!stagingRows.length) {
      Logs.logEvent('INFO', 'Mod_Sync', 'No staged transactions eligible for sync');
      return buildSummary_('NO_DATA', dryRun, []);
    }

    var existingFingerprints = loadExistingFingerprints_(ledgerSheet);
    var prepared = prepareLedgerRows_(stagingRows, ledgerSheet, existingFingerprints);
    var duplicates = prepared.duplicates;
    var ledgerRows = prepared.rows;

    if (!dryRun) {
      if (ledgerRows.length) {
        appendLedgerRows_(ledgerSheet, ledgerRows);
        markStagingAsSynced_(stagingSheet, prepared.syncedIds);
      }
      if (duplicates.length) {
        markDuplicates_(stagingSheet, duplicates);
      }
    }

    if (Mod_Metrics && Mod_Metrics.record) {
      Mod_Metrics.record('sync.committed', dryRun ? 0 : ledgerRows.length, { dryRun: dryRun ? '1' : '0' });
      Mod_Metrics.record('sync.duplicates', duplicates.length, {});
    }

    Logs.logEvent('INFO', 'Mod_Sync', 'Sync completed', {
      attempted: stagingRows.length,
      committed: ledgerRows.length,
      duplicates: duplicates.length,
      dryRun: dryRun
    });

    return buildSummary_('OK', dryRun, stagingRows, ledgerRows.length, duplicates);
  }

  function loadEligibleStaging_(sheet, statusFilter, sessionId, limit) {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return [];
    }
    var lastColumn = sheet.getLastColumn();
    var data = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
    var headers = data[0];
    var headerMap = buildHeaderMap_(headers);
    var statusIdx = headerMap.status;
    var sessionIdx = headerMap.importSessionId;

    var results = [];
    for (var i = 1; i < data.length; i++) {
      if (limit && results.length >= limit) {
        break;
      }
      var row = data[i];
      if (!row || !row.length) {
        continue;
      }
      var status = (row[statusIdx] || '').toString();
      if (statusFilter.indexOf(status) === -1) {
        continue;
      }
      if (sessionId && sessionIdx !== undefined) {
        var rowSession = row[sessionIdx] ? row[sessionIdx].toString() : '';
        if (rowSession !== sessionId) {
          continue;
        }
      }
      results.push(mapStagingRow_(row, headerMap, i + 1));
    }
    return results;
  }

  function mapStagingRow_(row, headerMap, rowNumber) {
    return {
      rowNumber: rowNumber,
      stagingId: row[headerMap.stagingId],
      date: row[headerMap.date],
      account: row[headerMap.account],
      payee: row[headerMap.payee],
      description: row[headerMap.description],
      amount: parseFloat(row[headerMap.amount] || 0),
      currency: row[headerMap.currency],
      categorySuggested: row[headerMap.categorySuggested],
      status: row[headerMap.status],
      fingerprint: row[headerMap.fingerprint],
      source: row[headerMap.source],
      createdAt: row[headerMap.createdAt],
      updatedAt: row[headerMap.updatedAt]
    };
  }

  function prepareLedgerRows_(stagingRows, ledgerSheet, existingFingerprints) {
    var headers = ledgerSheet.getRange(1, 1, 1, ledgerSheet.getLastColumn() || 16).getValues()[0];
    var headerMap = buildHeaderMap_(headers, true);
    var now = new Date().toISOString();

    var seenFingerprints = {};
    if (existingFingerprints) {
      Object.keys(existingFingerprints).forEach(function (key) {
        seenFingerprints[key] = true;
      });
    }
    var duplicates = [];
    var rows = [];
    var syncedIds = [];

    stagingRows.forEach(function (txn) {
      if (txn.fingerprint && seenFingerprints[txn.fingerprint]) {
        duplicates.push({
          stagingId: txn.stagingId,
          fingerprint: txn.fingerprint,
          rowNumber: txn.rowNumber
        });
        return;
      }

      var ledgerRow = new Array(headers.length);
      setValue_(ledgerRow, headerMap, 'id', generateLedgerId_(txn));
      setValue_(ledgerRow, headerMap, 'date', txn.date);
      setValue_(ledgerRow, headerMap, 'account', txn.account);
      setValue_(ledgerRow, headerMap, 'payeeId', '');
      setValue_(ledgerRow, headerMap, 'description', txn.description || txn.payee || '');
      setValue_(ledgerRow, headerMap, 'amount', txn.amount);
      setValue_(ledgerRow, headerMap, 'currency', txn.currency || '');
      setValue_(ledgerRow, headerMap, 'categoryId', txn.categorySuggested || '');
      setValue_(ledgerRow, headerMap, 'tags', '');
      setValue_(ledgerRow, headerMap, 'isTransfer', false);
      setValue_(ledgerRow, headerMap, 'splitGroupId', '');
      setValue_(ledgerRow, headerMap, 'source', txn.source || 'staging');
      setValue_(ledgerRow, headerMap, 'fingerprint', txn.fingerprint || '');
      setValue_(ledgerRow, headerMap, 'status', 'POSTED');
      setValue_(ledgerRow, headerMap, 'attachments', '[]');
      setValue_(ledgerRow, headerMap, 'createdAt', now);
      setValue_(ledgerRow, headerMap, 'updatedAt', now);

      if (txn.fingerprint) {
        seenFingerprints[txn.fingerprint] = true;
      }

      rows.push(ledgerRow);
      syncedIds.push({ rowNumber: txn.rowNumber, stagingId: txn.stagingId });
    });

    return {
      rows: rows,
      duplicates: duplicates,
      syncedIds: syncedIds
    };
  }

  function appendLedgerRows_(sheet, rows) {
    if (!rows.length) {
      return;
    }
    var startRow = Math.max(sheet.getLastRow() + 1, 2);
    var headerLength = sheet.getLastColumn();

    Mod_Utils.chunkedProcess(rows, 40, function (chunk) {
      var range = sheet.getRange(startRow, 1, chunk.length, headerLength);
      range.setValues(chunk);
      startRow += chunk.length;
    }, {
      sleepMs: 75
    });
  }

  function markStagingAsSynced_(sheet, syncedIds) {
    if (!syncedIds.length) {
      return;
    }
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 16).getValues()[0];
    var headerMap = buildHeaderMap_(headers);
    var statusCol = headerMap.status !== undefined ? headerMap.status + 1 : null;
    var updatedAtCol = headerMap.updatedAt !== undefined ? headerMap.updatedAt + 1 : null;
    var now = new Date().toISOString();

    Mod_Utils.chunkedProcess(syncedIds, 20, function (chunk) {
      chunk.forEach(function (record) {
        if (statusCol) {
          sheet.getRange(record.rowNumber, statusCol).setValue('SYNCED');
        }
        if (updatedAtCol) {
          sheet.getRange(record.rowNumber, updatedAtCol).setValue(now);
        }
      });
    }, {
      sleepMs: 50
    });
  }

  function markDuplicates_(sheet, duplicates) {
    if (!duplicates.length) {
      return;
    }
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 16).getValues()[0];
    var headerMap = buildHeaderMap_(headers);
    var statusCol = headerMap.status !== undefined ? headerMap.status + 1 : null;
    var updatedAtCol = headerMap.updatedAt !== undefined ? headerMap.updatedAt + 1 : null;
    var now = new Date().toISOString();

    Mod_Utils.chunkedProcess(duplicates, 20, function (chunk) {
      chunk.forEach(function (record) {
        if (!record.rowNumber) {
          return;
        }
        if (statusCol) {
          sheet.getRange(record.rowNumber, statusCol).setValue('DUPLICATE');
        }
        if (updatedAtCol) {
          sheet.getRange(record.rowNumber, updatedAtCol).setValue(now);
        }
      });
    }, {
      sleepMs: 50
    });
  }

  function loadExistingFingerprints_(sheet) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 16).getValues()[0];
    var headerMap = buildHeaderMap_(headers, true);
    var fingerprintIdx = headerMap.fingerprint ? headerMap.fingerprint - 1 : -1;
    if (fingerprintIdx === -1) {
      return {};
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return {};
    }

    var range = sheet.getRange(2, fingerprintIdx + 1, lastRow - 1, 1);
    var values = range.getValues();
    var seen = {};
    for (var i = 0; i < values.length; i++) {
      var value = values[i][0];
      if (value) {
        seen[value] = true;
      }
    }
    return seen;
  }

  function generateLedgerId_(txn) {
    var prefix = 'txn_';
    if (txn && txn.stagingId) {
      return prefix + txn.stagingId.toString();
    }
    try {
      if (typeof Utilities !== 'undefined' && Utilities.getUuid) {
        return prefix + Utilities.getUuid();
      }
    } catch (err) {
      // ignore
    }
    return prefix + Math.random().toString(36).slice(2) + Date.now();
  }

  function buildHeaderMap_(headers, oneBased) {
    return headers.reduce(function (map, header, index) {
      var key = (header || '').toString();
      if (key) {
        map[key] = oneBased ? index + 1 : index;
      }
      return map;
    }, {});
  }

  function setValue_(row, headerMap, key, value) {
    if (!headerMap[key]) {
      return;
    }
    row[headerMap[key] - 1] = value;
  }

  function buildSummary_(status, dryRun, stagingRows, committed, duplicates) {
    return {
      status: status,
      dryRun: dryRun,
      attempted: stagingRows.length,
      committed: committed || 0,
      duplicates: (duplicates || []).length,
      duplicateDetails: duplicates || []
    };
  }

  return {
    commitTransactions: commitTransactions
  };
})();
