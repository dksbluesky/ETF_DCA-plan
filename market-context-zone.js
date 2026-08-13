(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EtfDcaMarketContextZone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULT_PARAMETERS = Object.freeze({ swingWindow: 3, minimumCandles: 30, shallowPullbackAtr: 1.25, vRecoveryBars: 6, vRecoveryFraction: 0.8, zoneHalfWidthAtr: 0.35 });
  const finite = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };
  function ema(candles, period) { if (!Array.isArray(candles) || candles.length < period) return null; const k = 2 / (period + 1); let value = candles.slice(0, period).reduce((sum, bar) => sum + Number(bar.close), 0) / period; for (let i = period; i < candles.length; i++) value = Number(candles[i].close) * k + value * (1 - k); return value; }
  function atr(candles, period = 14) { if (!Array.isArray(candles) || candles.length < 2) return null; const values = []; for (let i = 1; i < candles.length; i++) { const bar = candles[i], previous = candles[i - 1]; values.push(Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close))); } const sample = values.slice(-period); return sample.length ? sample.reduce((sum, value) => sum + value, 0) / sample.length : null; }
  function pivots(candles, span) { const result = []; for (let i = span; i < candles.length - span; i++) { const bar = candles[i], left = candles.slice(i - span, i), right = candles.slice(i + 1, i + span + 1); if (left.every(x => bar.low < x.low) && right.every(x => bar.low <= x.low)) result.push({ kind: 'low', index: i, price: bar.low, date: bar.date }); if (left.every(x => bar.high > x.high) && right.every(x => bar.high >= x.high)) result.push({ kind: 'high', index: i, price: bar.high, date: bar.date }); } return result; }
  function bullishFvgNear(candles, level, range) { for (let i = Math.max(2, candles.length - 15); i < candles.length; i++) if (candles[i].low > candles[i - 2].high && Math.abs(candles[i - 2].high - level) <= range) return { low: candles[i - 2].high, high: candles[i].low, date: candles[i].date }; return null; }
  function tickFor(price, type) { if (String(type).toUpperCase() === 'ETF') return price < 50 ? 0.01 : 0.05; if (price < 10) return 0.01; if (price < 50) return 0.05; if (price < 100) return 0.1; if (price < 500) return 0.5; if (price < 1000) return 1; return 5; }
  const snap = (value, tick) => +(Math.round(value / tick) * tick).toFixed(2);
  const noZone = (context, evidence, reason) => ({ context, zoneType: null, automaticZoneEligible: false, activeZone: null, invalidationLevel: null, reason, evidence, parameters: DEFAULT_PARAMETERS });
  /** Classifies completed-candle structure and selects one retracement zone, if valid. It does not change Entry Watch C1-C4 or create a trading decision. */
  function classify(candles, options = {}) {
    const bars = (Array.isArray(candles) ? candles : []).filter(bar => finite(bar.open) !== null && finite(bar.high) !== null && finite(bar.low) !== null && finite(bar.close) !== null);
    if (bars.length < DEFAULT_PARAMETERS.minimumCandles) return noZone('unclear', { structure: ['Insufficient completed candles'], ema: [], supportResistance: [], fvg: [] }, 'Insufficient completed candles');
    const current = finite(options.currentPrice) || finite(bars.at(-1).close), range = atr(bars), ema20 = ema(bars, 20);
    if (!(current > 0) || !(range > 0) || ema20 === null) return noZone('unclear', { structure: ['Required context data unavailable'], ema: [], supportResistance: [], fvg: [] }, 'Required context data unavailable');
    const swings = pivots(bars, DEFAULT_PARAMETERS.swingWindow), lows = swings.filter(item => item.kind === 'low'), highs = swings.filter(item => item.kind === 'high');
    const lastLow = lows.at(-1), priorLow = lows.at(-2), lastHigh = highs.at(-1), priorHigh = highs.at(-2);
    const higherLow = Boolean(lastLow && priorLow && lastLow.price > priorLow.price), higherHigh = Boolean(lastHigh && priorHigh && lastHigh.price > priorHigh.price), lowerLow = Boolean(lastLow && priorLow && lastLow.price < priorLow.price), lowerHigh = Boolean(lastHigh && priorHigh && lastHigh.price < priorHigh.price);
    const previousEma20 = ema(bars.slice(0, -1), 20), emaSlope = previousEma20 === null ? 0 : ema20 - previousEma20;
    const bullish = higherLow && higherHigh && current >= ema20 && emaSlope >= 0, bearish = lowerLow && lowerHigh && current <= ema20 && emaSlope <= 0;
    const overlap = bars.slice(-6).filter((bar, index, sample) => index > 0 && bar.low <= sample[index - 1].high && bar.high >= sample[index - 1].low).length, rangeLike = overlap >= 4 && Math.abs(emaSlope) <= range * 0.08;
    const evidence = { structure: [higherHigh && higherLow ? 'Higher High + Higher Low' : lowerHigh && lowerLow ? 'Lower High + Lower Low' : 'No confirmed directional swing sequence'], ema: [`Price ${current >= ema20 ? 'above' : 'below'} EMA20`, `EMA20 ${emaSlope >= 0 ? 'rising/flat' : 'falling'}`], supportResistance: lastLow ? [`Recent swing low ${lastLow.price} (${lastLow.date})`] : [], fvg: [] };
    if (bearish) return noZone('bearish', evidence, 'LL + LH with declining EMA context');
    if (rangeLike) return noZone('range', evidence, 'Bar overlap and flat EMA indicate a trading range/transition');
    if (!bullish || !lastLow || !lastHigh) return noZone('unclear', evidence, 'No sustained bullish HH + HL structure');
    const latestHighAfterLow = highs.filter(item => item.index > lastLow.index).at(-1), pullbackDepth = latestHighAfterLow ? latestHighAfterLow.price - lastLow.price : 0, shallow = pullbackDepth > 0 && pullbackDepth <= range * DEFAULT_PARAMETERS.shallowPullbackAtr;
    const precedingHigh = highs.filter(item => item.index < lastLow.index).at(-1), recovery = precedingHigh ? (lastHigh.price - lastLow.price) / Math.max(0.000001, precedingHigh.price - lastLow.price) : 0, rapidRecovery = precedingHigh && lastHigh.index - lastLow.index <= DEFAULT_PARAMETERS.vRecoveryBars && recovery >= DEFAULT_PARAMETERS.vRecoveryFraction;
    const zoneType = rapidRecovery ? 'v_reversal_continuation' : shallow ? 'shallow_trend_continuation' : 'pullback_reversal', tick = tickFor(current, options.securityType || 'Stock'), halfWidth = Math.max(range * DEFAULT_PARAMETERS.zoneHalfWidthAtr, tick * 2), fvg = bullishFvgNear(bars, lastLow.price, range * 0.6);
    if (fvg) evidence.fvg.push(`Bullish FVG ${fvg.low}–${fvg.high} (${fvg.date})`);
    evidence.supportResistance.push(`Selected Higher Low support ${lastLow.price} (${lastLow.date})`);
    return { context: 'bullish', zoneType, automaticZoneEligible: true, activeZone: { low: snap(Math.min(lastLow.price - halfWidth, fvg?.low ?? Infinity), tick), high: snap(Math.max(lastLow.price + halfWidth, fvg?.high ?? -Infinity), tick) }, invalidationLevel: snap(lastLow.price - Math.max(range * 0.75, tick * 3), tick), reason: zoneType === 'v_reversal_continuation' ? 'V recovery followed by confirmed HH + HL; zone is the Higher Low retest.' : zoneType === 'shallow_trend_continuation' ? 'Bullish HH + HL with a usable shallow Higher Low retest.' : 'Bullish pullback/reversal support zone.', evidence, parameters: DEFAULT_PARAMETERS };
  }
  return Object.freeze({ DEFAULT_PARAMETERS, classify });
});
