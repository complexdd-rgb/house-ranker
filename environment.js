(() => {
  const attempted = new Set();

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function environmentFromRow(row) {
    return {
      status: row.environment_status || 'pending',
      score: numberOrNull(row.environment_score),
      components: {
        flood: numberOrNull(row.environment_flood_score),
        green: numberOrNull(row.environment_green_score),
        road: numberOrNull(row.environment_road_score),
        landuse: numberOrNull(row.environment_landuse_score)
      },
      nearestGreenName: row.environment_nearest_green_name || null,
      nearestGreenMiles: numberOrNull(row.environment_nearest_green_miles),
      nearestRoadName: row.environment_nearest_major_road_name || null,
      nearestRoadClass: row.environment_nearest_major_road_class || null,
      nearestRoadMiles: numberOrNull(row.environment_nearest_major_road_miles),
      nearestIndustrialName: row.environment_nearest_industrial_name || null,
      nearestIndustrialMiles: numberOrNull(row.environment_nearest_industrial_miles),
      enrichedAt: row.environment_enriched_at || null,
      raw: null
    };
  }

  if (typeof fromDbProperty === 'function') {
    const originalFromDbProperty = fromDbProperty;
    fromDbProperty = function environmentFromDbProperty(row) {
      const property = originalFromDbProperty(row);
      property.environmentInfo = environmentFromRow(row);
      return property;
    };
  }

  function miles(value) {
    const number = numberOrNull(value);
    if (number === null) return '—';
    return `${number < 10 ? number.toFixed(1) : Math.round(number)} mi`;
  }

  function scoreText(value) {
    const number = numberOrNull(value);
    return number === null ? '—' : `${Math.round(number)}/100`;
  }

  function roadClassLabel(value) {
    return ({ motorway: 'Motorway', trunk: 'Trunk road', primary: 'Primary road', secondary: 'Secondary road' })[value] || 'Major road';
  }

  function statusLabel(property) {
    const info = property.environmentInfo || {};
    if (info.status === 'matched' && info.score !== null) {
      return { className: 'matched', text: `Environment ${Math.round(info.score)}/100` };
    }
    if (info.status === 'partial' && info.score !== null) {
      return { className: 'partial', text: `Environment ${Math.round(info.score)}/100 · partial` };
    }
    if (info.status === 'needs_location') return { className: 'review', text: 'Environment waiting for location' };
    if (info.status === 'error') return { className: 'error', text: 'Environment lookup unavailable' };
    return { className: 'pending', text: 'Environment lookup pending' };
  }

  function decorateLeaderboard() {
    document.querySelectorAll('.property-row').forEach(row => {
      const detailButton = row.querySelector('[data-detail]');
      if (!detailButton || row.querySelector('.environment-inline')) return;
      const property = state.properties.find(item => item.id === detailButton.dataset.detail);
      if (!property || property.demo) return;
      const target = row.querySelector('.property-title');
      if (!target) return;
      const label = statusLabel(property);
      const badge = document.createElement('span');
      badge.className = `environment-inline ${label.className}`;
      badge.textContent = label.text;
      target.appendChild(badge);
    });
  }

  if (typeof renderDashboard === 'function') {
    const originalRenderDashboard = renderDashboard;
    renderDashboard = function environmentRenderDashboard(...args) {
      const result = originalRenderDashboard.apply(this, args);
      decorateLeaderboard();
      return result;
    };
  }

  function renderComponent(label, value, detail) {
    return `
      <div class="environment-component">
        <small>${escapeHtml(label)}</small>
        <strong>${scoreText(value)}</strong>
        <span>${escapeHtml(detail)}</span>
      </div>`;
  }

  function renderEnvironmentDetail(property) {
    if (!property || property.demo) return '';
    const info = property.environmentInfo || { status: 'pending', components: {} };
    const raw = info.raw || {};
    const counts = raw.counts || {};
    const components = info.components || {};
    const ready = ['matched', 'partial'].includes(info.status) && info.score !== null;

    if (ready) {
      const floodDetail = info.status === 'partial'
        ? 'Temporary neutral fallback until flood data is ready'
        : `Environment Agency flood resilience${property.flood?.band ? ` · ${String(property.flood.band).replace('_', ' ')}` : ''}`;
      const greenName = info.nearestGreenName || raw?.nearest?.green?.name || 'Nearest mapped green space';
      const roadName = info.nearestRoadName || raw?.nearest?.road?.name || roadClassLabel(info.nearestRoadClass);
      const industrialName = info.nearestIndustrialName || raw?.nearest?.industrial?.name || 'No mapped site nearby';

      return `
        <section class="environment-detail-card ${escapeHtml(info.status)}">
          <div class="environment-detail-heading">
            <div><p class="eyebrow">AUTOMATIC ENVIRONMENT DATA</p><h3>Environment & surroundings</h3></div>
            <div class="environment-score"><strong>${Math.round(info.score)}</strong><span>/100</span></div>
          </div>

          <div class="environment-components">
            ${renderComponent('Flood resilience · 40%', components.flood, floodDetail)}
            ${renderComponent('Green/open space · 25%', components.green, `${greenName} · ${miles(info.nearestGreenMiles)}`)}
            ${renderComponent('Major-road exposure · 20%', components.road, `${roadName} · ${miles(info.nearestRoadMiles)}`)}
            ${renderComponent('Industrial exposure · 15%', components.landuse, `${industrialName} · ${miles(info.nearestIndustrialMiles)}`)}
          </div>

          <div class="environment-summary-grid">
            <div><small>Green choice</small><strong>${numberOrNull(counts.green2Miles) ?? '—'} ≤2 mi</strong></div>
            <div><small>Major roads</small><strong>${numberOrNull(counts.majorRoads1Mile) ?? '—'} ≤1 mi</strong></div>
            <div><small>Industrial sites</small><strong>${numberOrNull(counts.industrial1Mile) ?? '—'} ≤1 mi</strong></div>
            <div><small>Road class</small><strong>${escapeHtml(roadClassLabel(info.nearestRoadClass))}</strong></div>
          </div>

          <div class="environment-method">
            <strong>How Environment is scored</strong>
            <p class="muted">40% flood resilience + 25% green/open-space access + 20% major-road exposure + 15% industrial/land-use exposure. Higher scores mean a more favourable environment.</p>
            <p class="muted">Flood uses the existing Environment Agency postcode screening. The other parts use OpenStreetMap via Overpass. Major-road distance is a practical noise/air-quality exposure proxy, not a measured pollution or decibel reading.</p>
          </div>
          <button class="ghost environment-retry" type="button" data-environment-retry="${property.id}">Refresh environment</button>
        </section>`;
    }

    const messages = {
      pending: 'This property is waiting for its first Environment lookup.',
      needs_location: 'House Ranker needs a full postcode or coordinates before it can calculate Environment.',
      error: 'The Environment lookup could not complete. The property remains saved and can be retried.'
    };
    const status = info.status === 'needs_location' ? 'needs_location' : info.status === 'error' ? 'error' : 'pending';
    return `
      <section class="environment-detail-card ${status}">
        <p class="eyebrow">AUTOMATIC ENVIRONMENT DATA</p>
        <h3>${status === 'needs_location' ? 'Waiting for location' : status === 'error' ? 'Environment lookup unavailable' : 'Environment lookup pending'}</h3>
        <p class="muted">${messages[status]}</p>
        <button class="ghost environment-retry" type="button" data-environment-retry="${property.id}">Try Environment lookup again</button>
      </section>`;
  }

  function injectEnvironmentDetail(propertyId) {
    const detail = document.getElementById('propertyDetail');
    if (!detail || detail.querySelector('.environment-detail-card')) return;
    const property = state.properties.find(item => item.id === propertyId);
    if (!property || property.demo) return;
    const anchor = detail.querySelector('.amenities-detail-card')
      || detail.querySelector('.transport-detail-card')
      || detail.querySelector('.connectivity-detail-card')
      || detail.querySelector('.flood-detail-card')
      || detail.querySelector('.schools-detail-card')
      || detail.querySelector('.crime-detail-card')
      || detail.querySelector('.epc-detail-card');
    const breakdown = detail.querySelector('.breakdown');
    if (anchor) anchor.insertAdjacentHTML('afterend', renderEnvironmentDetail(property));
    else if (breakdown) breakdown.insertAdjacentHTML('afterend', renderEnvironmentDetail(property));
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

  async function enrichPropertyEnvironment(propertyId, { quiet = false } = {}) {
    if (!cloud.client || !cloud.session) {
      if (!quiet) toast('Sign in to run automatic Environment scoring');
      return { ok: false, code: 'SIGNED_OUT' };
    }

    attempted.add(propertyId);
    if (!quiet) toast('Checking flood resilience, green space and nearby environmental exposure…');

    const { data, error } = await cloud.client.functions.invoke('environment-enrich', {
      body: { propertyId }
    });

    if (error) {
      const payload = await parseFunctionError(error);
      if (!quiet) toast(`Environment lookup failed: ${payload.detail || payload.error || error.message || 'unknown error'}`);
      return { ok: false, code: 'FUNCTION_ERROR', error };
    }

    let property = replaceProperty(data?.property);
    if (!property) property = state.properties.find(item => item.id === propertyId) || null;

    if (!quiet) {
      if (['matched', 'partial'].includes(data?.status)) toast(`Environment ${Math.round(data.score ?? property?.environmentInfo?.score ?? 0)}/100`);
      else if (data?.status === 'needs_location') toast('Environment scoring is waiting for a full postcode or coordinates');
      else if (data?.status === 'already_running') toast('Environment lookup is already running');
    }
    return { ok: true, status: data?.status, property };
  }

  async function hydrateEnvironmentMetadata() {
    if (!cloud.client || !cloud.session) return;

    const [propertyResult, areaResult] = await Promise.all([
      cloud.client.from('properties').select('id,environment_status,environment_score,environment_flood_score,environment_green_score,environment_road_score,environment_landuse_score,environment_nearest_green_name,environment_nearest_green_miles,environment_nearest_major_road_name,environment_nearest_major_road_class,environment_nearest_major_road_miles,environment_nearest_industrial_name,environment_nearest_industrial_miles,environment_enriched_at,metrics,postcode,latitude,longitude,flood_status,flood_score,flood_band'),
      cloud.client.from('area_metrics').select('property_id,environment_score,raw_data')
    ]);

    if (propertyResult.error) return;
    const areaById = new Map((areaResult.data || []).map(row => [row.property_id, row]));

    for (const row of propertyResult.data || []) {
      const property = state.properties.find(item => item.id === row.id);
      if (!property) continue;
      property.environmentInfo = environmentFromRow(row);
      property.metrics = { ...(property.metrics || {}), ...(row.metrics || {}) };
      property.postcode = row.postcode || property.postcode || '';
      property.latitude = numberOrNull(row.latitude);
      property.longitude = numberOrNull(row.longitude);
      property.environmentInfo.raw = areaById.get(row.id)?.raw_data?.environment || null;
      if (property.flood) {
        property.flood.status = row.flood_status || property.flood.status;
        property.flood.score = numberOrNull(row.flood_score);
        property.flood.band = row.flood_band || property.flood.band;
      }
    }
    renderDashboard();
  }

  function isStale(property) {
    const enrichedAt = property?.environmentInfo?.enrichedAt;
    if (!enrichedAt) return false;
    const stamp = new Date(enrichedAt).getTime();
    return Number.isFinite(stamp) && Date.now() - stamp > 30 * 24 * 60 * 60 * 1000;
  }

  function needsFloodRefresh(property) {
    return property?.environmentInfo?.status === 'partial' && property?.flood?.status === 'matched';
  }

  async function autoEnrichPending() {
    if (!cloud.session || !cloud.client) return;
    await hydrateEnvironmentMetadata();
    const candidate = state.properties.find(property => {
      if (property.demo || attempted.has(property.id)) return false;
      const status = property.environmentInfo?.status || 'pending';
      if (status === 'pending') return true;
      if (status === 'needs_location' && (property.postcode || (property.latitude !== null && property.longitude !== null))) return true;
      if (needsFloodRefresh(property)) return true;
      if (['matched', 'partial'].includes(status) && isStale(property)) return true;
      return false;
    });
    if (candidate) await enrichPropertyEnvironment(candidate.id, { quiet: true });
    await hydrateEnvironmentMetadata();
  }

  function updateFormCopy() {
    const scoringText = document.querySelector('#propertyForm .form-section:nth-of-type(2) .muted');
    if (scoringText) scoringText.textContent = 'Energy, Crime, Schools, Flood, Connectivity, Commute, Transport, Amenities and Environment are automatic after enrichment. Only Property and Price & Value remain manual fallbacks.';
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) setTimeout(() => injectEnvironmentDetail(detailButton.dataset.detail), 200);

    const retry = event.target.closest?.('[data-environment-retry]');
    if (retry) {
      event.preventDefault();
      attempted.delete(retry.dataset.environmentRetry);
      enrichPropertyEnvironment(retry.dataset.environmentRetry).then(async () => {
        await hydrateEnvironmentMetadata();
        const detail = document.getElementById('propertyDetail');
        if (detail) {
          detail.querySelector('.environment-detail-card')?.remove();
          injectEnvironmentDetail(retry.dataset.environmentRetry);
        }
      });
    }
  });

  const form = document.getElementById('propertyForm');
  if (form) {
    form.addEventListener('submit', () => {
      setTimeout(() => autoEnrichPending(), 19000);
      setTimeout(() => autoEnrichPending(), 39000);
    }, true);
  }

  updateFormCopy();
  setTimeout(() => autoEnrichPending(), 12500);
  setTimeout(() => autoEnrichPending(), 31000);

  window.houseRankerEnvironment = {
    enrichPropertyEnvironment,
    hydrateEnvironmentMetadata,
    autoEnrichPending
  };
})();
