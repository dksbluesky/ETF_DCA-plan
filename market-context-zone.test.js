const assert = require('assert');
const api = require('./market-context-zone.js');
function bars(values) { return values.map((close, index) => ({ date: `2026-01-${String(index + 1).padStart(2, '0')}`, open: close - .2, high: close + .5, low: close - .6, close, volume: 1000 })); }
const values = [10,11,12,20,15,14,13,14,15,16,24,19,18,17,18,19,20,28,23,22,21,22,23,24,32,27,26,25,26,27,28,36,31,30,29,30,31,32,40,35,34,33,34,35,36,44,39,38,37,38,39,40,48,43,42,41,42,43,44,52];
const result = api.classify(bars(values), { currentPrice: 52, securityType: 'ETF' });
assert.equal(result.context, 'bullish'); assert.equal(result.automaticZoneEligible, true); assert.ok(result.activeZone.low < result.activeZone.high);
console.log('market-context-zone tests passed');