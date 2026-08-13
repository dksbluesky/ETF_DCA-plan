const assert = require('assert');
const api = require('./market-context-zone.js');
function bars(values) { return values.map((close, index) => ({ date: `2026-01-${String(index + 1).padStart(2, '0')}`, open: close - .2, high: close + .5, low: close - .6, close, volume: 1000 })); }
const values = [10,11,12,20,15,14,13,14,15,16,24,19,18,17,18,19,20,28,23,22,21,22,23,24,32,27,26,25,26,27,28,36,31,30,29,30,31,32,40,35,34,33,34,35,36,44,39,38,37,38,39,40,48,43,42,41,42,43,44,52];
const result = api.classify(bars(values), { currentPrice: 52, securityType: 'ETF' });
assert.equal(result.context, 'bullish'); assert.equal(result.automaticZoneEligible, true); assert.ok(result.activeZone.low < result.activeZone.high);

const real006208VRecovery = [
  ['2026-06-18', 247.95, 249.1, 246.95, 249.1], ['2026-06-22', 253, 258.2, 253, 257.45], ['2026-06-23', 258.1, 260.1, 254.35, 254.35],
  ['2026-06-24', 249.65, 249.65, 245.9, 247.95], ['2026-06-25', 250, 250, 246.3, 248.1], ['2026-06-26', 244.4, 245, 238.1, 238.7],
  ['2026-06-29', 240, 244.6, 239.85, 242.75], ['2026-06-30', 247.9, 250.7, 247.55, 250.2], ['2026-07-01', 254.2, 254.6, 252, 253.65],
  ['2026-07-02', 249, 252.45, 248, 252.3], ['2026-07-03', 246.05, 252.2, 245.95, 251.35], ['2026-07-06', 252.95, 254.05, 250.4, 251.35],
  ['2026-07-07', 251.6, 253.15, 246.05, 246.5], ['2026-07-08', 247.05, 247.75, 243.85, 246.15], ['2026-07-09', 246.5, 248.2, 245, 245.7],
  ['2026-07-10', 245.7, 245.7, 245.7, 245.7], ['2026-07-13', 248, 249.7, 245.65, 246.75], ['2026-07-14', 245.1, 245.1, 237.6, 242.8],
  ['2026-07-15', 243.25, 246.8, 242.8, 246.6], ['2026-07-16', 240.6, 243.5, 238.5, 242.5], ['2026-07-17', 236.65, 236.9, 227.6, 227.75],
  ['2026-07-20', 228.55, 228.95, 224.05, 226], ['2026-07-21', 228.1, 234.55, 228.1, 234.55], ['2026-07-22', 239.1, 240.1, 236.35, 237.4],
  ['2026-07-23', 238.3, 239.75, 235.55, 237.9], ['2026-07-24', 234.6, 235.65, 232.05, 233], ['2026-07-27', 232.2, 232.9, 229.15, 232.75],
  ['2026-07-28', 225, 225.45, 222, 222.1], ['2026-07-29', 222.15, 222.25, 210.2, 214.05], ['2026-07-30', 212.95, 219.45, 210.7, 214.4],
  ['2026-07-31', 229.25, 235.8, 229.2, 235.35], ['2026-08-03', 232, 235.05, 231, 232.9], ['2026-08-04', 230.25, 234, 228.4, 230.15],
  ['2026-08-05', 237, 239.45, 235.4, 238.25], ['2026-08-06', 236.85, 237.6, 234.8, 236.55], ['2026-08-07', 237.15, 237.9, 233.7, 235.35],
  ['2026-08-10', 238, 240, 237.35, 238.7], ['2026-08-11', 237.5, 239.45, 236.45, 238.9], ['2026-08-13', 244.1, 245.15, 243.5, 244.4]
].map(([date, open, high, low, close]) => ({ date, open, high, low, close, volume: 0 }));
const vRecoveryResult = api.classify(real006208VRecovery, { currentPrice: 244.4, securityType: 'ETF', completedDailyDate: '2026-08-13' });
assert.equal(vRecoveryResult.context, 'unclear');
assert.equal(vRecoveryResult.noZoneSubtype, 'v_recovery_breakout_awaiting_hl');
assert.equal(vRecoveryResult.zoneType, null);
assert.equal(vRecoveryResult.automaticZoneEligible, false);
assert.equal(vRecoveryResult.activeZone, null);
assert.equal(vRecoveryResult.invalidationLevel, null);
assert.equal(vRecoveryResult.reason, 'V-recovery breakout — awaiting post-breakout Higher Low');
assert.deepEqual(vRecoveryResult.vRecoveryBreakout.vLow, { kind: 'low', index: 28, price: 210.2, date: '2026-07-29' });
assert.deepEqual(vRecoveryResult.vRecoveryBreakout.priorHigh, { kind: 'high', index: 23, price: 240.1, date: '2026-07-22' });
assert.equal(vRecoveryResult.vRecoveryBreakout.breakout.date, '2026-08-13');
assert.equal(vRecoveryResult.vRecoveryBreakout.breakout.close, 244.4);
const intradayHighOnly = [...real006208VRecovery, { date: '2026-08-14', open: 244.4, high: 250, low: 243.5, close: 249, volume: 0 }];
const intradayResult = api.classify(intradayHighOnly, { currentPrice: 249, securityType: 'ETF', completedDailyDate: '2026-08-11' });
assert.notEqual(intradayResult.noZoneSubtype, 'v_recovery_breakout_awaiting_hl');
console.log('market-context-zone tests passed');