(() => {
  const attempted = new Set();

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function connectivityFromRow(row) {
    return {
      status: row.connectivity_status || 'pending',
      score: numberOrNull(row.connectivity_score),
      broadbandScore: numberOrNull(row.broadband_score),
      mobileScore: numberOrNull(row.mobile_score),
      maxDownloadMbps: numberOrNull(row.broadband_max_download_mbps),
      maxUploadMbps: numberOrNull(row.broadband_max_upload_mbps),
      fullFibre: row.broadband_full_fibre,
      gigabit: row.broadband_gigabit,
      indoorNetworks: numberOrNull(row.mobile_likely_indoor_networks),
      outdoorNetworks: numberOrNull(row.mobile_likely_outdoor_networks),
      enrichedAt: row.connectivity_enriched_at || null,
      broadband: null,
      mobile: null,
      source: null,
      scoreMethod: null,
      note: null
    };
  }

  if (typeof fromDbProperty === 'function') {
    const originalFromDbProperty = fromDbProperty;
    fromDbProperty = function connectivityFromDbProperty(row) {
      const property = originalFromDbProperty(row);
      property.connectivity = connectivityFromRow(row);
      return property;
    };
  }

  function speed(value) {
    const n = numberOrNull(value);
    if (n === null) return '—';
    return `${n >= 100 ? Math.round(n) : n.toFixed(1)} Mbps`;
  }

  function percent(value) {
    const n = numberOrNull(value);
    if (n === null) return '—';
    return `${Math.round(n)}%`;
  }

  function yesNo(value) {
    if (value === true) return 'Yes';
    if (value === false) return 'No';
    return '—';
  }

  function matchMode(value) {
    return value === 'exact_uprn' ? 'Exact property' : value === 'postcode_median' ? 'Postcode fallback' : '—';
  }

  function connectivityLabel(property) {
    const c = property.connectivity || {};
    if (c.status === 'matched' || c.status === 'partial') {
      const parts = [`Connectivity ${Math.round(c.score ?? 0)}/100`];
      if (c.maxDownloadMbps !== null && c.maxDownloadMbps !== undefined) parts.push(speed(c.maxDownloadMbps));
      if (c.indoorNetworks !== null && c.indoorNetworks !== undefined) parts.push(`${Math.round(c.indoorNetworks)}/4 indoor`);
      return { className: c.status === 'partial' ? 'partial' : 'matched', text: parts.join(' · ') };
    }
    if (c.status === 'needs_api_keys') return { className: 'review', text: 'Connectivity setup required' };
    if (c.status === 'needs_location') return { className: 'review', text: 'Connectivity waiting for postcode' };
    if (c.status === 'error') return { className: 'error', text: 'Connectivity lookup unavailable' };
    return { className: 'pending', text: 'Connectivity lookup pending' };
  }

  function decorateLeaderboard() {
    document.querySelectorAll('.property-row').forEach(row => {
      const detailButton = row.querySelector('[data-detail]');
      if (!detailButton || row.querySelector('.connectivity-inline')) return;
      const property = state.properties.find(item => item.id === detailButton.dataset.detail);
      if (!property || property.demo) return;
      const target = row.querySelector('.property-title');
      if (!target) return;
      const label = connectivityLabel(property);
      const badge = document.createElement('span');
      badge.className = `connectivity-inline ${label.className}`;
      badge.textContent = label.text;
      target.appendChild(badge);
    });
  }

  if (typeof renderDashboard === 'function') {
    const originalRenderDashboard = renderDashboard;
    renderDashboard = function connectivityRenderDashboard(...args) {
      const result = originalRenderDashboard.apply(this, args);
      decorateLeaderboard();
      return result;
    };
  }

  function renderNetworks(mobile) {
    const rows = mobile?.networks || [];
    if (!rows.length) return '';
    return `
      <div class="connectivity-networks">
        ${rows.map(row => `
          <div class="connectivity-network-row">
            <strong>${escapeHtml(row.network || 'Network')}</strong>
            <span>Indoor: ${escapeHtml(row.indoorLabel || 'Unknown')}</span>
            <span>Outdoor: ${escapeHtml(row.outdoorLabel || 'Unknown')}</span>
            <b>${row.score === null || row.score === undefined ? '—' : `${Math.round(row.score)}/100`}</b>
          </div>
        `).join('')}
      </div>`;
  }

  function renderConnectivityDetail(property) {
    if (!property || property.demo) return '';
    const c = property.connectivity || { status: 'pending' };

    if (c.status === 'matched' || c.status === 'partial') {
      const score = Math.round(c.score ?? 0);
      const broadbandScore = c.broadbandScore === null ? '—' : `${Math.round(c.broadbandScore)}/100`;
      const mobileScore = c.mobileScore === null ? '—' : `${Math.round(c.mobileScore)}/100`;
      const premiseMode = c.broadband?.premiseMode || c.mobile?.premiseMode;
      const hasBroadband = c.broadbandScore !== null && c.broadbandScore !== undefined;
      const hasMobile = c.mobileScore !== null && c.mobileScore !== undefined;
      const hasBothSources = hasBroadband && hasMobile;
      const openBroadband = c.broadband?.coverage || null;
      const openMobile = c.mobile?.localAuthority ? c.mobile : null;
      const matchText = openBroadband || openMobile ? 'Postcode + area' : matchMode(premiseMode);

      const sourceMessage = hasBothSources
        ? '<p class="connectivity-warning">Broadband is postcode-level and mobile is local-authority-level, so this is a high-quality area score rather than an exact signal test inside the house.</p>'
        : '<p class="connectivity-warning">Only one Ofcom source returned successfully; this score currently uses the available source only.</p>';

      const broadbandPanel = openBroadband ? `
            <div class="connectivity-panel">
              <small>BROADBAND AVAILABILITY</small>
              <h4>${percent(openBroadband.gigabit)} gigabit</h4>
              <div class="connectivity-facts">
                <span>30+ Mbps <b>${percent(openBroadband.sfbb30)}</b></span>
                <span>100+ Mbps <b>${percent(openBroadband.ufbb100)}</b></span>
                <span>300+ Mbps <b>${percent(openBroadband.ufbb300)}</b></span>
                <span>Gigabit <b>${percent(openBroadband.gigabit)}</b></span>
              </div>
            </div>` : `
            <div class="connectivity-panel">
              <small>BROADBAND</small>
              <h4>${speed(c.maxDownloadMbps)} download</h4>
              <div class="connectivity-facts">
                <span>Upload <b>${speed(c.maxUploadMbps)}</b></span>
                <span>Full fibre <b>${yesNo(c.fullFibre)}</b></span>
                <span>Gigabit <b>${yesNo(c.gigabit)}</b></span>
              </div>
            </div>`;

      const mobilePanel = openMobile ? `
            <div class="connectivity-panel">
              <small>MOBILE COVERAGE</small>
              <h4>${percent(openMobile.indoor4gNetworkIndex)} indoor 4G network index</h4>
              <div class="connectivity-facts">
                <span>Outdoor 5G network index <b>${percent(openMobile.outdoor5gNetworkIndex)}</b></span>
                <span>Area <b>${escapeHtml(openMobile.localAuthority?.name || '—')}</b></span>
              </div>
            </div>` : `
            <div class="connectivity-panel">
              <small>MOBILE DATA</small>
              <h4>${c.indoorNetworks === null ? '—' : `${Math.round(c.indoorNetworks)}/4`} likely indoors</h4>
              <div class="connectivity-facts">
                <span>Likely outdoors <b>${c.outdoorNetworks === null ? '—' : `${Math.round(c.outdoorNetworks)}/4`}</b></span>
              </div>
              ${renderNetworks(c.mobile)}
            </div>`;

      return `
        <section class="connectivity-detail-card ${escapeHtml(c.status)}">
          <div class="connectivity-detail-heading">
            <div><p class="eyebrow">AUTOMATIC CONNECTIVITY DATA</p><h3>Broadband & mobile</h3></div>
            <span class="connectivity-score">${score}/100</span>
          </div>

          ${sourceMessage}

          <div class="connectivity-summary-grid">
            <div><small>Connectivity</small><strong>${score}/100</strong></div>
            <div><small>Broadband</small><strong>${broadbandScore}</strong></div>
            <div><small>Mobile</small><strong>${mobileScore}</strong></div>
            <div><small>Coverage level</small><strong>${escapeHtml(matchText)}</strong></div>
          </div>

          <div class="connectivity-columns">
            ${broadbandPanel}
            ${mobilePanel}
          </div>

          <p class="muted connectivity-footnote">Source: Ofcom Connected Nations Spring 2026 open datasets. Broadband uses residential availability at postcode level; mobile uses local-authority coverage, so real service at an individual property can vary. The Connectivity score is 75% broadband and 25% mobile when both sources are available.</p>
          <button class="ghost connectivity-retry" type="button" data-connectivity-retry="${property.id}">Refresh connectivity data</button>
        </section>`;
    }

    const messages = {
      pending: 'This property is waiting for its first Ofcom broadband and mobile lookup.',
      needs_location: 'House Ranker needs a full postcode before it can look up connectivity.',
      needs_api_keys: 'This property still has a legacy Ofcom setup status. Retry the connectivity lookup to use the free open datasets.',
      error: 'The connectivity lookup could not complete. The property remains saved and can be retried.'
    };
    const titles = {
      pending: 'Connectivity lookup pending',
      needs_location: 'Waiting for postcode',
      needs_api_keys: 'Connectivity retry required',
      error: 'Connectivity lookup unavailable'
    };

    return `
      <section class="connectivity-detail-card ${escapeHtml(c.status || 'pending')}">
        <p class="eyebrow">AUTOMATIC CONNECTIVITY DATA</p>
        <h3>${titles[c.status] || titles.pending}</h3>
        <p class="muted">${messages[c.status] || messages.pending}</p>
        <button class="ghost connectivity-retry" type="button" data-connectivity-retry="${property.id}">Try connectivity lookup again</button>
      </section>`;
  }

  function injectConnectivityDetail(propertyId) {
    const detail = document.getElementById('propertyDetail');
    if (!detail || detail.querySelector('.connectivity-detail-card')) return;
    const property = state.properties.find(item => item.id === propertyId);
    if (!property || property.demo) return;

    const floodCard = detail.querySelector('.flood-detail-card');
    const schoolsCard = detail.querySelector('.schools-detail-card');
    const crimeCard = detail.querySelector('.crime-detail-card');
    const epcCard = detail.querySelector('.epc-detail-card');
    const breakdown = detail.querySelector('.breakdown');
    if (floodCard) floodCard.insertAdjacentHTML('afterend', renderConnectivityDetail(property));
    else if (schoolsCard) schoolsCard.insertAdjacentHTML('afterend', renderConnectivityDetail(property));
    else if (crimeCard) crimeCard.insertAdjacentHTML('afterend', renderConnectivityDetail(property));
    else if (epcCard) epcCard.insertAdjacentHTML('afterend', renderConnectivityDetail(property));
    else if (breakdown) breakdown.insertAdjacentHTML('afterend', renderConnectivityDetail(property));
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
    if (!row || row.price === undefined || row.price === null) return null;
    const property = fromDbProperty(row);
    const index = state.properties.findIndex(item => item.id === property.id);
    if (index >= 0) state.properties[index] = property;
    else state.properties.push(property);
    renderDashboard();
    return property;
  }

  async function enrichPropertyConnectivity(propertyId, { quiet = false } = {}) {
    if (!cloud.client || !cloud.session) {
      if (!quiet) toast('Sign in to run automatic connectivity scoring');
      return { ok: false, code: 'SIGNED_OUT' };
    }

    attempted.add(propertyId);
    if (!quiet) toast('Checking Ofcom broadband and mobile coverage…');

    const { data, error } = await cloud.client.functions.invoke('connectivity-enrich', {
      body: { propertyId }
    });

    if (error) {
      const payload = await parseFunctionError(error);
      if (!quiet) toast(`Connectivity lookup failed: ${payload.detail || payload.error || error.message || 'unknown error'}`);
      return { ok: false, code: 'FUNCTION_ERROR', error };
    }

    let property = replaceProperty(data?.property);
    if (!property) property = state.properties.find(item => item.id === propertyId) || null;

    if (!quiet) {
      if (data?.status === 'matched' || data?.status === 'partial') {
        const both = data?.broadbandScore !== null && data?.broadbandScore !== undefined && data?.mobileScore !== null && data?.mobileScore !== undefined;
        toast(`Connectivity score ${data.score}/100${both ? ' · broadband + mobile' : ' · partial Ofcom data'}`);
      } else if (data?.status === 'needs_api_keys') {
        toast('Retry connectivity to use the free Ofcom open datasets');
      } else if (data?.status === 'needs_location') {
        toast('Connectivity lookup needs a full postcode');
      } else if (data?.status === 'already_running') {
        toast('Connectivity lookup is already running');
      }
    }
    return { ok: true, status: data?.status, property };
  }

  async function hydrateConnectivityMetadata() {
    if (!cloud.client || !cloud.session) return;

    const [propertyResult, areaResult] = await Promise.all([
      cloud.client.from('properties').select('id,connectivity_status,connectivity_score,broadband_score,mobile_score,broadband_max_download_mbps,broadband_max_upload_mbps,broadband_full_fibre,broadband_gigabit,mobile_likely_indoor_networks,mobile_likely_outdoor_networks,connectivity_enriched_at,metrics,postcode'),
      cloud.client.from('area_metrics').select('property_id,connectivity_score,raw_data')
    ]);

    if (propertyResult.error) return;
    const areaById = new Map((areaResult.data || []).map(row => [row.property_id, row]));

    for (const row of propertyResult.data || []) {
      const property = state.properties.find(item => item.id === row.id);
      if (!property) continue;
      property.connectivity = connectivityFromRow(row);
      property.metrics = { ...(property.metrics || {}), ...(row.metrics || {}) };
      property.postcode = row.postcode || property.postcode || '';

      const raw = areaById.get(row.id)?.raw_data?.connectivity;
      if (raw) {
        property.connectivity.broadband = raw.broadband || null;
        property.connectivity.mobile = raw.mobile || null;
        property.connectivity.source = raw.source || null;
        property.connectivity.scoreMethod = raw.scoreMethod || null;
        property.connectivity.note = raw.note || null;
      }
    }
    renderDashboard();
  }

  function isStale(c) {
    if (!c?.enrichedAt) return false;
    const age = Date.now() - new Date(c.enrichedAt).getTime();
    return Number.isFinite(age) && age > 40 * 24 * 60 * 60 * 1000;
  }

  async function autoEnrichPending() {
    if (!cloud.session || !cloud.client) return;
    await hydrateConnectivityMetadata();

    const candidates = state.properties.filter(property => {
      if (property.demo || attempted.has(property.id)) return false;
      const status = property.connectivity?.status || 'pending';
      if (status === 'pending') return true;
      if (status === 'needs_location' && property.postcode) return true;
      if ((status === 'matched' || status === 'partial') && isStale(property.connectivity)) return true;
      return false;
    });

    for (const property of candidates.slice(0, 1)) {
      const result = await enrichPropertyConnectivity(property.id, { quiet: true });
      if (!result.ok) break;
    }
    await hydrateConnectivityMetadata();
  }

  function updateFormCopy() {
    const scoringText = document.querySelector('#propertyForm .form-section:nth-of-type(2) .muted');
    if (scoringText) scoringText.textContent = 'Energy, Crime, Schools, Flood risk and Connectivity are automatic after enrichment. The remaining 0–100 inputs will be replaced with real sources one by one.';
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) setTimeout(() => injectConnectivityDetail(detailButton.dataset.detail), 75);

    const retry = event.target.closest?.('[data-connectivity-retry]');
    if (retry) {
      event.preventDefault();
      attempted.delete(retry.dataset.connectivityRetry);
      enrichPropertyConnectivity(retry.dataset.connectivityRetry).then(async () => {
        await hydrateConnectivityMetadata();
        const detailId = retry.dataset.connectivityRetry;
        const detail = document.getElementById('propertyDetail');
        if (detail) {
          detail.querySelector('.connectivity-detail-card')?.remove();
          injectConnectivityDetail(detailId);
        }
      });
    }
  });

  const form = document.getElementById('propertyForm');
  if (form) {
    form.addEventListener('submit', () => {
      setTimeout(() => autoEnrichPending(), 15000);
      setTimeout(() => autoEnrichPending(), 38000);
    }, true);
  }

  updateFormCopy();
  setTimeout(() => autoEnrichPending(), 7000);
  setTimeout(() => autoEnrichPending(), 30000);

  window.houseRankerConnectivity = {
    enrichPropertyConnectivity,
    hydrateConnectivityMetadata,
    autoEnrichPending
  };
})();