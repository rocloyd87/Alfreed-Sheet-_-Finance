/**
 * Categorization and rules engine module for Alfred 5.0.
 * Applies user-defined rules to staged transactions and prepares them for sync.
 */
var Mod_Categorize = (function () {
  'use strict';

  var DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
  var RULES_SHEET = 'Rules';
  var STAGING_SHEET = 'Staging_Transactions';
  var MATCH_STATUSES = ['STAGED', 'REVIEW'];

  /**
   * Applies rules to staged transactions.
   * @param {Object=} options - {dryRun:boolean, importSessionId:string, confidenceThreshold:number, statusFilter:Array<string>}
   * @return {Object} Summary of the categorization run.
   */
  function applyRules(options) {
    options = options || {};
    var dryRun = options.dryRun === true;
    var threshold = typeof options.confidenceThreshold === 'number'
      ? options.confidenceThreshold
      : DEFAULT_CONFIDENCE_THRESHOLD;
    var statusFilter = Array.isArray(options.statusFilter) && options.statusFilter.length
      ? options.statusFilter
      : MATCH_STATUSES;
    var sessionId = options.importSessionId || null;

    Logs.logEvent('INFO', 'Mod_Categorize', 'Categorization invoked', {
      dryRun: dryRun,
      threshold: threshold,
      statusFilter: statusFilter,
      importSessionId: sessionId
    });

    var rules = loadRules_(options.rulesSheet || RULES_SHEET);
    if (!rules.length) {
      Logs.logEvent('WARN', 'Mod_Categorize', 'No rules available; skipping categorization');
      return buildSummary_('NO_RULES', dryRun, [], []);
    }

    var staging = loadStagingTransactions_(options.stagingSheet || STAGING_SHEET, statusFilter, sessionId);
    if (!staging.length) {
      Logs.logEvent('INFO', 'Mod_Categorize', 'No staged transactions matched filter');
      return buildSummary_('NO_DATA', dryRun, [], []);
    }

    var updates = [];
    var held = [];
    var matches = [];

    staging.forEach(function (txn) {
      var evaluation = evaluateTransaction_(txn, rules, threshold);
      if (evaluation.matched) {
        matches.push({
          stagingId: txn.stagingId,
          ruleId: evaluation.rule.ruleId,
          categoryId: evaluation.categoryId,
          confidence: evaluation.appliedConfidence
        });
        updates.push({
          rowNumber: txn.rowNumber,
          categorySuggested: evaluation.categoryId,
          status: 'READY_SYNC',
          confidence: Math.max(txn.confidence || 0, evaluation.appliedConfidence)
        });
      } else {
        held.push({
          stagingId: txn.stagingId,
          reason: evaluation.reason,
          ruleId: evaluation.rule ? evaluation.rule.ruleId : null,
          confidence: evaluation.appliedConfidence
        });
        if (txn.status !== 'REVIEW') {
          updates.push({
            rowNumber: txn.rowNumber,
            status: 'REVIEW'
          });
        }
      }
    });

    if (!dryRun && updates.length) {
      persistUpdates_(options.stagingSheet || STAGING_SHEET, updates);
    }

    if (Mod_Metrics && Mod_Metrics.record) {
      Mod_Metrics.record('categorize.matched', matches.length, { dryRun: dryRun ? '1' : '0' });
      Mod_Metrics.record('categorize.held', held.length, { dryRun: dryRun ? '1' : '0' });
    }

    Logs.logEvent('INFO', 'Mod_Categorize', 'Categorization completed', {
      evaluated: staging.length,
      matched: matches.length,
      held: held.length,
      dryRun: dryRun
    });

    return buildSummary_('OK', dryRun, matches, held, staging.length);
  }

  function loadRules_(sheetName) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      throw new Error('SpreadsheetApp unavailable - cannot load rules');
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      Logs.logEvent('WARN', 'Mod_Categorize', 'Rules sheet missing', { sheet: sheetName });
      return [];
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return [];
    }

    var lastColumn = sheet.getLastColumn();
    var data = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
    var headers = data[0];
    var headerMap = headers.reduce(function (map, header, index) {
      map[(header || '').toString()] = index;
      return map;
    }, {});

    var rules = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row || !row.length) {
        continue;
      }
      var rule = normalizeRule_(row, headerMap);
      if (rule) {
        rules.push(rule);
      }
    }

    rules.sort(function (a, b) {
      return a.priority - b.priority;
    });

    return rules;
  }

  function normalizeRule_(row, headerMap) {
    var ruleId = getCell_(row, headerMap, 'ruleId') || ('rule_' + (row[0] || '').toString());
    var pattern = getCell_(row, headerMap, 'pattern');
    var scope = (getCell_(row, headerMap, 'scope') || 'description').toString().toLowerCase();
    var actionRaw = getCell_(row, headerMap, 'action');
    var priority = parsePriority_(getCell_(row, headerMap, 'priority'));
    var confidence = parseConfidence_(getCell_(row, headerMap, 'confidence'));

    if (!pattern || !actionRaw) {
      return null;
    }

    return {
      ruleId: ruleId,
      priority: priority,
      scope: scope,
      pattern: pattern,
      parsedPattern: parsePattern_(pattern, scope),
      action: parseAction_(actionRaw),
      confidence: confidence
    };
  }

  function loadStagingTransactions_(sheetName, statuses, sessionId) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      throw new Error('SpreadsheetApp unavailable - cannot load staging transactions');
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      throw new Error('Staging sheet not found: ' + sheetName);
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return [];
    }

    var lastColumn = sheet.getLastColumn();
    var range = sheet.getRange(1, 1, lastRow, lastColumn);
    var values = range.getValues();
    var headers = values[0];
    var headerMap = headers.reduce(function (map, header, index) {
      map[(header || '').toString()] = index;
      return map;
    }, {});

    var statusIdx = headerMap.status;
    var sessionIdx = headerMap.importSessionId;

    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (!row || !row.length) {
        continue;
      }
      var status = (row[statusIdx] || '').toString();
      if (statuses && statuses.length && statuses.indexOf(status) === -1) {
        continue;
      }
      if (sessionId && sessionIdx !== undefined) {
        var rowSession = row[sessionIdx] ? row[sessionIdx].toString() : '';
        if (rowSession !== sessionId) {
          continue;
        }
      }
      rows.push(mapStagingRow_(row, headerMap, i + 1));
    }

    return rows;
  }

  function mapStagingRow_(row, headerMap, rowNumber) {
    return {
      rowNumber: rowNumber,
      stagingId: getCell_(row, headerMap, 'stagingId'),
      date: getCell_(row, headerMap, 'date'),
      account: getCell_(row, headerMap, 'account'),
      payee: getCell_(row, headerMap, 'payee'),
      description: getCell_(row, headerMap, 'description'),
      amount: parseFloat(getCell_(row, headerMap, 'amount')),
      currency: getCell_(row, headerMap, 'currency'),
      categorySuggested: getCell_(row, headerMap, 'categorySuggested'),
      confidence: parseFloat(getCell_(row, headerMap, 'confidence') || 0),
      source: getCell_(row, headerMap, 'source'),
      rawPayload: getCell_(row, headerMap, 'rawPayload'),
      status: getCell_(row, headerMap, 'status'),
      fingerprint: getCell_(row, headerMap, 'fingerprint'),
      createdAt: getCell_(row, headerMap, 'createdAt'),
      updatedAt: getCell_(row, headerMap, 'updatedAt'),
      importSessionId: getCell_(row, headerMap, 'importSessionId')
    };
  }

  function evaluateTransaction_(txn, rules, threshold) {
    var bestLowConfidence = null;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (matchesRule_(rule, txn)) {
        var appliedConfidence = rule.confidence;
        if (appliedConfidence >= threshold) {
          return {
            matched: true,
            appliedConfidence: appliedConfidence,
            categoryId: rule.action.categoryId || rule.action.category || '',
            rule: rule
          };
        }
        if (!bestLowConfidence || appliedConfidence > bestLowConfidence.appliedConfidence) {
          bestLowConfidence = {
            matched: false,
            appliedConfidence: appliedConfidence,
            rule: rule,
            categoryId: rule.action.categoryId || rule.action.category || ''
          };
        }
      }
    }

    if (bestLowConfidence) {
      bestLowConfidence.reason = 'LOW_CONFIDENCE';
      return bestLowConfidence;
    }

    return {
      matched: false,
      reason: 'NO_RULE_MATCH'
    };
  }

  function matchesRule_(rule, txn) {
    if (!rule || !txn) {
      return false;
    }

    var fieldValue = getFieldValueForScope_(txn, rule.scope);
    if (fieldValue === null || typeof fieldValue === 'undefined') {
      return false;
    }

    var pattern = rule.parsedPattern;
    var value = fieldValue.toString();

    switch (pattern.type) {
      case 'regex':
        return pattern.regex.test(value);
      case 'contains':
        return value.toLowerCase().indexOf(pattern.value) !== -1;
      case 'startsWith':
        return value.toLowerCase().indexOf(pattern.value) === 0;
      case 'endsWith':
        return value.toLowerCase().slice(-pattern.value.length) === pattern.value;
      case 'equals':
        return value.toLowerCase() === pattern.value;
      case 'amountRange':
        var numeric = parseFloat(txn.amount || 0);
        if (isNaN(numeric)) {
          return false;
        }
        if (pattern.min !== null && numeric < pattern.min) {
          return false;
        }
        if (pattern.max !== null && numeric > pattern.max) {
          return false;
        }
        return true;
      case 'amountEquals':
        var amt = parseFloat(txn.amount || 0);
        if (isNaN(amt)) {
          return false;
        }
        return amt === pattern.value;
      default:
        return false;
    }
  }

  function getFieldValueForScope_(txn, scope) {
    switch (scope) {
      case 'payee':
        return txn.payee;
      case 'description':
      case 'memo':
        return txn.description || '';
      case 'account':
        return txn.account || '';
      case 'source':
        return txn.source || '';
      case 'raw':
        return txn.rawPayload || '';
      case 'currency':
        return txn.currency || '';
      case 'amount':
        return txn.amount;
      default:
        return txn.description || txn.payee || '';
    }
  }

  function persistUpdates_(sheetName, updates) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      throw new Error('Staging sheet not found: ' + sheetName);
    }

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 16).getValues()[0];
    var headerMap = headers.reduce(function (map, header, index) {
      map[(header || '').toString()] = index + 1; // 1-based columns
      return map;
    }, {});

    var now = new Date().toISOString();

    Mod_Utils.chunkedProcess(updates, 20, function (chunk) {
      chunk.forEach(function (update) {
        if (update.categorySuggested !== undefined && headerMap.categorySuggested) {
          sheet.getRange(update.rowNumber, headerMap.categorySuggested).setValue(update.categorySuggested);
        }
        if (update.confidence !== undefined && headerMap.confidence) {
          sheet.getRange(update.rowNumber, headerMap.confidence).setValue(update.confidence);
        }
        if (update.status && headerMap.status) {
          sheet.getRange(update.rowNumber, headerMap.status).setValue(update.status);
        }
        if (headerMap.updatedAt) {
          sheet.getRange(update.rowNumber, headerMap.updatedAt).setValue(now);
        }
      });
    }, {
      sleepMs: 50
    });
  }

  function parsePriority_(value) {
    var priority = parseInt(value, 10);
    if (isNaN(priority)) {
      return 1000;
    }
    return priority;
  }

  function parseConfidence_(value) {
    var num = parseFloat(value);
    if (isNaN(num)) {
      return DEFAULT_CONFIDENCE_THRESHOLD;
    }
    return Math.max(0, Math.min(1, num));
  }

  function parsePattern_(pattern, scope) {
    var raw = (pattern || '').toString();
    if (!raw) {
      return { type: 'contains', value: '' };
    }

    var lower = raw.toLowerCase();
    if (lower.indexOf('regex:') === 0) {
      var body = raw.slice(6);
      var regex;
      try {
        regex = new RegExp(body, 'i');
      } catch (err) {
        Logs.logEvent('WARN', 'Mod_Categorize', 'Invalid regex pattern', {
          pattern: raw,
          error: err.message
        });
        regex = new RegExp('^$');
      }
      return { type: 'regex', regex: regex };
    }
    if (lower.indexOf('contains:') === 0) {
      return { type: 'contains', value: raw.slice(9).toLowerCase() };
    }
    if (lower.indexOf('starts:') === 0 || lower.indexOf('startswith:') === 0) {
      var value = lower.indexOf('starts:') === 0 ? raw.slice(7) : raw.slice(11);
      return { type: 'startsWith', value: value.toLowerCase() };
    }
    if (lower.indexOf('ends:') === 0 || lower.indexOf('endswith:') === 0) {
      var endsValue = lower.indexOf('ends:') === 0 ? raw.slice(5) : raw.slice(9);
      return { type: 'endsWith', value: endsValue.toLowerCase() };
    }
    if (lower.indexOf('exact:') === 0 || lower.indexOf('equals:') === 0) {
      var exactValue = lower.indexOf('exact:') === 0 ? raw.slice(6) : raw.slice(7);
      return { type: 'equals', value: exactValue.toLowerCase() };
    }

    if (scope === 'amount') {
      var rangeMatch = raw.match(/range:\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/i);
      if (rangeMatch) {
        return {
          type: 'amountRange',
          min: parseFloat(rangeMatch[1]),
          max: parseFloat(rangeMatch[2])
        };
      }
      var geMatch = raw.match(/min:\s*(-?\d+(?:\.\d+)?)/i);
      var leMatch = raw.match(/max:\s*(-?\d+(?:\.\d+)?)/i);
      if (geMatch || leMatch) {
        return {
          type: 'amountRange',
          min: geMatch ? parseFloat(geMatch[1]) : null,
          max: leMatch ? parseFloat(leMatch[1]) : null
        };
      }
      var exactAmount = parseFloat(raw);
      if (!isNaN(exactAmount)) {
        return { type: 'amountEquals', value: exactAmount };
      }
    }

    return { type: 'contains', value: raw.toLowerCase() };
  }

  function parseAction_(value) {
    if (typeof value === 'string') {
      var trimmed = value.trim();
      if (!trimmed) {
        return {};
      }
      if (trimmed.charAt(0) === '{') {
        try {
          var parsed = JSON.parse(trimmed);
          return normalizeActionObject_(parsed);
        } catch (err) {
          Logs.logEvent('WARN', 'Mod_Categorize', 'Failed to parse JSON action', {
            action: trimmed,
            error: err.message
          });
        }
      }
      return { categoryId: trimmed };
    }
    if (typeof value === 'object' && value !== null) {
      return normalizeActionObject_(value);
    }
    return {};
  }

  function normalizeActionObject_(action) {
    var normalized = {};
    if (action.categoryId || action.category) {
      normalized.categoryId = (action.categoryId || action.category).toString();
    }
    if (action.tags) {
      normalized.tags = Array.isArray(action.tags) ? action.tags : action.tags.toString().split(',');
    }
    if (action.payeeId) {
      normalized.payeeId = action.payeeId.toString();
    }
    if (action.memo) {
      normalized.memo = action.memo.toString();
    }
    return normalized;
  }

  function buildSummary_(status, dryRun, matches, held, evaluated) {
    return {
      status: status,
      dryRun: dryRun,
      evaluated: evaluated || (matches.length + held.length),
      matches: matches,
      held: held
    };
  }

  function getCell_(row, headerMap, key) {
    var index = headerMap[key];
    if (index === undefined) {
      return '';
    }
    return row[index];
  }

  return {
    applyRules: applyRules
  };
})();
