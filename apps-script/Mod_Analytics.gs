/**
 * Analytics module providing FIRE and cash flow metrics.
 */
var Mod_Analytics = (function () {
  'use strict';

  var DEFAULT_TRANSACTIONS_SHEET = 'Transactions';

  /**
   * Computes aggregate analytics for the requested period.
   *
   * @param {Object=} options Analytics options.
   * @param {number=} options.periodDays Number of days to include (default 30).
   * @param {number=} options.cashOnHand Override cash on hand for runway calculations.
   * @param {boolean=} options.dryRun Skip recording metrics when true.
   * @return {Object} Analytics summary.
   */
  function computeMetrics(options) {
    options = options || {};
    var periodDays = typeof options.periodDays === 'number' && options.periodDays > 0 ? Math.floor(options.periodDays) : 30;
    var dryRun = options.dryRun === true;

    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      throw new Error('SpreadsheetApp unavailable - cannot compute analytics');
    }

    var now = new Date();
    var since = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

    var config = Mod_Config.load();
    var cashOnHand = resolveCashOnHand_(options, config);
    var baseCurrency = config.baseCurrency || 'USD';

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var transactionsSheetName = config.transactionsSheet || DEFAULT_TRANSACTIONS_SHEET;
    var sheet = ss.getSheetByName(transactionsSheetName);
    if (!sheet) {
      throw new Error('Transactions sheet not found: ' + transactionsSheetName);
    }

    var ledgerData = loadLedgerData_(sheet, since, now);
    var summary = buildAnalytics_(ledgerData.rows, since, now, cashOnHand, baseCurrency);

    if (options.includePortfolio !== false) {
      summary.portfolio = getPortfolioSnapshot_(options);
    }

    if (options.includeDebtForecast) {
      summary.debtForecast = forecastDebtFree({
        dryRun: true,
        strategy: options.debtStrategy,
        extraPayment: options.debtExtraPayment
      });
    }

    if (!dryRun && Mod_Metrics && Mod_Metrics.record) {
      Mod_Metrics.record('analytics.expense.daily', summary.metrics.averageDailyExpense || 0, { currency: baseCurrency });
      Mod_Metrics.record('analytics.runway.days', summary.metrics.runwayDays || 0, { currency: baseCurrency });
    }

    Logs.logEvent('INFO', 'Mod_Analytics', 'Analytics computed', {
      periodDays: periodDays,
      sampleSize: ledgerData.rows.length,
      expenseTotal: summary.totals.expense,
      incomeTotal: summary.totals.income
    });

    return summary;
  }

  /**
   * Probe used by health checks to ensure analytics can run without mutating state.
   * @return {Object}
   */
  function healthProbe() {
    try {
      var summary = computeMetrics({ periodDays: 7, dryRun: true });
      return {
        ok: true,
        sampleSize: summary.sampleSize,
        averageDailyExpense: summary.metrics.averageDailyExpense
      };
    } catch (err) {
      Logs.logEvent('WARN', 'Mod_Analytics', 'Health probe failed', { error: err.message });
      return {
        ok: false,
        error: err.message
      };
    }
  }

  function forecastDebtFree(options) {
    options = options || {};
    if (typeof Mod_Debt === 'undefined' || typeof Mod_Debt.planPayoff !== 'function') {
      return { status: 'UNAVAILABLE', message: 'Debt module unavailable' };
    }

    var payload = {
      dryRun: true,
      strategy: options.strategy || 'snowball',
      extraPayment: options.extraPayment || 0,
      startDate: options.startDate
    };

    var result = Mod_Debt.planPayoff(payload);
    return {
      status: result.status,
      summary: result.summary,
      strategy: result.strategy,
      warning: result.warning || null
    };
  }

  function exportForDashboard(options) {
    options = options || {};
    var analytics = computeMetrics({
      periodDays: options.periodDays || 30,
      dryRun: true,
      includePortfolio: true,
      includeDebtForecast: true,
      debtStrategy: options.debtStrategy,
      debtExtraPayment: options.debtExtraPayment
    });

    var payload = {
      generatedAt: new Date().toISOString(),
      analytics: analytics,
      portfolio: analytics.portfolio,
      debtForecast: analytics.debtForecast
    };

    if (options.asJson === false) {
      return payload;
    }
    return JSON.stringify(payload);
  }

  function getPortfolioSnapshot_(options) {
    try {
      if (typeof Mod_Invest === 'undefined') {
        return { status: 'UNAVAILABLE' };
      }
      if (options.refreshPortfolio) {
        return Mod_Invest.refreshPortfolio({ dryRun: true });
      }
      return Mod_Invest.snapshot();
    } catch (err) {
      Logs.logEvent('WARN', 'Mod_Analytics', 'Portfolio snapshot failed', { error: err.message });
      return { status: 'ERROR', error: err.message };
    }
  }

  function resolveCashOnHand_(options, config) {
    if (options && typeof options.cashOnHand === 'number') {
      return options.cashOnHand;
    }
    if (config && typeof config.cashOnHand === 'number') {
      return config.cashOnHand;
    }
    if (config && config.cashOnHand && !isNaN(parseFloat(config.cashOnHand))) {
      return parseFloat(config.cashOnHand);
    }
    return 0;
  }

  function loadLedgerData_(sheet, since, now) {
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

      var dateValue = headerMap.date !== undefined ? row[headerMap.date] : null;
      var dateIso = formatDateString_(dateValue);
      if (!dateIso) {
        continue;
      }
      var dateObj = new Date(dateIso);
      if (dateObj < since || dateObj > now) {
        continue;
      }

      var amount = headerMap.amount !== undefined ? parseFloat(row[headerMap.amount] || 0) : 0;
      if (isNaN(amount)) {
        amount = 0;
      }

      rows.push({
        rowNumber: i + 1,
        date: dateIso,
        amount: amount,
        description: headerMap.description !== undefined ? (row[headerMap.description] || '').toString() : '',
        categoryId: headerMap.categoryId !== undefined ? (row[headerMap.categoryId] || '').toString() : '',
        account: headerMap.account !== undefined ? (row[headerMap.account] || '').toString() : ''
      });
    }

    return {
      rows: rows,
      headerMap: headerMap
    };
  }

  function buildAnalytics_(rows, since, now, cashOnHand, baseCurrency) {
    var income = 0;
    var expense = 0;
    var categorySpend = {};

    for (var i = 0; i < rows.length; i++) {
      var amount = rows[i].amount || 0;
      if (amount >= 0) {
        income += amount;
      } else {
        var spend = Math.abs(amount);
        expense += spend;
        var categoryKey = rows[i].categoryId || 'uncategorized';
        if (!categorySpend[categoryKey]) {
          categorySpend[categoryKey] = 0;
        }
        categorySpend[categoryKey] += spend;
      }
    }

    var dayDiff = Math.max(1, Math.round((now - since) / (24 * 60 * 60 * 1000)));
    var averageDailyExpense = expense / dayDiff;
    var averageDailyIncome = income / dayDiff;
    var monthlyBurnRate = averageDailyExpense * 30;
    var runwayDays = averageDailyExpense > 0 ? cashOnHand / averageDailyExpense : null;
    var ageOfMoney = averageDailyExpense > 0 ? (cashOnHand / averageDailyExpense) : null;
    var forecastSpending30 = averageDailyExpense * 30;

    var categoryBreakdown = buildCategoryBreakdown_(categorySpend);

    return {
      status: 'OK',
      generatedAt: now.toISOString(),
      baseCurrency: baseCurrency,
      sampleSize: rows.length,
      period: {
        start: formatDateString_(since),
        end: formatDateString_(now),
        days: dayDiff
      },
      totals: {
        income: roundAmount_(income),
        expense: roundAmount_(expense),
        net: roundAmount_(income - expense)
      },
      metrics: {
        averageDailyExpense: roundAmount_(averageDailyExpense),
        averageDailyIncome: roundAmount_(averageDailyIncome),
        monthlyBurnRate: roundAmount_(monthlyBurnRate),
        runwayDays: runwayDays !== null ? roundAmount_(runwayDays) : null,
        ageOfMoneyDays: ageOfMoney !== null ? roundAmount_(ageOfMoney) : null,
        forecastSpendingNext30Days: roundAmount_(forecastSpending30)
      },
      breakdowns: {
        categories: categoryBreakdown
      },
      cashOnHand: roundAmount_(cashOnHand)
    };
  }

  function buildCategoryBreakdown_(categorySpend) {
    var breakdown = [];
    for (var key in categorySpend) {
      if (!categorySpend.hasOwnProperty(key)) {
        continue;
      }
      breakdown.push({
        categoryId: key,
        amount: roundAmount_(categorySpend[key])
      });
    }
    breakdown.sort(function (a, b) {
      return b.amount - a.amount;
    });
    return breakdown;
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

  return {
    computeMetrics: computeMetrics,
    healthProbe: healthProbe,
    forecastDebtFree: forecastDebtFree,
    exportForDashboard: exportForDashboard
  };
})();
