(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ManualZoneReassessment = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DAILY_TIMEFRAME = 'daily';
  const DEFAULT_THRESHOLD = 3;
  const DEFAULT_MIN_OPERATIONAL_TICKS = 2;
  const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const positiveInteger = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

  function normalize(state = {}) {
    const draft = state.manualDraft && typeof state.manualDraft === 'object' ? state.manualDraft : {};
    const applied = state.activeManualZone && typeof state.activeManualZone === 'object' ? state.activeManualZone : null;
    return {
      threshold: positiveInteger(state.threshold, DEFAULT_THRESHOLD),
      minOperationalTicks: positiveInteger(state.minOperationalTicks, DEFAULT_MIN_OPERATIONAL_TICKS),
      counter: Math.max(0, Number.isInteger(Number(state.counter)) ? Number(state.counter) : 0),
      sequenceTimeframe: typeof state.sequenceTimeframe === 'string' ? state.sequenceTimeframe : null,
      trackingBaselinePeriod: typeof state.trackingBaselinePeriod === 'string' ? state.trackingBaselinePeriod : null,
      lastCountedPeriod: typeof state.lastCountedPeriod === 'string' ? state.lastCountedPeriod : null,
      latestSnapshot: state.latestSnapshot && typeof state.latestSnapshot === 'object' ? { ...state.latestSnapshot } : null,
      snapshots: Array.isArray(state.snapshots) ? state.snapshots.map(snapshot => ({ ...snapshot })) : [],
      manualDraft: { low: number(draft.low), high: number(draft.high), edited: draft.edited === true },
      activeManualZone: applied && number(applied.low) !== null && number(applied.high) !== null ? { low: number(applied.low), high: number(applied.high) } : null,
      manualZoneSource: state.manualZoneSource === 'MANUAL' ? 'MANUAL' : null,
      manualAppliedAt: typeof state.manualAppliedAt === 'string' ? state.manualAppliedAt : null,
      readyNotifiedPeriod: typeof state.readyNotifiedPeriod === 'string' ? state.readyNotifiedPeriod : null
    };
  }

  function suggestedZone(aggressive, conservative, tickSize, minOperationalTicks = DEFAULT_MIN_OPERATIONAL_TICKS) {
    const aggressiveLow = number(aggressive?.zoneLow), aggressiveHigh = number(aggressive?.zoneHigh);
    const conservativeLow = number(conservative?.zoneLow), conservativeHigh = number(conservative?.zoneHigh);
    const low = aggressiveLow, high = conservativeHigh, tick = number(tickSize);
    if (low === null || high === null) return { status: 'UNAVAILABLE', low, high, aggressiveLow, aggressiveHigh, conservativeLow, conservativeHigh, tickSize: tick, widthTicks: null };
    if (high <= low) return { status: 'INVALID_SUGGESTED_ZONE', low, high, aggressiveLow, aggressiveHigh, conservativeLow, conservativeHigh, tickSize: tick, widthTicks: null };
    const widthTicks = tick && tick > 0 ? (high - low) / tick : null;
    return { status: widthTicks !== null && widthTicks < positiveInteger(minOperationalTicks, DEFAULT_MIN_OPERATIONAL_TICKS) - 1e-9 ? 'ZONE_TOO_NARROW' : 'VALID', low, high, aggressiveLow, aggressiveHigh, conservativeLow, conservativeHigh, tickSize: tick, widthTicks };
  }

  function startSequence(state, timeframe, baselinePeriod = null) {
    return { ...normalize(state), counter: 0, sequenceTimeframe: timeframe, trackingBaselinePeriod: baselinePeriod || null, lastCountedPeriod: null, latestSnapshot: null, snapshots: [], readyNotifiedPeriod: null };
  }
  function prefillDraft(state, zone) {
    const next = normalize(state);
    return next.manualDraft.edited || !zone || ['UNAVAILABLE', 'INVALID_SUGGESTED_ZONE'].includes(zone.status) ? next : { ...next, manualDraft: { low: zone.low, high: zone.high, edited: false } };
  }
  function setDraft(state, low, high) { return { ...normalize(state), manualDraft: { low: number(low), high: number(high), edited: true } }; }
  function setThreshold(state, threshold) { return { ...normalize(state), threshold: positiveInteger(threshold, DEFAULT_THRESHOLD) }; }
  function setMinOperationalTicks(state, minOperationalTicks) { return { ...normalize(state), minOperationalTicks: positiveInteger(minOperationalTicks, DEFAULT_MIN_OPERATIONAL_TICKS) }; }
  function resetCounter(state) { return { ...normalize(state), counter: 0, latestSnapshot: null, readyNotifiedPeriod: null }; }
  function applyManualZone(state, low, high, appliedAt) {
    const next = setDraft(state, low ?? normalize(state).manualDraft.low, high ?? normalize(state).manualDraft.high);
    if (next.manualDraft.low === null || next.manualDraft.high === null || next.manualDraft.high <= next.manualDraft.low) return { state: next, applied: false };
    return { state: { ...next, activeManualZone: { low: next.manualDraft.low, high: next.manualDraft.high }, manualZoneSource: 'MANUAL', manualAppliedAt: appliedAt || new Date().toISOString() }, applied: true };
  }

  function evaluateDaily(state, input = {}) {
    let next = normalize(state);
    const period = typeof input.period === 'string' ? input.period : null;
    if (input.timeframe !== DAILY_TIMEFRAME) return { state: next, evaluated: false, active: false, reason: 'DAILY_ONLY' };
    if (!period) return { state: next, evaluated: false, active: true, reason: 'NO_COMPLETED_PERIOD' };
    if (next.sequenceTimeframe !== DAILY_TIMEFRAME) return { state: startSequence(next, DAILY_TIMEFRAME, period), evaluated: false, active: true, reason: 'TRACKING_STARTED' };
    if (!next.trackingBaselinePeriod) return { state: { ...next, trackingBaselinePeriod: period }, evaluated: false, active: true, reason: 'TRACKING_STARTED' };
    if (period === next.trackingBaselinePeriod || period === next.lastCountedPeriod) return { state: next, evaluated: false, active: true, reason: 'ALREADY_PROCESSED' };
    const close = number(input.close), zone = input.zone;
    if (close === null || !zone || !['VALID', 'ZONE_TOO_NARROW'].includes(zone.status)) return { state: next, evaluated: false, active: true, reason: 'ZONE_OR_CLOSE_UNAVAILABLE' };
    const qualified = close > zone.high, counter = qualified ? next.counter + 1 : 0;
    const snapshot = { tradingDate: period, aggressiveLow: zone.aggressiveLow, aggressiveHigh: zone.aggressiveHigh, conservativeLow: zone.conservativeLow, conservativeHigh: zone.conservativeHigh, suggestedZoneLow: zone.low, suggestedZoneHigh: zone.high, closingPrice: close, result: qualified ? 'ABOVE_SUGGESTED_ZONE' : close >= zone.low ? 'INSIDE_SUGGESTED_ZONE' : 'BELOW_SUGGESTED_ZONE', counterAfter: counter };
    const readyJustReached = next.counter < next.threshold && counter >= next.threshold;
    next = { ...next, counter, lastCountedPeriod: period, latestSnapshot: snapshot, snapshots: [...next.snapshots, snapshot] };
    return { state: next, evaluated: true, active: true, readyJustReached, snapshot };
  }
  function markReadyNotified(state, period) { return { ...normalize(state), readyNotifiedPeriod: period || null }; }
  return { DAILY_TIMEFRAME, DEFAULT_THRESHOLD, DEFAULT_MIN_OPERATIONAL_TICKS, normalize, suggestedZone, startSequence, prefillDraft, setDraft, setThreshold, setMinOperationalTicks, resetCounter, applyManualZone, evaluateDaily, markReadyNotified };
});