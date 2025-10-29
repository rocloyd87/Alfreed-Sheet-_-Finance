/**
 * Schema module for Alfred 5.0
 * Responsible for verifying sheet structure, migrations, and fixtures.
 */
var Mod_Schema = (function () {
  'use strict';

  var CURRENT_VERSION = '0.4.0';
  var VERSION_PROPERTY_KEY = 'ALFRED_SCHEMA_VERSION';

  var TABLES = [
    {
      name: 'Transactions',
      headers: ['id', 'date', 'account', 'payeeId', 'description', 'amount', 'currency', 'categoryId', 'tags', 'isTransfer', 'splitGroupId', 'source', 'fingerprint', 'status', 'attachments', 'createdAt', 'updatedAt']
    },
    {
      name: 'Staging_Transactions',
      headers: ['stagingId', 'date', 'account', 'payee', 'description', 'amount', 'currency', 'categorySuggested', 'confidence', 'source', 'rawPayload', 'status', 'fingerprint', 'createdAt', 'updatedAt', 'importSessionId']
    },
    {
      name: 'Import_Sessions',
      headers: ['importSessionId', 'source', 'startedAt', 'completedAt', 'status', 'totalRecords', 'stagedRecords', 'skippedRecords', 'errorCount', 'notes']
    },
    {
      name: 'Accounts',
      headers: ['accountId', 'name', 'type', 'institution', 'currency', 'status', 'lastSyncAt']
    },
    {
      name: 'Categories',
      headers: ['categoryId', 'name', 'group', 'isIncome', 'status']
    },
    {
      name: 'Payees',
      headers: ['payeeId', 'name', 'normalizedName', 'defaultCategoryId', 'status']
    },
    {
      name: 'Tags',
      headers: ['tagId', 'name', 'description', 'status']
    },
    {
      name: 'Rules',
      headers: ['ruleId', 'priority', 'pattern', 'scope', 'action', 'confidence', 'createdAt', 'updatedAt']
    },
    {
      name: 'Statements',
      headers: ['statementId', 'account', 'periodStart', 'periodEnd', 'checksum', 'status', 'importedAt']
    },
    {
      name: 'Reconcile_Exceptions',
      headers: ['statementId', 'account', 'transactionDate', 'description', 'amount', 'ledgerId', 'type', 'notes', 'createdAt']
    },
    {
      name: 'Reconcile_Matches',
      headers: ['statementId', 'ledgerId', 'statementReference', 'matchType', 'amount', 'transactionDate', 'matchedAt']
    },
    {
      name: 'Debts',
      headers: ['debtId', 'name', 'balance', 'apr', 'minimumPayment', 'termMonths', 'extraPayment', 'notes', 'status']
    },
    {
      name: 'Debt_Strategy',
      headers: ['debtId', 'name', 'order', 'apr', 'minimumPayment', 'paidOffMonth', 'paidOffDate', 'totalPaid', 'totalInterest', 'remainingBalance', 'strategy']
    },
    {
      name: 'Debt_Amortization',
      headers: ['monthIndex', 'date', 'debtId', 'debtName', 'payment', 'principal', 'interest', 'remainingBalance', 'strategy']
    },
    {
      name: 'Config',
      headers: ['key', 'value']
    },
    {
      name: 'FXRates',
      headers: ['asOfDate', 'baseCurrency', 'counterCurrency', 'rate']
    },
    {
      name: 'Holdings',
      headers: ['holdingId', 'account', 'symbol', 'quantity', 'valueBase', 'currency', 'lastUpdated', 'source']
    },
    {
      name: 'Holdings_Allocations',
      headers: ['class', 'targetPercent', 'actualPercent', 'deviationPercent', 'valueBase', 'updatedAt']
    },
    {
      name: 'NetWorth_History',
      headers: ['snapshotAt', 'netWorth', 'currency', 'liquid', 'invested', 'debts']
    },
    {
      name: 'Security_Roles',
      headers: ['email', 'role', 'grantedAt', 'grantedBy', 'notes']
    },
    {
      name: 'Security_Access_Log',
      headers: ['timestamp', 'email', 'action', 'resource', 'result', 'notes']
    }
  ];

  /**
   * Verifies the schema and performs migrations when required.
   * @param {Object=} options - e.g., {dryRun: true, targetVersion: 'v1'}
   */
  function verifyAndMigrate(options) {
    options = options || {};
    var dryRun = options.dryRun === true;
    var operations = [];
    var ss;

    Logs.logEvent('INFO', 'Mod_Schema', 'Schema.verifyAndMigrate invoked', {
      dryRun: dryRun,
      targetVersion: options.targetVersion || CURRENT_VERSION
    });

    try {
      ss = getSpreadsheet_(options);
    } catch (err) {
      Logs.logEvent('ERROR', 'Mod_Schema', 'Unable to resolve spreadsheet', {
        error: err.message
      });
      throw err;
    }

    TABLES.forEach(function (table) {
      operations.push.apply(operations, ensureTable_(ss, table, dryRun));
    });

    var previousVersion = getCurrentVersion_();
    var propertiesResult = ensureVersionProperty_(dryRun, previousVersion);
    if (propertiesResult) {
      operations.push(propertiesResult);
    }

    var summary = {
      status: deriveStatus_(operations),
      targetVersion: options.targetVersion || CURRENT_VERSION,
      currentVersion: previousVersion,
      dryRun: dryRun,
      operations: operations
    };

    if (previousVersion !== CURRENT_VERSION) {
      summary.nextVersion = CURRENT_VERSION;
    }

    Logs.logEvent('INFO', 'Mod_Schema', 'Schema verification complete', {
      status: summary.status,
      dryRun: dryRun,
      operationsCount: operations.length
    });

    return summary;
  }

  function ensureTable_(ss, table, dryRun) {
    var operations = [];
    var sheet = ss.getSheetByName(table.name);

    if (!sheet) {
      operations.push(recordOperation_(table.name, 'CREATE_SHEET', dryRun ? 'PENDING' : 'EXECUTED'));
      if (dryRun) {
        return operations;
      }
      try {
        sheet = ss.insertSheet(table.name);
      } catch (insertErr) {
        operations.push(recordOperation_(table.name, 'CREATE_SHEET_FAILED', 'ERROR', {
          error: insertErr.message
        }));
        return operations;
      }
    }

    var headers = table.headers;
    var maxColumns = sheet.getMaxColumns();
    if (maxColumns < headers.length) {
      operations.push(recordOperation_(table.name, 'EXPAND_COLUMNS', dryRun ? 'PENDING' : 'EXECUTED', {
        from: maxColumns,
        to: headers.length
      }));
      if (!dryRun) {
        sheet.insertColumnsAfter(maxColumns, headers.length - maxColumns);
      }
    }

    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    var existing = headerRange.getValues()[0];
    var needsUpdate = !arraysEqual_(existing, headers);

    if (needsUpdate) {
      operations.push(recordOperation_(table.name, 'SET_HEADERS', dryRun ? 'PENDING' : 'EXECUTED', {
        expected: headers,
        existing: existing
      }));
      if (!dryRun) {
        headerRange.setValues([headers]);
      }
    } else {
      operations.push(recordOperation_(table.name, 'SET_HEADERS', 'NO_CHANGE'));
    }

    return operations;
  }

  function ensureVersionProperty_(dryRun, previous) {
    if (typeof PropertiesService === 'undefined') {
      return null;
    }

    var properties = PropertiesService.getScriptProperties();

    if (previous === CURRENT_VERSION) {
      return recordOperation_('SchemaVersion', 'SET_VERSION_PROPERTY', 'NO_CHANGE', {
        version: CURRENT_VERSION
      });
    }

    if (!dryRun) {
      properties.setProperty(VERSION_PROPERTY_KEY, CURRENT_VERSION);
    }

    return recordOperation_('SchemaVersion', 'SET_VERSION_PROPERTY', dryRun ? 'PENDING' : 'EXECUTED', {
      previousVersion: previous,
      nextVersion: CURRENT_VERSION
    });
  }

  function getCurrentVersion_() {
    if (typeof PropertiesService === 'undefined') {
      return null;
    }
    return PropertiesService.getScriptProperties().getProperty(VERSION_PROPERTY_KEY);
  }

  function recordOperation_(target, action, status, context) {
    var operation = {
      target: target,
      action: action,
      status: status
    };

    if (context) {
      operation.context = context;
    }

    return operation;
  }

  function arraysEqual_(a, b) {
    if (!a || !b) {
      return false;
    }

    if (a.length !== b.length) {
      return false;
    }

    for (var i = 0; i < a.length; i++) {
      if ((a[i] || '').toString().trim() !== (b[i] || '').toString().trim()) {
        return false;
      }
    }

    return true;
  }

  function deriveStatus_(operations) {
    var hasError = operations.some(function (op) {
      return op.status === 'ERROR';
    });
    if (hasError) {
      return 'ERROR';
    }

    var hasExecuted = operations.some(function (op) {
      return op.status === 'EXECUTED';
    });
    var hasPending = operations.some(function (op) {
      return op.status === 'PENDING';
    });

    if (hasExecuted) {
      return 'UPDATED';
    }
    if (hasPending) {
      return 'PENDING';
    }
    return 'UNCHANGED';
  }

  function getSpreadsheet_(options) {
    if (typeof SpreadsheetApp === 'undefined') {
      throw new Error('SpreadsheetApp is unavailable in the current runtime');
    }

    if (options && options.spreadsheetId && SpreadsheetApp.openById) {
      return SpreadsheetApp.openById(options.spreadsheetId);
    }

    if (SpreadsheetApp.getActiveSpreadsheet) {
      return SpreadsheetApp.getActiveSpreadsheet();
    }

    if (SpreadsheetApp.getActive) {
      return SpreadsheetApp.getActive();
    }

    throw new Error('Unable to resolve active spreadsheet');
  }

  return {
    verifyAndMigrate: verifyAndMigrate
  };
})();
