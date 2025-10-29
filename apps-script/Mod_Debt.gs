/**
 * Debt payoff planning module.
 */
var Mod_Debt = (function () {
  'use strict';

  function planPayoff(options) {
    options = options || {};
    var dryRun = options.dryRun === true;
    var strategy = (options.strategy || 'snowball').toLowerCase();
    var extraPayment = options.extraPayment || 0;
    var startDate = options.startDate || new Date().toISOString();

    Logs.logEvent('INFO', 'Mod_Debt', 'Debt payoff planning invoked', {
      strategy: strategy,
      dryRun: dryRun,
      extraPayment: extraPayment
    });

    var debts = fetchDebts_();
    if (!debts.length) {
      return {
        status: 'EMPTY',
        message: 'No active debts found in Debts sheet.',
        dryRun: dryRun,
        summary: {
          totalPaid: 0,
          totalInterest: 0,
          months: 0,
          payoffDate: null
        }
      };
    }

    var plan = DebtLib.computePortfolioPlan(debts, {
      strategy: strategy,
      extraPayment: extraPayment,
      startDate: startDate
    });

    if (!dryRun) {
      persistPlan_(plan);
    }

    return {
      status: plan.summary.status,
      strategy: plan.strategy,
      dryRun: dryRun,
      warning: plan.summary.warning || null,
      summary: plan.summary,
      schedulePreview: plan.schedule.slice(0, 12)
    };
  }

  function healthProbe() {
    try {
      var debtsSheet = getSheet_(getConfig_().debtsSheet || 'Debts');
      if (!debtsSheet) {
        return { ok: false, reason: 'Debts sheet missing' };
      }
      var headerRange = debtsSheet.getRange(1, 1, 1, debtsSheet.getLastColumn());
      var headers = headerRange.getValues()[0];
      var required = ['debtId', 'name', 'balance', 'apr'];
      var missing = required.filter(function (header) {
        return headers.indexOf(header) === -1;
      });
      return {
        ok: missing.length === 0,
        missingHeaders: missing
      };
    } catch (err) {
      Logs.logEvent('ERROR', 'Mod_Debt', 'Health probe failed', { error: err.message });
      return {
        ok: false,
        error: err.message
      };
    }
  }

  function persistPlan_(plan) {
    var config = getConfig_();
    var amortSheet = getSheet_(config.debtAmortizationSheet || 'Debt_Amortization');
    var summarySheet = getSheet_(config.debtSummarySheet || 'Debt_Strategy');

    if (!amortSheet || !summarySheet) {
      Logs.logEvent('WARN', 'Mod_Debt', 'Debt sheets missing, skipping persistence', {
        amortizationSheet: !!amortSheet,
        summarySheet: !!summarySheet
      });
      return;
    }

    writeAmortization_(amortSheet, plan);
    writeSummary_(summarySheet, plan);
  }

  function writeAmortization_(sheet, plan) {
    sheet.clearContents();
    var headers = ['monthIndex', 'date', 'debtId', 'debtName', 'payment', 'principal', 'interest', 'remainingBalance', 'strategy'];
    var rows = [headers];
    plan.schedule.forEach(function (month) {
      month.payments.forEach(function (payment) {
        rows.push([
          month.monthIndex,
          month.date,
          payment.debtId,
          payment.debtName,
          payment.payment,
          payment.principal,
          payment.interest,
          payment.remainingBalance,
          plan.strategy
        ]);
      });
    });

    sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
  }

  function writeSummary_(sheet, plan) {
    sheet.clearContents();
    var headers = ['debtId', 'name', 'order', 'apr', 'minimumPayment', 'paidOffMonth', 'paidOffDate', 'totalPaid', 'totalInterest', 'remainingBalance', 'strategy'];
    var rows = [headers];
    plan.summary.debts.forEach(function (debt) {
      rows.push([
        debt.debtId,
        debt.name,
        debt.order,
        debt.apr,
        debt.minimumPayment,
        debt.paidOffMonth,
        debt.paidOffDate,
        debt.totalPaid,
        debt.totalInterest,
        debt.remainingBalance,
        plan.strategy
      ]);
    });

    sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
  }

  function fetchDebts_() {
    var config = getConfig_();
    var sheet = getSheet_(config.debtsSheet || 'Debts');
    if (!sheet) {
      Logs.logEvent('WARN', 'Mod_Debt', 'Debts sheet not found');
      return [];
    }

    var values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      return [];
    }

    var headers = values[0];
    var rows = values.slice(1);
    var debts = [];
    rows.forEach(function (row) {
      if (!row || !row.length) {
        return;
      }
      var record = mapRow_(headers, row);
      var normalized = DebtLib.normalizeDebt(record);
      if (normalized) {
        debts.push(normalized);
      }
    });

    return debts;
  }

  function mapRow_(headers, row) {
    var record = {};
    for (var i = 0; i < headers.length; i++) {
      var key = headers[i];
      if (!key) {
        continue;
      }
      record[String(key)] = row[i];
    }
    return record;
  }

  function getSheet_(name) {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActiveSpreadsheet) {
      return null;
    }
    return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  }

  function getConfig_() {
    return Mod_Config && Mod_Config.load ? Mod_Config.load() : {};
  }

  return {
    planPayoff: planPayoff,
    healthProbe: healthProbe
  };
})();
