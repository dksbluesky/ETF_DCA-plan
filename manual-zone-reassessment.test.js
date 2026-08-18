'use strict';
const assert = require('node:assert/strict');
const R = require('./manual-zone-reassessment.js');
const aggressive = { zoneLow: 241.45, zoneHigh: 245.90 };
const conservative = { zoneLow: 237.05, zoneHigh: 241.50 };
let zone = R.suggestedZone(aggressive, conservative, 0.05);
assert.deepEqual([zone.low, zone.high, zone.status], [241.45, 241.5, 'ZONE_TOO_NARROW']);
zone = R.suggestedZone({ zoneLow: 240, zoneHigh: 245 }, { zoneLow: 235, zoneHigh: 240.15 }, 0.05);
assert.equal(zone.status, 'VALID');
assert.equal(R.suggestedZone({ zoneLow: 241.5 }, { zoneHigh: 241.45 }, 0.05).status, 'INVALID_SUGGESTED_ZONE');
let state = R.normalize();
state = R.prefillDraft(state, zone);
assert.deepEqual(state.manualDraft, { low: 240, high: 240.15, edited: false, editedAt: null });
state = R.setDraft(state, 239.8, 240.4);
state = R.prefillDraft(state, R.suggestedZone({ zoneLow: 241 }, { zoneHigh: 242 }, 0.05));
assert.equal(state.manualDraft.edited, true);
assert.equal(state.manualDraft.low, 239.8);
assert.equal(state.manualDraft.high, 240.4);
let applied = R.applyManualZone(state, undefined, undefined, '2026-08-18T00:00:00.000Z');
assert.equal(applied.applied, true);
assert.deepEqual(applied.state.activeManualZone, { low: 239.8, high: 240.4 });
assert.equal(applied.state.manualZoneSource, 'MANUAL');
assert.equal(applied.state.manualDraft.edited, false, 'applying separates the Active Manual Zone from the next editable draft');
state = R.prefillDraft(applied.state, R.suggestedZone({ zoneLow: 242 }, { zoneHigh: 243 }, 0.05));
assert.deepEqual(state.manualDraft, { low: 242, high: 243, edited: false, editedAt: null }, 'an unapplied draft follows the latest Suggested Zone after Apply Manual');
assert.deepEqual(state.activeManualZone, { low: 239.8, high: 240.4 }, 'a later Suggested Zone does not alter the applied Active Manual Zone');
assert.equal(R.applyManualZone(R.setDraft(R.normalize(), 241.5, 242), undefined, undefined, undefined, R.suggestedZone({ zoneLow: 241.5 }, { zoneHigh: 241.45 }, 0.05)).applied, false, 'an invalid Suggested Zone cannot be applied');
const legacyAppliedState = {
  manualDraft: { low: 237.05, high: 237.85, edited: true },
  activeManualZone: { low: 237.05, high: 237.85 },
  manualZoneSource: 'MANUAL',
  manualAppliedAt: '2026-08-17T00:00:00.000Z'
};
state = R.migrateLegacyAppliedDraft(legacyAppliedState);
state = R.prefillDraft(state, R.suggestedZone({ zoneLow: 237.60 }, { zoneHigh: 237.75 }, 0.05));
assert.deepEqual(state.manualDraft, { low: 237.60, high: 237.75, edited: false, editedAt: null }, 'legacy Apply-only draft flag migrates to the latest Suggested Zone');
assert.deepEqual(state.activeManualZone, { low: 237.05, high: 237.85 }, 'legacy migration never changes the Active Manual Zone');
const genuineDraft = R.setDraft(legacyAppliedState, 237.1, 237.9, '2026-08-18T00:00:00.000Z');
assert.equal(R.migrateLegacyAppliedDraft(genuineDraft).manualDraft.edited, true, 'a current user-edited draft is not migrated');
state = R.evaluateDaily(R.normalize(), { timeframe: 'daily', period: '2026-08-10', close: 241, zone }).state;
assert.equal(state.counter, 0, 'first completed candle starts a baseline only');
state = R.evaluateDaily(state, { timeframe: 'daily', period: '2026-08-11', close: 241, zone }).state;
assert.equal(state.counter, 1);
const changedZone = R.suggestedZone({ zoneLow: 242, zoneHigh: 245 }, { zoneLow: 238, zoneHigh: 242.1 }, 0.05);
state = R.evaluateDaily(state, { timeframe: 'daily', period: '2026-08-12', close: 243, zone: changedZone }).state;
assert.equal(state.counter, 2, 'each completed close uses that day’s suggested zone');
state = R.evaluateDaily(state, { timeframe: 'daily', period: '2026-08-13', close: 242.05, zone: changedZone }).state;
assert.equal(state.counter, 0, 'inside today’s zone resets');
state = R.evaluateDaily(state, { timeframe: 'daily', period: '2026-08-14', close: 240, zone: changedZone }).state;
assert.equal(state.counter, 0, 'below today’s zone resets');
assert.equal(R.evaluateDaily(state, { timeframe: 'daily', period: '2026-08-14', close: 250, zone: changedZone }).evaluated, false, 'period is counted only once');
assert.equal(R.evaluateDaily(state, { timeframe: 'weekly', period: '2026-W33', close: 250, zone: changedZone }).active, false, 'weekly counting is inactive');
state = R.startSequence({ ...state, snapshots: [{ tradingDate: 'old' }], counter: 2 }, 'weekly');
assert.deepEqual([state.counter, state.snapshots.length], [0, 0], 'timeframe change clears only the reassessment sequence');
state = R.setThreshold(state, 2);
assert.equal(state.threshold, 2);
assert.equal(R.resetCounter({ ...state, counter: 2 }).counter, 0);
console.log('Manual reassessment tests passed.');