(() => {
  const attempted = new Set();

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function propertyScoreFromRow(row) {
    return {
      status: row.property_status || 'pending',
      score: numberOrNull(row.property_score),
      confidence: numberOrNull(row.property_data_confidence),
      components: {
        space: numberOrNull(row.property_space_score),
        type: numberOrNull(row.property_type_score),
        bedrooms: numberOrNull(row.property_bedroom_score),
        bathrooms: numberOrNull(row.property_bathroom_score),
        parking: numberOrNull(row.property_parking_score),
        garden: numberOrNull(row.property_garden_score)
      },
      spacePerBedroomM2: numberOrNull(row.property_space_per_bedroom_m2),
      enrichedAt: row.property_enriched_at || null,
      floorAreaM2: numberOrNull(row.floor_area_m2),
      bathrooms: numberOrNull(row.bathrooms),
      garden: row.garden === true ? true : row.garden === false ? false : null,
      parkingKnown: row.parking === true ? true : row.parking === false ? false : null,
      listingData: row.listing_data || {}
    };
  }

  if (typeof fromDbProperty === 'function') {
    const originalFromDbProperty = fromDbProperty;
    fromDbProperty = function propertyScoreFromDbProperty(row) {
      const property = originalFromDbProperty(row);
      property.propertyScoreInfo = propertyScoreFromRow(row);
      return property;
    };
  }

  function scoreText(value) {
    const n = numberOrNull(value);
    return n === null ? '—' : `${Math.round(n)}/100`;
  }

  function yesNo(value) {
    return value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
  }

  function propertyStatusLabel(property) {
    const info = property.propertyScoreInfo || {};
    if (info.status === 'matched' && info.score !== null) {
      return { className: 'matched', text: `Property ${Math.round(info.score)}/100` };
    }
    if (info.status === 'partial' && info.score !== null) {
      return { className: 'partial', text: `Property ${Math.round(info.score)}/100 · ${Math.round(info.confidence || 0)}% data` };
    }
    if (info.status === 'error') return { className: 'error', text: 'Property score unavailable' };
    return { className: 'pending', text: 'Property score pending' };
  }

  function decorateLeaderboard() {
    document.querySelectorAll('.property-row').forEach(row => {
      const detailButton = row.querySelector('[data-detail]');
      if (!detailButton || row.querySelector('.property-score-inline')) return;
      const property = state.properties.find(item => item.id === detailButton.dataset.detail);
      if (!property || property.demo) return;
      const target = row.querySelector('.property-title');
      if (!target) return;
      const label = propertyStatusLabel(property);
      const badge = document.createElement('span');
      badge.className = `property-score-inline ${label.className}`;
      badge.textContent = label.text;
      target.appendChild(badge);
    });
  }

  if (typeof renderDashboard === 'function') {
    const originalRenderDashboard = renderDashboard;
    renderDashboard = function propertyScoreRenderDashboard(...args) {
      const result = originalRenderDashboard.apply(this, args);
      decorateLeaderboard();
      return result;
    };
  }

  function renderComponent(label, value, detail) {
    return `
      <div class="property-score-component">
        <small>${escapeHtml(label)}</small>
        <strong>${scoreText(value)}</strong>
        <span>${escapeHtml(detail)}</span>
      </div>`;
  }

  function missingFields(info, property) {
    const missing = [];
    if (info.floorAreaM2 === null) missing.push('floor area');
    if (!property.propertyType || String(property.propertyType).toLowerCase() === 'other') missing.push('property type');
    if (numberOrNull(property.bedrooms) === null) missing.push('bedrooms');
    if (info.bathrooms === null) missing.push('bathrooms');
    if (info.parkingKnown === null) missing.push('parking');
    if (info.garden === null) missing.push('garden');
    return missing;
  }

  function renderPropertyScoreDetail(property) {
    if (!property || property.demo) return '';
    const info = property.propertyScoreInfo || { status: 'pending', components: {} };
    const components = info.components || {};
    const ready = ['matched', 'partial'].includes(info.status) && info.score !== null;

    if (ready) {
      const area = info.floorAreaM2 === null ? 'Unknown floor area' : `${Math.round(info.floorAreaM2)} m² total`;
      const perBed = info.spacePerBedroomM2 === null ? '' : ` · ${info.spacePerBedroomM2.toFixed(1)} m²/bed`;
      const bathrooms = info.bathrooms === null ? 'Bathrooms unknown' : `${info.bathrooms} bathroom${info.bathrooms === 1 ? '' : 's'}`;
      const missing = missingFields(info, property);
      return `
        <section class="property-score-detail-card ${escapeHtml(info.status)}">
          <div class="property-score-detail-heading">
            <div><p class="eyebrow">AUTOMATIC PROPERTY DATA</p><h3>Property itself</h3></div>
            <div class="property-score-total"><strong>${Math.round(info.score)}</strong><span>/100</span></div>
          </div>

          <div class="property-score-components">
            ${renderComponent('Space & layout · 40%', components.space, `${area}${perBed}`)}
            ${renderComponent('Property type · 20%', components.type, property.propertyType || 'Unknown')}
            ${renderComponent('Bedrooms · 15%', components.bedrooms, `${property.bedrooms || 0} bedroom${property.bedrooms === 1 ? '' : 's'}`)}
            ${renderComponent('Bathrooms · 10%', components.bathrooms, bathrooms)}
            ${renderComponent('Parking · 8%', components.parking, yesNo(info.parkingKnown))}
            ${renderComponent('Garden · 7%', components.garden, yesNo(info.garden))}
          </div>

          <div class="property-score-confidence">
            <div><small>Data confidence</small><strong>${Math.round(info.confidence || 0)}%</strong></div>
            <div><small>Floor area source</small><strong>${info.floorAreaM2 === null ? 'Not available' : 'Listing / EPC'}</strong></div>
            <div><small>Missing fields</small><strong>${missing.length ? escapeHtml(missing.join(', ')) : 'None'}</strong></div>
          </div>

          <div class="property-score-method">
            <strong>How Property is scored</strong>
            <p class="muted">40% space/layout + 20% property type + 15% bedrooms + 10% bathrooms + 8% parking + 7% garden.</p>
            <p class="muted">Space uses both total floor area and floor area per bedroom, so adding extra bedrooms without enough usable space does not automatically improve the score. Unknown listing fields use a neutral 60/100 and reduce the displayed data confidence.</p>
          </div>
          <button class="ghost property-score-retry" type="button" data-property-score-retry="${property.id}">Refresh property score</button>
        </section>`;
    }

    const title = info.status === 'error' ? 'Property score unavailable' : 'Property score pending';
    const message = info.status === 'error'
      ? 'The automatic Property calculation could not complete. The house remains saved and can be retried.'
      : 'House Ranker is waiting to calculate the Property score from the saved listing and EPC fields.';
    return `
      <section class="property-score-detail-card ${info.status === 'error' ? 'error' : 'pending'}">
        <p class="eyebrow">AUTOMATIC PROPERTY DATA</p>
        <h3>${title}</h3>
        <p class="muted">${message}</p>
        <button class="ghost property-score-retry" type="button" data-property-score-retry="${property.id}">Try Property score again</button>
      </section>`;
  }

  function injectPropertyScoreDetail(propertyId) {
    const detail = document.getElementById('propertyDetail');
    if (!detail || detail.querySelector('.property-score-detail-card')) return;
    const property = state.properties.find(item => item.id === propertyId);
    if (!property || property.demo) return;
    const anchor = detail.querySelector('.environment-detail-card')
      || detail.querySelector('.amenities-detail-card')
      || detail.querySelector('.transport-detail-card')
      || detail.querySelector('.connectivity-detail-card')
      || detail.querySelector('.flood-detail-card')
      || detail.querySelector('.schools-detail-card')
      || detail.querySelector('.crime-detail-card')
      || detail.querySelector('.epc-detail-card');
    const breakdown = detail.querySelector('.breakdown');
    if (anchor) anchor.insertAdjacentHTML('afterend', renderPropertyScoreDetail(property));
    else if (breakdown) breakdown.insertAdjacentHTML('afterend', renderPropertyScoreDetail(property));
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

  async function enrichPropertyScore(propertyId, { quiet = false } = {}) {
    if (!cloud.client || !cloud.session) {
      if (!quiet) toast('Sign in to run automatic Property scoring');
      return { ok: false, code: 'SIGNED_OUT' };
    }

    attempted.add(propertyId);
    if (!quiet) toast('Scoring floor space, layout and property features…');

    const { data, error } = await cloud.client.functions.invoke('property-enrich', {
      body: { propertyId }
    });

    if (error) {
      const payload = await parseFunctionError(error);
      if (!quiet) toast(`Property score failed: ${payload.detail || payload.error || error.message || 'unknown error'}`);
      return { ok: false, code: 'FUNCTION_ERROR', error };
    }

    let property = replaceProperty(data?.property);
    if (!property) property = state.properties.find(item => item.id === propertyId) || null;

    if (!quiet) {
      if (['matched', 'partial'].includes(data?.status)) toast(`Property ${Math.round(data.score ?? property?.propertyScoreInfo?.score ?? 0)}/100`);
      else if (data?.status === 'already_running') toast('Property scoring is already running');
    }
    return { ok: true, status: data?.status, property };
  }

  async function hydratePropertyScoreMetadata() {
    if (!cloud.client || !cloud.session) return;
    const { data, error } = await cloud.client.from('properties').select('id,property_status,property_score,property_space_score,property_type_score,property_bedroom_score,property_bathroom_score,property_parking_score,property_garden_score,property_data_confidence,property_space_per_bedroom_m2,property_enriched_at,floor_area_m2,bathrooms,garden,parking,property_type,bedrooms,listing_data,metrics');
    if (error) return;

    for (const row of data || []) {
      const property = state.properties.find(item => item.id === row.id);
      if (!property) continue;
      property.propertyScoreInfo = propertyScoreFromRow(row);
      property.metrics = { ...(property.metrics || {}), ...(row.metrics || {}) };
    }
    renderDashboard();
  }

  function isStale(property) {
    const enrichedAt = property?.propertyScoreInfo?.enrichedAt;
    if (!enrichedAt) return false;
    const stamp = new Date(enrichedAt).getTime();
    return Number.isFinite(stamp) && Date.now() - stamp > 30 * 24 * 60 * 60 * 1000;
  }

  async function autoEnrichPending() {
    if (!cloud.session || !cloud.client) return;
    await hydratePropertyScoreMetadata();
    const candidate = state.properties.find(property => {
      if (property.demo) return false;
      const status = property.propertyScoreInfo?.status || 'pending';
      if (status === 'pending') return true;
      if (attempted.has(property.id)) return false;
      return ['matched', 'partial'].includes(status) && isStale(property);
    });
    if (candidate) await enrichPropertyScore(candidate.id, { quiet: true });
    await hydratePropertyScoreMetadata();
  }

  function updateFormCopy() {
    const scoringText = document.querySelector('#propertyForm .form-section:nth-of-type(2) .muted');
    if (scoringText) scoringText.textContent = 'Energy, Crime, Schools, Flood, Connectivity, Commute, Transport, Amenities, Environment and Property are automatic. Only Price & Value remains a manual fallback.';
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) setTimeout(() => injectPropertyScoreDetail(detailButton.dataset.detail), 240);

    const retry = event.target.closest?.('[data-property-score-retry]');
    if (retry) {
      event.preventDefault();
      attempted.delete(retry.dataset.propertyScoreRetry);
      enrichPropertyScore(retry.dataset.propertyScoreRetry).then(async () => {
        await hydratePropertyScoreMetadata();
        const detail = document.getElementById('propertyDetail');
        if (detail) {
          detail.querySelector('.property-score-detail-card')?.remove();
          injectPropertyScoreDetail(retry.dataset.propertyScoreRetry);
        }
      });
    }
  });

  const form = document.getElementById('propertyForm');
  if (form) {
    form.addEventListener('submit', () => {
      setTimeout(() => autoEnrichPending(), 22000);
      setTimeout(() => autoEnrichPending(), 43000);
    }, true);
  }

  updateFormCopy();
  setTimeout(() => autoEnrichPending(), 15000);
  setTimeout(() => autoEnrichPending(), 34000);

  window.houseRankerPropertyScore = {
    enrichPropertyScore,
    hydratePropertyScoreMetadata,
    autoEnrichPending
  };
})();
