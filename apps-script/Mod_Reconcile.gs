/**
 * Reconciliation module responsible for importing statements,
 * matching against the ledger, and routing unmatched items to an
 * exceptions queue.
 */
var Mod_Reconcile = (function () {
  'use strict';

  var DEFAULT_TRANSACTIONS_SHEET = 'Transactions';
  var DEFAULT_STATEMENTS_SHEET = 'Statements';
  var DEFAULT_EXCEPTIONS_SHEET = 'Reconcile_Exceptions';
  var DEFAULT_MATCHES_SHEET = 'Reconcile_Matches';

  /**
   * Reconciles a bank statement against the ledger.
   *
   * @param {Object} options Reconciliation options.
   * @param {string} options.account Account identifier.
   * @param {string|Date=} options.periodStart Start of the statement period.
   * @param {string|Date=} options.periodEnd End of the statement period.
   * @param {Array<Object>} options.transactions Statement transactions.
   * @param {boolean=} options.dryRun If true, do not persist results.
   * @param {string=} options.statementId Optional explicit statementId.
   * @return {Object} Summary of reconciliation results.
   */
  function reconcileStatement(options) {
    options = options || {};

    var account = (options.account || '').toString().trim();
    var periodStart = normalizeDateInput_(options.periodStart);
    var periodEnd = normalizeDateInput_(options.periodEnd);
    var dryRun = options.dryRun === true;
    var transactionsInput = Array.isArray(options.transactions) ? options.transactions : [];

    if (!account) {
      throw new Error('reconcileStatement requires an account');
    }

    if (!transactionsInput.length) {
      throw new Error('reconcileStatement requires at least one transaction');
    }

    Logs.logEvent('INFO', 'Mod_Reconcile', 'Statement reconciliation invoked', {
      account: account,
      periodStart: periodStart ? periodStart.toISOString() : null,
      periodEnd: periodEnd ? periodEnd.toISOString() : null,
      transactionCount: transactionsInput.length,
      dryRun: dryRun
    });

    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      throw new Error('SpreadsheetApp unavailable - cannot reconcile');
    }

    var config = Mod_Config.load();
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    var ledgerSheetName = config.transactionsSheet || DEFAULT_TRANSACTIONS_SHEET;
    var statementsSheetName = config.statementsSheet || DEFAULT_STATEMENTS_SHEET;
    var exceptionsSheetName = config.reconcileExceptionsSheet || DEFAULT_EXCEPTIONS_SHEET;
    var matchesSheetName = config.reconcileMatchesSheet || DEFAULT_MATCHES_SHEET;

    var ledgerSheet = ss.getSheetByName(ledgerSheetName);
    if (!ledgerSheet) {
      throw new Error('Ledger sheet not found: ' + ledgerSheetName);
    }

    var statementsSheet = ensureSheet_(ss, statementsSheetName, ['statementId', 'account', 'periodStart', 'periodEnd', 'checksum', 'status', 'importedAt']);
    var exceptionsSheet = ensureSheet_(ss, exceptionsSheetName, ['statementId', 'account', 'transactionDate', 'description', 'amount', 'ledgerId', 'type', 'notes', 'createdAt']);
    var matchesSheet = ensureSheet_(ss, matchesSheetName, ['statementId', 'ledgerId', 'statementReference', 'matchType', 'amount', 'transactionDate', 'matchedAt']);

    var statementTransactions = normalizeStatementTransactions_(transactionsInput);
    var checksum = createChecksum_(statementTransactions);
    var statementId = options.statementId || generateStatementId_(account, periodStart, periodEnd, checksum);

    var ledgerRows = loadLedgerRows_(ledgerSheet, account, periodStart, periodEnd);
    var matchingResult = matchTransactions_(statementTransactions, ledgerRows.rows);

    var status = matchingResult.unmatchedStatements.length === 0 && matchingResult.unmatchedLedger.length === 0
      ? 'RECONCILED'
      : 'EXCEPTIONS';

    var summary = {
      status: status,
      statementId: statementId,
      account: account,
      checksum: checksum,
      matchedCount: matchingResult.matches.length,
      unmatchedStatementCount: matchingResult.unmatchedStatements.length,
      unmatchedLedgerCount: matchingResult.unmatchedLedger.length,
      totals: matchingResult.totals,
      dryRun: dryRun
    };

    if (!dryRun) {
      recordStatementRow_(statementsSheet, statementId, account, periodStart, periodEnd, checksum, status);
      overwriteMatches_(matchesSheet, statementId, matchingResult.matches);
      overwriteExceptions_(exceptionsSheet, statementId, account, matchingResult.unmatchedStatements, matchingResult.unmatchedLedger);
    }

    if (Mod_Metrics && Mod_Metrics.record) {
      Mod_Metrics.record('reconcile.matched', matchingResult.matches.length, { account: account, status: status });
      Mod_Metrics.record('reconcile.unmatched.statement', matchingResult.unmatchedStatements.length, { account: account });
      Mod_Metrics.record('reconcile.unmatched.ledger', matchingResult.unmatchedLedger.length, { account: account });
    }

    Logs.logEvent('INFO', 'Mod_Reconcile', 'Statement reconciliation completed', summary);

    return summary;
  }

  /**
   * Lightweight probe used by health checks to confirm required sheets exist.
   * @return {Object}
   */
  function healthProbe() {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return {
        spreadsheetAvailable: false,
        ok: false
      };
    }

    var config = Mod_Config.load();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var result = {
      spreadsheetAvailable: true,
      statementsSheet: !!ss.getSheetByName(config.statementsSheet || DEFAULT_STATEMENTS_SHEET),
      exceptionsSheet: !!ss.getSheetByName(config.reconcileExceptionsSheet || DEFAULT_EXCEPTIONS_SHEET),
      matchesSheet: !!ss.getSheetByName(config.reconcileMatchesSheet || DEFAULT_MATCHES_SHEET)
    };

    result.ok = result.spreadsheetAvailable && result.statementsSheet && result.exceptionsSheet && result.matchesSheet;
    return result;
  }

  function normalizeStatementTransactions_(transactions) {
    var normalized = [];
    for (var i = 0; i < transactions.length; i++) {
      var txn = transactions[i] || {};
      var amount = parseFloat(txn.amount || 0);
      if (isNaN(amount)) {
        amount = 0;
      }
      normalized.push({
        index: i,
        date: formatDateString_(txn.date || txn.transactionDate || txn.postedAt || null),
        amount: roundAmount_(amount),
        description: (txn.description || txn.memo || txn.payee || '').toString(),
        fingerprint: txn.fingerprint ? txn.fingerprint.toString() : '',
        reference: txn.reference || txn.id || '',
        raw: txn
      });
    }
    return normalized;
  }

  function loadLedgerRows_(sheet, account, periodStart, periodEnd) {
    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn === 0) {
      return { rows: [] };
    }

    var values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
    var headers = values[0];
    var headerMap = buildHeaderMap_(headers);
    var rows = [];

    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (!row || row.length === 0) {
        continue;
      }
      var rowAccount = headerMap.account !== undefined ? (row[headerMap.account] || '').toString().trim() : '';
      if (rowAccount && rowAccount !== account) {
        continue;
      }

      var dateValue = headerMap.date !== undefined ? row[headerMap.date] : null;
      var dateIso = formatDateString_(dateValue);
      var dateObj = dateIso ? new Date(dateIso) : null;

      if (periodStart && dateObj && dateObj < periodStart) {
        continue;
      }
      if (periodEnd && dateObj && dateObj > periodEnd) {
        continue;
      }

      var amount = headerMap.amount !== undefined ? parseFloat(row[headerMap.amount] || 0) : 0;
      if (isNaN(amount)) {
        amount = 0;
      }

      rows.push({
        rowNumber: i + 1,
        id: headerMap.id !== undefined ? row[headerMap.id] : '',
        account: rowAccount,
        date: dateIso,
        amount: roundAmount_(amount),
        description: headerMap.description !== undefined ? (row[headerMap.description] || '').toString() : '',
        fingerprint: headerMap.fingerprint !== undefined ? (row[headerMap.fingerprint] || '').toString() : '',
        status: headerMap.status !== undefined ? (row[headerMap.status] || '').toString() : ''
      });
    }

    return {
      rows: rows,
      headerMap: headerMap
    };
  }

  function matchTransactions_(statementTransactions, ledgerRows) {
    var ledgerIndex = buildLedgerIndex_(ledgerRows);
    var matches = [];
    var unmatchedStatements = [];
    var usedLedgerRows = {};
    var statementTotal = 0;

    for (var i = 0; i < statementTransactions.length; i++) {
      var txn = statementTransactions[i];
      statementTotal += txn.amount;
      var match = null;
      var matchType = null;

      if (txn.fingerprint) {
        var fingerprintCandidate = ledgerIndex.byFingerprint[txn.fingerprint];
        if (fingerprintCandidate && !usedLedgerRows[fingerprintCandidate.rowNumber]) {
          match = fingerprintCandidate;
          matchType = 'FINGERPRINT';
        }
      }

      if (!match) {
        var compositeKey = buildCompositeKey_(txn.date, txn.amount, txn.description);
        var compositeCandidates = ledgerIndex.byComposite[compositeKey] || [];
        for (var c = 0; c < compositeCandidates.length; c++) {
          var candidate = compositeCandidates[c];
          if (!usedLedgerRows[candidate.rowNumber]) {
            match = candidate;
            matchType = 'AMOUNT_DATE_DESC';
            break;
          }
        }
      }

      if (!match) {
        var amountKey = buildAmountDateKey_(txn.date, txn.amount);
        var amountCandidates = ledgerIndex.byAmountDate[amountKey] || [];
        for (var a = 0; a < amountCandidates.length; a++) {
          var amountCandidate = amountCandidates[a];
          if (!usedLedgerRows[amountCandidate.rowNumber]) {
            match = amountCandidate;
            matchType = 'AMOUNT_DATE';
            break;
          }
        }
      }

      if (match) {
        usedLedgerRows[match.rowNumber] = true;
        matches.push({
          statementIndex: txn.index,
          ledgerRowNumber: match.rowNumber,
          ledgerId: match.id || '',
          amount: roundAmount_(txn.amount),
          transactionDate: txn.date || match.date,
          matchType: matchType,
          statementReference: txn.reference || txn.fingerprint || ('statement-row-' + txn.index)
        });
      } else {
        unmatchedStatements.push({
          statementIndex: txn.index,
          transactionDate: txn.date,
          description: txn.description,
          amount: roundAmount_(txn.amount),
          reference: txn.reference || txn.fingerprint || null
        });
      }
    }

    var unmatchedLedger = [];
    for (var j = 0; j < ledgerRows.length; j++) {
      var ledgerTxn = ledgerRows[j];
      if (!usedLedgerRows[ledgerTxn.rowNumber]) {
        unmatchedLedger.push({
          ledgerId: ledgerTxn.id || '',
          rowNumber: ledgerTxn.rowNumber,
          transactionDate: ledgerTxn.date,
          description: ledgerTxn.description,
          amount: roundAmount_(ledgerTxn.amount)
        });
      }
    }

    var matchedTotal = 0;
    for (var m = 0; m < matches.length; m++) {
      matchedTotal += matches[m].amount;
    }

    return {
      matches: matches,
      unmatchedStatements: unmatchedStatements,
      unmatchedLedger: unmatchedLedger,
      checksum: createChecksum_(statementTransactions),
      totals: {
        statementTotal: roundAmount_(statementTotal),
        matchedTotal: roundAmount_(matchedTotal),
        difference: roundAmount_(statementTotal - matchedTotal)
      }
    };
  }

  function buildLedgerIndex_(ledgerRows) {
    var index = {
      byFingerprint: {},
      byComposite: {},
      byAmountDate: {}
    };

    for (var i = 0; i < ledgerRows.length; i++) {
      var row = ledgerRows[i];
      if (row.fingerprint) {
        index.byFingerprint[row.fingerprint] = row;
      }

      var compositeKey = buildCompositeKey_(row.date, row.amount, row.description);
      if (!index.byComposite[compositeKey]) {
        index.byComposite[compositeKey] = [];
      }
      index.byComposite[compositeKey].push(row);

      var amountKey = buildAmountDateKey_(row.date, row.amount);
      if (!index.byAmountDate[amountKey]) {
        index.byAmountDate[amountKey] = [];
      }
      index.byAmountDate[amountKey].push(row);
    }

    return index;
  }

  function overwriteMatches_(sheet, statementId, matches) {
    if (!sheet || !matches || !matches.length) {
      purgeStatementRows_(sheet, statementId);
      return;
    }

    purgeStatementRows_(sheet, statementId);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 7).getValues()[0];
    var headerMap = buildHeaderMap_(headers);
    var rows = [];
    var timestamp = new Date().toISOString();

    for (var i = 0; i < matches.length; i++) {
      var rowValues = new Array(headers.length);
      setValue_(rowValues, headerMap, 'statementId', statementId);
      setValue_(rowValues, headerMap, 'ledgerId', matches[i].ledgerId);
      setValue_(rowValues, headerMap, 'statementReference', matches[i].statementReference);
      setValue_(rowValues, headerMap, 'matchType', matches[i].matchType);
      setValue_(rowValues, headerMap, 'amount', matches[i].amount);
      setValue_(rowValues, headerMap, 'transactionDate', matches[i].transactionDate);
      setValue_(rowValues, headerMap, 'matchedAt', timestamp);
      rows.push(rowValues);
    }

    writeRows_(sheet, rows);
  }

  function overwriteExceptions_(sheet, statementId, account, unmatchedStatements, unmatchedLedger) {
    if (!sheet) {
      return;
    }

    purgeStatementRows_(sheet, statementId);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 9).getValues()[0];
    var headerMap = buildHeaderMap_(headers);
    var rows = [];
    var timestamp = new Date().toISOString();

    for (var i = 0; i < unmatchedStatements.length; i++) {
      var stmt = unmatchedStatements[i];
      var rowValues = new Array(headers.length);
      setValue_(rowValues, headerMap, 'statementId', statementId);
      setValue_(rowValues, headerMap, 'account', account);
      setValue_(rowValues, headerMap, 'transactionDate', stmt.transactionDate);
      setValue_(rowValues, headerMap, 'description', stmt.description);
      setValue_(rowValues, headerMap, 'amount', stmt.amount);
      setValue_(rowValues, headerMap, 'ledgerId', '');
      setValue_(rowValues, headerMap, 'type', 'MISSING_LEDGER');
      var notes = 'No ledger match found';
      if (stmt.reference) {
        notes += ' (ref: ' + stmt.reference + ')';
      }
      setValue_(rowValues, headerMap, 'notes', notes);
      setValue_(rowValues, headerMap, 'createdAt', timestamp);
      rows.push(rowValues);
    }

    for (var j = 0; j < unmatchedLedger.length; j++) {
      var led = unmatchedLedger[j];
      var ledgerRowValues = new Array(headers.length);
      setValue_(ledgerRowValues, headerMap, 'statementId', statementId);
      setValue_(ledgerRowValues, headerMap, 'account', account);
      setValue_(ledgerRowValues, headerMap, 'transactionDate', led.transactionDate);
      setValue_(ledgerRowValues, headerMap, 'description', led.description);
      setValue_(ledgerRowValues, headerMap, 'amount', led.amount);
      setValue_(ledgerRowValues, headerMap, 'ledgerId', led.ledgerId || 'row:' + led.rowNumber);
      setValue_(ledgerRowValues, headerMap, 'type', 'UNEXPECTED_LEDGER');
      setValue_(ledgerRowValues, headerMap, 'notes', 'Ledger transaction missing from statement');
      setValue_(ledgerRowValues, headerMap, 'createdAt', timestamp);
      rows.push(ledgerRowValues);
    }

    if (rows.length) {
      writeRows_(sheet, rows);
    }
  }

  function recordStatementRow_(sheet, statementId, account, periodStart, periodEnd, checksum, status) {
    if (!sheet) {
      return;
    }

    var lastColumn = sheet.getLastColumn() || 7;
    var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var headerMap = buildHeaderMap_(headers);
    var rowValues = new Array(headers.length);

    setValue_(rowValues, headerMap, 'statementId', statementId);
    setValue_(rowValues, headerMap, 'account', account);
    setValue_(rowValues, headerMap, 'periodStart', periodStart ? formatDateString_(periodStart) : '');
    setValue_(rowValues, headerMap, 'periodEnd', periodEnd ? formatDateString_(periodEnd) : '');
    setValue_(rowValues, headerMap, 'checksum', checksum);
    setValue_(rowValues, headerMap, 'status', status);
    setValue_(rowValues, headerMap, 'importedAt', new Date().toISOString());

    var existingRow = findRowById_(sheet, headerMap.statementId, statementId);
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, headers.length).setValues([rowValues]);
    } else {
      writeRows_(sheet, [rowValues]);
    }
  }

  function ensureSheet_(ss, name, headers) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    if (headers && headers.length) {
      var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
      if (!arraysEqual_(existing, headers)) {
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      }
    }
    return sheet;
  }

  function writeRows_(sheet, rows) {
    if (!rows.length) {
      return;
    }
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
  }

  function findRowById_(sheet, columnIndex, value) {
    if (columnIndex === undefined) {
      return null;
    }
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return null;
    }
    var range = sheet.getRange(2, columnIndex + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < range.length; i++) {
      if ((range[i][0] || '').toString() === value) {
        return i + 2;
      }
    }
    return null;
  }

  function purgeStatementRows_(sheet, statementId) {
    if (!sheet) {
      return;
    }
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return;
    }
    var idValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = idValues.length - 1; i >= 0; i--) {
      if ((idValues[i][0] || '').toString() === statementId) {
        sheet.deleteRow(i + 2);
      }
    }
  }

  function setValue_(rowValues, headerMap, key, value) {
    if (headerMap[key] === undefined) {
      return;
    }
    rowValues[headerMap[key]] = value;
  }

  function buildHeaderMap_(headers) {
    var map = {};
    for (var i = 0; i < headers.length; i++) {
      var header = (headers[i] || '').toString();
      if (!header) {
        continue;
      }
      map[header] = i;
    }
    return map;
  }

  function arraysEqual_(a, b) {
    if (!a || !b) {
      return false;
    }
    if (a.length !== b.length) {
      return false;
    }
    for (var i = 0; i < a.length; i++) {
      if ((a[i] || '') !== (b[i] || '')) {
        return false;
      }
    }
    return true;
  }

  function normalizeDateInput_(value) {
    if (!value) {
      return null;
    }
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return new Date(value.getTime());
    }
    var date = new Date(value);
    if (isNaN(date.getTime())) {
      return null;
    }
    return date;
  }

  function formatDateString_(value) {
    if (!value) {
      return '';
    }
    var date = value;
    if (Object.prototype.toString.call(value) !== '[object Date]') {
      date = new Date(value);
    }
    if (isNaN(date.getTime())) {
      return '';
    }
    return date.getFullYear() + '-' + pad_(date.getMonth() + 1) + '-' + pad_(date.getDate());
  }

  function pad_(value) {
    return value < 10 ? '0' + value : '' + value;
  }

  function roundAmount_(value) {
    if (!value) {
      return 0;
    }
    return Math.round(value * 100) / 100;
  }

  function buildCompositeKey_(date, amount, description) {
    return [formatDateString_(date), amountKey_(amount), normalizeText_(description).slice(0, 32)].join('|');
  }

  function buildAmountDateKey_(date, amount) {
    return [formatDateString_(date), amountKey_(amount)].join('|');
  }

  function amountKey_(amount) {
    var normalized = roundAmount_(typeof amount === 'number' ? amount : parseFloat(amount || 0));
    return normalized.toFixed(2);
  }

  function normalizeText_(text) {
    if (!text) {
      return '';
    }
    return text.toString().trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function createChecksum_(transactions) {
    if (!transactions || !transactions.length) {
      return '0:0:0';
    }
    var aggregate = [];
    var total = 0;
    for (var i = 0; i < transactions.length; i++) {
      var txn = transactions[i];
      total += txn.amount;
      aggregate.push([
        formatDateString_(txn.date),
        amountKey_(txn.amount),
        normalizeText_(txn.description),
        txn.fingerprint || '',
        txn.reference || ''
      ].join('|'));
    }
    var payload = aggregate.join('~');
    return transactions.length + ':' + amountKey_(total) + ':' + computeHash_(payload);
  }

  function computeHash_(payload) {
    if (!payload) {
      return '0';
    }
    try {
      if (typeof Utilities !== 'undefined' && Utilities.computeDigest && Utilities.base64Encode) {
        var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, payload);
        return Utilities.base64Encode(digest).slice(0, 16);
      }
    } catch (err) {
      // ignore and fall back
    }
    var hash = 0;
    for (var i = 0; i < payload.length; i++) {
      hash = (hash << 5) - hash + payload.charCodeAt(i);
      hash |= 0;
    }
    return (hash >>> 0).toString(16);
  }

  function generateStatementId_(account, periodStart, periodEnd, checksum) {
    var base = (account || 'STATEMENT').replace(/[^A-Z0-9]+/gi, '').toUpperCase();
    var startPart = formatDateString_(periodStart) || 'NA';
    var endPart = formatDateString_(periodEnd) || 'NA';
    var seed = base + '|' + startPart + '|' + endPart + '|' + (checksum || '');
    return base + '-' + startPart + '-' + endPart + '-' + computeHash_(seed).slice(0, 6);
  }

  return {
    reconcileStatement: reconcileStatement,
    healthProbe: healthProbe
  };
})();
