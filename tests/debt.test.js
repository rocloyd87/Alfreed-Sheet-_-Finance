const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let DebtLib;

test.before(async () => {
  const debtLibUrl = pathToFileURL(path.resolve('apps-script/lib/DebtLib.js')).href;
  const mod = await import(debtLibUrl);
  DebtLib = mod.default || mod.DebtLib || mod;
});

function roughlyEqual(a, b, delta = 0.05) {
  assert.ok(Math.abs(a - b) <= delta, `expected ${a} ≈ ${b}`);
}

test('normalizeDebt filters invalid rows and estimates minimum payment', () => {
  const normalized = DebtLib.normalizeDebt({
    debtId: 'card-1',
    name: 'Card 1',
    balance: 2500,
    apr: 19.99
  });
  assert.equal(normalized.debtId || normalized.id, 'card-1');
  assert.equal(normalized.name, 'Card 1');
  assert.ok(normalized.minimumPayment >= 25);
});

test('computePortfolioPlan returns empty summary when no debts', () => {
  const plan = DebtLib.computePortfolioPlan([], { strategy: 'snowball' });
  assert.equal(plan.summary.status, 'EMPTY');
  assert.equal(plan.summary.totalPaid, 0);
  assert.equal(plan.schedule.length, 0);
});

test('snowball strategy prioritizes smallest balance first', () => {
  const plan = DebtLib.computePortfolioPlan([
    { id: 'loanA', name: 'Loan A', balance: 1000, apr: 5, minimumPayment: 50 },
    { id: 'loanB', name: 'Loan B', balance: 2000, apr: 25, minimumPayment: 60 }
  ], { strategy: 'snowball', extraPayment: 100, startDate: '2025-01-01' });

  assert.equal(plan.summary.status, 'OK');
  const firstDebt = plan.summary.debts[0];
  assert.equal(firstDebt.debtId || firstDebt.id, 'loanA');
  assert.ok(firstDebt.paidOffMonth <= plan.summary.debts[1].paidOffMonth);
  assert.ok(plan.schedule.length > 0);
  const totalPayment = plan.schedule.reduce((sum, month) => sum + month.totalPayment, 0);
  const totalInterest = plan.schedule.reduce((sum, month) => sum + month.totalInterest, 0);
  roughlyEqual(plan.summary.totalPaid, totalPayment);
  roughlyEqual(plan.summary.totalInterest, totalInterest);
});

test('avalanche strategy prioritizes highest rate first', () => {
  const plan = DebtLib.computePortfolioPlan([
    { id: 'loanA', name: 'Loan A', balance: 1500, apr: 5, minimumPayment: 50 },
    { id: 'loanB', name: 'Loan B', balance: 2000, apr: 25, minimumPayment: 60 }
  ], { strategy: 'avalanche', extraPayment: 50, startDate: '2025-01-01' });

  const firstDebt = plan.summary.debts[0];
  assert.equal(firstDebt.debtId || firstDebt.id, 'loanB');
  assert.ok(plan.schedule.length > 0);
});

test('large extra payment results in quick payoff', () => {
  const plan = DebtLib.computePortfolioPlan([
    { id: 'loanA', name: 'Loan A', balance: 500, apr: 10, minimumPayment: 50 }
  ], { strategy: 'snowball', extraPayment: 450, startDate: '2025-01-01' });

  assert.ok(plan.summary.months <= 2);
  assert.ok((plan.summary.debts[0].paidOffMonth || 0) <= 2);
  assert.equal(plan.summary.debts[0].remainingBalance || 0, 0);
});

test('estimateMinimumPayment respects loan term and zero interest', () => {
  const amortized = DebtLib.estimateMinimumPayment(1200, 0, 12);
  assert.equal(Math.round(amortized), 100);

  const revolving = DebtLib.estimateMinimumPayment(1200, 18, null);
  assert.ok(revolving >= 25);
});

test('normalizeDebt filters out invalid rows', () => {
  const valid = DebtLib.normalizeDebt({ balance: 300, apr: 12, name: 'Valid' });
  assert.ok(valid);
  const invalid = DebtLib.normalizeDebt({ balance: 'not-a-number' });
  assert.equal(invalid, null);
});
