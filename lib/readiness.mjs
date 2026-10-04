// One status contract for the home card and campaign dashboard.
export function launchReadiness({assets = [], run = null, readyRelease = null, driftMessage = null}) {
  if (driftMessage || run?.status === 'stale') return {label: 'Review required', tone: 'danger'};
  if (!run) {
    const ready = assets.length > 0 && assets.filter(asset => asset.required !== false).every(asset => asset.sourceHash && asset.status !== 'blocked');
    return ready ? {label: 'Launch ready', tone: 'ready'} : {label: 'Needs attention', tone: 'danger'};
  }
  if (['interpreting', 'proposing', 'rendering', 'checking'].includes(run.status)) return {label: 'Updating', tone: 'warning'};
  if (['failed', 'blocked'].includes(run.status)) return {label: 'Needs attention', tone: 'danger'};
  if (run.status === 'rejected') return {label: 'Changes requested', tone: 'danger'};
  if (run.status === 'review') return {label: 'Awaiting approval', tone: 'warning'};
  if (run.status === 'approved') return {label: 'Approved · package pending', tone: 'warning'};
  if (run.status === 'packaged' && readyRelease && run.approval?.decision === 'approve' && readyRelease.candidateHash === run.approval.candidateHash) {
    return readyRelease.partial || readyRelease.assetCount !== assets.length
      ? {label: 'Partial release ready', tone: 'warning'}
      : {label: 'Launch ready', tone: 'ready'};
  }
  return {label: 'Draft · not launch ready', tone: 'warning'};
}
