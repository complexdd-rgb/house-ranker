(() => {
  const attempted = new Set();
  let pendingSubmission = null;

  function cleanPostcode(value) {
    const raw = String(value || '').toUpperCase().replace(/[\s+]+/g, '').trim();
    if (!raw) return '';
    return raw.length > 3 ? `${raw.slice(0, -3)} ${raw.slice(-3)}` : raw;
  }

  function extractPostcode(value) {
    const match = String(value || '').toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
    return match ? cleanPostcode(match[1]) : '';
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function epcFromRow(row) {
    return {
      status: row.epc_status || 'pending',
      certificateNumber: row.epc_certificate_number || null,
      uprn: row.epc_uprn || null,
      rating: numberOrNull(row.epc_rating),
      band: row.epc_band || null,
      potentialRating: numberOrNull(row.epc_potential_rating),
      potentialBand: row.epc_potential_band || null,
      registrationDate: row.epc_registration_date || null,
      matchConfidence: numberOrNull(row.epc_match_confidence),
      enrichedAt: row.epc_enriched_at || null
    };
  }

  // Extend the Phase 1 DB mappers without changing the stable core file.
  if (typeof fromDbProperty === 'function') {
    const originalFromDbProperty = fromDbProperty;
    fromDbProperty = function phase2FromDbProperty(row) {
      const property = originalFromDbProperty(row);
      property.postcode = row.postcode || extractPostcode(row.address) || '';
      property.floorArea = numberOrNull(row.floor_area_m2);
      property.epc = epcFromRow(row);
      return property;
    };
  }

  if (typeof toDbProperty === 'function') {
    const originalToDbProperty = toDbProperty;
    toDbProperty = function phase2ToDbProperty(property, userId) {
      const row = originalToDbProperty(property, userId);
      row.postcode = cleanPostcode(property.postcode) || extractPostcode(property.address) || null;
      if (property.floorArea !== undefined && property.floorArea !== null) row.floor_area_m2 = property.floorArea;
      return row;
    };
  }

  function ensurePhase2Form() {
    const address = document.getElementById('address');
    if (!address) return;

    address.placeholder = 'e.g. 12 Example Road, Nottingham';

    if (!document.getElementById('postcode')) {
      const label = document.createElement('label');
      label.innerHTML = 'Postcode <span class="field-hint">recommended for EPC matching</span><input id="postcode" autocomplete="postal-code" placeholder="e.g. NG9 1AA" />';
      const addressLabel = address.closest('label');
      if (addressLabel) addressLabel.insertAdjacentElement('afterend', label);
    }

    const formSection = document.querySelector('#propertyForm .form-section');
    if (formSection && !document.getElementById('epcFormNote')) {
      const note = document.createElement('div');
      note.id = 'epcFormNote';
      note.className = 'epc-form-note';
      note.innerHTML = '<strong>Automatic EPC enrichment</strong><span>When you are signed in, House Ranker will match this address to official England & Wales EPC data and automatically fill the Energy score and floor area.</span>';
      formSection.appendChild(note);
    }

    const addViewText = document.querySelector('#add .page-heading .muted');
    if (addViewText) {
      addViewText.textContent = 'Add the full address and postcode. Signed-in houses are automatically checked against official EPC data.';
    }

    const scoringText = document.querySelector('#propertyForm .form-section:nth-of-type(2) .muted');
    if (scoringText) {
      scoringText.textContent = 'Most inputs remain manual for now. After a confident EPC match, Energy is replaced automatically with the official energy-efficiency rating.';
    }
  }

  function epcLabel(property) {
    const epc = property.epc || {};
    if (epc.status === 'matched') {
      const bits = [];
      if (epc.band) bits.push(`EPC ${epc.band}${epc.rating !== null && epc.rating !== undefined ? ` ${epc.rating}` : ''}`);
      if (property.floorArea) bits.push(`${Math.round(property.floorArea)} m²`);
      bits.push(`Energy ${Math.round(Number(property.metrics?.energy || 0))}/100`);
      return { className: 'matched', text: bits.join(' · ') };
    }
    if (epc.status === 'needs_review') return { className: 'review', text: 'EPC match needs review' };
    if (epc.status === 'no_match') return { className: 'muted', text: 'No EPC match found' };
    if (epc.status === 'error') return { className: 'error', text: 'EPC lookup unavailable' };
    return { className: 'pending', text: 'EPC lookup pending' };
  }

  function decorateLeaderboard() {
    document.querySelectorAll('.property-row').forEach(row => {
      const detailButton = row.querySelector('[data-detail]');
      if (!detailButton || row.querySelector('.epc-inline')) return;
      const property = state.properties.find(item => item.id === detailButton.dataset.detail);
      if (!property || property.demo) return;
      const target = row.querySelector('.property-title');
      if (!target) return;
      const label = epcLabel(property);
      const badge = document.createElement('span');
      badge.className = `epc-inline ${label.className}`;
      badge.textContent = label.text;
      target.appendChild(badge);
    });
  }

  if (typeof renderDashboard === 'function') {
    const originalRenderDashboard = renderDashboard;
    renderDashboard = function phase2RenderDashboard(...args) {
      const result = originalRenderDashboard.apply(this, args);
      decorateLeaderboard();
      return result;
    };
  }

  function dateLabel(value) {
    if (!value) return '—';
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' }).format(date);
  }

  function renderEpcDetail(property) {
    if (!property || property.demo) return '';
    const epc = property.epc || { status: 'pending' };
    const energy = Math.round(Number(property.metrics?.energy || 0));

    if (epc.status === 'matched') {
      return `
        <section class="epc-detail-card matched">
          <div class="epc-detail-heading">
            <div><p class="eyebrow">AUTOMATIC EPC DATA</p><h3>Energy & floor area</h3></div>
            <span class="epc-band">${escapeHtml(epc.band || '—')}</span>
          </div>
          <div class="epc-data-grid">
            <div><small>Current rating</small><strong>${epc.rating ?? '—'}</strong></div>
            <div><small>Energy score</small><strong>${energy}/100</strong></div>
            <div><small>Floor area</small><strong>${property.floorArea ? `${Math.round(property.floorArea)} m²` : '—'}</strong></div>
            <div><small>Potential</small><strong>${escapeHtml(epc.potentialBand || '')}${epc.potentialRating !== null && epc.potentialRating !== undefined ? ` ${epc.potentialRating}` : '—'}</strong></div>
          </div>
          <p class="muted epc-footnote">Official EPC dataset · registered ${dateLabel(epc.registrationDate)}${epc.matchConfidence !== null && epc.matchConfidence !== undefined ? ` · ${epc.matchConfidence}% address-match confidence` : ''}. The Energy category now uses the current EPC numerical rating.</p>
          <button class="ghost epc-retry" type="button" data-epc-retry="${property.id}">Refresh EPC data</button>
        </section>`;
    }

    const messages = {
      pending: 'This property is waiting for its first EPC lookup.',
      no_match: 'No sufficiently close EPC record was found for this address. Check the house number/name and postcode, then retry.',
      needs_review: `A possible EPC was found${epc.matchConfidence !== null && epc.matchConfidence !== undefined ? ` (${epc.matchConfidence}% confidence)` : ''}, but House Ranker did not auto-apply it because the address match was not strong enough.`,
      error: 'The EPC lookup could not complete. The house is still saved and its other scores are unaffected.'
    };

    return `
      <section class="epc-detail-card ${escapeHtml(epc.status || 'pending')}">
        <p class="eyebrow">AUTOMATIC EPC DATA</p>
        <h3>${epc.status === 'needs_review' ? 'Match needs review' : epc.status === 'no_match' ? 'No EPC match yet' : epc.status === 'error' ? 'EPC lookup unavailable' : 'EPC lookup pending'}</h3>
        <p class="muted">${messages[epc.status] || messages.pending}</p>
        <button class="ghost epc-retry" type="button" data-epc-retry="${property.id}">Try EPC lookup again</button>
      </section>`;
  }

  function injectEpcDetail(propertyId) {
    const detail = document.getElementById('propertyDetail');
    if (!detail || detail.querySelector('.epc-detail-card')) return;
    const property = state.properties.find(item => item.id === propertyId);
    if (!property || property.demo) return;
    const breakdown = detail.querySelector('.breakdown');
    if (breakdown) breakdown.insertAdjacentHTML('afterend', renderEpcDetail(property));
  }

  async function parseFunctionError(error) {
    let payload = null;
    try {
      if (error?.context?.clone) payload = await error.context.clone().json();
      else if (error?.context?.json) payload = await error.context.json();
    } catch {}
    return payload || {};
  }

  function replaceProperty(row) {
    if (!row) return null;
    const property = fromDbProperty(row);
    const index = state.properties.findIndex(item => item.id === property.id);
    if (index >= 0) state.properties[index] = property;
    else state.properties.push(property);
    renderDashboard();
    return property;
  }

  async function enrichPropertyEpc(propertyId, { quiet = false } = {}) {
    if (!cloud.client || !cloud.session) {
      if (!quiet) toast('Sign in to run automatic EPC matching');
      return { ok: false, code: 'SIGNED_OUT' };
    }

    attempted.add(propertyId);
    if (!quiet) toast('Checking the official EPC dataset…');

    const { data, error } = await cloud.client.functions.invoke('epc-enrich', {
      body: { propertyId }
    });

    if (error) {
      const payload = await parseFunctionError(error);
      const code = payload.code || 'FUNCTION_ERROR';
      if (!quiet) {
        if (code === 'EPC_TOKEN_NOT_CONFIGURED') toast('EPC matching is ready but the government API token still needs adding in Supabase');
        else toast(`EPC lookup failed: ${payload.detail || payload.error || error.message || 'unknown error'}`);
      }
      return { ok: false, code, error };
    }

    const property = replaceProperty(data?.property);
    if (!quiet) {
      if (data?.status === 'matched') {
        const band = property?.epc?.band ? ` · EPC ${property.epc.band}` : '';
        const floor = property?.floorArea ? ` · ${Math.round(property.floorArea)} m²` : '';
        toast(`EPC matched${band}${floor} · Energy ${data.energyScore}/100`);
      } else if (data?.status === 'needs_review') {
        toast('Possible EPC found, but the address match is not strong enough to auto-apply');
      } else if (data?.status === 'no_match') {
        toast('No EPC match found — check the full address and postcode');
      }
    }
    return { ok: true, status: data?.status, property };
  }

  async function waitForSavedProperty(beforeIds, address, startedAt) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = state.properties.find(property =>
        !property.demo &&
        !beforeIds.has(property.id) &&
        new Date(property.createdAt || 0).getTime() >= startedAt - 2000
      );
      if (candidate) return candidate;
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    return null;
  }

  function wireAutomaticEnrichment() {
    const form = document.getElementById('propertyForm');
    if (!form) return;

    // Capture phase runs before the Phase 1 submit handler, so the saved address includes the postcode.
    form.addEventListener('submit', event => {
      if (event.defaultPrevented || !cloud.session) return;
      const addressInput = document.getElementById('address');
      const postcodeInput = document.getElementById('postcode');
      const postcode = cleanPostcode(postcodeInput?.value) || extractPostcode(addressInput?.value);
      if (postcodeInput) postcodeInput.value = postcode;
      if (addressInput && postcode && !extractPostcode(addressInput.value)) {
        addressInput.value = `${addressInput.value.trim()}, ${postcode}`;
      }

      const beforeIds = new Set(state.properties.map(property => property.id));
      const address = addressInput?.value || '';
      const startedAt = Date.now();
      pendingSubmission = { beforeIds, address, startedAt };

      setTimeout(async () => {
        if (!pendingSubmission || pendingSubmission.startedAt !== startedAt) return;
        const saved = await waitForSavedProperty(beforeIds, address, startedAt);
        if (!saved) return;
        pendingSubmission = null;
        await enrichPropertyEpc(saved.id);
      }, 0);
    }, true);
  }

  async function hydrateEpcMetadata() {
    if (!cloud.client || !cloud.session) return;
    const { data, error } = await cloud.client
      .from('properties')
      .select('id,postcode,floor_area_m2,epc_certificate_number,epc_uprn,epc_rating,epc_band,epc_potential_rating,epc_potential_band,epc_registration_date,epc_match_confidence,epc_status,epc_enriched_at,metrics');
    if (error) return;

    for (const row of data || []) {
      const property = state.properties.find(item => item.id === row.id);
      if (!property) continue;
      property.postcode = row.postcode || property.postcode || extractPostcode(property.address);
      property.floorArea = numberOrNull(row.floor_area_m2);
      property.epc = epcFromRow(row);
      property.metrics = { ...(property.metrics || {}), ...(row.metrics || {}) };
    }
    renderDashboard();
  }

  async function autoEnrichPending() {
    if (!cloud.session || !cloud.client) return;
    await hydrateEpcMetadata();
    const pending = state.properties.filter(property => !property.demo && (property.epc?.status || 'pending') === 'pending' && !attempted.has(property.id));
    for (const property of pending.slice(0, 5)) {
      const result = await enrichPropertyEpc(property.id, { quiet: true });
      if (!result.ok) break;
    }
  }

  function scheduleHydration() {
    setTimeout(() => autoEnrichPending(), 900);
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) setTimeout(() => injectEpcDetail(detailButton.dataset.detail), 0);

    const retry = event.target.closest?.('[data-epc-retry]');
    if (retry) {
      event.preventDefault();
      enrichPropertyEpc(retry.dataset.epcRetry).then(() => {
        const detailId = retry.dataset.epcRetry;
        const detail = document.getElementById('propertyDetail');
        if (detail && document.getElementById('propertyDialog')?.open) {
          detail.querySelector('.epc-detail-card')?.remove();
          injectEpcDetail(detailId);
        }
      });
    }
  });

  ensurePhase2Form();
  wireAutomaticEnrichment();
  decorateLeaderboard();

  // initCloud() starts before this file loads. Wait for its client/session, then keep EPC metadata in sync across auth changes.
  const initTimer = setInterval(() => {
    if (!cloud.client) return;
    clearInterval(initTimer);
    if (cloud.session) scheduleHydration();
    cloud.client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) scheduleHydration();
    });
  }, 100);
  setTimeout(() => clearInterval(initTimer), 10000);

  window.HouseRankerEpc = Object.freeze({ enrichPropertyEpc });
})();
