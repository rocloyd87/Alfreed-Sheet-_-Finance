/**
 * Debt payoff strategy helpers reused across runtimes.
 */
var DebtLib = (function () {
  'use strict';

  var MAX_MONTHS = 600;

  function toNumber(value, defaultValue) {
    var n = Number(value);
    if (isNaN(n)) {
      return defaultValue;
    }
    return n;
  }

  function calculateMonthlyRate(apr) {
    var rate = toNumber(apr, 0);
    if (rate <= 0) {
      return 0;
    }
    return rate / 12 / 100;
  }

  function roundCurrency(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function normalizeDebt(raw) {
    if (!raw) {
      return null;
    }

    var balance = Math.max(0, toNumber(raw.balance || raw.principal || raw.outstanding, 0));
    if (!balance) {
      return null;
    }

    var apr = Math.max(0, toNumber(raw.apr || raw.interestRate || 0, 0));
    var minimumPayment = toNumber(raw.minimumPayment || raw.minPayment, NaN);
    if (!minimumPayment || minimumPayment <= 0) {
      minimumPayment = estimateMinimumPayment(balance, apr, raw.termMonths);
    }

    return {
      id: raw.id || raw.debtId || String(raw.name || balance),
      name: raw.name || raw.description || raw.account || 'Debt',
      balance: roundCurrency(balance),
      apr: apr,
      minimumPayment: roundCurrency(Math.max(minimumPayment, 0.01)),
      termMonths: raw.termMonths ? Math.max(1, Math.floor(raw.termMonths)) : null,
      extraPayment: Math.max(0, toNumber(raw.extraPayment, 0))
    };
  }

  function estimateMinimumPayment(balance, apr, termMonths) {
    if (termMonths && termMonths > 0) {
      var monthlyRate = calculateMonthlyRate(apr);
      if (!monthlyRate) {
        return roundCurrency(balance / termMonths);
      }
      var numerator = monthlyRate * Math.pow(1 + monthlyRate, termMonths);
      var denominator = Math.pow(1 + monthlyRate, termMonths) - 1;
      if (!denominator) {
        return roundCurrency(balance / termMonths);
      }
      return roundCurrency(balance * (numerator / denominator));
    }

    if (!apr || apr <= 0) {
      return roundCurrency(Math.max(25, balance / 24));
    }

    var percentPayment = balance * 0.02;
    return roundCurrency(Math.max(25, percentPayment));
  }

  function selectOrdering(strategy, debts) {
    var sorted = debts.slice();
    if (strategy === 'avalanche') {
      sorted.sort(function (a, b) {
        if (b.apr === a.apr) {
          return a.balance - b.balance;
        }
        return b.apr - a.apr;
      });
    } else {
      sorted.sort(function (a, b) {
        if (a.balance === b.balance) {
          return b.apr - a.apr;
        }
        return a.balance - b.balance;
      });
    }
    return sorted;
  }

  function computePortfolioPlan(debts, options) {
    options = options || {};
    var normalized = [];
    (debts || []).forEach(function (debt) {
      var normalizedDebt = normalizeDebt(debt);
      if (normalizedDebt) {
        normalized.push(normalizedDebt);
      }
    });

    if (!normalized.length) {
      return {
        strategy: options.strategy || 'snowball',
        schedule: [],
        summary: {
          status: 'EMPTY',
          totalPaid: 0,
          totalInterest: 0,
          months: 0,
          payoffDate: null,
          debts: []
        }
      };
    }

    var strategy = (options.strategy || 'snowball').toLowerCase();
    if (['snowball', 'avalanche'].indexOf(strategy) === -1) {
      strategy = 'snowball';
    }

    var baseExtra = Math.max(0, toNumber(options.extraPayment, 0));
    var startDate = options.startDate ? new Date(options.startDate) : new Date();
    var sorted = selectOrdering(strategy, normalized);
    var schedule = [];
    var totalPaid = 0;
    var totalInterest = 0;
    var monthIndex = 0;
    var freedPool = 0;
    var outstanding = normalized.length;
    var payoffMeta = {};

    while (outstanding > 0 && monthIndex < MAX_MONTHS) {
      monthIndex += 1;
      var payments = [];
      var availableExtra = baseExtra + freedPool;
      var freedThisMonth = 0;
      var remainingDebts = 0;

      sorted.forEach(function (debt) {
        if (debt.balance <= 0) {
          return;
        }
        remainingDebts += 1;
        var monthlyRate = calculateMonthlyRate(debt.apr);
        var interestCharge = roundCurrency(debt.balance * monthlyRate);
        var balanceAfterInterest = roundCurrency(debt.balance + interestCharge);
        var baselinePayment = Math.max(debt.minimumPayment, interestCharge ? interestCharge + 0.01 : debt.minimumPayment);
        var requestedPayment = baselinePayment;
        if (debt.extraPayment) {
          requestedPayment += debt.extraPayment;
        }
        if (availableExtra > 0) {
          var additional = Math.min(availableExtra, balanceAfterInterest - requestedPayment);
          if (additional > 0) {
            requestedPayment += additional;
            availableExtra = roundCurrency(availableExtra - additional);
          }
        }
        requestedPayment = Math.min(balanceAfterInterest, requestedPayment);
        requestedPayment = roundCurrency(Math.max(requestedPayment, interestCharge + 0.01));

        var principalPaid = roundCurrency(requestedPayment - interestCharge);
        if (principalPaid < 0) {
          principalPaid = 0;
        }

        var newBalance = roundCurrency(balanceAfterInterest - requestedPayment);
        if (newBalance < 0) {
          principalPaid = roundCurrency(principalPaid + newBalance);
          newBalance = 0;
        }

        debt.balance = newBalance;
        totalPaid = roundCurrency(totalPaid + requestedPayment);
        totalInterest = roundCurrency(totalInterest + interestCharge);

        payments.push({
          debtId: debt.id,
          debtName: debt.name,
          payment: requestedPayment,
          principal: principalPaid,
          interest: interestCharge,
          remainingBalance: newBalance
        });

        if (newBalance <= 0.01) {
          debt.balance = 0;
          if (!payoffMeta[debt.id]) {
            payoffMeta[debt.id] = {
              paidOffMonth: monthIndex,
              paidOffDate: addMonths(startDate, monthIndex - 1).toISOString().split('T')[0],
              totalPaid: 0,
              totalInterest: 0
            };
          }
          payoffMeta[debt.id].totalPaid = roundCurrency((payoffMeta[debt.id].totalPaid || 0) + requestedPayment);
          payoffMeta[debt.id].totalInterest = roundCurrency((payoffMeta[debt.id].totalInterest || 0) + interestCharge);
          freedThisMonth += debt.minimumPayment + debt.extraPayment;
          outstanding -= 1;
        } else {
          if (!payoffMeta[debt.id]) {
            payoffMeta[debt.id] = {
              paidOffMonth: null,
              paidOffDate: null,
              totalPaid: 0,
              totalInterest: 0
            };
          }
          payoffMeta[debt.id].totalPaid = roundCurrency((payoffMeta[debt.id].totalPaid || 0) + requestedPayment);
          payoffMeta[debt.id].totalInterest = roundCurrency((payoffMeta[debt.id].totalInterest || 0) + interestCharge);
        }
      });

      schedule.push({
        monthIndex: monthIndex,
        date: addMonths(startDate, monthIndex - 1).toISOString().split('T')[0],
        payments: payments,
        remainingDebts: remainingDebts,
        totalPayment: payments.reduce(function (sum, payment) {
          return roundCurrency(sum + payment.payment);
        }, 0),
        totalInterest: payments.reduce(function (sum, payment) {
          return roundCurrency(sum + payment.interest);
        }, 0)
      });

      freedPool += freedThisMonth;

      if (remainingDebts === 0) {
        break;
      }
    }

    var status = outstanding > 0 ? 'WARN' : 'OK';
    var warning = outstanding > 0 ? 'Reached iteration cap before debts were fully repaid.' : null;

    return {
      strategy: strategy,
      schedule: schedule,
      summary: {
        status: status,
        warning: warning,
        totalPaid: roundCurrency(totalPaid),
        totalInterest: roundCurrency(totalInterest),
        months: monthIndex,
        payoffDate: monthIndex ? addMonths(startDate, monthIndex - 1).toISOString().split('T')[0] : null,
        debts: sorted.map(function (debt, index) {
          var meta = payoffMeta[debt.id] || {};
          return {
            debtId: debt.id,
            name: debt.name,
            order: index + 1,
            apr: debt.apr,
            minimumPayment: debt.minimumPayment,
            paidOffMonth: meta.paidOffMonth,
            paidOffDate: meta.paidOffDate,
            totalPaid: meta.totalPaid || 0,
            totalInterest: meta.totalInterest || 0,
            remainingBalance: roundCurrency(debt.balance)
          };
        })
      }
    };
  }

  function addMonths(date, months) {
    var result = new Date(date.getTime());
    result.setMonth(result.getMonth() + months);
    return result;
  }

  return {
    calculateMonthlyRate: calculateMonthlyRate,
    estimateMinimumPayment: estimateMinimumPayment,
    computePortfolioPlan: computePortfolioPlan,
    normalizeDebt: normalizeDebt,
    roundCurrency: roundCurrency
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DebtLib;
}
