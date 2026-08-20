(() => {
  const attempted = new Set();

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function amenitiesFromRow(row) {
    return {
      status: row.amenities_status || 'pending',
      score: numberOrNull(row.amenities_score),
      components: {
        grocery: numberOrNull(row.amenities_grocery_score),
        healthcare: numberOrNull(row.amenities_healthcare_score),
        green: numberOrNull(row.amenities_green_score),
        centre: numberOrNull(row.amenities_centre_score),
        leisure: numberOrNull(row.amenities_leisure_score)
      },
      nearestSupermarketName: row.amenities_nearest_supermarket_name || null,
      nearestSupermarketMiles: numberOrNull(row.amenities_nearest_supermarket_miles),
      nearestGpMiles: numberOrNull(row.amenities_nearest_gp_miles),
      nearestPharmacyMiles: numberOrNull(row.amenities_nearest_pharmacy_miles),
      nearestParkMiles: numberOrNull(row.amenities_nearest_park_miles),
      nearestPlaygroundMiles: numberOrNull(row.amenities_nearest_playground_miles),
      nearestLeisureMiles: numberOrNull(row.amenities_nearest_leisure_miles),
      enrichedAt: row.amenities_enriched_at || null,
      raw: null
    };
  }

  if (typeof fromDbProperty === 'function') {
    const originalFromDbProperty = fromDbProperty;
    fromDbProperty = function amenitiesFromDbProperty(row) {
      const property = originalFromDbProperty(row);
      property.amenitiesInfo = amenitiesFromRow(row);
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

  function statusLabel(property) {
    const info = property.amenitiesInfo || {};
    if (info.status === 'matched' && info.score !== null && info.score !== undefined) {
      return { className: 'matched', text: `Amenities ${Math.round(info.score)}/100` };
    }
    if (info.status === 'partial' && info.score !== null && info.score !== undefined) {
      return { className: 'partial', text: `Amenities ${Math.round(info.score)}/100 · partial` };
    }
    if (info.status === 'needs_location') return { className: 'review', text: 'Amenities waiting for location' };
    if (info.status === 'error') return { className: 'error', text: 'Amenities lookup unavailable' };
    return { className: 'pending', text: 'Amenities lookup pending' };
  }

  function decorateLeaderboard() {
    document.querySelectorAll('.property-row').forEach(row => {
      const detailButton = row.querySelector('[data-detail]');
      if (!detailButton || row.querySelector('.amenities-inline')) return;
      const property = state.properties.find(item => item.id === detailButton.dataset.detail);
      if (!property || property.demo) return;
      const target = row.querySelector('.property-title');
      if (!target) return;
      const label = statusLabel(property);
      const badge = document.createElement('span');
      badge.className = `amenities-inline ${label.className}`;
      badge.textContent = label.text;
      target.appendChild(badge);
    });
  }

  if (typeof renderDashboard === 'function') {
    const originalRenderDashboard = renderDashboard;
    renderDashboard = function amenitiesRenderDashboard(...args) {
      const result = originalRenderDashboard.apply(this, args);
      decorateLeaderboard();
      return result;
    };
  }

  function renderComponent(label, value, detail) {
    return `
      <div class="amenities-component">
        <small>${escapeHtml(label)}</small>
        <strong>${scoreText(value)}</strong>
        <span>${escapeHtml(detail)}</span>
      </div>`;
  }

  function renderAmenitiesDetail(property) {
    if (!property || property.demo) return '';
    const info = property.amenitiesInfo || { status: 'pending', components: {} };
    const raw = info.raw || {};
    const counts = raw.counts || {};
    const components = info.components || {};
    const ready = ['matched', 'partial'].includes(info.status) && info.score !== null && info.score !== undefined;

    if (ready) {
      const supermarketName = info.nearestSupermarketName || raw?.nearest?.supermarket?.name || 'Nearest mapped supermarket';
      const centreCount = numberOrNull(counts.centrePois1_2Miles);
      const centreTypes = numberOrNull(counts.centreDistinctTypes);
      const supermarkets = numberOrNull(counts.supermarkets3Miles);
      const foodShops = numberOrNull(counts.foodShops1_5Miles);
      const gps = numberOrNull(counts.gps2_5Miles);
      const pharmacies = numberOrNull(counts.pharmacies2_5Miles);
      const parks = numberOrNull(counts.parks1_5Miles);
      const playgrounds = numberOrNull(counts.playgrounds1_5Miles);
      const leisure = numberOrNull(counts.leisure3Miles);

      return `
        <section class="amenities-detail-card ${escapeHtml(info.status)}">
          <div class="amenities-detail-heading">
            <div><p class="eyebrow">AUTOMATIC AMENITIES DATA</p><h3>Everyday amenities</h3></div>
            <div class="amenities-score"><strong>${Math.round(info.score)}</strong><span>/100</span></div>
          </div>

          <div class="amenities-components">
            ${renderComponent('Groceries · 30%', components.grocery, `${supermarketName} · ${miles(info.nearestSupermarketMiles)}`)}
            ${renderComponent('Healthcare · 20%', components.healthcare, `GP ${miles(info.nearestGpMiles)} · Pharmacy ${miles(info.nearestPharmacyMiles)}`)}
            ${renderComponent('Parks & play · 20%', components.green, `Park ${miles(info.nearestParkMiles)} · Playground ${miles(info.nearestPlaygroundMiles)}`)}
            ${renderComponent('Local centre · 20%', components.centre, `${centreCount ?? '—'} useful POIs · ${centreTypes ?? '—'}/4 types ≤1.2 mi`)}
            ${renderComponent('Leisure · 10%', components.leisure, `Nearest ${miles(info.nearestLeisureMiles)}`)}
          </div>

          <div class="amenities-summary-grid">
            <div><small>Supermarket choice</small><strong>${supermarkets ?? '—'} ≤3 mi</strong></div>
            <div><small>Local food shops</small><strong>${foodShops ?? '—'} ≤1.5 mi</strong></div>
            <div><small>Healthcare choice</small><strong>${gps ?? '—'} GP · ${pharmacies ?? '—'} pharmacy</strong></div>
            <div><small>Family green space</small><strong>${parks ?? '—'} park · ${playgrounds ?? '—'} play</strong></div>
            <div><small>Leisure choice</small><strong>${leisure ?? '—'} ≤3 mi</strong></div>
          </div>

          <div class="amenities-method">
            <strong>How Amenities is scored</strong>
            <p class="muted">30% groceries + 20% healthcare + 20% parks/playgrounds + 20% local-centre usefulness + 10% leisure. Each part combines distance with capped choice, so a pile of cafés cannot compensate for missing essentials.</p>
            <p class="muted">Source: OpenStreetMap via the public Overpass API. V1 uses straight-line distance and mapped POIs; it does not yet judge opening hours, store size, footpath routing or service quality.</p>
          </div>
          <button class="ghost amenities-retry" type="button" data-amenities-retry="${property.id}">Refresh amenities</button>
        </section>`;
    }

    const messages = {
      pending: 'This property is waiting for its first OpenStreetMap amenities lookup.',
      needs_location: 'House Ranker needs a full postcode or coordinates before it can calculate Amenities.',
      error: 'The amenities lookup could not complete. The property remains saved and can be retried.'
    };
    const status = info.status === 'needs_location' ? 'needs_location' : info.status === 'error' ? 'error' : 'pending';
    return `
      <section class="amenities-detail-card ${status}">
        <p class="eyebrow">AUTOMATIC AMENITIES DATA</p>
        <h3>${status === 'needs_location' ? 'Waiting for location' : status === 'error' ? 'Amenities lookup unavailable' : 'Amenities lookup pending'}</h3>
        <p class="muted">${messages[status]}</p>
        <button class="ghost amenities-retry" type="button" data-amenities-retry="${property.id}">Try amenities lookup again</button>
      </section>`;
  }

  function injectAmenitiesDetail(propertyId) {
    const detail = document.getElementById('propertyDetail');
    if (!detail || detail.querySelector('.amenities-detail-card')) return;
    const property = state.properties.find(item => item.id === propertyId);
    if (!property || property.demo) return;
    const anchor = detail.querySelector('.transport-detail-card')
      || detail.querySelector('.connectivity-detail-card')
      || detail.querySelector('.flood-detail-card')
      || detail.querySelector('.schools-detail-card')
      || detail.querySelector('.crime-detail-card')
      || detail.querySelector('.epc-detail-card');
    const breakdown = detail.querySelector('.breakdown');
    if (anchor) anchor.insertAdjacentHTML('afterend', renderAmenitiesDetail(property));
    else if (breakdown) breakdown.insertAdjacentHTML('afterend', renderAmenitiesDetail(property));
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

  async function enrichPropertyAmenities(propertyId, { quiet = false } = {}) {
    if (!cloud.client || !cloud.session) {
      if (!quiet) toast('Sign in to run automatic Amenities scoring');
      return { ok: false, code: 'SIGNED_OUT' };
    }

    attempted.add(propertyId);
    if (!quiet) toast('Checking nearby everyday amenities…');

    const { data, error } = await cloud.client.functions.invoke('amenities-enrich', {
      body: { propertyId }
    });

    if (error) {
      const payload = await parseFunctionError(error);
      if (!quiet) toast(`Amenities lookup failed: ${payload.detail || payload.error || error.message || 'unknown error'}`);
      return { ok: false, code: 'FUNCTION_ERROR', error };
    }

    let property = replaceProperty(data?.property);
    if (!property) property = state.properties.find(item => item.id === propertyId) || null;

    if (!quiet) {
      if (['matched', 'partial'].includes(data?.status)) toast(`Amenities ${Math.round(data.score ?? property?.amenitiesInfo?.score ?? 0)}/100`);
      else if (data?.status === 'needs_location') toast('Amenities scoring is waiting for a full postcode or coordinates');
      else if (data?.status === 'already_running') toast('Amenities lookup is already running');
    }
    return { ok: true, status: data?.status, property };
  }

  async function hydrateAmenitiesMetadata() {
    if (!cloud.client || !cloud.session) return;

    const [propertyResult, areaResult] = await Promise.all([
      cloud.client.from('properties').select('id,amenities_status,amenities_score,amenities_grocery_score,amenities_healthcare_score,amenities_green_score,amenities_centre_score,amenities_leisure_score,amenities_nearest_supermarket_name,amenities_nearest_supermarket_miles,amenities_nearest_gp_miles,amenities_nearest_pharmacy_miles,amenities_nearest_park_miles,amenities_nearest_playground_miles,amenities_nearest_leisure_miles,amenities_enriched_at,metrics,postcode,latitude,longitude'),
      cloud.client.from('area_metrics').select('property_id,amenities_score,raw_data')
    ]);

    if (propertyResult.error) return;
    const areaById = new Map((areaResult.data || []).map(row => [row.property_id, row]));

    for (const row of propertyResult.data || []) {
      const property = state.properties.find(item => item.id === row.id);
      if (!property) continue;
      property.amenitiesInfo = amenitiesFromRow(row);
      property.metrics = { ...(property.metrics || {}), ...(row.metrics || {}) };
      property.postcode = row.postcode || property.postcode || '';
      property.latitude = numberOrNull(row.latitude);
      property.longitude = numberOrNull(row.longitude);
      property.amenitiesInfo.raw = areaById.get(row.id)?.raw_data?.amenities || null;
    }
    renderDashboard();
  }

  function isStale(property) {
    const enrichedAt = property?.amenitiesInfo?.enrichedAt;
    if (!enrichedAt) return false;
    const stamp = new Date(enrichedAt).getTime();
    return Number.isFinite(stamp) && Date.now() - stamp > 30 * 24 * 60 * 60 * 1000;
  }

  async function autoEnrichPending() {
    if (!cloud.session || !cloud.client) return;
    await hydrateAmenitiesMetadata();
    const candidate = state.properties.find(property => {
      if (property.demo || attempted.has(property.id)) return false;
      const status = property.amenitiesInfo?.status || 'pending';
      if (status === 'pending') return true;
      if (status === 'needs_location' && (property.postcode || (property.latitude !== null && property.longitude !== null))) return true;
      if (['matched', 'partial'].includes(status) && isStale(property)) return true;
      return false;
    });
    if (candidate) await enrichPropertyAmenities(candidate.id, { quiet: true });
    await hydrateAmenitiesMetadata();
  }

  function updateFormCopy() {
    const scoringText = document.querySelector('#propertyForm .form-section:nth-of-type(2) .muted');
    if (scoringText) scoringText.textContent = 'Energy, Crime, Schools, Flood, Connectivity, Commute, Transport and Amenities are automatic after enrichment. The remaining 0–100 inputs are manual fallbacks until their live sources are added.';
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) setTimeout(() => injectAmenitiesDetail(detailButton.dataset.detail), 160);

    const retry = event.target.closest?.('[data-amenities-retry]');
    if (retry) {
      event.preventDefault();
      attempted.delete(retry.dataset.amenitiesRetry);
      enrichPropertyAmenities(retry.dataset.amenitiesRetry).then(async () => {
        await hydrateAmenitiesMetadata();
        const detail = document.getElementById('propertyDetail');
        if (detail) {
          detail.querySelector('.amenities-detail-card')?.remove();
          injectAmenitiesDetail(retry.dataset.amenitiesRetry);
        }
      });
    }
  });

  const form = document.getElementById('propertyForm');
  if (form) {
    form.addEventListener('submit', () => {
      setTimeout(() => autoEnrichPending(), 15500);
      setTimeout(() => autoEnrichPending(), 34500);
    }, true);
  }

  updateFormCopy();
  setTimeout(() => autoEnrichPending(), 9500);
  setTimeout(() => autoEnrichPending(), 29000);

  window.houseRankerAmenities = {
    enrich: enrichPropertyAmenities,
    hydrate: hydrateAmenitiesMetadata,
    autoEnrich: autoEnrichPending
  };
})();
