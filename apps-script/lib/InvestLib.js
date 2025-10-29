/**
 * Investment portfolio helpers.
 */
var InvestLib = (function () {
  'use strict';

  function toNumber(value, defaultValue) {
    var number = Number(value);
    return isNaN(number) ? defaultValue : number;
  }

  function roundCurrency(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function roundPercent(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function buildFxMap(fxRates, baseCurrency) {
    var map = {};
    (fxRates || []).forEach(function (rate) {
      if (!rate || !rate.counterCurrency) {
        return;
      }
      var pair = [rate.baseCurrency || baseCurrency, rate.counterCurrency].join('->').toUpperCase();
      map[pair] = toNumber(rate.rate, 0);
    });
    map[baseCurrency.toUpperCase() + '->' + baseCurrency.toUpperCase()] = 1;
    return map;
  }

  function convertToBase(amount, currency, fxMap, baseCurrency) {
    var normalizedCurrency = (currency || baseCurrency).toString().toUpperCase();
    var key = (normalizedCurrency + '->' + baseCurrency.toUpperCase());
    var rate = fxMap[key];
    if (!rate || rate <= 0) {
      if (normalizedCurrency === baseCurrency.toUpperCase()) {
        rate = 1;
      } else {
        return roundCurrency(amount);
      }
    }
    return roundCurrency(amount * rate);
  }

  function normalizeTransaction(raw, defaults) {
    defaults = defaults || {};
    if (!raw) {
      return null;
    }

    var valueDelta = toNumber(raw.valueDelta, NaN);
    if (isNaN(valueDelta)) {
      valueDelta = toNumber(raw.amount, NaN);
      if (isNaN(valueDelta)) {
        return null;
      }
    }

    var quantityDelta = toNumber(raw.quantityDelta, 0);
    if (!quantityDelta && raw.quantityDelta === undefined && raw.quantity !== undefined) {
      quantityDelta = toNumber(raw.quantity, 0);
    }

    var account = (raw.account || defaults.account || 'Unassigned').toString();
    var symbol = (raw.symbol || raw.ticker || raw.instrument || account).toString();
    var assetClass = (raw.assetClass || raw.classification || raw.category || defaults.assetClass || 'unclassified').toString();
    var currency = (raw.currency || defaults.currency || 'USD').toString();
    var liquid = !!raw.isLiquid;

    return {
      account: account,
      symbol: symbol,
      assetClass: assetClass,
      currency: currency,
      valueDelta: roundCurrency(valueDelta),
      quantityDelta: roundCurrency(quantityDelta),
      isLiquid: liquid
    };
  }

  function buildPortfolio(transactions, fxRates, baseCurrency, targetAllocations) {
    var fxMap = buildFxMap(fxRates, baseCurrency || 'USD');
    var normalizedTransactions = [];
    (transactions || []).forEach(function (tx) {
      var normalized = normalizeTransaction(tx, { currency: baseCurrency || 'USD' });
      if (normalized) {
        normalizedTransactions.push(normalized);
      }
    });

    var holdingsMap = {};
    var totals = {
      invested: 0,
      liquid: 0,
      netWorth: 0
    };

    normalizedTransactions.forEach(function (tx) {
      var valueBase = convertToBase(tx.valueDelta, tx.currency, fxMap, baseCurrency || 'USD');
      if (!valueBase) {
        return;
      }
      var key = (tx.account + '|' + tx.symbol).toLowerCase();
      if (!holdingsMap[key]) {
        holdingsMap[key] = {
          holdingId: key,
          account: tx.account,
          symbol: tx.symbol,
          assetClass: tx.assetClass,
          quantity: 0,
          valueBase: 0,
          currency: baseCurrency || 'USD',
          lastUpdated: new Date().toISOString()
        };
      }
      holdingsMap[key].quantity = roundCurrency(holdingsMap[key].quantity + tx.quantityDelta);
      holdingsMap[key].valueBase = roundCurrency(holdingsMap[key].valueBase + valueBase);
      totals.netWorth = roundCurrency(totals.netWorth + valueBase);
      if (tx.isLiquid) {
        totals.liquid = roundCurrency(totals.liquid + valueBase);
      } else {
        totals.invested = roundCurrency(totals.invested + valueBase);
      }
    });

    var holdings = Object.keys(holdingsMap).map(function (key) {
      return holdingsMap[key];
    }).filter(function (holding) {
      return Math.abs(holding.valueBase) > 0.01;
    });

    var allocations = calculateAllocations(holdings, targetAllocations);
    var snapshot = buildNetWorthSnapshot(totals, baseCurrency || 'USD');

    return {
      holdings: holdings,
      totals: totals,
      allocations: allocations,
      netWorthSnapshot: snapshot
    };
  }

  function calculateAllocations(holdings, targetAllocations) {
    var totalsByClass = {};
    var totalValue = 0;
    (holdings || []).forEach(function (holding) {
      var value = Math.max(0, toNumber(holding.valueBase, 0));
      totalValue += value;
      var assetClass = (holding.assetClass || 'unclassified').toString();
      if (!totalsByClass[assetClass]) {
        totalsByClass[assetClass] = 0;
      }
      totalsByClass[assetClass] += value;
    });

    if (totalValue <= 0) {
      totalValue = 1;
    }

    var allocations = [];
    var seenClasses = {};
    (targetAllocations || []).forEach(function (target) {
      var assetClass = (target.class || target.assetClass || 'unclassified').toString();
      var targetPercent = toNumber(target.targetPercent || target.weight, 0);
      var actualValue = totalsByClass[assetClass] || 0;
      var actualPercent = roundPercent((actualValue / totalValue) * 100);
      allocations.push({
        class: assetClass,
        targetPercent: roundPercent(targetPercent),
        actualPercent: actualPercent,
        deviationPercent: roundPercent(actualPercent - roundPercent(targetPercent)),
        valueBase: roundCurrency(actualValue)
      });
      seenClasses[assetClass] = true;
    });

    Object.keys(totalsByClass).forEach(function (assetClass) {
      if (seenClasses[assetClass]) {
        return;
      }
      var actualValue = totalsByClass[assetClass] || 0;
      var actualPercent = roundPercent((actualValue / totalValue) * 100);
      allocations.push({
        class: assetClass,
        targetPercent: 0,
        actualPercent: actualPercent,
        deviationPercent: actualPercent,
        valueBase: roundCurrency(actualValue)
      });
    });

    allocations.sort(function (a, b) {
      return b.actualPercent - a.actualPercent;
    });

    return allocations;
  }

  function buildNetWorthSnapshot(totals, baseCurrency) {
    return {
      snapshotAt: new Date().toISOString(),
      netWorth: roundCurrency(toNumber(totals.netWorth, 0)),
      currency: baseCurrency || 'USD',
      liquid: roundCurrency(toNumber(totals.liquid, 0)),
      invested: roundCurrency(toNumber(totals.invested, 0)),
      debts: roundCurrency(toNumber(totals.debts || 0, 0))
    };
  }

  return {
    buildPortfolio: buildPortfolio,
    calculateAllocations: calculateAllocations,
    normalizeTransaction: normalizeTransaction,
    buildNetWorthSnapshot: buildNetWorthSnapshot,
    convertToBase: convertToBase,
    buildFxMap: buildFxMap
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = InvestLib;
}
