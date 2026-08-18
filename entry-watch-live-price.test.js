'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

assert.match(
  html,
  /intraday\/quote\/\$\{ticker\}`,\s*\{\s*headers:\s*\{\s*'X-API-KEY':\s*fugleKey\s*\},\s*cache:\s*'no-store'\s*\}/,
  'ETF Fugle quote requests bypass browser cache'
);
assert.match(
  html,
  /const price = today\.close;\s*const displayedPrice = isIntraday && Number\.isFinite\(Number\(_watchQuote\?\.price\)\)/,
  'raw Entry Watch calculations retain the merged daily-candle close'
);
assert.match(
  html,
  /現價 Price NT\$\$\{displayedPrice\.toFixed\(2\)\}/,
  'visible intraday price uses the current Fugle quote'
);
assert.match(
  html,
  /last\.close = quote\.price;/,
  'the existing current-day candle merge remains intact'
);

assert.match(
  html,
  /const WATCH_AUTO_REFRESH_MS = 10 \* 1000;/,
  'Entry Watch refreshes every 10 seconds while open'
);
assert.match(
  html,
  /function startWatchAutoRefresh\(listType, posId\)[\s\S]*?setInterval\([\s\S]*?refreshWatchLivePrice\(listType, posId\)/,
  'auto-refresh reuses the existing Entry Watch refresh path'
);
assert.match(
  html,
  /if \(document\.hidden\) return;/,
  'auto-refresh pauses while the page is hidden'
);
assert.match(
  html,
  /function closeModal\(\) \{ stopWatchAutoRefresh\(\);/,
  'closing the modal stops Entry Watch polling'
);
assert.match(
  html,
  /async function refreshWatchLivePrice\(listType, posId\)[\s\S]*?fetchLivePrice\(pos\.ticker\)[\s\S]*?recomputeWatchStatus\(\)/,
  'automatic polling refreshes only the live quote and reuses the existing Entry Watch calculation'
);
console.log('Entry Watch live-price alignment tests passed.');
assert.match(html, /function completedDailyCandleForReassessment\([\s\S]*?_watchQuote\?\.state === 'REGULAR' \? _watchCandles\.at\(-2\)/, 'Reassessment uses the last completed Daily candle during regular trading');
assert.match(html, /quote\?\.state === 'CLOSED' && previousQuoteState !== 'CLOSED'[\s\S]*?recalculateMarketLevelSuggestions/, 'A completed close refreshes Daily reassessment data');