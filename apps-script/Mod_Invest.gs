/**
 * Investment portfolio management module.
 */
var Mod_Invest = (function () {
  'use strict';

  function refreshPortfolio(options) {
    options = options || {};
    var dryRun = options.dryRun === true;

    Logs.logEvent('INFO', 'Mod_Invest', 'Portfolio refresh invoked', {
      dryRun: dryRun,
      source: options.source || 'manual'
    });

    var config = Mod_Config.load();
    var baseCurrency = config.baseCurrency || 'USD';
    var targetAllocations = loadTargetAllocations_(config);
    var transactions = loadInvestmentTransactions_(config, options);
    var fxRates = loadFxRates_(config);

    var portfolio = InvestLib.buildPortfolio(transactions, fxRates, baseCurrency, targetAllocations);

    if (!dryRun) {
      persistHoldings_(portfolio.holdings, config);
      persistAllocations_(portfolio.allocations, config);
      appendNetWorthSnapshot_(portfolio.netWorthSnapshot, config);
    }

    return {
      status: 'OK',
      dryRun: dryRun,
      holdings: portfolio.holdings.length,
      allocations: portfolio.allocations.length,
      totals: portfolio.totals,
      netWorthSnapshot: portfolio.netWorthSnapshot
    };
  }

  function snapshot() {
    var config = Mod_Config.load();
    var sheet = getHoldingsSheet_(config);
    if (!sheet) {
      return { holdings: [], totals: { netWorth: 0, invested: 0, liquid: 0 } };
    }

    var values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      return { holdings: [], totals: { netWorth: 0, invested: 0, liquid: 0 } };
    }

    var headers = values[0];
    var map = buildHeaderMap_(headers);
    var holdings = [];
    var totals = { netWorth: 0, invested: 0, liquid: 0 };

    values.slice(1).forEach(function (row) {
      if (!row || !row.length) {
        return;
      }
      var valueBase = parseFloat(row[map.valueBase] || 0);
      if (isNaN(valueBase) || valueBase === 0) {
        return;
      }
      var holding = {
        holdingId: row[map.holdingId],
        account: row[map.account],
        symbol: row[map.symbol],
        assetClass: row[map.assetClass],
        quantity: parseFloat(row[map.quantity] || 0),
        valueBase: valueBase,
        currency: row[map.currency]
      };
      holdings.push(holding);
      totals.netWorth += valueBase;
      if ((holding.assetClass || '').toString().toLowerCase() === 'cash') {
        totals.liquid += valueBase;
      } else {
        totals.invested += valueBase;
      }
    });

    totals.netWorth = Math.round((totals.netWorth + Number.EPSILON) * 100) / 100;
    totals.invested = Math.round((totals.invested + Number.EPSILON) * 100) / 100;
    totals.liquid = Math.round((totals.liquid + Number.EPSILON) * 100) / 100;

    return {
      holdings: holdings,
      totals: totals
    };
  }

  function healthProbe() {
    try {
      var config = Mod_Config.load();
      var holdingsSheet = getHoldingsSheet_(config);
      if (!holdingsSheet) {
        return { ok: false, reason: 'Holdings sheet missing' };
      }
      var headers = holdingsSheet.getRange(1, 1, 1, holdingsSheet.getLastColumn()).getValues()[0];
      var required = ['holdingId', 'account', 'symbol', 'valueBase'];
      var missing = required.filter(function (header) {
        return headers.indexOf(header) === -1;
      });
      return {
        ok: missing.length === 0,
        missingHeaders: missing
      };
    } catch (err) {
      Logs.logEvent('ERROR', 'Mod_Invest', 'Health probe failed', { error: err.message });
      return { ok: false, error: err.message };
    }
  }

  function loadInvestmentTransactions_(config, options) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return [];
    }

    var sheetName = config.transactionsSheet || 'Transactions';
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      Logs.logEvent('WARN', 'Mod_Invest', 'Transactions sheet missing', { sheet: sheetName });
      return [];
    }

    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn === 0) {
      return [];
    }

    var values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
    var headers = values[0];
    var headerMap = buildHeaderMap_(headers);
    var rows = [];
    var cutoff = options.since ? new Date(options.since) : null;

    values.slice(1).forEach(function (row) {
      if (!row || !row.length) {
        return;
      }
      if (!isInvestmentRow_(row, headerMap)) {
        return;
      }
      var dateValue = headerMap.date !== undefined ? row[headerMap.date] : null;
      if (cutoff && dateValue) {
        var dateObj = new Date(dateValue);
        if (dateObj < cutoff) {
          return;
        }
      }

      rows.push({
        account: headerMap.account !== undefined ? (row[headerMap.account] || '').toString() : 'Unknown',
        symbol: deriveSymbol_(row, headerMap),
        assetClass: deriveAssetClass_(row, headerMap),
        currency: headerMap.currency !== undefined ? (row[headerMap.currency] || config.baseCurrency || 'USD').toString() : (config.baseCurrency || 'USD'),
        valueDelta: parseFloat(row[headerMap.amount] || 0),
        quantityDelta: headerMap.quantity !== undefined ? parseFloat(row[headerMap.quantity] || 0) : 0,
        isLiquid: isLiquidRow_(row, headerMap)
      });
    });

    return rows;
  }

  function loadFxRates_(config) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return [];
    }
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('FXRates');
    if (!sheet) {
      return [];
    }
    var values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      return [];
    }
    var headers = values[0];
    var map = buildHeaderMap_(headers);
    var rates = [];
    values.slice(1).forEach(function (row) {
      if (!row || !row.length) {
        return;
      }
      rates.push({
        baseCurrency: map.baseCurrency !== undefined ? row[map.baseCurrency] : config.baseCurrency || 'USD',
        counterCurrency: map.counterCurrency !== undefined ? row[map.counterCurrency] : null,
        rate: map.rate !== undefined ? row[map.rate] : null
      });
    });
    return rates;
  }

  function persistHoldings_(holdings, config) {
    var sheet = getHoldingsSheet_(config);
    if (!sheet) {
      Logs.logEvent('WARN', 'Mod_Invest', 'Holdings sheet missing, skipping persistence');
      return;
    }

    var headers = ['holdingId', 'account', 'symbol', 'assetClass', 'quantity', 'valueBase', 'currency', 'lastUpdated'];
    var rows = [headers];
    holdings.forEach(function (holding) {
      rows.push([
        holding.holdingId,
        holding.account,
        holding.symbol,
        holding.assetClass,
        holding.quantity,
        holding.valueBase,
        holding.currency,
        holding.lastUpdated
      ]);
    });

    sheet.clearContents();
    sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
  }

  function persistAllocations_(allocations, config) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return;
    }
    var sheetName = config.holdingsAllocationsSheet || 'Holdings_Allocations';
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      Logs.logEvent('WARN', 'Mod_Invest', 'Allocations sheet missing', { sheet: sheetName });
      return;
    }

    var headers = ['class', 'targetPercent', 'actualPercent', 'deviationPercent', 'valueBase', 'updatedAt'];
    var now = new Date().toISOString();
    var rows = [headers];
    allocations.forEach(function (allocation) {
      rows.push([
        allocation.class,
        allocation.targetPercent,
        allocation.actualPercent,
        allocation.deviationPercent,
        allocation.valueBase,
        now
      ]);
    });

    sheet.clearContents();
    sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
  }

  function appendNetWorthSnapshot_(snapshot, config) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return;
    }

    var sheetName = config.netWorthHistorySheet || 'NetWorth_History';
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      Logs.logEvent('WARN', 'Mod_Invest', 'Net worth history sheet missing', { sheet: sheetName });
      return;
    }

    var headers = ['snapshotAt', 'netWorth', 'currency', 'liquid', 'invested', 'debts'];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
    }
    sheet.appendRow([
      snapshot.snapshotAt,
      snapshot.netWorth,
      snapshot.currency,
      snapshot.liquid,
      snapshot.invested,
      snapshot.debts
    ]);
  }

  function loadTargetAllocations_(config) {
    var raw = config.portfolioTargets || config.portfolioTargetsJson;
    if (!raw) {
      return [];
    }
    if (Array.isArray(raw)) {
      return raw;
    }
    if (typeof raw === 'string') {
      try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        Logs.logEvent('WARN', 'Mod_Invest', 'Failed to parse portfolio targets', { error: err.message });
      }
    }
    return [];
  }

  function isInvestmentRow_(row, headerMap) {
    var category = headerMap.categoryId !== undefined ? (row[headerMap.categoryId] || '').toString().toLowerCase() : '';
    var tags = headerMap.tags !== undefined ? (row[headerMap.tags] || '').toString().toLowerCase() : '';
    if (!category && !tags) {
      return false;
    }
    return category.indexOf('invest') !== -1 || tags.indexOf('invest') !== -1;
  }

  function deriveAssetClass_(row, headerMap) {
    var tags = headerMap.tags !== undefined ? (row[headerMap.tags] || '').toString().toLowerCase() : '';
    if (tags.indexOf('equity') !== -1) {
      return 'equity';
    }
    if (tags.indexOf('bond') !== -1) {
      return 'fixed_income';
    }
    if (tags.indexOf('cash') !== -1) {
      return 'cash';
    }
    var category = headerMap.categoryId !== undefined ? (row[headerMap.categoryId] || '').toString().toLowerCase() : '';
    if (category.indexOf('cash') !== -1) {
      return 'cash';
    }
    if (category.indexOf('retire') !== -1) {
      return 'retirement';
    }
    return 'unclassified';
  }

  function deriveSymbol_(row, headerMap) {
    if (headerMap.description !== undefined) {
      var description = (row[headerMap.description] || '').toString();
      if (description) {
        return description.split(' ')[0];
      }
    }
    if (headerMap.payeeId !== undefined) {
      var payee = (row[headerMap.payeeId] || '').toString();
      if (payee) {
        return payee;
      }
    }
    if (headerMap.account !== undefined) {
      return (row[headerMap.account] || '').toString();
    }
    return 'Instrument';
  }

  function isLiquidRow_(row, headerMap) {
    var tags = headerMap.tags !== undefined ? (row[headerMap.tags] || '').toString().toLowerCase() : '';
    return tags.indexOf('cash') !== -1 || tags.indexOf('liquid') !== -1;
  }

  function getHoldingsSheet_(config) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return null;
    }
    var sheetName = config.holdingsSheet || 'Holdings';
    return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  }

  function buildHeaderMap_(headers) {
    var map = {};
    headers.forEach(function (header, index) {
      if (!header) {
        return;
      }
      map[header] = index;
    });
    return map;
  }

  return {
    refreshPortfolio: refreshPortfolio,
    snapshot: snapshot,
    healthProbe: healthProbe
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Mod_Invest;
}
