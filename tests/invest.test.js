const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let InvestLib;

test.before(async () => {
  const investLibUrl = pathToFileURL(path.resolve('apps-script/lib/InvestLib.js')).href;
  const mod = await import(investLibUrl);
  InvestLib = mod.default || mod.InvestLib || mod;
});

test('buildPortfolio aggregates holdings and allocations', () => {
  const transactions = [
    { account: 'Brokerage', symbol: 'VTI', assetClass: 'equity', valueDelta: 1000, quantityDelta: 5, currency: 'USD' },
    { account: 'Brokerage', symbol: 'VTI', assetClass: 'equity', valueDelta: 250, quantityDelta: 1.25, currency: 'USD' },
    { account: 'Retirement', symbol: 'BND', assetClass: 'fixed_income', valueDelta: 500, quantityDelta: 5, currency: 'USD' },
    { account: 'Savings', symbol: 'CASH', assetClass: 'cash', valueDelta: 200, quantityDelta: 200, currency: 'USD', isLiquid: true },
    { account: 'International', symbol: 'VXUS', assetClass: 'equity', valueDelta: 1000, quantityDelta: 2, currency: 'EUR' }
  ];

  const fxRates = [
    { baseCurrency: 'USD', counterCurrency: 'EUR', rate: 0.8 },
    { baseCurrency: 'EUR', counterCurrency: 'USD', rate: 1.2 }
  ];

  const targets = [
    { class: 'equity', targetPercent: 60 },
    { class: 'fixed_income', targetPercent: 30 },
    { class: 'cash', targetPercent: 10 }
  ];

  const portfolio = InvestLib.buildPortfolio(transactions, fxRates, 'USD', targets);
  assert.equal(portfolio.holdings.length, 4);
  const equity = portfolio.allocations.find((a) => a.class === 'equity');
  assert.ok(equity);
  assert.ok(equity.actualPercent > 60);
  const cash = portfolio.allocations.find((a) => a.class === 'cash');
  assert.ok(cash.actualPercent > 0);
  assert.equal(portfolio.totals.liquid > 0, true);
  assert.equal(portfolio.netWorthSnapshot.currency, 'USD');
});

test('calculateAllocations fills missing targets with zero target percent', () => {
  const holdings = [
    { assetClass: 'real_estate', valueBase: 1000 },
    { assetClass: 'equity', valueBase: 1000 }
  ];
  const allocations = InvestLib.calculateAllocations(holdings, [{ class: 'equity', targetPercent: 50 }]);
  assert.equal(allocations.length, 2);
  const realEstate = allocations.find((a) => a.class === 'real_estate');
  assert.equal(realEstate.targetPercent, 0);
  assert.ok(realEstate.actualPercent > 0);
});

test('normalizeTransaction tolerates missing quantity and defaults', () => {
  const normalized = InvestLib.normalizeTransaction({ account: 'A', amount: '100.5' }, { currency: 'EUR' });
  assert.equal(normalized.currency, 'EUR');
  assert.equal(normalized.valueDelta, 100.5);
  assert.equal(normalized.quantityDelta, 0);
});

test('buildNetWorthSnapshot rounds values', () => {
  const snapshot = InvestLib.buildNetWorthSnapshot({ netWorth: 1000.123, invested: 800.456, liquid: 199.667 }, 'USD');
  assert.equal(snapshot.netWorth, 1000.12);
  assert.equal(snapshot.invested, 800.46);
  assert.equal(snapshot.liquid, 199.67);
});
