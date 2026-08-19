(() => {
  const attempted = new Set();

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function crimeFromRow(row) {
    return {
      status: row.crime_status || 'pending',
      score: numberOrNull(row.crime_score),
      latestMonth: row.crime_latest_month || null,
      monthlyAverage: numberOrNull(row.crime_monthly_average),
      weightedMonthlyAverage: numberOrNull(row.crime_weighted_monthly_average),
      totalSixMonths: numberOrNull(row.crime_total_6m),
      enrichedAt: row.crime_enriched_at || null,
      topCategories: [],
      radiusMetres: 1000,
      months: 6
    };
  }

  if (typeof fromDbProperty === 'function') {
    const originalFromDbProperty = fromDbProperty;
    fromDbProperty = function crimeFromDbProperty(row) {
      const property = originalFromDbProperty(row);
      property.crime = crimeFromRow(row);
      return property;
    };
  }

  function categoryLabel(value) {
    const labels = {
      'anti-social-behaviour': 'Anti-social behaviour',
      'bicycle-theft': 'Bicycle theft',
      burglary: 'Burglary',
      'criminal-damage-arson': 'Criminal damage & arson',
      drugs: 'Drugs',
      'other-crime': 'Other crime',
      'other-theft': 'Other theft',
      'possession-of-weapons': 'Weapons',
      'public-order': 'Public order',
      robbery: 'Robbery',
      shoplifting: 'Shoplifting',
      'theft-from-person': 'Theft from person',
      'vehicle-crime': 'Vehicle crime',
      'violent-crime': 'Violence & sexual offences'
    };
    return labels[value] || String(value || '').replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  }

  function monthLabel(value) {
    if (!value) return '—';
    const raw = String(value).slice(0, 7);
    const [year, month] = raw.split('-').map(Number);
    if (!year || !month) return raw;
    return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' }).format(new Date(Date.UTC(year, month - 1, 1)));
  }

  function crimeLabel(property) {
    const crime = property.crime || {};
    if (crime.status === 'matched') {
      const avg = crime.monthlyAverage !== null && crime.monthlyAverage !== undefined
        ? ` · ${Math.round(crime.monthlyAverage * 10) / 10}/mo`
        : '';
      return { className: 'matched', text: `Crime ${Math.round(crime.score ?? property.metrics?.crime ?? 0)}/100${avg}` };
    }
    if (crime.status === 'needs_location') return { className: 'review', text: 'Crime score waiting for location' };
    if (crime.status === 'error') return { className: 'error', text: 'Crime lookup unavailable' };
    return { className: 'pending', text: 'Crime lookup pending' };
  }

  function decorateLeaderboard() {
    document.querySelectorAll('.property-row').forEach(row => {
      const detailButton = row.querySelector('[data-detail]');
      if (!detailButton || row.querySelector('.crime-inline')) return;
      const property = state.properties.find(item => item.id === detailButton.dataset.detail);
      if (!property || property.demo) return;
      const target = row.querySelector('.property-title');
      if (!target) return;
      const label = crimeLabel(property);
      const badge = document.createElement('span');
      badge.className = `crime-inline ${label.className}`;
      badge.textContent = label.text;
      target.appendChild(badge);
    });
  }

  if (typeof renderDashboard === 'function') {
    const originalRenderDashboard = renderDashboard;
    renderDashboard = function crimeRenderDashboard(...args) {
      const result = originalRenderDashboard.apply(this, args);
      decorateLeaderboard();
      return result;
    };
  }

  function renderCrimeDetail(property) {
    if (!property || property.demo) return '';
    const crime = property.crime || { status: 'pending' };

    if (crime.status === 'matched') {
      const score = Math.round(crime.score ?? property.metrics?.crime ?? 0);
      const top = (crime.topCategories || []).slice(0, 5);
      const topHtml = top.length
        ? `<div class="crime-categories">${top.map(item => `<div><span>${escapeHtml(categoryLabel(item.category))}</span><strong>${Math.round(Number(item.count || 0))}</strong></div>`).join('')}</div>`
        : '';

      return `
        <section class="crime-detail-card matched">
          <div class="crime-detail-heading">
            <div><p class="eyebrow">AUTOMATIC CRIME DATA</p><h3>Neighbourhood safety</h3></div>
            <span class="crime-score">${score}/100</span>
          </div>
          <div class="crime-data-grid">
            <div><small>Crime score</small><strong>${score}/100</strong></div>
            <div><small>Average reported</small><strong>${crime.monthlyAverage !== null && crime.monthlyAverage !== undefined ? `${Math.round(crime.monthlyAverage * 10) / 10}/month` : '—'}</strong></div>
            <div><small>6-month total</small><strong>${crime.totalSixMonths ?? '—'}</strong></div>
            <div><small>Latest data</small><strong>${monthLabel(crime.latestMonth)}</strong></div>
          </div>
          ${topHtml}
          <p class="muted crime-footnote">Police.uk street-level data · latest 6 available months · approximately 1 km around the property. Reported locations are anonymised, so this describes the surrounding neighbourhood rather than the exact house. More serious categories carry a larger penalty in the score.</p>
          <button class="ghost crime-retry" type="button" data-crime-retry="${property.id}">Refresh crime data</button>
        </section>`;
    }

    const messages = {
      pending: 'This property is waiting for its first Police.uk crime lookup.',
      needs_location: 'House Ranker needs a full postcode or coordinates before it can calculate the neighbourhood crime score.',
      error: 'The Police.uk lookup could not complete. The property remains saved and can be retried.'
    };

    return `
      <section class="crime-detail-card ${escapeHtml(crime.status || 'pending')}">
        <p class="eyebrow">AUTOMATIC CRIME DATA</p>
        <h3>${crime.status === 'needs_location' ? 'Waiting for location' : crime.status === 'error' ? 'Crime lookup unavailable' : 'Crime lookup pending'}</h3>
        <p class="muted">${messages[crime.status] || messages.pending}</p>
        <button class="ghost crime-retry" type="button" data-crime-retry="${property.id}">Try crime lookup again</button>
      </section>`;
  }

  function injectCrimeDetail(propertyId) {
    const detail = document.getElementById('propertyDetail');
    if (!detail || detail.querySelector('.crime-detail-card')) return;
    const property = state.properties.find(item => item.id === propertyId);
    if (!property || property.demo) return;
    const epcCard = detail.querySelector('.epc-detail-card');
    const breakdown = detail.querySelector('.breakdown');
    if (epcCard) epcCard.insertAdjacentHTML('afterend', renderCrimeDetail(property));
    else if (breakdown) breakdown.insertAdjacentHTML('afterend', renderCrimeDetail(property));
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

  async function enrichPropertyCrime(propertyId, { quiet = false } = {}) {
    if (!cloud.client || !cloud.session) {
      if (!quiet) toast('Sign in to run automatic crime scoring');
      return { ok: false, code: 'SIGNED_OUT' };
    }

    attempted.add(propertyId);
    if (!quiet) toast('Checking recent Police.uk crime data…');

    const { data, error } = await cloud.client.functions.invoke('crime-enrich', {
      body: { propertyId }
    });

    if (error) {
      const payload = await parseFunctionError(error);
      if (!quiet) toast(`Crime lookup failed: ${payload.detail || payload.error || error.message || 'unknown error'}`);
      return { ok: false, code: 'FUNCTION_ERROR', error };
    }

    const property = replaceProperty(data?.property);
    if (!quiet) {
      if (data?.status === 'matched') {
        toast(`Crime score ${data.score}/100 · ${Math.round(Number(data.monthlyAverage || 0) * 10) / 10} reports/month nearby`);
      } else if (data?.status === 'needs_location') {
        toast('Crime scoring is waiting for a full postcode or property coordinates');
      }
    }
    return { ok: true, status: data?.status, property };
  }

  async function hydrateCrimeMetadata() {
    if (!cloud.client || !cloud.session) return;

    const [propertyResult, areaResult] = await Promise.all([
      cloud.client.from('properties').select('id,crime_status,crime_score,crime_latest_month,crime_monthly_average,crime_weighted_monthly_average,crime_total_6m,crime_enriched_at,metrics,postcode,latitude,longitude'),
      cloud.client.from('area_metrics').select('property_id,crime_score,raw_data')
    ]);

    if (propertyResult.error) return;
    const areaById = new Map((areaResult.data || []).map(row => [row.property_id, row]));

    for (const row of propertyResult.data || []) {
      const property = state.properties.find(item => item.id === row.id);
      if (!property) continue;
      property.crime = crimeFromRow(row);
      property.metrics = { ...(property.metrics || {}), ...(row.metrics || {}) };
      property.postcode = row.postcode || property.postcode || '';
      property.latitude = numberOrNull(row.latitude);
      property.longitude = numberOrNull(row.longitude);
      const rawCrime = areaById.get(row.id)?.raw_data?.crime;
      if (rawCrime) {
        property.crime.topCategories = rawCrime.topCategories || [];
        property.crime.radiusMetres = rawCrime.radiusMetres || 1000;
        property.crime.months = Array.isArray(rawCrime.months) ? rawCrime.months.length : 6;
      }
    }
    renderDashboard();
  }

  function isStale(crime) {
    if (!crime?.enrichedAt) return false;
    const age = Date.now() - new Date(crime.enrichedAt).getTime();
    return Number.isFinite(age) && age > 35 * 24 * 60 * 60 * 1000;
  }

  async function autoEnrichPending() {
    if (!cloud.session || !cloud.client) return;
    await hydrateCrimeMetadata();
    const candidates = state.properties.filter(property => {
      if (property.demo || attempted.has(property.id)) return false;
      const status = property.crime?.status || 'pending';
      if (status === 'pending') return true;
      if (status === 'needs_location' && property.postcode) return true;
      if (status === 'matched' && isStale(property.crime)) return true;
      return false;
    });

    for (const property of candidates.slice(0, 4)) {
      const result = await enrichPropertyCrime(property.id, { quiet: true });
      if (!result.ok) break;
    }
    await hydrateCrimeMetadata();
  }

  function updateFormCopy() {
    const scoringText = document.querySelector('#propertyForm .form-section:nth-of-type(2) .muted');
    if (scoringText) scoringText.textContent = 'Energy and Crime are now automatic after enrichment. The remaining 0–100 inputs will be replaced with real sources one by one.';
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) setTimeout(() => injectCrimeDetail(detailButton.dataset.detail), 20);

    const retry = event.target.closest?.('[data-crime-retry]');
    if (retry) {
      event.preventDefault();
      attempted.delete(retry.dataset.crimeRetry);
      enrichPropertyCrime(retry.dataset.crimeRetry).then(async () => {
        await hydrateCrimeMetadata();
        const detailId = retry.dataset.crimeRetry;
        const detail = document.getElementById('propertyDetail');
        if (detail) {
          detail.querySelector('.crime-detail-card')?.remove();
          injectCrimeDetail(detailId);
        }
      });
    }
  });

  const form = document.getElementById('propertyForm');
  if (form) {
    form.addEventListener('submit', () => {
      setTimeout(() => autoEnrichPending(), 4500);
      setTimeout(() => autoEnrichPending(), 10000);
    }, true);
  }

  updateFormCopy();
  setTimeout(() => autoEnrichPending(), 1800);
  setTimeout(() => autoEnrichPending(), 6000);

  window.houseRankerCrime = {
    enrich: enrichPropertyCrime,
    hydrate: hydrateCrimeMetadata,
    refreshPending: autoEnrichPending
  };
})();