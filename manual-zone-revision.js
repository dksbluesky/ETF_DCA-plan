(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ManualZoneRevision = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const revisionMs = value => {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  function manualZone(position) {
    const criteria = position?.watchCriteria || {};
    const active = criteria.manualReassessment?.activeManualZone;
    const low = number(active?.low ?? (criteria.zoneMode === 'manual' ? criteria.zoneLow : null));
    const high = number(active?.high ?? (criteria.zoneMode === 'manual' ? criteria.zoneHigh : null));
    if (low === null || high === null || high <= low) return null;
    return { low, high, revision: criteria.manualReassessment?.manualAppliedAt || null };
  }
  function positions(data) {
    return ['dca', 'direct'].flatMap(listType => (data?.[listType] || []).map(position => ({ key: `${listType}:${position.id}`, listType, position })));
  }
  function findNewerRemoteManualZoneConflicts(localData, remoteData) {
    const localByKey = new Map(positions(localData).map(item => [item.key, manualZone(item.position)]));
    return positions(remoteData).flatMap(remoteItem => {
      const remote = manualZone(remoteItem.position);
      if (!remote) return [];
      const local = localByKey.get(remoteItem.key);
      if (local && local.low === remote.low && local.high === remote.high) return [];
      const remoteMs = revisionMs(remote.revision);
      const localMs = revisionMs(local?.revision);
      if (remoteMs !== null && (localMs === null || remoteMs > localMs)) return [{ ...remoteItem, local, remote, reason: 'REMOTE_NEWER' }];
      if (remoteMs === null) return [{ ...remoteItem, local, remote, reason: 'REMOTE_REVISION_UNKNOWN' }];
      return [];
    });
  }
  return { manualZone, findNewerRemoteManualZoneConflicts };
});