(() => {
  const attempted = new Set();

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function valueScoreFromRow(row) {
    return {
      status: row.value_status || 'pending',
      score: numberOrNull(row.value_score),
      marketScore: numberOrNull(row.value_market_score),
      budgetScore: numberOrNull(row.value_budget_score),
      confidence: numberOrNull(row.value_data_confidence),
      comparableCount: numberOrNull(row.value_comparable_count),
      medianPrice: numberOrNull(row.value_median_price),
      expectedPrice: numberOrNull(row.value_expected_price),
      priceVsExpectedPct: numberOrNull(row.value_price_vs_expected_pct),
      pricePerM2: numberOrNull(row.value_price_per_m2),
      postcode: row.value_postcode || null,
      comparables: Array.isArray(row.value_comparables) ? row.value_comparables : [],
      enrichedAt: row.value_enriched_at || null
    };
  }

  if (typeof fromDbProperty === 'function') {
    const originalFromDbProperty = fromDbProperty;
    fromDbProperty = function valueScoreFromDbProperty(row) {
      const property = originalFromDbProperty(row);
      property.valueScoreInfo = valueScoreFromRow(row);
      return property;
    };
  }

  function valueStatusLabel(property) {
    const info = property.valueScoreInfo || {};
    if (info.status === 'matched' && info.score !== null) {
      return { className: 'matched', text: `Value ${Math.round(info.score)}/100` };
    }
    if (info.status === 'partial' && info.score !== null) {
      const confidence = Math.round(info.confidence || 0);
      return { className: 'partial', text: `Value ${Math.round(info.score)}/100 · ${confidence}% data` };
    }
    if (info.status === 'error') return { className: 'error', text: 'Value unavailable' };
    return { className: 'pending', text: 'Value pending' };
  }

  function decorateLeaderboard() {
    document.querySelectorAll('.property-row').forEach(row => {
      const detailButton = row.querySelector('[data-detail]');
      if (!detailButton || row.querySelector('.value-score-inline')) return;
      const property = state.properties.find(item => item.id === detailButton.dataset.detail);
      if (!property || property.demo) return;
      const target = row.querySelector('.property-title');
      if (!target) return;
      const label = valueStatusLabel(property);
      const badge = document.createElement('span');
      badge.className = `value-score-inline ${label.className}`;
      badge.textContent = label.text;
      target.appendChild(badge);
    });
  }

  if (typeof renderDashboard === 'function') {
    const originalRenderDashboard = renderDashboard;
    renderDashboard = function valueRenderDashboard(...args) {
      const result = originalRenderDashboard.apply(this, args);
      decorateLeaderboard();
      return result;
    };
  }

  function money(value) {
    const n = numberOrNull(value);
    return n === null ? '—' : formatPrice(Math.round(n));
  }

  function scoreText(value) {
    const n = numberOrNull(value);
    return n === null ? '—' : `${Math.round(n)}/100`;
  }

  function signedPercent(value) {
    const n = numberOrNull(value);
    if (n === null) return '—';
    if (Math.abs(n) < 0.05) return 'Around benchmark';
    return `${n > 0 ? '+' : ''}${n.toFixed(1)}% vs benchmark`;
  }

  function budgetDetail(property) {
    const budget = numberOrNull(state?.rules?.maxBudget);
    if (!budget || budget <= 0) return 'No maximum budget saved';
    const difference = property.price - budget;
    if (difference <= 0) return `${money(Math.abs(difference))} under / at ${money(budget)} budget`;
    return `${money(difference)} over ${money(budget)} budget`;
  }

  function renderComparableRows(info) {
    if (!info.comparables?.length) {
      return '<p class="muted value-no-comps">No usable local sold-price comparables were returned yet.</p>';
    }
    return `<div class="value-comparables">${info.comparables.slice(0, 4).map(item => `
      <div class="value-comparable-row">
        <div><strong>${escapeHtml(item.address || 'Nearby sale')}</strong><small>${escapeHtml(item.propertyType || 'property')} · ${escapeHtml(item.date || '')}</small></div>
        <strong>${money(item.price)}</strong>
      </div>`).join('')}</div>`;
  }

  function renderValueDetail(property) {
    if (!property || property.demo) return '';
    const info = property.valueScoreInfo || { status: 'pending' };
    const ready = ['matched', 'partial'].includes(info.status) && info.score !== null;

    if (ready) {
      const marketDetail = info.expectedPrice !== null
        ? `${info.comparableCount || 0} local sale${Number(info.comparableCount) === 1 ? '' : 's'} · benchmark ${money(info.expectedPrice)}`
        : info.postcode
          ? 'Local sold-price evidence is still too thin for a benchmark'
          : 'Full postcode needed for local sold-price evidence';
      const perM2 = info.pricePerM2 === null ? 'Floor area unavailable' : `${money(info.pricePerM2)} per m²`;
      return `
        <section class="value-detail-card ${escapeHtml(info.status)}">
          <div class="value-detail-heading">
            <div><p class="eyebrow">AUTOMATIC PRICE & VALUE</p><h3>Price & value</h3></div>
            <div class="value-total"><strong>${Math.round(info.score)}</strong><span>/100</span></div>
          </div>

          <div class="value-components">
            <div class="value-component">
              <small>Local market value · 80%</small>
              <strong>${scoreText(info.marketScore)}</strong>
              <span>${escapeHtml(marketDetail)}</span>
            </div>
            <div class="value-component">
              <small>Budget fit · 20%</small>
              <strong>${scoreText(info.budgetScore)}</strong>
              <span>${escapeHtml(budgetDetail(property))}</span>
            </div>
            <div class="value-component">
              <small>Asking price efficiency</small>
              <strong>${escapeHtml(signedPercent(info.priceVsExpectedPct))}</strong>
              <span>${escapeHtml(perM2)}</span>
            </div>
          </div>

          <div class="value-confidence">
            <div><small>Data confidence</small><strong>${Math.round(info.confidence || 0)}%</strong></div>
            <div><small>Postcode used</small><strong>${escapeHtml(info.postcode || 'Not resolved')}</strong></div>
            <div><small>Comparable median</small><strong>${money(info.medianPrice)}</strong></div>
          </div>

          <div class="value-evidence">
            <div class="section-heading compact"><div><strong>Recent local evidence</strong><p class="muted">Latest usable sales in the property's postcode, normalised towards the listing property type when needed.</p></div></div>
            ${renderComparableRows(info)}
          </div>

          <div class="value-method">
            <strong>How Price & Value V1 is scored</strong>
            <p class="muted">80% compares the asking price with recent HM Land Registry sold-price evidence in the full postcode. Where there are too few same-type sales, nearby property types are normalised before the local median is calculated. The listing's floor area and bedroom count make a small size adjustment to that benchmark.</p>
            <p class="muted">20% measures the asking price against your saved maximum budget. Missing market data uses a neutral market score rather than pretending the house is cheap or expensive.</p>
            <p class="muted value-attribution">Contains HM Land Registry data © Crown copyright and database right 2026. This data is licensed under the Open Government Licence v3.0.</p>
          </div>
          <button class="ghost value-retry" type="button" data-value-retry="${property.id}">Refresh Price & Value</button>
        </section>`;
    }

    const title = info.status === 'error' ? 'Price & Value unavailable' : 'Price & Value pending';
    const message = info.status === 'error'
      ? 'The automatic value calculation could not complete. The house remains saved and can be retried.'
      : 'House Ranker is waiting to compare this asking price with local sold-price evidence and your saved budget.';
    return `
      <section class="value-detail-card ${info.status === 'error' ? 'error' : 'pending'}">
        <p class="eyebrow">AUTOMATIC PRICE & VALUE</p>
        <h3>${title}</h3>
        <p class="muted">${message}</p>
        <button class="ghost value-retry" type="button" data-value-retry="${property.id}">Try Price & Value again</button>
      </section>`;
  }

  function injectValueDetail(propertyId) {
    const detail = document.getElementById('propertyDetail');
    if (!detail || detail.querySelector('.value-detail-card')) return;
    const property = state.properties.find(item => item.id === propertyId);
    if (!property || property.demo) return;
    const anchor = detail.querySelector('.property-score-detail-card')
      || detail.querySelector('.environment-detail-card')
      || detail.querySelector('.amenities-detail-card')
      || detail.querySelector('.transport-detail-card')
      || detail.querySelector('.connectivity-detail-card')
      || detail.querySelector('.flood-detail-card')
      || detail.querySelector('.schools-detail-card')
      || detail.querySelector('.crime-detail-card')
      || detail.querySelector('.epc-detail-card');
    const breakdown = detail.querySelector('.breakdown');
    if (anchor) anchor.insertAdjacentHTML('afterend', renderValueDetail(property));
    else if (breakdown) breakdown.insertAdjacentHTML('afterend', renderValueDetail(property));
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

  async function enrichValue(propertyId, { quiet = false } = {}) {
    if (!cloud.client || !cloud.session) {
      if (!quiet) toast('Sign in to run automatic Price & Value scoring');
      return { ok: false, code: 'SIGNED_OUT' };
    }

    attempted.add(propertyId);
    if (!quiet) toast('Comparing asking price with local sold prices…');

    const { data, error } = await cloud.client.functions.invoke('value-enrich', {
      body: { propertyId }
    });

    if (error) {
      const payload = await parseFunctionError(error);
      if (!quiet) toast(`Price & Value failed: ${payload.detail || payload.error || error.message || 'unknown error'}`);
      return { ok: false, code: 'FUNCTION_ERROR', error };
    }

    let property = replaceProperty(data?.property);
    if (!property) property = state.properties.find(item => item.id === propertyId) || null;

    if (!quiet) {
      if (['matched', 'partial'].includes(data?.status)) toast(`Price & Value ${Math.round(data.score ?? property?.valueScoreInfo?.score ?? 0)}/100`);
      else if (data?.status === 'already_running') toast('Price & Value is already running');
    }
    return { ok: true, status: data?.status, property };
  }

  async function hydrateValueMetadata() {
    if (!cloud.client || !cloud.session) return;
    const { data, error } = await cloud.client.from('properties').select('id,value_status,value_score,value_market_score,value_budget_score,value_data_confidence,value_comparable_count,value_median_price,value_expected_price,value_price_vs_expected_pct,value_price_per_m2,value_postcode,value_comparables,value_enriched_at,metrics');
    if (error) return;

    for (const row of data || []) {
      const property = state.properties.find(item => item.id === row.id);
      if (!property) continue;
      property.valueScoreInfo = valueScoreFromRow(row);
      property.metrics = { ...(property.metrics || {}), ...(row.metrics || {}) };
    }
    renderDashboard();
  }

  function isStale(property) {
    const enrichedAt = property?.valueScoreInfo?.enrichedAt;
    if (!enrichedAt) return false;
    const stamp = new Date(enrichedAt).getTime();
    return Number.isFinite(stamp) && Date.now() - stamp > 30 * 24 * 60 * 60 * 1000;
  }

  async function autoEnrichPending() {
    if (!cloud.session || !cloud.client) return;
    await hydrateValueMetadata();
    const candidate = state.properties.find(property => {
      if (property.demo) return false;
      const status = property.valueScoreInfo?.status || 'pending';
      if (status === 'pending') return true;
      if (attempted.has(property.id)) return false;
      return ['matched', 'partial'].includes(status) && isStale(property);
    });
    if (candidate) await enrichValue(candidate.id, { quiet: true });
    await hydrateValueMetadata();
  }

  function updateFormCopy() {
    const scoringText = document.querySelector('#propertyForm .form-section:nth-of-type(2) .muted');
    if (scoringText) scoringText.textContent = 'All nine House Score categories are now automatic after a listing is saved. The sliders remain as a local/demo fallback only.';
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) setTimeout(() => injectValueDetail(detailButton.dataset.detail), 320);

    const retry = event.target.closest?.('[data-value-retry]');
    if (retry) {
      event.preventDefault();
      attempted.delete(retry.dataset.valueRetry);
      enrichValue(retry.dataset.valueRetry).then(async () => {
        await hydrateValueMetadata();
        const detail = document.getElementById('propertyDetail');
        if (detail) {
          detail.querySelector('.value-detail-card')?.remove();
          injectValueDetail(retry.dataset.valueRetry);
        }
      });
    }
  });

  const form = document.getElementById('propertyForm');
  if (form) {
    form.addEventListener('submit', () => {
      setTimeout(() => autoEnrichPending(), 26000);
      setTimeout(() => autoEnrichPending(), 52000);
    }, true);
  }

  updateFormCopy();
  setTimeout(() => autoEnrichPending(), 21000);
  setTimeout(() => autoEnrichPending(), 47000);

  window.houseRankerValue = {
    enrichValue,
    hydrateValueMetadata,
    autoEnrichPending
  };
})();
