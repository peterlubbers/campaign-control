'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const active = new Set(['interpreting','proposing','rendering','checking']);
const channels = {website:'Website',email:'Email',social:'Social',paid:'Paid media',video:'Video',sales:'Sales',support:'Support',partners:'Partners','in-product':'In-product',events:'Events',press:'PR / communications'};
const channel = key => channels[key] || key;
const assetType = asset => asset.kind === 'video' ? 'Motion asset · MP4' : asset.metadata?.presentation ? 'Google Slides presentation' : asset.metadata?.outputFormat === 'pdf' ? 'Sales battlecard · PDF' : asset.channel === 'sales' ? 'Sales collateral' : asset.kind === 'page' ? 'Web page' : asset.kind === 'graphic' ? `${channel(asset.channel)} graphic` : `${channel(asset.channel)} copy`;
const revisionDrafts = new Map();
const candidateDrafts = new Map();
let revisionOpenKey = null;
let resetTarget = null, resolutionTarget = null;
let aiDraft = null, aiSaving = false, aiChoiceSignature = '';
let state, view = 'home', selectedId, requestBusy = false, refreshing = false, reviewSignature = '', librarySignature = '', toastTimer, lastProgress = '', pendingRun = false, demoMode = false, demoModeLoaded = false;
// Multi-launch state: chooser is the workspace launch list; launch is the identity of the campaign currently open.
let chooser = null, launch = null, csrfToken = '', pendingConnectionId = null, reconnectTarget = null, activeJob = null, disconnectTarget = null;
const defaultBrief = $('brief').value;
const money = value => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(value);
function safeURL(value) {try {const url = new URL(value,location.origin); const scoped = /^\/api\/workspaces\/[A-Za-z0-9_-]+\/launches\/[A-Za-z0-9_-]+\/artifacts\//.test(url.pathname); return url.origin === location.origin && (url.pathname.startsWith('/artifacts/') || scoped) ? url.pathname : '';} catch {return '';}}
function toast(message) {clearTimeout(toastTimer); $('message').textContent = message; $('message').hidden = false; toastTimer = setTimeout(() => {$('message').hidden = true;},10000);}
// Campaign operations carry the opened launch identity in their path; workspace operations stay unscoped.
function apiPath(route) {if (route.startsWith('/api/workspaces/')) return route; return launch ? `/api/workspaces/${launch.workspaceId}/launches/${launch.launchId}${route.replace(/^\/api/,'')}` : route;}
function launchRoute(launchId,route) {return `/api/workspaces/${chooser.workspace.id}/launches/${launchId}${route}`;}
async function api(route, data) {
  const response = await fetch(apiPath(route), data === undefined ? {cache:'no-store'} : {method:'POST',headers:{'Content-Type':'application/json','X-Campaign-Control-Token':csrfToken},body:JSON.stringify(data)});
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  if (typeof result.csrfToken === 'string') csrfToken = result.csrfToken;
  return result;
}
function setView(next, focus = true) {
  if (view === next) return;
  view = next;
  for (const section of document.querySelectorAll('main>.view')) section.hidden = section.id !== `${next}-view`;
  const home = next === 'home' || next === 'chooser';
  $('brand-theme').href = home ? '/brand/default.css' : '/brand.css';
  $('product-mark').hidden = !home;
  $('header-logo').hidden = home;
  $('header-name').textContent = home ? 'Campaign Control' : state?.branding.company || 'Campaign Control';
  $('location-label').textContent = home ? (chooser ? 'Campaign workspace · launches' : 'Campaign workspace') : 'Campaign Control / ' + (state?.campaign.facts.product || 'Campaign');
  document.title = home ? 'Campaign Control' : `${state?.campaign.facts.product || 'Campaign'} · Campaign Control`;
  if (state) updateMode();
  if (focus) {window.scrollTo({top:0,behavior:'instant'}); $('main').focus({preventScroll:true});}
}
function representativeIds() {
  const preferred = ['WEB002','VID-001','SOC-001','SAL-004'].filter(id => state.assets.some(a => a.id === id));
  for (const type of ['website','video','social','sales']) {if (preferred.length >= 4) break; const a = state.assets.find(a => a.channel === type && !preferred.includes(a.id)); if (a) preferred.push(a.id);}
  for (const a of state.assets) {if (preferred.length >= 4) break; if (!preferred.includes(a.id)) preferred.push(a.id);}
  return preferred;
}
function scopeAssets() {return state.run?.scope ? state.assets.filter(a => state.run.scope.assetIds.includes(a.id)) : state.assets;}
function assetCleared(asset) {return asset.status === 'checked' || asset.resolution?.overridden;}
function reviewIds() {return state.run?.reviewAssetIds || scopeAssets().slice(0,4).map(a => a.id);}
function isBusy() {return requestBusy || state?.busy || active.has(state?.run?.status) || otherLaunchProcessing();}
// One campaign update runs at a time across the whole workspace; every launch shows it.
function otherLaunchProcessing() {return Boolean(state?.processingLock && state.identity && state.processingLock.launchId !== state.identity.launchId);}
// Fresh sessions start in demo scope for the bundled example; the server flag keeps other campaign folders in full-campaign mode.
function adoptDemoDefault() {demoModeLoaded = true; demoMode = Boolean(state?.capabilities?.demoScopeDefault);}
// Unsaved work belongs to (launch, run, asset): switching launches preserves other launches' drafts.
const draftScope = () => launch ? `${launch.workspaceId}/${launch.launchId}` : 'workspace';
function candidateDraftKey(runId, assetId) {return `${draftScope()}/${runId}/${assetId}`;}
function clearLaunchDrafts() {const scope = `${draftScope()}/`; for (const key of [...revisionDrafts.keys(), ...candidateDrafts.keys()]) if (key.startsWith(scope)) {revisionDrafts.delete(key); candidateDrafts.delete(key);}}
// An unsaved candidate edit stays current only for the exact candidate content it was written against.
function hasCurrentDraft(run, asset) {const draft = candidateDrafts.get(candidateDraftKey(run.id, asset.id)); return Boolean(draft && draft.candidateHash === run.candidateHash && draft.text !== (asset.candidateText || ''));}
function markReviewedLocked(run, asset, reviewed) {return hasCurrentDraft(run,asset) || reviewed || !assetCleared(asset) || isBusy() || run.status === 'approved';}
function reviewCardState(run, asset) {const reviewed = run.reviews?.[asset.id]?.candidateHash === run.candidateHash; return hasCurrentDraft(run,asset) ? '✎ Unsaved edits' : reviewed ? '✓ Reviewed' : assetCleared(asset) ? '○ Awaiting your review' : '! Needs attention';}
function modelEntry(selection) {return state?.aiSettings?.catalog.models.find(item=>item.provider===selection?.provider && item.model===selection?.model);}
function modelLabel(selection) {
  const entry=modelEntry(selection);
  return entry ? `${entry.name} · ${entry.version} · ${entry.model}` : selection?.model ? `${selection.provider === 'openai' ? 'OpenAI' : selection.provider === 'anthropic' ? 'Anthropic' : 'Recorded provider'} · ${selection.model}` : 'Model not recorded';
}
function versionSelection() {return state?.versionProvider?.selection || state?.run?.aiSelection || state?.run?.provider;}
function versionModelText() {return `This version’s model: ${modelLabel(versionSelection())}`;}
function versionAIBlocked() {return state?.versionProvider?.canContinue === false;}
function renderAISettings() {
  $('ai-settings-button').disabled = !state?.capabilities?.aiSettings || isBusy();
  if (!aiDraft || !state.aiSettings) return;
  const settings=state.aiSettings, busy=isBusy() || settings.saving;
  $('ai-saved-selection').textContent=`Saved for next update: ${modelLabel(settings.selection)}`;
  $('ai-version-selection').hidden=!state.run || state.run.status==='draft';
  $('ai-version-selection').textContent=versionModelText();
  const notices=[];
  if(!modelEntry(settings.selection))notices.push('Your saved model is not in this catalog. It has not been replaced. Choose a listed model to start a new update.');
  if(settings.ignoredOverrides.length)notices.push(`Ignored model environment overrides: ${settings.ignoredOverrides.join(', ')}. The saved app selection is authoritative.`);
  $('ai-settings-notice').hidden=!notices.length;$('ai-settings-notice').textContent=notices.join(' ');
  $('ai-provider').value=aiDraft.provider;$('ai-provider').disabled=busy;
  $('ai-model-choices').disabled=busy;
  // Keep native radio nodes and keyboard focus when changing a model or polling.
  const signature=JSON.stringify([aiDraft.provider,settings.catalog.version]);
  if(signature!==aiChoiceSignature){
    aiChoiceSignature=signature;
    $('ai-model-list').innerHTML=settings.catalog.models.filter(item=>item.provider===aiDraft.provider).map(item=>`<label class="ai-model-choice"><input type="radio" name="ai-model" value="${esc(item.model)}"${item.model===aiDraft.model?' checked':''}><span><strong>${esc(item.name)}</strong><small>${esc(item.version)} · <code>${esc(item.model)}</code></small><span class="help">${esc(item.description)}</span></span></label>`).join('');
  }
  const configured=settings.credentials[aiDraft.provider], selectedEntry=modelEntry(aiDraft);
  const same=aiDraft.provider===settings.selection.provider && aiDraft.model===settings.selection.model;
  $('ai-credential-status').textContent=`Server credential: ${configured?'configured':'not configured'}. ${same && state.provider.connected?'Model access: verified by a successful request this server session.':'Model access: not verified for this selection; choosing or saving sends no request.'}${configured?'':' You can save this choice, but configure its API key on the server before running.'}`;
  $('ai-settings-lock').hidden=!busy;
  $('save-ai-settings').disabled=busy || !selectedEntry || same;
  $('save-ai-settings').textContent=aiSaving?'Saving…':'Save selection';
  $('cancel-ai-settings').disabled=aiSaving;
}
function openAISettings() {
  if(isBusy() || !state?.aiSettings)return;
  aiDraft={...state.aiSettings.selection};aiChoiceSignature='';
  $('ai-settings-error').hidden=true;
  const catalog=state.aiSettings.catalog;
  $('ai-catalog-details').innerHTML=`<p class="help">Catalog ${esc(catalog.version)} · Verified ${esc(catalog.verifiedAt)}. ${esc(catalog.maintenance)}</p><p class="help">${esc(catalog.requirements)}</p><p class="help">${esc(catalog.pricingNote)}</p><ul>${catalog.models.map(item=>`<li>${esc(item.name)}: $${esc(item.inputUSD)} input / $${esc(item.outputUSD)} output per million tokens. <a href="${esc(item.source)}" target="_blank" rel="noopener">Official model documentation</a></li>`).join('')}</ul>`;
  renderAISettings();$('ai-settings-dialog').showModal();$('ai-provider').focus();
}
function cancelAISettings() {
  if(aiSaving)return;
  aiDraft=null;$('ai-settings-dialog').close();
}
async function saveAISettings() {
  if(isBusy() || !aiDraft || !modelEntry(aiDraft) || $('save-ai-settings').disabled)return;
  const next={...aiDraft};requestBusy=true;aiSaving=true;renderAISettings();
  $('ai-settings-error').hidden=true;
  try {
    const result=await api('/api/settings/ai',next);
    // A workspace-level save returns the chooser; a launch-level save returns that launch's state.
    if (result.launches && result.workspace && !result.campaign) {chooser=result;state=chooserState();renderChooser();}
    else state=result;
    aiDraft=null;$('ai-settings-dialog').close();toast('Model selection saved for the next update. Existing versions are unchanged.');
  } catch(error) {$('ai-settings-error').textContent=error.message;$('ai-settings-error').hidden=false;}
  finally {requestBusy=false;aiSaving=false;if(state?.campaign)dashboard();}
}
function setBriefExpanded(expanded, focus = false) {
  $('update-editor').hidden = !expanded;
  const button = $('toggle-update');
  button.setAttribute('aria-expanded', String(expanded));
  button.textContent = expanded ? 'Hide update' : 'Make an update';
  button.className = expanded ? 'secondary' : 'primary';
  $('brief-length').textContent = `${$('brief').value.length} / 4,000`;
  if (focus) {
    (expanded ? $('brief') : button).focus({preventScroll:true});
    if (expanded) $('campaign-updates').scrollIntoView({block:'start',behavior:'instant'});
  }
}
function updateMode() {
  const locked = isBusy() || !['home','dashboard'].includes(view);
  const runScope = state.run?.scope;
  const showingRun = !pendingRun && runScope && (state.busy || active.has(state.run.status) || !['home','dashboard','loading'].includes(view));
  const enabled = showingRun ? (runScope.initialAssetIds || runScope.assetIds).length < runScope.inventoryCount : demoMode;
  $('demo-mode').checked = enabled;
  $('demo-mode').disabled = locked;
  const assets = showingRun ? scopeAssets() : enabled ? state.assets.filter(a => representativeIds().includes(a.id)) : state.assets;
  // A recorded version keeps its own inventory count; the next update counts the current inventory.
  const inventory = showingRun ? runScope.inventoryCount : state.assets.length;
  const channelCount = new Set(assets.map(a => a.channel)).size;
  $('scope-heading').textContent = enabled ? `Demo update: ${assets.length} of ${inventory} assets.` : `Full campaign: all ${inventory} assets.`;
  $('full-scope-count').textContent = enabled ? `${assets.length} demo assets · ${channelCount} ${channelCount === 1 ? 'channel' : 'channels'}` : `${assets.length} assets · ${channelCount} ${channelCount === 1 ? 'channel' : 'channels'}`;
  const excluded = inventory - assets.length;
  $('scope-description').textContent = enabled ? `Only these ${assets.length} demo assets and their publisher files will be updated and checked. The other ${excluded} ${excluded === 1 ? 'asset stays' : 'assets stay'} unchanged.` : `All ${inventory} assets and their publisher metadata will be processed and checked.`;
}
function dashboard() {
  const {campaign,evidence,provider,run} = state;
  $('reset-demo-button').hidden = !(state.capabilities?.demoReset || state.capabilities?.workspaceReset);
  $('reset-demo-button').textContent = state.launch?.type === 'google-drive' ? 'Reset workspace' : 'Reset demo';
  $('reset-demo-button').disabled = isBusy();
  $('confirm-reset-demo').disabled = isBusy();
  $('campaign-company').textContent = state.branding.company;
  $('campaign-name').textContent = campaign.facts.product;
  $('campaign-counts').textContent = `${evidence.registered} assets / ${evidence.channelCount} channels`;
  $('campaign-button').disabled = false;
  $('workspace-eyebrow').textContent = `${state.branding.company} / CAMPAIGN`;
  $('dashboard-heading').textContent = campaign.facts.product;
  $('asset-count').textContent = evidence.registered;
  $('channel-count').textContent = evidence.channelCount;
  updateMode();
  const readiness = state.launchReadiness || {label:'Checking readiness',tone:'warning'};
  for (const id of ['readiness','campaign-readiness']) {
    $(id).className = `status-pill launch-readiness ${readiness.tone}`;
    if ($(id).textContent !== readiness.label) $(id).textContent = readiness.label;
  }
  $('campaign-description').textContent = run ? `${run.change?.product || campaign.facts.product} · ${run.version}` : 'Product analytics launch · Original campaign';
  $('model-name').textContent = modelLabel(provider);
  $('provider-status').textContent = `${provider.configured ? 'Server credential configured.' : provider.message} ${provider.connected ? 'Model access verified this server session.' : 'Model access not verified; checked only when you run.'}${provider.listed === false ? ' Saved model is unlisted; choose a replacement in AI settings.' : ''}`;
  $('update-button').disabled = isBusy() || !provider.configured || provider.listed === false || !$('brief').value.trim();
  renderAISettings();
  $('toggle-update').disabled = isBusy();
  $('update-button').title = !provider.configured ? provider.message : '';
  $('brief').disabled = isBusy();
  const banner = $('resume-banner');
  banner.hidden = !run || run.status === 'draft';
  if (run) banner.innerHTML = `<strong>${esc(run.version)}</strong> · ${esc(state.workspace.status)}. ${esc(state.workspace.driftMessage || 'Earlier work is preserved. A new update creates another version.')} <button class="text-button" id="resume-button">${active.has(run.status) || state.busy ? 'View progress' : 'Open version'} →</button>`;
  $('resume-button')?.addEventListener('click',() => routeRun());
  const lock = $('lock-banner');
  lock.hidden = !otherLaunchProcessing();
  if (otherLaunchProcessing()) lock.innerHTML = `<strong>Another launch is busy.</strong> Campaign Control processes one campaign update at a time. Wait for the ${esc(state.processingLock.kind || 'current operation')} in another launch to finish before updating this one.`;
  const evidenceData = state.marketEvidence;
  $('market-context').textContent = evidenceData ? `${evidenceData.prompts.length} observed buyer questions from Profound’s ${evidenceData.dataset.brand} dataset inform relevant claim checks. These are reference observations, not Fictitious AI performance results or a live Profound API connection.` : 'No external market evidence is attached. The campaign facts and your brief guide the revision.';
}
function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const value = Math.max(0, Math.round(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2,'0')}`;
}
function processingReceipt() {
  const processing = state.processing;
  if (processing?.elapsedSeconds == null) return `${versionModelText()} · Processing time not recorded.`;
  return `${versionModelText()} · Processing time: ${formatDuration(processing.elapsedSeconds)} · ${processing.total} assets included · Human review time excluded`;
}
function renderProgress() {
  const run = state.run;
  const stages = [['interpreting','Interpreting your brief'],['proposing','Revising copy and publisher metadata'],['rendering','Producing the new asset files'],['checking','Checking the complete version']];
  const current = stages.findIndex(([key]) => key === run?.status);
  $('progress-eyebrow').textContent = run ? `${run.version} / NEW VERSION` : 'STARTING NEW VERSION';
  $('progress-scope').textContent = run?.scope ? `${versionModelText()} · ${run.scope.inventoryCount} assets inventoried · ${run.scope.assetIds.length} included in this release` : 'Checking the campaign and creating a new version.';
  $('progress-steps').innerHTML = stages.map(([key,label],i) => `<li class="${i < current ? 'done' : i === current ? 'active' : ''}"${i===current?' aria-current="step"':''}><span aria-hidden="true">${i < current ? '✓' : String(i+1).padStart(2,'0')}</span><span>${label}${i < current ? '<span class="sr-only"> — complete</span>' : ''}</span></li>`).join('');
  const message = run?.progress?.message || 'Opening source files and reserving a new version…';
  if (message !== lastProgress) {$('progress-message').textContent = message; lastProgress = message;}
  const processing = state.processing;
  const total = processing?.total || state.assets.length;
  $('proposals-count').textContent = `${processing?.proposed || 0} / ${total}`;
  $('outputs-count').textContent = `${processing?.produced || 0} / ${total}`;
  $('audits-count').textContent = `${processing?.audited || 0} / ${total}`;
  $('elapsed').textContent = formatDuration(processing?.elapsedSeconds);
}
function fileLabel(file) {return ({'publisher-metadata':'Publisher metadata','youtube-metadata':'YouTube metadata',captions:'Captions',thumbnail:'Thumbnail','native-video':'Motion asset (MP4)','native-presentation-reference':'Google Slides reference','publishable-copy':'Publish copy','pdf-document':'PDF document',graphic:'Graphic'})[file.role] || file.path;}
function preview(asset, side) {
  const files = asset[`${side}Files`] || [];
  const primary = files.find(f => f.role === 'native-video') || files.find(f => f.role === 'graphic') || files.find(f => f.role === 'document-preview') || files.find(f => f.role === 'review-preview') || asset[`${side}Preview`] || files[0];
  const document = files.find(f => f.role === 'pdf-document');
  const openURL = safeURL(document?.url || primary?.url);
  const url = safeURL(primary?.url); const mime = primary?.mime || ''; const title = side === 'source' ? 'Before · preserved' : 'After · new version';
  let media;
  if (url && mime.startsWith('video/')) {const captions = files.find(f => f.role === 'captions');media = `<video controls playsinline preload="metadata" aria-label="${esc(title)}: ${esc(asset.title)}"><source src="${esc(url)}" type="${esc(mime)}">${captions ? `<track kind="captions" src="${esc(safeURL(captions.url))}" srclang="en" label="English">` : ''}</video>`;}
  else if (url && mime.startsWith('image/')) media = `<img src="${esc(url)}" alt="${esc(title)}: ${esc(asset.title)}" loading="lazy">`;
  else if (url && mime.startsWith('text/html')) media = `<iframe src="${esc(url)}" title="${esc(title)}: ${esc(asset.title)}" sandbox loading="lazy"></iframe>`;
  else media = `<pre>${esc(asset[`${side}Text`] || 'No preview is available for this asset yet.')}</pre>`;
  const companions = files.filter(f => ['publisher-metadata','youtube-metadata','captions','native-video','thumbnail','publishable-copy','graphic','native-presentation-reference','pdf-document'].includes(f.role));
  return `<div class="preview-column"><div class="preview-label"><span>${esc(title)}</span>${openURL?`<a href="${esc(openURL)}" target="_blank" rel="noopener">${document ? 'Open PDF' : 'Open'} ↗</a>`:''}</div><div class="preview-media">${media}</div><div class="file-links">${companions.map(f=>`<a href="${esc(safeURL(f.url))}" target="_blank" rel="noopener">${esc(fileLabel(f))}${f.path.endsWith('.json')?' (JSON)':''} ↗</a>`).join('')}</div></div>`;
}
function metadata(text) {const video = String(text||'').split(/^## YouTube title\s*$/mi)[1]; if(video) return '## YouTube title\n'+video.trim(); const section = String(text||'').split(/^## Publisher metadata\s*$/mi)[1]; return section ? section.split(/^## /m)[0].trim() : 'No publisher metadata section.';}
function captureCandidateDraft(run, asset) {
  const key = candidateDraftKey(run.id, asset.id), value = $('candidate-editor').value;
  if (value === (asset.candidateText || '')) candidateDrafts.delete(key);
  else candidateDrafts.set(key, {candidateHash: run.candidateHash, text: value});
}
// Keep typing cheap: targeted updates plus the gated approval status, never an editor rebuild mid-keystroke.
function refreshDraftUI(run, asset) {
  const dirty = hasCurrentDraft(run, asset);
  const note = $('draft-note'); if (note) note.hidden = !dirty;
  const flag = document.querySelector('.draft-flag'); if (flag) flag.hidden = !dirty;
  const gate = $('mark-gate'); if (gate) gate.hidden = !dirty;
  const discard = $('discard-draft'); if (discard) discard.hidden = !dirty;
  const mark = $('mark-reviewed'); if (mark) mark.disabled = markReviewedLocked(run, asset, run.reviews?.[asset.id]?.candidateHash === run.candidateHash);
  const card = document.querySelector(`[data-review="${CSS.escape(asset.id)}"] small`);
  if (card) card.textContent = reviewCardState(run, asset);
  renderReview();
}
function renderReview(force = false) {
  const run = state.run, assets = scopeAssets(), ids = reviewIds();
  if (!assets.some(asset=>asset.id===selectedId)) selectedId = ids[0];
  const reviewedCount = ids.filter(id => run.reviews?.[id]?.candidateHash === run.candidateHash).length;
  // A finished browser request must unlock the toolbar even when candidate data is unchanged.
  const signature = JSON.stringify([run.id,run.status,run.candidateHash,run.reviews,selectedId,isBusy(),state.capabilities?.assetRevision,state.capabilities?.assetResolution,state.versionProvider]);
  $('review-timing').textContent = processingReceipt();
  $('review-eyebrow').textContent = `${run.version} / HUMAN REVIEW`;
  $('review-summary').textContent = `${assets.length} assets included · ${assets.filter(a=>a.checks?.some(c=>c.name==='Independent semantic audit')).length} AI audited · ${assets.filter(a=>a.status==='checked').length} passed checks · ${assets.filter(a=>a.resolution?.overridden).length} human override${assets.filter(a=>a.resolution?.overridden).length===1?'':'s'} · ${assets.filter(a=>!assetCleared(a)).length} need attention`;
  $('review-sample-description').textContent = ids.length < assets.length ? `These ${ids.length} assets are representative examples. All ${assets.length} included assets receive automated checks; final approval covers the entire included set.` : `These are all ${assets.length} assets included in this version. Final approval covers them and their publisher files.`;
  $('review-all-button').textContent = `Browse all ${assets.length} included assets`;
  $('review-status').textContent = `${reviewedCount} of ${ids.length} representative assets reviewed`;
  $('review-status').className = `status-pill ${reviewedCount === ids.length ? 'ready' : 'warning'}`;
  const facts = run.change;
  $('interpretation').innerHTML = facts ? `<span class="fact-chip"><small>Product</small>${esc(facts.product)}</span><span class="fact-chip"><small>Monthly price</small>${esc(money(facts.monthlyPrice))}</span><span class="fact-chip"><small>Sharing</small>${facts.sharing?`Up to ${esc(facts.maxTeammates)} teammates`:'Removed'}</span><p>AI interpretation: ${esc(run.interpretation || 'Confirm these facts before approval.')}</p>` : '';
  const blocked = assets.filter(a=>!assetCleared(a) && a.required);
  const draftAssets = assets.filter(a=>hasCurrentDraft(run,a));
  if (blocked.length) $('review-status').className = 'status-pill warning';
  $('review-alert').hidden = !blocked.length && !run.error && run.status !== 'rejected';
  const alertHTML = blocked.length ? `<strong>Approval blocked: ${blocked.length} required asset${blocked.length===1?' needs':'s need'} attention.</strong> ${reviewedCount===ids.length?'Your representative reviews are complete. ':''}<button type="button" id="show-approval-blockers" class="text-button">Review ${blocked.length===1?'the issue':'the issues'} below ↓</button>` : esc(run.error || 'Changes were requested. Correct a candidate or start a new version with an amended brief.');
  if ($('review-alert').innerHTML !== alertHTML) {
    $('review-alert').innerHTML = alertHTML;
    $('show-approval-blockers')?.addEventListener('click',()=>{$('approval-blockers').scrollIntoView({block:'center',behavior:'instant'});$('approval-blockers-heading').focus({preventScroll:true});});
  }
  const excluded = state.assets.length - assets.length;
  $('approval-scope').textContent = `Approval covers ${assets.length} included assets and their publisher companions. ${excluded ? `${excluded} ${excluded === 1 ? 'asset is' : 'assets are'} outside this release. ` : ''}${ids.length} representative assets require your review; every included required asset needs passed checks or a recorded human override of its AI finding.`;
  $('approve-button').disabled = isBusy() || blocked.length>0 || draftAssets.length>0 || !run.candidateHash || !['review','rejected','approved'].includes(run.status) || reviewedCount !== ids.length || !$('confirm-facts').checked || !$('reviewer').value.trim();
  $('approve-button').textContent = run.status === 'approved' ? 'Prepare approved release →' : 'Approve & prepare release →';
  const remainingReviews=ids.length-reviewedCount;
  $('approval-readiness').textContent = isBusy() ? 'Waiting for the current checks to finish.' : blocked.length ? `Approval blocked by ${blocked.length} required asset${blocked.length===1?'':'s'}. Open each issue to resolve it.` : draftAssets.length ? `Save or discard unsaved candidate edits on ${draftAssets.map(a=>a.id).join(', ')} before approval.` : remainingReviews ? `Review ${remainingReviews} more representative asset${remainingReviews===1?'':'s'} before approval.` : !$('confirm-facts').checked ? 'Confirm the product facts below before approval.' : !$('reviewer').value.trim() ? 'Enter your name to record approval.' : 'Checks, human resolutions and representative reviews are complete.';
  $('approval-readiness').className = (blocked.length || draftAssets.length) ? 'approval-readiness danger' : 'approval-readiness muted';
  $('reject-button').disabled = isBusy() || !run.candidateHash || run.status === 'approved';
  if (!force && signature === reviewSignature) return; reviewSignature = signature;
  $('approval-blockers').hidden = !blocked.length;
  $('approval-blockers').innerHTML = blocked.length ? `<h3 id="approval-blockers-heading" tabindex="-1">${blocked.length} ${blocked.length===1?'asset needs':'assets need'} a decision</h3><p class="muted">Revise the asset, exclude it from this launch, or explicitly override an eligible AI finding.</p><ul class="approval-blocker-list">${blocked.map(a=>{const reason=a.issues?.find(i=>i.severity==='error')?.message || a.checks?.find(c=>c.status!=='pass')?.message || 'Required checks have not completed.';return `<li><div><div class="asset-identity"><span class="asset-id">${esc(a.id)}</span><span class="asset-type">${esc(assetType(a))}</span></div><strong>${esc(a.title)}</strong><p>${esc(reason)}</p></div><button type="button" class="secondary" data-blocked-asset="${esc(a.id)}" aria-label="Review issue for ${esc(a.id)}">Review issue</button></li>`;}).join('')}</ul>` : '';
  $('review-cards').innerHTML = ids.map(id => {const a=state.assets.find(a=>a.id===id), reviewed=run.reviews?.[id]?.candidateHash === run.candidateHash;return `<button class="review-card ${reviewed?'reviewed':''}" data-review="${esc(id)}" aria-pressed="${selectedId===id}"><span class="asset-id">${esc(id)}</span><span class="asset-type">${esc(assetType(a))}</span><strong>${esc(a.title)}</strong><small>${esc(reviewCardState(run,a))}</small></button>`;}).join('');
  renderResolutions();
  const asset = state.assets.find(a=>a.id===selectedId); if (!asset) return;
  const reviewed = run.reviews?.[asset.id]?.candidateHash === run.candidateHash;
  const revisionKey = candidateDraftKey(run.id, asset.id), lastRevision = run.assetRevisions?.filter(r=>r.assetId===asset.id).at(-1);
  const candidateDraft = candidateDrafts.get(revisionKey);
  const currentDraft = candidateDraft && candidateDraft.candidateHash === run.candidateHash ? candidateDraft : null;
  const staleDraft = candidateDraft && candidateDraft.candidateHash !== run.candidateHash ? candidateDraft : null;
  const editorText = currentDraft ? currentDraft.text : (asset.candidateText || '');
  // Capabilities tell the reviewer what can happen here versus what needs an external editor.
  const cap = asset.capabilities || null;
  const capabilityBadge = cap ? `<span class="capability-pill${cap.externalEditorRequired ? ' external' : ''}">${cap.externalEditorRequired ? 'External editor required' : 'Editable here'}</span>` : '';
  const capabilityNote = cap?.mediaStatus ? `<p class="motion-note">${esc(cap.mediaStatus)}</p>` : '';
  const unsupportedNote = asset.remoteUnsupported?.length ? `<p class="motion-note">Drive originals needing an external editor: ${esc(asset.remoteUnsupported.map(file=>file.path).join(', '))}.</p>` : '';
  $('asset-toolbar').innerHTML = `<div class="asset-description"><div class="asset-identity"><span class="asset-id">${esc(asset.id)}</span><span class="asset-type">${esc(assetType(asset))}</span>${capabilityBadge}<span class="status-pill ${asset.status==='checked'?'ready':'warning'}">${asset.resolution?.overridden?'Human override':asset.status==='checked'?'Checks passed':'Needs attention'}</span></div><h2 id="asset-heading" tabindex="-1">${esc(asset.title)}</h2><p class="muted">${esc(asset.reason || 'Review the complete asset and its metadata.')}</p>${asset.kind==='video'?'<p class="motion-note">Silent motion graphics with on-screen copy.</p>':''}${asset.metadata?.presentation && asset.status!=='checked'?'<p class="motion-note">This presentation needs a verified Google Slides revision. Copy edits alone cannot complete its native output.</p>':''}${capabilityNote}${unsupportedNote}</div><div class="asset-actions"><button id="request-revision" class="secondary" aria-expanded="${revisionOpenKey===revisionKey}" aria-controls="asset-revision-form"${isBusy()||!asset.candidateText?' disabled':''}>Request revision</button>${resolutionActions(asset)}<button id="mark-reviewed" class="${reviewed?'secondary':'primary'}"${ids.includes(asset.id)?'':' hidden'}${markReviewedLocked(run,asset,reviewed)?' disabled':''}>${reviewed?'✓ Reviewed':'Mark reviewed →'}</button>${ids.includes(asset.id)?`<p id="mark-gate" class="help"${hasCurrentDraft(run,asset)?'':' hidden'}>Save or discard your unsaved edits before marking ${esc(asset.id)} reviewed.</p>`:''}</div>`;
  $('asset-content').innerHTML = `<div class="preview-grid">${preview(asset,'source')}${preview(asset,'candidate')}</div><div class="review-extra"><details><summary>Compare publisher metadata</summary><div class="preview-grid"><div class="preview-column"><p>Before</p><pre>${esc(metadata(asset.sourceText))}</pre></div><div class="preview-column"><p>After</p><pre>${esc(metadata(asset.candidateText))}</pre></div></div></details><details${asset.status!=='checked'?' open':''}><summary>Quality checks and findings</summary><ul class="check-list">${(asset.issues||[]).map(i=>`<li class="${i.severity==='error'?'danger':'warning'}"><div><strong>${asset.resolution?.overridden && i.severity==='error'?'AI FINDING · HUMAN OVERRIDE':esc(i.severity.toUpperCase())}</strong><p>${esc(i.message)}</p><p>${esc(i.evidence)}</p></div></li>`).join('')}${(asset.checks||[]).map(c=>`<li><strong class="${c.status==='pass'?'ready':asset.resolution?.overridden&&c.name==='Independent semantic audit'?'warning':'danger'}">${asset.resolution?.overridden&&c.name==='Independent semantic audit'?'OVERRIDDEN':esc(c.status.toUpperCase())}</strong><div>${esc(c.name)}<p>${esc(c.name === 'source-render-binding' ? 'The output files match this exact candidate source.' : c.message)}</p></div></li>`).join('')}</ul></details><details${asset.status!=='checked' || currentDraft ? ' open':''}><summary>Read or edit the candidate source <span class="draft-flag"${currentDraft ? '' : ' hidden'}>Unsaved edits</span></summary><p>Saving creates new rendered files and reruns checks. All representative reviews and approval are reset.</p>${staleDraft ? `<div class="stale-draft" role="note"><strong>Your unsaved edit was written before this candidate changed.</strong><p>It may no longer match the new content. Continue from your edit, or discard it.</p><button type="button" id="apply-stale-draft" class="secondary">Continue your edit</button><button type="button" id="discard-stale-draft" class="text-button">Discard it</button></div>` : ''}<p id="draft-note" class="help"${currentDraft ? '' : ' hidden'}>You have unsaved edits. Save them to check and publish this exact content, or discard them before marking the asset reviewed.</p><label class="sr-only" for="candidate-editor">Candidate source</label><textarea id="candidate-editor" spellcheck="false"${isBusy()||run.status==='approved'?' disabled':''}>${esc(editorText)}</textarea><button id="save-candidate" class="secondary"${isBusy()||!asset.candidateText||run.status==='approved'?' disabled':''}>Save changes & check again</button><button type="button" id="discard-draft" class="text-button"${currentDraft ? '' : ' hidden'}>Discard edits</button></details></div>`;
  $('asset-content').insertAdjacentHTML('afterbegin',`${lastRevision?`<div class="revision-receipt"><strong>${lastRevision.status==='completed'?'Revision checked. Review the updated asset.':'Revision needs attention.'}</strong><p>Your request: ${esc(lastRevision.feedback)}</p></div>`:''}<form id="asset-revision-form" class="asset-revision-form"${revisionOpenKey===revisionKey?'':' hidden'}><label for="revision-feedback">What should change in ${esc(asset.id)}?</label><p id="revision-help">AI revises this asset, then checks the included campaign again. Earlier files stay intact; review marks and approval reset.</p><textarea id="revision-feedback" maxlength="2000" required rows="3" aria-describedby="revision-help" placeholder="Describe the correction you want…">${esc(revisionDrafts.get(revisionKey)||'')}</textarea><div class="revision-form-actions"><button id="submit-revision" class="primary"${isBusy()||!state.capabilities?.assetRevision?' disabled':''}>Revise asset & check</button><button id="cancel-revision" type="button" class="text-button">Cancel</button><span class="muted">${state.capabilities?.assetRevision?esc(versionModelText()):'Restart Campaign Control in Terminal to enable asset revisions.'}</span></div></form>`);
  if(versionAIBlocked()){
    for(const id of ['request-revision','submit-revision','save-candidate'])$(id).disabled=true;
    $('asset-revision-form').insertAdjacentHTML('beforeend',`<p class="help">${esc(state.versionProvider.message)}</p>`);
  }
  $('request-revision').addEventListener('click',()=>{revisionOpenKey=revisionKey;$('asset-revision-form').hidden=false;$('request-revision').setAttribute('aria-expanded','true');$('revision-feedback').focus();});
  $('cancel-revision').addEventListener('click',()=>{revisionOpenKey=null;$('asset-revision-form').hidden=true;$('request-revision').setAttribute('aria-expanded','false');$('request-revision').focus();});
  $('revision-feedback').addEventListener('input',()=>revisionDrafts.set(revisionKey,$('revision-feedback').value));
  $('asset-revision-form').addEventListener('submit',event=>{event.preventDefault();const feedback=$('revision-feedback').value.trim();if(!feedback||isBusy())return;void guarded(async()=>{pendingRun=true;setView('progress');renderProgress();$('progress-message').textContent=`Sending your revision request for ${asset.id}…`;try{state=await api(`/api/runs/${run.id}/assets/${asset.id}/revision`,{feedback,candidateHash:run.candidateHash});revisionDrafts.delete(revisionKey);revisionOpenKey=null;$('confirm-facts').checked=false;selectedId=asset.id;routeRun();}finally{pendingRun=false;}},{id:'submit-revision',label:'Revising…'}).then(()=>{if(view==='review'){$('asset-toolbar').scrollIntoView({block:'start',behavior:'instant'});$('request-revision')?.focus({preventScroll:true});}});});
  $('candidate-editor').addEventListener('input',()=>{captureCandidateDraft(run,asset);refreshDraftUI(run,asset);});
  $('discard-draft').addEventListener('click',()=>{candidateDrafts.delete(revisionKey);renderReview(true);});
  $('apply-stale-draft')?.addEventListener('click',()=>{const draft=candidateDrafts.get(revisionKey);if(!draft)return;candidateDrafts.set(revisionKey,{candidateHash:run.candidateHash,text:draft.text});renderReview(true);$('candidate-editor')?.focus();});
  $('discard-stale-draft')?.addEventListener('click',()=>{candidateDrafts.delete(revisionKey);renderReview(true);});
  $('mark-reviewed').addEventListener('click',() => {if(hasCurrentDraft(run,asset)){toast('Save or discard your unsaved edits before marking this asset reviewed.');return;} guarded(async()=>{state=await api(`/api/runs/${run.id}/reviews/${asset.id}`,{candidateHash:run.candidateHash}); const next=ids.find(id=>state.run.reviews?.[id]?.candidateHash!==state.run.candidateHash); if(next)selectedId=next;renderReview(true);},{id:'mark-reviewed',label:'Recording…'}).then(()=>{const finished=ids.every(id=>state.run.reviews?.[id]?.candidateHash===state.run.candidateHash);const target=finished?$('confirm-facts'):$('mark-reviewed');target?.scrollIntoView({block:'center',behavior:'instant'});target?.focus({preventScroll:true});});});
  $('save-candidate').addEventListener('click',() => {const markdown=$('candidate-editor').value; void guarded(async()=>{setView('progress');renderProgress();$('progress-message').textContent='Saving your correction and producing new output files…';state=await api(`/api/runs/${run.id}/assets/${asset.id}`,{markdown});candidateDrafts.delete(revisionKey);$('confirm-facts').checked=false;routeRun();},{id:'save-candidate',label:'Saving…'});});
}
function resolutionActions(asset) {
  const enabled=state.capabilities?.assetResolution && !isBusy();
  return `${!assetCleared(asset)?`<button type="button" class="secondary" data-resolution="override" data-resolution-asset="${esc(asset.id)}"${!enabled||!asset.resolution?.canOverride?' disabled':''}>Override AI finding</button>`:''}<button type="button" class="text-button" data-resolution="exclude" data-resolution-asset="${esc(asset.id)}"${!enabled||scopeAssets().length<2?' disabled':''}>Exclude from launch</button>${!state.capabilities?.assetResolution?'<span class="help">Restart Campaign Control to enable human resolutions.</span>':''}`;
}
function renderResolutions() {
  const decisions=Object.values(state.run?.assetDecisions || {});
  $('review-resolutions').hidden=!decisions.length;
  $('review-resolutions').innerHTML=decisions.length?`<h3>Human decisions for this release</h3>${decisions.map(d=>`<div class="resolution-row"><div><strong>${esc(d.assetId)} · ${d.action==='exclude'?'Excluded from launch':'AI finding overridden'}</strong><p>${esc(d.reason)}</p><small>Recorded by ${esc(d.reviewer)}</small></div><button type="button" class="secondary" data-resolution="restore" data-resolution-asset="${esc(d.assetId)}"${isBusy()?' disabled':''}>${d.action==='exclude'?'Include again':'Undo override'}</button></div>`).join('')}`:'';
}
function openResolution(assetId, action) {
  const asset=state.assets.find(a=>a.id===assetId);if(!asset||isBusy()||!state.capabilities?.assetResolution)return;
  resolutionTarget={runId:state.run.id,assetId,action,candidateHash:state.run.candidateHash};
  $('resolution-heading').textContent=action==='override'?`Override the AI finding on ${assetId}?`:action==='exclude'?`Exclude ${assetId} from launch?`:`Undo the decision on ${assetId}?`;
  $('resolution-description').textContent=action==='override'?'You are accepting this exact asset despite the AI finding. The original finding and your reason stay in the record. This marks the asset reviewed; final release approval is still required.':action==='exclude'?'This asset and all its publisher files will stay out of the release. Its work is preserved, and you can include it again. Reviews of unchanged assets are retained.':'The asset returns to its previous review state. Any restored blocker must be resolved before release approval.';
  $('resolution-reviewer').value=$('reviewer').value;
  $('resolution-reason').value='';$('resolution-error').hidden=true;$('submit-resolution').disabled=false;
  $('submit-resolution').textContent=action==='override'?'Override & continue':action==='exclude'?'Exclude asset':'Undo decision';
  $('resolution-dialog').showModal();($('resolution-reviewer').value?$('resolution-reason'):$('resolution-reviewer')).focus();
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-resolution]');if(button&&!button.disabled)openResolution(button.dataset.resolutionAsset,button.dataset.resolution);});
$('cancel-resolution').addEventListener('click',()=>$('resolution-dialog').close());
$('resolution-form').addEventListener('submit',async event=>{
  event.preventDefault();if(isBusy()||!resolutionTarget)return;
  const target={...resolutionTarget}, reviewer=$('resolution-reviewer').value.trim(),reason=$('resolution-reason').value.trim();if(!reviewer||!reason)return;
  requestBusy=true;$('submit-resolution').disabled=true;$('resolution-error').hidden=true;
  try {
    state=await api(`/api/runs/${target.runId}/assets/${target.assetId}/resolution`,{action:target.action,candidateHash:target.candidateHash,reviewer,reason,markReviewed:target.action==='override'});
    $('resolution-dialog').close();resolutionTarget=null;$('reviewer').value=reviewer;$('confirm-facts').checked=false;reviewSignature='';
    toast(target.action==='exclude'?'Asset excluded. Review the updated release scope.':target.action==='override'?'AI finding overridden. Your decision is recorded.':'Decision undone. Review the updated status.');
  } catch(error) {$('resolution-error').textContent=error.message;$('resolution-error').hidden=false;}
  finally {requestBusy=false;$('submit-resolution').disabled=false;dashboard();if(view==='review')renderReview(true);}
});
function renderFailure() {
  const run=state.run; const questions=run?.questions || [];
  const providerFailure=run?.providerFailure || /Live AI request returned HTTP|not configured on the server/.test(run?.error || '');
  $('failure-heading').textContent=providerFailure ? 'AI access needs attention.' : 'Let’s resolve this first.';
  $('retry-button').textContent=providerFailure ? 'Back to campaign' : 'Revise brief & start a new version';
  $('failure-details').innerHTML = `<p>${esc(versionModelText())}</p><p>${esc(run?.error || run?.progress?.message || 'This version needs attention.')}</p>${questions.length?`<ul>${questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul>`:''}`;
}
function renderRelease() {
  const release=state.readyRelease, run=state.run; if(!release)return;
  $('release-summary').textContent=`${run.change.product} · ${release.assetCount} approved assets, with their publisher files.`;
  $('release-timing').textContent = processingReceipt();
  $('release-version').textContent=release.version;
  $('release-scope').textContent=release.partial?`Focused release: ${release.assetCount} of ${state.assets.length} campaign assets. The remaining ${state.assets.length-release.assetCount} ${state.assets.length-release.assetCount===1?'asset is':'assets are'} not approved by this package.`:'The full campaign is included in this approved release.';
  $('release-path').textContent=`${state.workspace.path}/${release.directory}`;
  $('download-release').href=safeURL(release.downloadUrl);
  $('release-approval').textContent=`Approved by ${run.approval.reviewer} · ${new Date(run.approval.at).toLocaleString()} · Starting another version clears current readiness; this release is retained.`;
}
function routeRun() {
  if (!state.run || state.run.status === 'draft') {setView('dashboard');dashboard();return;}
  if (state.busy || active.has(state.run.status)) {setView('progress');renderProgress();}
  else if(state.readyRelease && state.run.status==='packaged'){setView('release');renderRelease();}
  else if(state.run.change && state.run.candidateHash && ['review','blocked','rejected','approved'].includes(state.run.status)){setView('review');renderReview();}
  else {setView('failure');renderFailure();}
}
// A lightweight state shim keeps shared renderers (AI settings, busy flags) working on the chooser.
function chooserState() {
  return {identity:{workspaceId:chooser.workspace.id,launchId:null},launch:null,capabilities:{aiSettings:Boolean(chooser.aiSettings)},
    aiSettings:chooser.aiSettings,provider:chooser.provider,processingLock:chooser.processingLock,
    branding:{company:'Campaign Control'},campaign:null,evidence:{},assets:[],run:null,workspace:{status:'Launches',driftMessage:null}};
}
function renderChooser() {
  if (!chooser) return;
  $('launch-count').textContent = chooser.launches.length;
  const lock = chooser.processingLock;
  $('chooser-lock').hidden = !lock;
  if (lock) {$('chooser-lock').className = `status-pill warning`; $('chooser-lock').textContent = `Busy: ${lock.kind || 'processing'} in another launch`;}
  const notice = $('chooser-notice');
  notice.hidden = !(chooser.google && !chooser.google.configured);
  if (chooser.google && !chooser.google.configured) notice.innerHTML = `<strong>Google Drive is not configured on this server.</strong> Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, and <code>GOOGLE_REDIRECT_URI</code>, then restart. Local campaigns keep working.`;
  $('launch-cards').innerHTML = chooser.launches.map(card => {
    const readiness = card.readiness || {label:'Not opened yet',tone:'warning'};
    const refreshed = card.lastSuccessfulRefreshAt ? ` · Refreshed ${new Date(card.lastSuccessfulRefreshAt).toLocaleString()}` : '';
    const details = `${card.campaignName ? esc(card.campaignName) : 'Campaign manifest not verified yet'}${card.registered != null ? ` · ${card.registered} assets` : ''}`;
    const disconnected = card.status === 'disconnected';
    // A disconnected launch can only reconnect: there is nothing to open, refresh, or revoke.
    const driveActions = card.type !== 'google-drive' ? '' : disconnected
      ? `<button type="button" class="secondary launch-action" data-reconnect="${esc(card.id)}">Reconnect</button><button type="button" class="text-button launch-action" data-disconnect="${esc(card.id)}" disabled>Disconnect</button>`
      : `<button type="button" class="secondary launch-action" data-refresh="${esc(card.id)}">Refresh</button><button type="button" class="text-button launch-action" data-disconnect="${esc(card.id)}">Disconnect</button>`;
    return `<article class="launch-card${card.status === 'disconnected' ? ' disconnected' : ''}"><div class="card-top"><img src="/brand/logo.svg" alt="" width="34" height="34"><span class="status-pill launch-readiness ${readiness.tone || 'info'}">${esc(readiness.label)}</span></div><p class="eyebrow">${esc(card.source)}</p><h2>${esc(card.label)}</h2><p class="muted">${details}</p><p class="launch-meta">${esc(card.workspacePath ? 'Local folder' : 'Read-only Drive snapshot')}${card.type === 'google-drive' && !refreshed ? ' · Not refreshed yet' : ''}${esc(refreshed)}</p>${card.sampleMatch ? '<span class="pill">Public demo copy · demo scope by default</span>' : ''}<div class="card-bottom"><button type="button" class="primary open-launch" data-open="${esc(card.id)}"${disconnected ? ' disabled' : ''}>Open campaign <span aria-hidden="true">→</span></button>${driveActions}</div><p class="launch-job" data-job="${esc(card.id)}" role="status" hidden></p></article>`;
  }).join('');
  for (const button of $('launch-cards').querySelectorAll('[data-open]')) button.addEventListener('click',() => void openLaunch(button.dataset.open));
  for (const button of $('launch-cards').querySelectorAll('[data-refresh]')) button.addEventListener('click',() => void refreshDriveLaunch(button.dataset.refresh));
  for (const button of $('launch-cards').querySelectorAll('[data-reconnect]')) button.addEventListener('click',() => void startReconnect(button.dataset.reconnect));
  for (const button of $('launch-cards').querySelectorAll('[data-disconnect]')) button.addEventListener('click',() => {disconnectTarget = button.dataset.disconnect; $('disconnect-dialog').showModal(); $('cancel-disconnect').focus();});
  updateConnectForm();
}
function updateConnectForm() {
  // A reconnect replaces one launch's connection, so it never asks for a folder again.
  const connected = Boolean(pendingConnectionId) && !reconnectTarget;
  $('google-start').hidden = connected;
  $('drive-launch-form').hidden = !connected;
  if (!connected) return;
  $('drive-folder').focus();
}
function setConnectStatus(message, tone = 'help') {
  const status = $('connect-status');
  status.hidden = !message;
  status.className = tone === 'danger' ? 'danger' : 'help';
  status.textContent = message || '';
}
// Poll a durable job until it reports a final outcome; launch jobs use their scoped job route.
function pollJob(route, onStatus, onDone) {
  const timer = setInterval(async () => {
    let job;
    try {job = await api(route);}
    catch (error) {clearInterval(timer);toast(error.message);onDone(null);return;}
    onStatus(job);
    if (['completed','failed','interrupted'].includes(job.status)) {clearInterval(timer);onDone(job);}
  },1000);
}
async function openLaunch(launchId) {
  if (requestBusy) return;
  requestBusy = true;
  try {
    launch = {workspaceId:chooser.workspace.id,launchId};
    // Per-launch interface state resets; unsaved drafts stay keyed to this launch's identity.
    state = null; selectedId = null; reviewSignature = ''; librarySignature = ''; lastProgress = ''; pendingRun = false; demoModeLoaded = false; revisionOpenKey = null; aiDraft = null;
    setView('loading'); $('loading-message').textContent = 'Cross-checking campaign sources and registered files…';
    state = await api('/api/state');
    if (!demoModeLoaded) adoptDemoDefault();
    await api('/api/campaign/open',{});
    state = await api('/api/state');
    $('loading-message').textContent = `${state.evidence.registered} assets found across ${state.evidence.channelCount} channels. Opening your dashboard…`;
    setBriefExpanded(false); setView('dashboard'); dashboard();
  } catch (error) {
    toast(error.message);
    launch = null; state = chooser ? chooserState() : null;
    if (chooser) {setView('chooser'); renderChooser();}
  } finally {requestBusy = false;}
}
async function refreshDriveLaunch(launchId) {
  if (requestBusy || activeJob) return;
  requestBusy = true;
  try {
    const result = await api(launchRoute(launchId,'/refresh'),{launchId});
    requestBusy = false;
    activeJob = result.jobId;
    pollJob(launchRoute(launchId,`/jobs/${result.jobId}`),job => {
      const line = document.querySelector(`[data-job="${CSS.escape(launchId)}"]`);
      if (line) {line.hidden = false; line.textContent = job.progress?.message || 'Refreshing the Drive snapshot…';}
    },async job => {
      activeJob = null;
      chooser = await api('/api/state');
      state = chooserState();
      renderChooser();
      if (!job || job.status === 'completed') toast('Drive snapshot refreshed. The launch now works from the new snapshot.');
      else toast(job?.error || 'The Drive refresh failed. The previous snapshot and all recorded work were preserved.');
    });
  } catch (error) {requestBusy = false; toast(error.message);}
}
// A disconnected launch reconnects in place: the browser authorizes, then the boot step replaces
// this launch's connection. The launch keeps its identity, snapshots, and recorded work.
async function startReconnect(launchId) {
  if (requestBusy || activeJob) return;
  if (chooser?.google && !chooser.google.configured) {toast('Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI on this server, then restart to connect Google Drive.');return;}
  requestBusy = true;
  try {
    reconnectTarget = launchId;
    try {sessionStorage.setItem('cc-reconnect-launch', launchId);} catch {}
    const {authorizationUrl} = await api('/api/google/authorize',{});
    location.href = authorizationUrl;
  } catch (error) {reconnectTarget = null; try {sessionStorage.removeItem('cc-reconnect-launch');} catch {} toast(error.message);}
  finally {requestBusy = false;}
}
// Runs once the chooser is loaded, so the launch's scoped route is known after the Google redirect.
async function completeReconnect() {
  const launchId = reconnectTarget, connectionId = pendingConnectionId;
  reconnectTarget = null; pendingConnectionId = null;
  try {
    const result = await api(launchRoute(launchId,'/connection'),{launchId,connectionId});
    try {sessionStorage.removeItem('cc-reconnect-launch');history.replaceState(null,'','/');} catch {}
    renderChooser();
    activeJob = result.jobId;
    pollJob(launchRoute(launchId,`/jobs/${result.jobId}`),job => {
      const line = document.querySelector(`[data-job="${CSS.escape(launchId)}"]`);
      if (line) {line.hidden = false; line.textContent = job.progress?.message || 'Verifying the new Google connection…';}
    },async job => {
      activeJob = null;
      chooser = await api('/api/state');
      state = chooserState();
      renderChooser();
      if (!job || job.status === 'completed') toast('Google Drive reconnected. Refresh to work from a new snapshot.');
      else toast(job?.error || 'Reconnecting failed. The previous snapshot and all recorded work were preserved.');
    });
  } catch (error) {
    try {sessionStorage.removeItem('cc-reconnect-launch');history.replaceState(null,'','/');} catch {}
    toast(error.message);
    setConnectStatus(error.message,'danger');
  }
}
async function refresh() {
  if (refreshing) return; refreshing=true;
  try {
    if (launch) {
      const previousHash=state?.run?.candidateHash, previousRun=state?.run?.id;
      state=await api('/api/state');
      if (!demoModeLoaded) adoptDemoDefault();
      if(previousHash!==state.run?.candidateHash || previousRun!==state.run?.id){$('confirm-facts').checked=false;reviewSignature='';}
      dashboard();
      if(view==='progress' && !pendingRun)routeRun();
      else if(view==='review'){if(state.busy || !state.run?.candidateHash || state.run.status==='stale')routeRun();else renderReview();}
      else if(view==='release'){if(!state.readyRelease)routeRun();else renderRelease();}
      if($('library').open && librarySignature!==JSON.stringify([state.run?.id,state.run?.candidateHash]))renderLibrary();
    } else {
      const snapshot = await api('/api/state');
      if (snapshot.launches && snapshot.workspace && !snapshot.campaign) {
        chooser = snapshot; state = chooserState();
        if (view !== 'chooser') setView('chooser');
        renderChooser();
        // Returning from Google consent for an existing launch replaces its connection instead of adding one.
        if (pendingConnectionId && reconnectTarget) void completeReconnect();
      } else {
        state = snapshot;
        if (!demoModeLoaded) adoptDemoDefault();
        dashboard();
        if(view==='progress' && !pendingRun)routeRun();
        else if(view==='review'){if(state.busy || !state.run?.candidateHash || state.run.status==='stale')routeRun();else renderReview();}
        else if(view==='release'){if(!state.readyRelease)routeRun();else renderRelease();}
      }
    }
  } catch(error){toast(error.message);}
  finally{refreshing=false;}
}
async function guarded(work, busy) {
  if(requestBusy)return;requestBusy=true;
  if(state)renderAISettings();
  // Show the pending state immediately and block duplicate submissions while the request runs.
  const button = busy?.id ? $(busy.id) : null;
  // Structured controls (the campaign card) carry their content inside the button; disabling is their pending state.
  const simple = button ? !(button.children && button.children.length) : false;
  const restoreLabel = simple ? button.textContent : null;
  if (button) {button.disabled = true; if (simple && busy.label) button.textContent = busy.label;}
  try{await work();}catch(error){toast(error.message);if(view==='progress'){await refresh();if(!state?.busy&&!active.has(state?.run?.status))routeRun();}}
  finally{if (button) {button.disabled = false; if (simple && restoreLabel !== null) button.textContent = restoreLabel;}requestBusy=false;if(state?.campaign){dashboard();if(view==='review')renderReview(true);}}
}
async function openCampaign() {
  await guarded(async()=>{
    setView('loading');$('loading-message').textContent='Cross-checking campaign sources and registered files…';
    state=await api('/api/campaign/open',{});
    // The dashboard opens as soon as the real cross-check completes; no staged delay.
    $('loading-message').textContent=`${state.evidence.registered} assets found across ${state.evidence.channelCount} channels. Opening your dashboard…`;
    setBriefExpanded(false);setView('dashboard');dashboard();
  },{id:'campaign-button',label:'Opening…'});
  if(view==='loading')setView('home');
}
function newBrief() {if(state.run?.brief)$('brief').value=state.run.brief;if(state.run?.scope)demoMode=state.run.scope.assetIds.length<state.run.scope.inventoryCount;setView('dashboard');dashboard();setBriefExpanded(true,true);}
function openAssetReview(assetId) {
  if (!scopeAssets().some(a=>a.id===assetId && a.candidateText) || !state.run?.candidateHash || isBusy()) return;
  if ($('library').open) $('library').close();
  selectedId=assetId;setView('review',false);renderReview(true);
  $('asset-toolbar').scrollIntoView({block:'start',behavior:'instant'});$('asset-heading').focus({preventScroll:true});
}
function renderLibrary() {
  const query=$('asset-search').value.toLowerCase().trim(), filter=$('channel-filter').value;
  const status=$('asset-status-filter').value, included=new Set(scopeAssets().map(a=>a.id));
  const items=state.assets.filter(a=>(!filter||a.channel===filter)&&(!status||(status==='included'?included.has(a.id):included.has(a.id)&&a.required&&!assetCleared(a)))&&`${a.id} ${a.title} ${channel(a.channel)}`.toLowerCase().includes(query));
  $('library-list').innerHTML=items.length?items.map(a=>`<button class="library-row" data-asset="${esc(a.id)}"><span class="asset-id">${esc(a.id)}</span><strong>${esc(a.title)}</strong><small>${esc(assetType(a))}${a.capabilities?.externalEditorRequired?' · External editor':''} · ${state.run&&!included.has(a.id)?'Outside this release':a.resolution?.overridden?'Human override':a.candidateText?(a.status==='checked'?'Checks passed':'Needs attention'):'Original'}</small><span aria-hidden="true">↗</span></button>`).join(''):'<p class="muted">No matching assets.</p>';
  librarySignature=JSON.stringify([state.run?.id,state.run?.candidateHash]);
}
function openLibrary(status='') {
  $('library-detail').hidden=true;$('library-list').hidden=false;$('asset-search').value='';
  $('asset-status-filter').value=typeof status==='string'?status:'';
  $('channel-filter').innerHTML='<option value="">All channels</option>'+Object.keys(state.evidence.channels).map(c=>`<option value="${esc(c)}">${esc(channel(c))}</option>`).join('');
  renderLibrary();$('library').showModal();$('asset-search').focus();
}
$('home-button').addEventListener('click',()=>{if(chooser){launch=null;state=chooserState();setView('chooser');renderChooser();}else{setView('home');dashboard();}});
$('ai-settings-button').addEventListener('click',openAISettings);
$('cancel-ai-settings').addEventListener('click',cancelAISettings);
$('ai-settings-dialog').addEventListener('cancel',event=>{if(aiSaving)event.preventDefault();else aiDraft=null;});
$('ai-provider').addEventListener('change',()=>{if(isBusy()||!aiDraft)return;aiDraft={provider:$('ai-provider').value,model:''};renderAISettings();});
$('ai-model-list').addEventListener('change',event=>{if(isBusy()||!aiDraft||event.target.name!=='ai-model')return;aiDraft.model=event.target.value;renderAISettings();});
$('ai-settings-form').addEventListener('submit',event=>{event.preventDefault();void saveAISettings();});
$('demo-mode').addEventListener('change',()=>{demoMode=$('demo-mode').checked;updateMode();});
$('campaign-button').addEventListener('click',openCampaign);
$('toggle-update').addEventListener('click',()=>{if(!isBusy())setBriefExpanded($('update-editor').hidden,true);});
$('background-button').addEventListener('click',()=>{setView('dashboard');dashboard();});
$('brief').addEventListener('input',()=>{$('brief-length').textContent=`${$('brief').value.length} / 4,000`;if(state)dashboard();});
$('brief-length').textContent=`${defaultBrief.length} / 4,000`;
$('brief-form').addEventListener('submit',event=>{event.preventDefault();if(isBusy())return;void guarded(async()=>{
  const brief=$('brief').value.trim();
  const reviewAssetIds=representativeIds();
  const request={brief,reviewAssetIds,...(demoMode ? {assetIds:reviewAssetIds} : {})};
  pendingRun=true;setView('progress');$('progress-message').textContent='Reserving a new version and reading campaign sources…';
  try{await api('/api/runs',request);state=await api('/api/state');selectedId=null;reviewSignature='';renderProgress();}finally{pendingRun=false;}
},{id:'update-button',label:'Updating…'});
});
$('review-cards').addEventListener('click',event=>{const button=event.target.closest('[data-review]');if(button){selectedId=button.dataset.review;renderReview(true);document.querySelector(`[data-review="${CSS.escape(selectedId)}"]`)?.focus({preventScroll:true});}});
$('approval-blockers').addEventListener('click',event=>{const button=event.target.closest('[data-blocked-asset]');if(button)openAssetReview(button.dataset.blockedAsset);});
$('review-all-button').addEventListener('click',()=>openLibrary('included'));
$('confirm-facts').addEventListener('change',()=>renderReview());$('reviewer').addEventListener('input',()=>renderReview());
$('approval-form').addEventListener('submit',event=>{event.preventDefault();if($('approve-button').disabled)return;const dirty=scopeAssets().filter(a=>hasCurrentDraft(state.run,a));if(dirty.length){toast(`Save or discard unsaved edits on ${dirty.map(a=>a.id).join(', ')} before approving.`);return;}void guarded(async()=>{
  const run=state.run, candidateHash=run.candidateHash;
  if(run.status!=='approved')state=await api(`/api/runs/${run.id}/decision`,{decision:'approve',candidateHash,reviewer:$('reviewer').value.trim(),comment:'Confirmed interpreted facts and reviewed representative assets in Campaign Control.'});
  await api(`/api/runs/${run.id}/package`,{candidateHash});state=await api('/api/state');routeRun();
},{id:'approve-button',label:'Preparing release…'});});
$('reject-button').addEventListener('click',()=>{if(!$('reviewer').value.trim()){toast('Enter your name to record a review decision.');$('reviewer').focus();return;}void guarded(async()=>{state=await api(`/api/runs/${state.run.id}/decision`,{decision:'reject',candidateHash:state.run.candidateHash,reviewer:$('reviewer').value.trim(),comment:'Reviewer requested changes.'});toast('Version rejected. Request an asset revision or revise the brief.');renderReview(true);},{id:'reject-button',label:'Recording…'});});
for(const id of ['revise-brief-button','retry-button'])$(id).addEventListener('click',newBrief);
$('next-version').addEventListener('click',()=>void guarded(async()=>{const brief=state.run?.brief || $('brief').value;state=await api('/api/revisions',{});$('brief').value=brief;newBrief();},{id:'next-version',label:'Starting…'}));
for(const id of ['browse-button','all-candidates-button'])$(id).addEventListener('click',openLibrary);
$('close-library').addEventListener('click',()=>$('library').close());
$('asset-search').addEventListener('input',()=>{$('library-detail').hidden=true;$('library-list').hidden=false;renderLibrary();});
$('channel-filter').addEventListener('change',()=>{$('library-detail').hidden=true;$('library-list').hidden=false;renderLibrary();});
$('asset-status-filter').addEventListener('change',()=>{$('library-detail').hidden=true;$('library-list').hidden=false;renderLibrary();});
$('library-list').addEventListener('click',event=>{const button=event.target.closest('[data-asset]');if(!button)return;const asset=state.assets.find(a=>a.id===button.dataset.asset);$('library-list').hidden=true;$('library-detail').hidden=false;$('library-detail').innerHTML=`<button class="text-button" id="back-library">← All assets</button><div class="asset-identity"><span class="asset-id">${esc(asset.id)}</span><span class="asset-type">${esc(assetType(asset))}</span></div><h3>${esc(asset.title)}</h3>${asset.candidateText&&scopeAssets().includes(asset)&&state.run?.candidateHash?'<button class="secondary" id="review-library-asset">Open review & revision controls</button>':''}<div class="preview-grid">${preview(asset,'source')}${asset.candidateText?preview(asset,'candidate'):''}</div>${asset.issues?.length?`<div class="notice">${asset.issues.map(i=>`<p>${esc(i.message)} ${esc(i.evidence)}</p>`).join('')}</div>`:''}`;$('back-library').addEventListener('click',()=>{$('library-detail').hidden=true;$('library-list').hidden=false;});$('review-library-asset')?.addEventListener('click',()=>openAssetReview(asset.id));$('back-library').focus();});
$('copy-path').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('release-path').textContent);toast('Release folder path copied.');}catch{toast('Copy the folder path shown above.');}});
$('reset-demo-button').addEventListener('click',()=>{if(isBusy())return;resetTarget={launchId:state.identity?.launchId ?? null,campaignId:state.campaign.id,runId:state.run?.id ?? null};$('reset-demo-dialog').showModal();$('cancel-reset-demo').focus();});
$('cancel-reset-demo').addEventListener('click',()=>$('reset-demo-dialog').close());
$('confirm-reset-demo').addEventListener('click',()=>{if(isBusy()||!resetTarget)return;void guarded(async()=>{
  state=await api('/api/demo/reset',resetTarget);
  $('reset-demo-dialog').close();resetTarget=null;
  // Clear only this launch's unsaved drafts; other launches keep theirs.
  clearLaunchDrafts();revisionOpenKey=null;selectedId=null;reviewSignature='';librarySignature='';lastProgress='';
  adoptDemoDefault();
  if(state.capabilities?.demoScopeDefault){$('brief').value=defaultBrief;$('brief-length').textContent=`${defaultBrief.length} / 4,000`;}
  $('reviewer').value='';$('confirm-facts').checked=false;
  if(chooser){setView('dashboard');dashboard();}else{setView('home');dashboard();}
  toast('Reset complete. The original campaign is restored; previous work is archived privately.');
},{id:'confirm-reset-demo',label:'Resetting…'});});
$('google-start').addEventListener('click',async()=>{
  if(requestBusy)return;
  if(chooser.google && !chooser.google.configured){toast('Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI on this server, then restart to connect Google Drive.');return;}
  requestBusy=true;
  try{const {authorizationUrl}=await api('/api/google/authorize',{});location.href=authorizationUrl;}
  catch(error){toast(error.message);}
  finally{requestBusy=false;}
});
$('cancel-drive-launch').addEventListener('click',()=>{pendingConnectionId=null;$('drive-launch-form').hidden=true;$('google-start').hidden=false;setConnectStatus('');});
$('drive-launch-form').addEventListener('submit',event=>{
  event.preventDefault();
  if(requestBusy||!pendingConnectionId)return;
  const folderId=$('drive-folder').value.trim();
  if(!folderId){toast('Paste the Google Drive folder ID or URL that holds campaign.json.');$('drive-folder').focus();return;}
  void guarded(async()=>{
    setConnectStatus('Reserving a private snapshot space and reading the Drive folder…');
    const result=await api('/api/google/launches',{connectionId:pendingConnectionId,folderId});
    activeJob=result.jobId;
    pollJob(`/api/jobs/${result.jobId}`,job=>{setConnectStatus(job.progress?.message || 'Reading the Drive campaign…');},async job=>{
      activeJob=null;
      if(!job||job.status==='completed'){
        setConnectStatus('');pendingConnectionId=null;$('drive-folder').value='';
        try{history.replaceState(null,'','/');}catch{}
        const newLaunchId=job?.result?.launchId;
        chooser=await api('/api/state');state=chooserState();renderChooser();
        toast('Google Drive campaign connected.');
        if(newLaunchId)await openLaunch(newLaunchId);
      }else{
        chooser=await api('/api/state');state=chooserState();renderChooser();
        setConnectStatus(job.error || 'The Drive connection failed.','danger');
        toast(job.error || 'The Drive connection failed.');
      }
    });
  },{id:'add-drive-launch',label:'Connecting…'});
});
$('cancel-disconnect').addEventListener('click',()=>$('disconnect-dialog').close());
$('confirm-disconnect').addEventListener('click',()=>{
  if(!disconnectTarget)return;
  $('disconnect-dialog').close();
  void guarded(async()=>{
    const result=await api(launchRoute(disconnectTarget,'/disconnect'),{launchId:disconnectTarget});
    disconnectTarget=null;
    chooser=result.launches?result:chooser;
    state=chooserState();renderChooser();
    toast('Google Drive disconnected. Access was revoked on this server; recorded work is preserved.');
  },{id:'confirm-disconnect',label:'Disconnecting…'});
});
// Google redirects back to /?googleConnection=<id> after consent; that identity authorizes one folder choice,
// or replaces the connection of the launch that was reconnecting.
try {pendingConnectionId=/[?&]googleConnection=([A-Za-z0-9_-]+)/.exec(typeof location.search==='string'?location.search:'')?.[1]||null;} catch {pendingConnectionId=null;}
try {reconnectTarget=pendingConnectionId ? sessionStorage.getItem('cc-reconnect-launch') : null;} catch {reconnectTarget=null;}
void refresh();setInterval(()=>void refresh(),2500);
