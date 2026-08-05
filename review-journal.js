(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EtfDcaReviewJournal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ETF_STORAGE_KEY = 'etfDca.decisionJournal.v1';
  const TAR_STORAGE_KEY = 'tarObi.assessmentJournal.v1';
  const OUTCOME_STORAGE_KEY = 'etfDca.outcomeCheckpoints.v1';
  const PACKAGE_VERSION = 1;
  const REVIEW_SAMPLE_TARGET = 20;
  let latestReviewPackage = null;
  let activeBuild = null;

  function storageGet(key) {
    try { return root.localStorage?.getItem(key) ?? null; } catch (error) { return null; }
  }

  function storageSet(key, value) {
    try { root.localStorage?.setItem(key, value); return true; } catch (error) { return false; }
  }

  function readEntries(key) {
    try {
      const parsed = JSON.parse(storageGet(key) || 'null');
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch (error) {
      return [];
    }
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function caseKey(ticker, date) {
    return `${String(ticker || '').trim().toUpperCase()}|${date || ''}`;
  }

  function recordDate(entry) {
    return entry.quoteDate || String(entry.evaluatedAt || entry.recordedAt || '').slice(0, 10);
  }

  function isSetupSnapshot(entry) {
    return entry && Object.prototype.hasOwnProperty.call(entry, 'marketSessionState');
  }

  function groupCases(etfEntries, tarEntries) {
    const setupsByKey = new Map();
    const bridgesByKey = new Map();
    etfEntries.filter(isSetupSnapshot).forEach(entry => {
      const key = caseKey(entry.ticker, recordDate(entry));
      if (!setupsByKey.has(key)) setupsByKey.set(key, []);
      setupsByKey.get(key).push(entry);
    });
    etfEntries.filter(entry => entry?.events?.includes('BRIDGE_STARTED')).forEach(entry => {
      const key = caseKey(entry.ticker, recordDate(entry));
      if (!bridgesByKey.has(key)) bridgesByKey.set(key, []);
      bridgesByKey.get(key).push(entry);
    });

    return [...setupsByKey.entries()].map(([key, snapshots]) => {
      snapshots.sort((a, b) => Date.parse(a.evaluatedAt || a.recordedAt) - Date.parse(b.evaluatedAt || b.recordedAt));
      const bridges = (bridgesByKey.get(key) || []).sort((a, b) =>
        Date.parse(a.evaluatedAt || a.recordedAt) - Date.parse(b.evaluatedAt || b.recordedAt)
      );
      const cutoff = bridges.length ? Date.parse(bridges[0].evaluatedAt || bridges[0].recordedAt) : null;
      const eligible = cutoff === null
        ? snapshots
        : snapshots.filter(entry => Date.parse(entry.evaluatedAt || entry.recordedAt) <= cutoff);
      const setup = eligible.at(-1) || snapshots.at(-1);
      const bridgeIds = [...new Set(bridges.map(entry => entry.bridgeId).filter(Boolean))];
      const assessments = tarEntries.filter(entry =>
        caseKey(entry.ticker, recordDate(entry)) === key
        && (!bridgeIds.length || bridgeIds.includes(entry.bridgeId))
      );
      return { key, ticker: setup.ticker, date: recordDate(setup), setup, bridgeIds, assessments };
    }).sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
  }

  function normalizeCandles(candles) {
    return (Array.isArray(candles) ? candles : [])
      .map(candle => ({
        date: String(candle.date || candle.time || '').slice(0, 10),
        open: finiteNumber(candle.open), high: finiteNumber(candle.high),
        low: finiteNumber(candle.low), close: finiteNumber(candle.close),
        volume: finiteNumber(candle.volume)
      }))
      .filter(candle => candle.date && candle.close !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  function checkpoint(candles, index, baseline) {
    const candle = candles[index];
    if (!candle || !(baseline > 0)) return null;
    const window = candles.slice(0, index + 1);
    const highs = window.map(item => item.high).filter(Number.isFinite);
    const lows = window.map(item => item.low).filter(Number.isFinite);
    return {
      date: candle.date,
      close: candle.close,
      changePct: (candle.close - baseline) / baseline * 100,
      maxHighPct: highs.length ? (Math.max(...highs) - baseline) / baseline * 100 : null,
      maxDrawdownPct: lows.length ? (Math.min(...lows) - baseline) / baseline * 100 : null
    };
  }

  function calculateOutcome(item, candles) {
    const future = normalizeCandles(candles).filter(candle => candle.date > item.date);
    const baseline = finiteNumber(item.setup.currentPrice)
      ?? finiteNumber(item.setup.previousClose)
      ?? finiteNumber(item.setup.open);
    return {
      caseKey: item.key,
      ticker: item.ticker,
      setupDate: item.date,
      baselinePrice: baseline,
      day1: checkpoint(future, 0, baseline),
      day3: checkpoint(future, 2, baseline),
      day5: checkpoint(future, 4, baseline),
      updatedAt: new Date().toISOString()
    };
  }

  function readOutcomes() {
    try {
      const parsed = JSON.parse(storageGet(OUTCOME_STORAGE_KEY) || 'null');
      return parsed?.version === PACKAGE_VERSION && parsed.items && typeof parsed.items === 'object'
        ? parsed.items
        : {};
    } catch (error) {
      return {};
    }
  }

  function writeOutcomes(items) {
    return storageSet(OUTCOME_STORAGE_KEY, JSON.stringify({
      version: PACKAGE_VERSION,
      updatedAt: new Date().toISOString(),
      items
    }));
  }

  function average(values) {
    const valid = values.filter(Number.isFinite);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  }

  function groupedOutcome(cases, field) {
    const groups = {};
    cases.forEach(item => {
      const raw = field(item);
      const key = raw === null || raw === undefined || raw === '' ? 'UNAVAILABLE' : String(raw);
      groups[key] ||= [];
      groups[key].push(item);
    });
    return Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, {
      cases: items.length,
      completed5d: items.filter(item => item.outcome?.day5).length,
      average1dPct: average(items.map(item => item.outcome?.day1?.changePct)),
      average3dPct: average(items.map(item => item.outcome?.day3?.changePct)),
      average5dPct: average(items.map(item => item.outcome?.day5?.changePct))
    }]));
  }

  function summarize(cases, etfEntries, tarEntries) {
    const completed5d = cases.filter(item => item.outcome?.day5).length;
    const stateCounts = {};
    tarEntries.forEach(entry => {
      const state = entry.assessmentState || 'UNAVAILABLE';
      stateCounts[state] = (stateCounts[state] || 0) + 1;
    });
    return {
      setupCases: cases.length,
      completed1dCases: cases.filter(item => item.outcome?.day1).length,
      completed3dCases: cases.filter(item => item.outcome?.day3).length,
      completed5dCases: completed5d,
      sampleTarget: REVIEW_SAMPLE_TARGET,
      reviewReady: completed5d >= REVIEW_SAMPLE_TARGET,
      remainingToTarget: Math.max(0, REVIEW_SAMPLE_TARGET - completed5d),
      etfEventRecords: etfEntries.length,
      tarAssessmentRecords: tarEntries.length,
      assessmentStateCounts: stateCounts,
      byGapDirection: groupedOutcome(cases, item => item.setup.gapContext?.direction),
      byGapZoneRelation: groupedOutcome(cases, item => item.setup.gapContext?.zoneRelation),
      byC1: groupedOutcome(cases, item => item.setup.C1?.met === true ? 'MET' : 'NOT_MET'),
      byC2: groupedOutcome(cases, item => item.setup.C2?.met === true ? 'MET' : 'NOT_MET'),
      byC3: groupedOutcome(cases, item => item.setup.C3?.met === true ? 'MET' : 'NOT_MET'),
      byC4: groupedOutcome(cases, item => item.setup.C4?.classification || item.setup.C4?.decision)
    };
  }

  function safeCase(item, outcome) {
    return {
      caseKey: item.key,
      ticker: item.ticker,
      date: item.date,
      setup: item.setup,
      bridgeIds: item.bridgeIds,
      assessments: item.assessments,
      outcome
    };
  }

  /**
   * Builds a privacy-filtered review package and updates 1/3/5 trading-day outcomes.
   * @param {object} options Review options including an async fetchCandles(ticker, fromDate) callback.
   * @returns {Promise<object>} Complete deterministic review package.
   */
  async function buildReviewPackage(options = {}) {
    const etfEntries = readEntries(ETF_STORAGE_KEY);
    const tarEntries = readEntries(TAR_STORAGE_KEY);
    const grouped = groupCases(etfEntries, tarEntries);
    const outcomes = readOutcomes();
    const fetchCandles = typeof options.fetchCandles === 'function' ? options.fetchCandles : null;
    const byTicker = new Map();
    grouped.forEach(item => {
      if (!byTicker.has(item.ticker) || item.date < byTicker.get(item.ticker)) byTicker.set(item.ticker, item.date);
    });

    if (fetchCandles) {
      for (const [ticker, fromDate] of byTicker.entries()) {
        try {
          const candles = await fetchCandles(ticker, fromDate);
          grouped.filter(item => item.ticker === ticker).forEach(item => {
            outcomes[item.key] = calculateOutcome(item, candles);
          });
        } catch (error) {
          grouped.filter(item => item.ticker === ticker && !outcomes[item.key]).forEach(item => {
            outcomes[item.key] = {
              caseKey: item.key, ticker, setupDate: item.date,
              baselinePrice: finiteNumber(item.setup.currentPrice),
              day1: null, day3: null, day5: null,
              updatedAt: new Date().toISOString(), dataError: String(error?.message || error)
            };
          });
        }
      }
      writeOutcomes(outcomes);
    }

    const cases = grouped.map(item => safeCase(item, outcomes[item.key] || null));
    return {
      packageVersion: PACKAGE_VERSION,
      generatedAt: new Date().toISOString(),
      purpose: 'Retrospective ETF_DCA-plan and TAR-OBI decision review',
      privacy: {
        excluded: ['Fugle API key', 'GitHub PAT', 'portfolio values', 'order history', 'personal information'],
        storage: 'Browser localStorage; exported only by explicit user action'
      },
      methodology: {
        caseUnit: 'Latest ETF setup snapshot per ticker and trading date',
        checkpoints: ['next trading day', 'third subsequent trading day', 'fifth subsequent trading day'],
        baseline: 'Recorded setup current price with previous close/open fallback',
        caution: 'Descriptive retrospective evidence only; no trading rule is changed automatically.'
      },
      summary: summarize(cases, etfEntries, tarEntries),
      cases,
      rawRecords: { etfDecisionJournal: etfEntries, tarAssessmentJournal: tarEntries }
    };
  }

  function download(name, content, type) {
    if (!root.document || !root.URL || typeof root.Blob !== 'function') return false;
    const url = root.URL.createObjectURL(new root.Blob([content], { type }));
    const link = root.document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    root.URL.revokeObjectURL(url);
    return true;
  }

  /** Downloads the complete review package as JSON. */
  function downloadJson(reviewPackage) {
    const date = String(reviewPackage?.generatedAt || new Date().toISOString()).slice(0, 10);
    return download(`etf-tar-obi-review-${date}.json`, JSON.stringify(reviewPackage, null, 2), 'application/json');
  }

  function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  /** Downloads one-row-per-case outcome checkpoints as CSV. */
  function downloadCsv(reviewPackage) {
    const columns = ['ticker', 'date', 'baselinePrice', 'gapDirection', 'gapPct', 'zoneRelation', 'C1', 'C2', 'C3', 'C4', 'day1Pct', 'day3Pct', 'day5Pct', 'maxHigh5dPct', 'maxDrawdown5dPct'];
    const rows = (reviewPackage?.cases || []).map(item => [
      item.ticker, item.date, item.outcome?.baselinePrice,
      item.setup?.gapContext?.direction, item.setup?.gapContext?.percent,
      item.setup?.gapContext?.zoneRelation,
      item.setup?.C1?.met, item.setup?.C2?.met, item.setup?.C3?.met,
      item.setup?.C4?.classification || item.setup?.C4?.decision,
      item.outcome?.day1?.changePct, item.outcome?.day3?.changePct,
      item.outcome?.day5?.changePct, item.outcome?.day5?.maxHighPct,
      item.outcome?.day5?.maxDrawdownPct
    ]);
    const csv = [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    const date = String(reviewPackage?.generatedAt || new Date().toISOString()).slice(0, 10);
    return download(`etf-tar-obi-review-${date}.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
  }

  function percent(value) {
    return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : 'Pending';
  }

  function renderSummary(container, reviewPackage) {
    const summary = reviewPackage.summary;
    container.innerHTML = '';
    const headline = root.document.createElement('div');
    headline.style.cssText = 'font-size:12px;font-weight:700;margin-top:8px';
    headline.textContent = summary.reviewReady
      ? `Review sample ready: ${summary.completed5dCases} completed 5-day cases.`
      : `${summary.completed5dCases}/${summary.sampleTarget} completed 5-day cases · ${summary.remainingToTarget} more recommended.`;
    container.appendChild(headline);
    const meta = root.document.createElement('div');
    meta.style.cssText = 'font-size:11px;color:var(--muted);margin-top:4px';
    meta.textContent = `${summary.setupCases} setup cases · ${summary.etfEventRecords} ETF events · ${summary.tarAssessmentRecords} TAR assessments`;
    container.appendChild(meta);

    const table = root.document.createElement('div');
    table.style.cssText = 'margin-top:8px;display:grid;gap:4px;font-size:11px';
    reviewPackage.cases.slice(-10).reverse().forEach(item => {
      const row = root.document.createElement('div');
      row.style.cssText = 'padding-top:4px;border-top:1px solid var(--border)';
      row.textContent = `${item.date} ${item.ticker} · 1D ${percent(item.outcome?.day1?.changePct)} · 3D ${percent(item.outcome?.day3?.changePct)} · 5D ${percent(item.outcome?.day5?.changePct)}`;
      table.appendChild(row);
    });
    container.appendChild(table);
  }

  /**
   * Renders user-triggered Review Journal and export controls.
   * @param {HTMLElement} container Target container.
   * @param {object} options Includes fetchCandles and optional toast callback.
   * @returns {void}
   */
  function renderControls(container, options = {}) {
    if (!container || !root.document) return;
    container.innerHTML = `
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
        <button type="button" class="btn btn-primary btn-sm" data-review-generate>Review Journal</button>
        <button type="button" class="btn btn-outline btn-sm" data-review-json disabled>Download JSON</button>
        <button type="button" class="btn btn-outline btn-sm" data-review-csv disabled>Download CSV</button>
      </div>
      <div data-review-status style="font-size:10px;color:var(--muted);margin-top:6px">Review is generated only when you trigger it.</div>
      <div data-review-summary></div>`;
    const generate = container.querySelector('[data-review-generate]');
    const json = container.querySelector('[data-review-json]');
    const csv = container.querySelector('[data-review-csv]');
    const status = container.querySelector('[data-review-status]');
    const summary = container.querySelector('[data-review-summary]');
    let reviewPackage = latestReviewPackage;
    if (reviewPackage) {
      renderSummary(summary, reviewPackage);
      json.disabled = false;
      csv.disabled = false;
      status.textContent = 'Review ready. Download JSON for Codex analysis; CSV is available for your own reference.';
    } else if (activeBuild) {
      generate.disabled = true;
      status.textContent = 'Collecting later prices and building the review…';
    }
    generate.addEventListener('click', async () => {
      if (activeBuild) return;
      generate.disabled = true;
      status.textContent = 'Collecting later prices and building the review…';
      try {
        activeBuild = buildReviewPackage({ fetchCandles: options.fetchCandles });
        reviewPackage = await activeBuild;
        latestReviewPackage = reviewPackage;
        renderSummary(summary, reviewPackage);
        json.disabled = false;
        csv.disabled = false;
        status.textContent = 'Review ready. Download JSON for Codex analysis; CSV is available for your own reference.';
        options.toast?.('Review Journal generated.', 'ok');
      } catch (error) {
        status.textContent = `Review failed: ${error.message}`;
        options.toast?.(`Review failed: ${error.message}`, 'err');
      } finally {
        activeBuild = null;
        generate.disabled = false;
      }
    });
    json.addEventListener('click', () => reviewPackage && downloadJson(reviewPackage));
    csv.addEventListener('click', () => reviewPackage && downloadCsv(reviewPackage));
  }

  return Object.freeze({
    ETF_STORAGE_KEY, TAR_STORAGE_KEY, OUTCOME_STORAGE_KEY, PACKAGE_VERSION,
    REVIEW_SAMPLE_TARGET, groupCases, calculateOutcome, buildReviewPackage,
    downloadJson, downloadCsv, renderControls
  });
});
