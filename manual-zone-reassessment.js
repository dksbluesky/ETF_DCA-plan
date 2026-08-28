(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ManualZoneReassessment = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DAILY_TIMEFRAME = 'daily';
  const DEFAULT_THRESHOLD = 3;
  const DEFAULT_MIN_OPERATIONAL_TICKS = 2;
  const number = value => value === '' || value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
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
      manualDraft: { low: number(draft.low), high: number(draft.high), edited: draft.edited === true, editedAt: typeof draft.editedAt === 'string' ? draft.editedAt : null, suggestedForDate: typeof draft.suggestedForDate === 'string' ? draft.suggestedForDate : null, editedForDate: typeof draft.editedForDate === 'string' ? draft.editedForDate : null },
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

  function manualZoneIsValid(low, high, tickSize = null) {
    const manualLow = number(low), manualHigh = number(high), tick = number(tickSize);
    if (manualLow === null || manualHigh === null || manualHigh <= manualLow) return false;
    if (tick === null || tick <= 0) return true;
    const isOnTick = value => Math.abs(value / tick - Math.round(value / tick)) < 1e-8;
    return isOnTick(manualLow) && isOnTick(manualHigh);
  }

  function explicitActiveManualZone(state, tickSize = null) {
    const next = normalize(state);
    const appliedAt = typeof next.manualAppliedAt === 'string' ? next.manualAppliedAt.trim() : '';
    if (next.manualZoneSource !== 'MANUAL' || !appliedAt || !Number.isFinite(Date.parse(appliedAt))) return null;
    if (!manualZoneIsValid(next.activeManualZone?.low, next.activeManualZone?.high, tickSize)) return null;
    return { low: next.activeManualZone.low, high: next.activeManualZone.high, manualAppliedAt: appliedAt };
  }

  function startSequence(state, timeframe, baselinePeriod = null) {
    return { ...normalize(state), counter: 0, sequenceTimeframe: timeframe, trackingBaselinePeriod: baselinePeriod || null, lastCountedPeriod: null, latestSnapshot: null, snapshots: [], readyNotifiedPeriod: null };
  }
  function prefillDraft(state, zone, suggestedForDate = null) {
    const next = normalize(state);
    const currentDate = typeof suggestedForDate === 'string' ? suggestedForDate : null;
    const editedForCurrentDate = next.manualDraft.edited && (!currentDate || next.manualDraft.editedForDate === currentDate);
    if (editedForCurrentDate) return next;
    if (!zone || ['UNAVAILABLE', 'INVALID_SUGGESTED_ZONE'].includes(zone.status)) {
      return { ...next, manualDraft: { low: null, high: null, edited: false, editedAt: null, suggestedForDate: currentDate || next.manualDraft.suggestedForDate, editedForDate: null } };
    }
    return { ...next, manualDraft: { low: zone.low, high: zone.high, edited: false, editedAt: null, suggestedForDate: currentDate || next.manualDraft.suggestedForDate, editedForDate: null } };
  }
  function setDraft(state, low, high, editedAt = new Date().toISOString(), editedForDate = null) {
    const next = normalize(state);
    const currentDate = typeof editedForDate === 'string' ? editedForDate : next.manualDraft.suggestedForDate;
    return { ...next, manualDraft: { low: number(low), high: number(high), edited: true, editedAt, suggestedForDate: currentDate, editedForDate: currentDate } };
  }
  function migrateLegacyAppliedDraft(state) {
    const next = normalize(state);
    const draft = next.manualDraft, active = next.activeManualZone;
    const staleLegacyApplyFlag = draft.edited && !draft.editedAt && next.manualAppliedAt && active && draft.low === active.low && draft.high === active.high;
    return staleLegacyApplyFlag ? { ...next, manualDraft: { ...draft, edited: false, editedAt: null } } : next;
  }
  function setThreshold(state, threshold) { return { ...normalize(state), threshold: positiveInteger(threshold, DEFAULT_THRESHOLD) }; }
  function setMinOperationalTicks(state, minOperationalTicks) { return { ...normalize(state), minOperationalTicks: positiveInteger(minOperationalTicks, DEFAULT_MIN_OPERATIONAL_TICKS) }; }
  function resetCounter(state) { return { ...normalize(state), counter: 0, latestSnapshot: null, readyNotifiedPeriod: null }; }
  function applyManualZone(state, low, high, appliedAt, suggestedZone = null) {
    const next = setDraft(state, low ?? normalize(state).manualDraft.low, high ?? normalize(state).manualDraft.high);
    if (!manualZoneIsValid(next.manualDraft.low, next.manualDraft.high, suggestedZone?.tickSize)) return { state: next, applied: false };
    return { state: { ...next, manualDraft: { low: next.manualDraft.low, high: next.manualDraft.high, edited: false, editedAt: null }, activeManualZone: { low: next.manualDraft.low, high: next.manualDraft.high }, manualZoneSource: 'MANUAL', manualAppliedAt: appliedAt || new Date().toISOString() }, applied: true };
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
  return { DAILY_TIMEFRAME, DEFAULT_THRESHOLD, DEFAULT_MIN_OPERATIONAL_TICKS, normalize, suggestedZone, manualZoneIsValid, explicitActiveManualZone, startSequence, prefillDraft, setDraft, migrateLegacyAppliedDraft, setThreshold, setMinOperationalTicks, resetCounter, applyManualZone, evaluateDaily, markReadyNotified };
});
