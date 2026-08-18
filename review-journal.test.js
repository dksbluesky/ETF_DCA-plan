const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
assert.match(html, /<script src="review-journal\.js"><\/script>/);
assert.match(html, /fetchJournalOutcomeCandles[\s\S]*historical\/candles[\s\S]*cache: 'no-store'/);
assert.match(html, /EtfDcaReviewJournal\?\.renderControls/);

const values = new Map();
global.localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); }
};
delete require.cache[require.resolve('./review-journal.js')];
const review = require('./review-journal.js');

const setup = {
  ticker: '006208', quoteDate: '2026-08-05', evaluatedAt: '2026-08-05T01:00:00.000Z',
  currentPrice: 100, marketSessionState: 'REGULAR',
  gapContext: { direction: 'GAP_UP', percent: 2, zoneRelation: 'ABOVE_ACTIVE_ZONE' },
  C1: { met: false }, C2: { met: true }, C3: { met: false },
  C4: { classification: 'WEAK' },
  systemSuggestedZone: { aggressive: { low: 98, high: 101 }, conservative: { low: 96, high: 99 } },
  manualDraft: { low: 98, high: 99, edited: false },
  activeManualZone: { low: 97, high: 99, source: 'MANUAL', manualAppliedAt: '2026-08-05T00:30:00.000Z' },
  manualReassessment: { completedDailyDate: '2026-08-04', completedClose: 100, suggestedZoneLow: 98, suggestedZoneHigh: 99, result: 'ABOVE_SUGGESTED_ZONE', counter: 1, threshold: 3, ready: false },
  events: ['INITIAL_SNAPSHOT']
};
const bridge = {
  ticker: '006208', evaluatedAt: '2026-08-05T01:01:00.000Z',
  events: ['BRIDGE_STARTED'], bridgeId: 'bridge-1'
};
const laterSetup = {
  ...setup, evaluatedAt: '2026-08-05T02:00:00.000Z', currentPrice: 110,
  C1: { met: true }, events: ['CONDITIONS_CHANGED']
};
values.set(review.ETF_STORAGE_KEY, JSON.stringify({ version: 1, entries: [setup, bridge, laterSetup] }));
values.set(review.TAR_STORAGE_KEY, JSON.stringify({ version: 1, entries: [{
  ticker: '006208', bridgeId: 'bridge-1', evaluatedAt: '2026-08-05T01:02:00.000Z',
  assessmentState: 'WAIT_FOR_CONFIRMATION'
}] }));

const candles = [
  { date: '2026-08-05', open: 100, high: 101, low: 99, close: 100 },
  { date: '2026-08-06', open: 101, high: 103, low: 100, close: 102 },
  { date: '2026-08-07', open: 102, high: 104, low: 101, close: 103 },
  { date: '2026-08-10', open: 103, high: 106, low: 102, close: 105 },
  { date: '2026-08-11', open: 105, high: 107, low: 104, close: 106 },
  { date: '2026-08-12', open: 106, high: 108, low: 105, close: 107 }
];

(async () => {
  const result = await review.buildReviewPackage({
    async fetchCandles(ticker, fromDate) {
      assert.strictEqual(ticker, '006208');
      assert.strictEqual(fromDate, '2026-08-05');
      return candles;
    }
  });
  assert.strictEqual(result.cases.length, 1);
  assert.strictEqual(result.cases[0].assessments.length, 1);
  assert.strictEqual(result.cases[0].setup.C1.met, false, 'case freezes at the latest setup before bridge start');
  assert.strictEqual(result.cases[0].setup.systemSuggestedZone.aggressive.low, 98, 'same-day case retains its selected setup snapshot fields');
  assert.strictEqual(result.cases[0].setup.manualReassessment.counter, 1);
  assert.strictEqual(result.cases[0].outcome.baselinePrice, 100);
  assert.strictEqual(result.cases[0].outcome.day1.changePct, 2);
  assert.strictEqual(result.cases[0].outcome.day3.changePct, 5);
  assert.ok(Math.abs(result.cases[0].outcome.day5.changePct - 7) < 0.0001);
  assert.strictEqual(result.cases[0].outcome.day5.maxHighPct, 8);
  assert.strictEqual(result.summary.completed5dCases, 1);
  assert.strictEqual(result.summary.reviewReady, false);
  assert.deepStrictEqual(result.privacy.excluded.includes('Fugle API key'), true);
  assert.ok(values.has(review.OUTCOME_STORAGE_KEY));
  console.log('review-journal tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
