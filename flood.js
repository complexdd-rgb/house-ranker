(() => {
  const attempted = new Set();

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function floodFromRow(row) {
    return {
      status: row.flood_status || 'pending',
      score: numberOrNull(row.flood_score),
      band: row.flood_band || null,
      highCount: numberOrNull(row.flood_high_count),
      mediumCount: numberOrNull(row.flood_medium_count),
      lowCount: numberOrNull(row.flood_low_count),
      groundwaterRisk: row.flood_groundwater_risk || null,
      dataDate: row.flood_data_date || null,
      enrichedAt: row.flood_enriched_at || null,
      source: null,
      officialChecker: null,
      caveat: null,
      scoreMethod: null
    };
  }

  if (typeof fromDbProperty === 'function') {
    const originalFromDbProperty = fromDbProperty;
    fromDbProperty = function floodFromDbProperty(row) {
      const property = originalFromDbProperty(row);
      property.flood = floodFromRow(row);
      return property;
    };
  }

  function bandLabel(value) {
    return ({
      very_low: 'Very low',
      low: 'Low',
      medium: 'Medium',
      high: 'High'
    })[value] || 'Unknown';
  }

  function dateLabel(value) {
    if (!value) return '—';
    const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  }

  function floodLabel(property) {
    const flood = property.flood || {};
    if (flood.status === 'matched') {
      return {
        className: flood.band === 'high' ? 'high' : flood.band === 'medium' ? 'medium' : 'matched',
        text: `Flood ${bandLabel(flood.band)} · ${Math.round(flood.score ?? property.metrics?.environment ?? 0)}/100`
      };
    }
    if (flood.status === 'not_found') return { className: 'review', text: 'Flood data needs review' };
    if (flood.status === 'error') return { className: 'error', text: 'Flood lookup unavailable' };
    return { className: 'pending', text: 'Flood lookup pending' };
  }

  function decorateLeaderboard() {
    document.querySelectorAll('.property-row').forEach(row => {
      const detailButton = row.querySelector('[data-detail]');
      if (!detailButton || row.querySelector('.flood-inline')) return;
      const property = state.properties.find(item => item.id === detailButton.dataset.detail);
      if (!property || property.demo) return;
      const target = row.querySelector('.property-title');
      if (!target) return;
      const label = floodLabel(property);
      const badge = document.createElement('span');
      badge.className = `flood-inline ${label.className}`;
      badge.textContent = label.text;
      target.appendChild(badge);
    });
  }

  if (typeof renderDashboard === 'function') {
    const originalRenderDashboard = renderDashboard;
    renderDashboard = function floodRenderDashboard(...args) {
      const result = originalRenderDashboard.apply(this, args);
      decorateLeaderboard();
      return result;
    };
  }

  function safeOfficialUrl(value) {
    try {
      const url = new URL(String(value || 'https://www.gov.uk/check-long-term-flood-risk'));
      return url.protocol === 'https:' ? url.toString() : 'https://www.gov.uk/check-long-term-flood-risk';
    } catch {
      return 'https://www.gov.uk/check-long-term-flood-risk';
    }
  }

  function renderFloodDetail(property) {
    if (!property || property.demo) return '';
    const flood = property.flood || { status: 'pending' };

    if (flood.status === 'matched') {
      const score = Math.round(flood.score ?? property.metrics?.environment ?? 0);
      const checker = safeOfficialUrl(flood.officialChecker);
      return `
        <section class="flood-detail-card ${escapeHtml(flood.band || 'matched')}">
          <div class="flood-detail-heading">
            <div><p class="eyebrow">AUTOMATIC FLOOD DATA</p><h3>Long-term flood screening</h3></div>
            <span class="flood-score">${score}/100</span>
          </div>
          <div class="flood-summary-grid">
            <div><small>Headline risk</small><strong>${escapeHtml(bandLabel(flood.band))}</strong></div>
            <div><small>Flood score</small><strong>${score}/100</strong></div>
            <div><small>Groundwater</small><strong>${escapeHtml(flood.groundwaterRisk || 'Not indicated')}</strong></div>
            <div><small>EA data date</small><strong>${dateLabel(flood.dataDate)}</strong></div>
          </div>
          <div class="flood-counts">
            <div><span>Addresses in high-risk areas</span><strong>${Math.round(flood.highCount || 0)}</strong></div>
            <div><span>Addresses in medium-risk areas</span><strong>${Math.round(flood.mediumCount || 0)}</strong></div>
            <div><span>Addresses in low-risk areas</span><strong>${Math.round(flood.lowCount || 0)}</strong></div>
          </div>
          <p class="muted flood-footnote">Environment Agency postcode screening combines long-term river/sea and surface-water risk. The counts show addresses in this postcode whose surrounding area falls into each published risk band. Very-low counts are not published. This is an area screening result, not a guarantee that this individual building will or will not flood.</p>
          <div class="flood-actions">
            <a class="ghost" href="${escapeAttribute(checker)}" target="_blank" rel="noopener">Open official flood checker ↗</a>
            <button class="ghost flood-retry" type="button" data-flood-retry="${property.id}">Refresh flood data</button>
          </div>
        </section>`;
    }

    const messages = {
      pending: 'This property is waiting for its first Environment Agency flood lookup.',
      not_found: 'No current postcode screening row was found. Use the official checker before relying on the flood result.',
      error: 'The flood lookup could not complete. The property remains saved and can be retried.'
    };

    return `
      <section class="flood-detail-card ${escapeHtml(flood.status || 'pending')}">
        <p class="eyebrow">AUTOMATIC FLOOD DATA</p>
        <h3>${flood.status === 'not_found' ? 'Flood data needs review' : flood.status === 'error' ? 'Flood lookup unavailable' : 'Flood lookup pending'}</h3>
        <p class="muted">${messages[flood.status] || messages.pending}</p>
        <div class="flood-actions">
          <a class="ghost" href="https://www.gov.uk/check-long-term-flood-risk" target="_blank" rel="noopener">Open official flood checker ↗</a>
          <button class="ghost flood-retry" type="button" data-flood-retry="${property.id}">Try flood lookup again</button>
        </div>
      </section>`;
  }

  function injectFloodDetail(propertyId) {
    const detail = document.getElementById('propertyDetail');
    if (!detail || detail.querySelector('.flood-detail-card')) return;
    const property = state.properties.find(item => item.id === propertyId);
    if (!property || property.demo) return;

    const schoolsCard = detail.querySelector('.schools-detail-card');
    const crimeCard = detail.querySelector('.crime-detail-card');
    const epcCard = detail.querySelector('.epc-detail-card');
    const breakdown = detail.querySelector('.breakdown');
    if (schoolsCard) schoolsCard.insertAdjacentHTML('afterend', renderFloodDetail(property));
    else if (crimeCard) crimeCard.insertAdjacentHTML('afterend', renderFloodDetail(property));
    else if (epcCard) epcCard.insertAdjacentHTML('afterend', renderFloodDetail(property));
    else if (breakdown) breakdown.insertAdjacentHTML('afterend', renderFloodDetail(property));
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

  async function enrichPropertyFlood(propertyId, { quiet = false } = {}) {
    if (!cloud.client || !cloud.session) {
      if (!quiet) toast('Sign in to run automatic flood scoring');
      return { ok: false, code: 'SIGNED_OUT' };
    }

    attempted.add(propertyId);
    if (!quiet) toast('Checking Environment Agency long-term flood data…');

    const { data, error } = await cloud.client.functions.invoke('flood-enrich', {
      body: { propertyId }
    });

    if (error) {
      const payload = await parseFunctionError(error);
      if (!quiet) toast(`Flood lookup failed: ${payload.detail || payload.error || error.message || 'unknown error'}`);
      return { ok: false, code: 'FUNCTION_ERROR', error };
    }

    let property = replaceProperty(data?.property);
    if (!property) property = state.properties.find(item => item.id === propertyId) || null;

    if (!quiet) {
      if (data?.status === 'matched') {
        toast(`Flood ${bandLabel(data.band)} · score ${data.score}/100`);
      } else if (data?.status === 'not_found') {
        toast('No automatic flood row found — use the official checker');
      } else if (data?.status === 'already_running') {
        toast('Flood lookup is already running');
      }
    }
    return { ok: true, status: data?.status, property };
  }

  async function hydrateFloodMetadata() {
    if (!cloud.client || !cloud.session) return;

    const [propertyResult, areaResult] = await Promise.all([
      cloud.client.from('properties').select('id,flood_status,flood_score,flood_band,flood_high_count,flood_medium_count,flood_low_count,flood_groundwater_risk,flood_data_date,flood_enriched_at,flood_risk,metrics,postcode'),
      cloud.client.from('area_metrics').select('property_id,environment_score,raw_data')
    ]);

    if (propertyResult.error) return;
    const areaById = new Map((areaResult.data || []).map(row => [row.property_id, row]));

    for (const row of propertyResult.data || []) {
      const property = state.properties.find(item => item.id === row.id);
      if (!property) continue;
      property.flood = floodFromRow(row);
      property.floodRisk = row.flood_risk || property.floodRisk || 'unknown';
      property.metrics = { ...(property.metrics || {}), ...(row.metrics || {}) };
      property.postcode = row.postcode || property.postcode || '';

      const rawFlood = areaById.get(row.id)?.raw_data?.flood;
      if (rawFlood) {
        property.flood.source = rawFlood.source || null;
        property.flood.officialChecker = rawFlood.officialChecker || null;
        property.flood.caveat = rawFlood.caveat || null;
        property.flood.scoreMethod = rawFlood.scoreMethod || null;
      }
    }
    renderDashboard();
  }

  function isStale(flood) {
    if (!flood?.enrichedAt) return false;
    const age = Date.now() - new Date(flood.enrichedAt).getTime();
    return Number.isFinite(age) && age > 100 * 24 * 60 * 60 * 1000;
  }

  async function autoEnrichPending() {
    if (!cloud.session || !cloud.client) return;
    await hydrateFloodMetadata();

    const candidates = state.properties.filter(property => {
      if (property.demo || attempted.has(property.id)) return false;
      const status = property.flood?.status || 'pending';
      if (status === 'pending') return true;
      if (status === 'not_found' && property.postcode) return true;
      if (status === 'matched' && isStale(property.flood)) return true;
      return false;
    });

    for (const property of candidates.slice(0, 1)) {
      const result = await enrichPropertyFlood(property.id, { quiet: true });
      if (!result.ok) break;
    }
    await hydrateFloodMetadata();
  }

  function updateFormCopy() {
    const scoringText = document.querySelector('#propertyForm .form-section:nth-of-type(2) .muted');
    if (scoringText) scoringText.textContent = 'Energy, Crime, Schools and Flood risk are automatic after enrichment. The remaining 0–100 inputs will be replaced with real sources one by one.';

    const floodSelect = document.getElementById('floodRisk');
    if (floodSelect) {
      const label = floodSelect.closest('label');
      if (label && !label.querySelector('.flood-form-hint')) {
        const hint = document.createElement('small');
        hint.className = 'flood-form-hint muted';
        hint.textContent = 'Fallback only — signed-in properties are replaced with Environment Agency data after saving.';
        label.appendChild(hint);
      }
    }
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) setTimeout(() => injectFloodDetail(detailButton.dataset.detail), 60);

    const retry = event.target.closest?.('[data-flood-retry]');
    if (retry) {
      event.preventDefault();
      attempted.delete(retry.dataset.floodRetry);
      enrichPropertyFlood(retry.dataset.floodRetry).then(async () => {
        await hydrateFloodMetadata();
        const detailId = retry.dataset.floodRetry;
        const detail = document.getElementById('propertyDetail');
        if (detail) {
          detail.querySelector('.flood-detail-card')?.remove();
          injectFloodDetail(detailId);
        }
      });
    }
  });

  const form = document.getElementById('propertyForm');
  if (form) {
    form.addEventListener('submit', () => {
      setTimeout(() => autoEnrichPending(), 12000);
      setTimeout(() => autoEnrichPending(), 32000);
    }, true);
  }

  updateFormCopy();
  setTimeout(() => autoEnrichPending(), 5500);
  setTimeout(() => autoEnrichPending(), 24000);

  window.houseRankerFlood = {
    enrichPropertyFlood,
    hydrateFloodMetadata,
    autoEnrichPending
  };
})();
