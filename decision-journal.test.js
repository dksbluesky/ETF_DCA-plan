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
  C1: { met: false, provisional: true },
  C2: { met: true, provisional: true },
  C3: { met: false, provisional: true },
  C4: { classification: 'WEAK', decision: 'DO_NOT_CHASE', confirmed: false },
  setupStatus: { label: 'Monitoring', provisional: true }
};

const first = journal.recordSetupSnapshot(base);
assert.deepStrictEqual(first.events, ['INITIAL_SNAPSHOT', 'OPENING_GAP']);
assert.strictEqual(journal.recordSetupSnapshot({ ...base, currentPrice: 238 }), null, 'price-only refresh must deduplicate');

const changed = journal.recordSetupSnapshot({
  ...base,
  evaluatedAt: '2026-08-05T01:01:00.000Z',
  activeZone: { low: 232, high: 235 }
});
assert.deepStrictEqual(changed.events, ['ACTIVE_ZONE_CHANGED']);

journal.recordBridgeStart(base, {
  ticker: '006208',
  bridgeId: 'bridge-1',
  createdAt: '2026-08-05T01:02:00.000Z'
});
assert.strictEqual(journal.listEntries({ ticker: '006208', limit: 1 })[0].events[0], 'BRIDGE_STARTED');
assert.strictEqual(journal.recordSetupSnapshot({ ...base, activeZone: { low: 232, high: 235 } }), null,
  'bridge event must not disturb setup deduplication');

console.log('decision-journal tests passed');
