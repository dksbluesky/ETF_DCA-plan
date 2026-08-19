const assert = require('assert');

function loadJournal() {
  const values = new Map();
  global.localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
  delete require.cache[require.resolve('./decision-journal.js')];
  return require('./decision-journal.js');
}

const journal = loadJournal();

const gap = journal.calculateGapContext({
  open: 237,
  previousClose: 230.15,
  activeZone: { low: 225, high: 231 },
  atr: 5
});
assert.strictEqual(gap.direction, 'GAP_UP');
assert.strictEqual(gap.zoneRelation, 'ABOVE_ACTIVE_ZONE');
assert.ok(Math.abs(gap.percent - 2.9763) < 0.001);
assert.ok(Math.abs(gap.atrMultiple - 1.37) < 0.001);

const base = {
  ticker: '006208',
  evaluatedAt: '2026-08-05T01:00:00.000Z',
  quoteDate: '2026-08-05',
  currentPrice: 237,
  open: 237,
  previousClose: 230.15,
  marketSessionState: 'REGULAR',
  activeZone: { low: 225, high: 231 },
  zoneMode: 'aggressive',
  systemSuggestedZone: {
    aggressive: { low: 235, high: 238 },
    conservative: { low: 232, high: 236 }
  },
  manualDraft: { low: 234, high: 236, edited: true },
  activeManualZone: { low: 233, high: 235, source: 'MANUAL', manualAppliedAt: '2026-08-05T00:30:00.000Z' },
  manualReassessment: {
    completedDailyDate: '2026-08-04', completedClose: 237,
    suggestedZoneLow: 235, suggestedZoneHigh: 236,
    result: 'ABOVE_SUGGESTED_ZONE', counter: 2, threshold: 3, ready: false
  },
  C1: { met: false, provisional: true },
  C2: { met: true, provisional: true },
  C3: { met: false, provisional: true },
  C4: { classification: 'WEAK', decision: 'DO_NOT_CHASE', confirmed: false },
  setupStatus: { label: 'Monitoring', provisional: true }
};

const first = journal.recordSetupSnapshot(base);
assert.deepStrictEqual(first.events, ['INITIAL_SNAPSHOT', 'OPENING_GAP']);
assert.deepStrictEqual(first.systemSuggestedZone, base.systemSuggestedZone);
assert.deepStrictEqual(first.manualDraft, base.manualDraft);
assert.deepStrictEqual(first.activeManualZone, base.activeManualZone);
assert.deepStrictEqual(first.manualReassessment, { ...base.manualReassessment, resetState: null, resetAt: null });
assert.strictEqual(journal.recordSetupSnapshot({ ...base, currentPrice: 238 }), null, 'price-only refresh must deduplicate');

const changed = journal.recordSetupSnapshot({
  ...base,
  evaluatedAt: '2026-08-05T01:01:00.000Z',
  activeZone: { low: 232, high: 235 }
});
assert.deepStrictEqual(changed.events, ['ACTIVE_ZONE_CHANGED']);
const reassessmentChanged = journal.recordSetupSnapshot({
  ...changed,
  evaluatedAt: '2026-08-05T01:01:30.000Z',
  manualReassessment: { ...base.manualReassessment, counter: 3, ready: true }
});
assert.deepStrictEqual(reassessmentChanged.events, ['MANUAL_REASSESSMENT_CHANGED'], 'same-day reassessment changes remain raw snapshots');
const missingFields = journal.recordSetupSnapshot({
  ticker: '00900', evaluatedAt: '2026-08-05T01:02:00.000Z', quoteDate: '2026-08-05',
  currentPrice: 20, marketSessionState: 'REGULAR'
});
assert.strictEqual(missingFields.systemSuggestedZone.aggressive.low, null, 'missing historical suggested values are not reconstructed');
assert.strictEqual(missingFields.manualDraft.low, null, 'missing historical draft values are not reconstructed');
assert.strictEqual(missingFields.manualReassessment.counter, null, 'missing historical reassessment values are not reconstructed');

const leftSnapshot = journal.recordSetupSnapshot({ ...base, ticker: '00900', bridgeId: 'left-bridge', entryMode: 'left_side_starter', starterEligible: true, starterAllocationPct: 10, starterExecuted: false, starterRisk: { level: 'ELEVATED' } });
assert.ok(leftSnapshot.events.includes('left_authorized'));
assert.ok(leftSnapshot.events.includes('left_execution_assessment_available'));
const withdrawnLeft = journal.recordSetupSnapshot({ ...base, ticker: '00900', bridgeId: 'left-bridge', entryMode: 'pending', starterEligible: false, starterAllocationPct: 10, starterExecuted: false, starterRisk: { level: 'ELEVATED' } });
assert.ok(withdrawnLeft.events.includes('left_withdrawn'));
const executedLeft = journal.recordSetupSnapshot({ ...base, ticker: '00900', bridgeId: 'left-bridge', entryMode: 'pending', starterEligible: false, starterAllocationPct: 10, starterExecuted: true, starterRisk: { level: 'ELEVATED' } });
assert.ok(executedLeft.events.includes('left_executed'));

journal.recordBridgeStart(base, {
  ticker: '006208',
  bridgeId: 'bridge-1',
  createdAt: '2026-08-05T01:02:00.000Z'
});
assert.strictEqual(journal.listEntries({ ticker: '006208', limit: 1 })[0].events[0], 'BRIDGE_STARTED');
assert.strictEqual(journal.recordSetupSnapshot(reassessmentChanged), null,
  'bridge event must not disturb setup deduplication');

console.log('decision-journal tests passed');
