(() => {
  const attempted = new Set();

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function schoolsFromRow(row) {
    return {
      status: row.schools_status || 'pending',
      score: numberOrNull(row.schools_score),
      primaryScore: numberOrNull(row.schools_primary_score),
      secondaryScore: numberOrNull(row.schools_secondary_score),
      nearestPrimaryMiles: numberOrNull(row.schools_nearest_primary_miles),
      nearestSecondaryMiles: numberOrNull(row.schools_nearest_secondary_miles),
      enrichedAt: row.schools_enriched_at || null,
      primary: null,
      secondary: null,
      directoryDataDate: null,
      currentOfstedDataDate: null,
      formula: null
    };
  }

  if (typeof fromDbProperty === 'function') {
    const originalFromDbProperty = fromDbProperty;
    fromDbProperty = function schoolsFromDbProperty(row) {
      const property = originalFromDbProperty(row);
      property.schools = schoolsFromRow(row);
      return property;
    };
  }

  function miles(value) {
    const number = numberOrNull(value);
    if (number === null) return '—';
    return `${number < 10 ? number.toFixed(1) : Math.round(number)} mi`;
  }

  function dateLabel(value) {
    if (!value) return '—';
    const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  }

  function schoolLabel(property) {
    const schools = property.schools || {};
    if (schools.status === 'matched') {
      const parts = [`Schools ${Math.round(schools.score ?? property.metrics?.schools ?? 0)}/100`];
      if (schools.nearestPrimaryMiles !== null && schools.nearestPrimaryMiles !== undefined) {
        parts.push(`P ${miles(schools.nearestPrimaryMiles)}`);
      }
      if (schools.nearestSecondaryMiles !== null && schools.nearestSecondaryMiles !== undefined) {
        parts.push(`S ${miles(schools.nearestSecondaryMiles)}`);
      }
      return { className: 'matched', text: parts.join(' · ') };
    }
    if (schools.status === 'needs_location') return { className: 'review', text: 'Schools waiting for location' };
    if (schools.status === 'error') return { className: 'error', text: 'Schools lookup unavailable' };
    return { className: 'pending', text: 'Schools lookup pending' };
  }

  function decorateLeaderboard() {
    document.querySelectorAll('.property-row').forEach(row => {
      const detailButton = row.querySelector('[data-detail]');
      if (!detailButton || row.querySelector('.schools-inline')) return;
      const property = state.properties.find(item => item.id === detailButton.dataset.detail);
      if (!property || property.demo) return;
      const target = row.querySelector('.property-title');
      if (!target) return;
      const label = schoolLabel(property);
      const badge = document.createElement('span');
      badge.className = `schools-inline ${label.className}`;
      badge.textContent = label.text;
      target.appendChild(badge);
    });
  }

  if (typeof renderDashboard === 'function') {
    const originalRenderDashboard = renderDashboard;
    renderDashboard = function schoolsRenderDashboard(...args) {
      const result = originalRenderDashboard.apply(this, args);
      decorateLeaderboard();
      return result;
    };
  }

  function safeReportUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.toString() : '';
    } catch {
      return '';
    }
  }

  function renderSchoolRows(phase) {
    const rows = phase?.schools || [];
    if (!rows.length) return '<p class="muted school-empty">No nearby mainstream schools were returned for this phase.</p>';
    return `
      <div class="school-list">
        ${rows.slice(0, 3).map((school, index) => {
          const reportUrl = safeReportUrl(school.reportUrl);
          return `
            <div class="school-row">
              <div class="school-rank">${index + 1}</div>
              <div class="school-main">
                <strong>${escapeHtml(school.name || 'Unnamed school')}</strong>
                <small>${escapeHtml(school.type || school.phase || 'School')} · ${miles(school.distanceMiles)}</small>
                <span class="school-quality">${escapeHtml(school.qualityLabel || 'No current published grade used')}</span>
              </div>
              <div class="school-row-score">
                <strong>${Math.round(Number(school.qualityScore ?? 65))}</strong><span>/100</span>
                ${reportUrl ? `<a href="${escapeAttribute(reportUrl)}" target="_blank" rel="noopener">Ofsted ↗</a>` : ''}
              </div>
            </div>`;
        }).join('')}
      </div>`;
  }

  function renderSchoolsDetail(property) {
    if (!property || property.demo) return '';
    const schools = property.schools || { status: 'pending' };

    if (schools.status === 'matched') {
      const score = Math.round(schools.score ?? property.metrics?.schools ?? 0);
      const primaryScore = schools.primaryScore !== null && schools.primaryScore !== undefined ? Math.round(schools.primaryScore) : '—';
      const secondaryScore = schools.secondaryScore !== null && schools.secondaryScore !== undefined ? Math.round(schools.secondaryScore) : '—';
      const sourceDate = schools.currentOfstedDataDate || schools.directoryDataDate;
      return `
        <section class="schools-detail-card matched">
          <div class="schools-detail-heading">
            <div><p class="eyebrow">AUTOMATIC SCHOOL DATA</p><h3>Nearby schools</h3></div>
            <span class="schools-score">${score}/100</span>
          </div>
          <div class="schools-data-grid">
            <div><small>Schools score</small><strong>${score}/100</strong></div>
            <div><small>Primary</small><strong>${primaryScore}${primaryScore === '—' ? '' : '/100'}</strong></div>
            <div><small>Secondary</small><strong>${secondaryScore}${secondaryScore === '—' ? '' : '/100'}</strong></div>
            <div><small>Latest source data</small><strong>${dateLabel(sourceDate)}</strong></div>
          </div>
          <div class="school-phase-grid">
            <div class="school-phase">
              <div class="school-phase-head"><div><small>PRIMARY</small><strong>Nearest mainstream schools</strong></div><span>${miles(schools.nearestPrimaryMiles)}</span></div>
              ${renderSchoolRows(schools.primary)}
            </div>
            <div class="school-phase">
              <div class="school-phase-head"><div><small>SECONDARY</small><strong>Nearest mainstream schools</strong></div><span>${miles(schools.nearestSecondaryMiles)}</span></div>
              ${renderSchoolRows(schools.secondary)}
            </div>
          </div>
          <p class="muted schools-footnote">DfE Get Information About Schools + Ofsted. Each phase uses the 3 nearest mainstream schools found: 60% inspection quality, 30% distance and 10% nearby choice. Distances are straight-line approximations. “Nearby” does not mean the property is in catchment or that admission is guaranteed.</p>
          <button class="ghost schools-retry" type="button" data-schools-retry="${property.id}">Refresh schools data</button>
        </section>`;
    }

    const messages = {
      pending: 'This property is waiting for its first nearby-schools lookup.',
      needs_location: 'House Ranker needs a full postcode or coordinates before it can calculate the schools score.',
      error: 'The schools lookup could not complete. The property remains saved and can be retried.'
    };

    return `
      <section class="schools-detail-card ${escapeHtml(schools.status || 'pending')}">
        <p class="eyebrow">AUTOMATIC SCHOOL DATA</p>
        <h3>${schools.status === 'needs_location' ? 'Waiting for location' : schools.status === 'error' ? 'Schools lookup unavailable' : 'Schools lookup pending'}</h3>
        <p class="muted">${messages[schools.status] || messages.pending}</p>
        <button class="ghost schools-retry" type="button" data-schools-retry="${property.id}">Try schools lookup again</button>
      </section>`;
  }

  function injectSchoolsDetail(propertyId) {
    const detail = document.getElementById('propertyDetail');
    if (!detail || detail.querySelector('.schools-detail-card')) return;
    const property = state.properties.find(item => item.id === propertyId);
    if (!property || property.demo) return;
    const crimeCard = detail.querySelector('.crime-detail-card');
    const epcCard = detail.querySelector('.epc-detail-card');
    const breakdown = detail.querySelector('.breakdown');
    if (crimeCard) crimeCard.insertAdjacentHTML('afterend', renderSchoolsDetail(property));
    else if (epcCard) epcCard.insertAdjacentHTML('afterend', renderSchoolsDetail(property));
    else if (breakdown) breakdown.insertAdjacentHTML('afterend', renderSchoolsDetail(property));
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

  async function enrichPropertySchools(propertyId, { quiet = false } = {}) {
    if (!cloud.client || !cloud.session) {
      if (!quiet) toast('Sign in to run automatic school scoring');
      return { ok: false, code: 'SIGNED_OUT' };
    }

    attempted.add(propertyId);
    if (!quiet) toast('Checking nearby DfE and Ofsted school data…');

    const { data, error } = await cloud.client.functions.invoke('schools-enrich', {
      body: { propertyId }
    });

    if (error) {
      const payload = await parseFunctionError(error);
      if (!quiet) toast(`Schools lookup failed: ${payload.detail || payload.error || error.message || 'unknown error'}`);
      return { ok: false, code: 'FUNCTION_ERROR', error };
    }

    let property = replaceProperty(data?.property);
    if (!property) property = state.properties.find(item => item.id === propertyId) || null;

    if (!quiet) {
      if (data?.status === 'matched') {
        const primary = data.primaryScore !== null && data.primaryScore !== undefined ? ` · primary ${Math.round(data.primaryScore)}` : '';
        const secondary = data.secondaryScore !== null && data.secondaryScore !== undefined ? ` · secondary ${Math.round(data.secondaryScore)}` : '';
        toast(`Schools score ${data.score}/100${primary}${secondary}`);
      } else if (data?.status === 'needs_location') {
        toast('School scoring is waiting for a full postcode or property coordinates');
      } else if (data?.status === 'already_running') {
        toast('Schools lookup is already running');
      }
    }
    return { ok: true, status: data?.status, property };
  }

  async function hydrateSchoolsMetadata() {
    if (!cloud.client || !cloud.session) return;

    const [propertyResult, areaResult] = await Promise.all([
      cloud.client.from('properties').select('id,schools_status,schools_score,schools_primary_score,schools_secondary_score,schools_nearest_primary_miles,schools_nearest_secondary_miles,schools_enriched_at,metrics,postcode,latitude,longitude'),
      cloud.client.from('area_metrics').select('property_id,schools_score,raw_data')
    ]);

    if (propertyResult.error) return;
    const areaById = new Map((areaResult.data || []).map(row => [row.property_id, row]));

    for (const row of propertyResult.data || []) {
      const property = state.properties.find(item => item.id === row.id);
      if (!property) continue;
      property.schools = schoolsFromRow(row);
      property.metrics = { ...(property.metrics || {}), ...(row.metrics || {}) };
      property.postcode = row.postcode || property.postcode || '';
      property.latitude = numberOrNull(row.latitude);
      property.longitude = numberOrNull(row.longitude);

      const rawSchools = areaById.get(row.id)?.raw_data?.schools;
      if (rawSchools) {
        property.schools.primary = rawSchools.primary || null;
        property.schools.secondary = rawSchools.secondary || null;
        property.schools.directoryDataDate = rawSchools.directoryDataDate || null;
        property.schools.currentOfstedDataDate = rawSchools.currentOfstedDataDate || null;
        property.schools.formula = rawSchools.formula || null;
      }
    }
    renderDashboard();
  }

  function isStale(schools) {
    if (!schools?.enrichedAt) return false;
    const age = Date.now() - new Date(schools.enrichedAt).getTime();
    return Number.isFinite(age) && age > 40 * 24 * 60 * 60 * 1000;
  }

  async function autoEnrichPending() {
    if (!cloud.session || !cloud.client) return;
    await hydrateSchoolsMetadata();
    const candidates = state.properties.filter(property => {
      if (property.demo || attempted.has(property.id)) return false;
      const status = property.schools?.status || 'pending';
      if (status === 'pending') return true;
      if (status === 'needs_location' && (property.postcode || (property.latitude !== null && property.longitude !== null))) return true;
      if (status === 'matched' && isStale(property.schools)) return true;
      return false;
    });

    for (const property of candidates.slice(0, 1)) {
      const result = await enrichPropertySchools(property.id, { quiet: true });
      if (!result.ok) break;
    }
    await hydrateSchoolsMetadata();
  }

  function updateFormCopy() {
    const scoringText = document.querySelector('#propertyForm .form-section:nth-of-type(2) .muted');
    if (scoringText) scoringText.textContent = 'Energy, Crime and Schools are automatic after enrichment. The remaining 0–100 inputs will be replaced with real sources one by one.';
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) setTimeout(() => injectSchoolsDetail(detailButton.dataset.detail), 45);

    const retry = event.target.closest?.('[data-schools-retry]');
    if (retry) {
      event.preventDefault();
      attempted.delete(retry.dataset.schoolsRetry);
      enrichPropertySchools(retry.dataset.schoolsRetry).then(async () => {
        await hydrateSchoolsMetadata();
        const detailId = retry.dataset.schoolsRetry;
        const detail = document.getElementById('propertyDetail');
        if (detail) {
          detail.querySelector('.schools-detail-card')?.remove();
          injectSchoolsDetail(detailId);
        }
      });
    }
  });

  const form = document.getElementById('propertyForm');
  if (form) {
    form.addEventListener('submit', () => {
      setTimeout(() => autoEnrichPending(), 8500);
      setTimeout(() => autoEnrichPending(), 22000);
    }, true);
  }

  updateFormCopy();
  setTimeout(() => autoEnrichPending(), 3500);
  setTimeout(() => autoEnrichPending(), 14000);

  window.houseRankerSchools = {
    enrich: enrichPropertySchools,
    hydrate: hydrateSchoolsMetadata,
    refreshPending: autoEnrichPending
  };
})();
