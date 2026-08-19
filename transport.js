(() => {
  const attempted = new Set();

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function transportFromRow(row) {
    return {
      commute: {
        status: row.commute_status || 'pending',
        score: numberOrNull(row.commute_score),
        minutes: numberOrNull(row.commute_minutes),
        distanceMiles: numberOrNull(row.commute_distance_miles),
        destination: row.commute_destination || "Queen's Medical Centre, Nottingham",
        enrichedAt: row.commute_enriched_at || null
      },
      transport: {
        status: row.transport_status || 'pending',
        score: numberOrNull(row.transport_score),
        nearestRailName: row.transport_nearest_rail_name || null,
        nearestRailMiles: numberOrNull(row.transport_nearest_rail_miles),
        nearestBusMiles: numberOrNull(row.transport_nearest_bus_miles),
        busStopsHalfMile: numberOrNull(row.transport_bus_stops_half_mile),
        enrichedAt: row.transport_enriched_at || null,
        raw: null
      }
    };
  }

  if (typeof fromDbProperty === 'function') {
    const originalFromDbProperty = fromDbProperty;
    fromDbProperty = function transportFromDbProperty(row) {
      const property = originalFromDbProperty(row);
      const data = transportFromRow(row);
      property.commuteInfo = data.commute;
      property.transportInfo = data.transport;
      return property;
    };
  }

  function miles(value) {
    const number = numberOrNull(value);
    if (number === null) return '—';
    return `${number < 10 ? number.toFixed(1) : Math.round(number)} mi`;
  }

  function transportLabel(property) {
    const commute = property.commuteInfo || {};
    const transport = property.transportInfo || {};
    const commuteReady = commute.status === 'matched' && commute.minutes !== null && commute.minutes !== undefined;
    const transportReady = ['matched', 'partial'].includes(transport.status) && transport.score !== null && transport.score !== undefined;

    if (commuteReady || transportReady) {
      const parts = [];
      if (commuteReady) parts.push(`QMC ${Math.round(commute.minutes)} min`);
      if (transportReady) parts.push(`Transport ${Math.round(transport.score)}/100`);
      return { className: transport.status === 'partial' ? 'partial' : 'matched', text: parts.join(' · ') };
    }
    if (commute.status === 'needs_location' || transport.status === 'needs_location') {
      return { className: 'review', text: 'Transport waiting for location' };
    }
    if (commute.status === 'error' && transport.status === 'error') {
      return { className: 'error', text: 'Transport lookup unavailable' };
    }
    return { className: 'pending', text: 'Transport lookup pending' };
  }

  function decorateLeaderboard() {
    document.querySelectorAll('.property-row').forEach(row => {
      const detailButton = row.querySelector('[data-detail]');
      if (!detailButton || row.querySelector('.transport-inline')) return;
      const property = state.properties.find(item => item.id === detailButton.dataset.detail);
      if (!property || property.demo) return;
      const target = row.querySelector('.property-title');
      if (!target) return;
      const label = transportLabel(property);
      const badge = document.createElement('span');
      badge.className = `transport-inline ${label.className}`;
      badge.textContent = label.text;
      target.appendChild(badge);
    });
  }

  if (typeof renderDashboard === 'function') {
    const originalRenderDashboard = renderDashboard;
    renderDashboard = function transportRenderDashboard(...args) {
      const result = originalRenderDashboard.apply(this, args);
      decorateLeaderboard();
      return result;
    };
  }

  function renderTransportDetail(property) {
    if (!property || property.demo) return '';
    const commute = property.commuteInfo || { status: 'pending' };
    const transport = property.transportInfo || { status: 'pending' };
    const raw = transport.raw || {};
    const commuteReady = commute.status === 'matched' && commute.minutes !== null && commute.minutes !== undefined;
    const transportReady = ['matched', 'partial'].includes(transport.status) && transport.score !== null && transport.score !== undefined;

    if (commuteReady || transportReady) {
      const score = transportReady ? Math.round(transport.score) : '—';
      const nearestRail = transport.nearestRailName
        ? `${escapeHtml(transport.nearestRailName)} · ${miles(transport.nearestRailMiles)}`
        : '—';
      const busStops = transport.busStopsHalfMile !== null && transport.busStopsHalfMile !== undefined
        ? Math.round(transport.busStopsHalfMile)
        : null;
      const busText = transport.nearestBusMiles !== null && transport.nearestBusMiles !== undefined
        ? `${miles(transport.nearestBusMiles)}${busStops !== null ? ` · ${busStops} stop locations ≤0.5 mi` : ''}`
        : '—';

      return `
        <section class="transport-detail-card ${escapeHtml(transport.status || commute.status || 'matched')}">
          <div class="transport-detail-heading">
            <div><p class="eyebrow">AUTOMATIC TRANSPORT DATA</p><h3>Commute & transport</h3></div>
            <span class="transport-score">${score === '—' ? '—' : `${score}/100`}</span>
          </div>
          <div class="transport-summary-grid">
            <div><small>QMC drive</small><strong>${commuteReady ? `${Math.round(commute.minutes)} min` : '—'}</strong></div>
            <div><small>Commute score</small><strong>${commute.score !== null && commute.score !== undefined ? `${Math.round(commute.score)}/100` : '—'}</strong></div>
            <div><small>Nearest rail</small><strong>${nearestRail}</strong></div>
            <div><small>Bus access</small><strong>${busText}</strong></div>
          </div>
          <div class="transport-panels">
            <div class="transport-panel">
              <small>Drive to Queen's Medical Centre</small>
              <strong>${commuteReady ? `${Math.round(commute.minutes)} minutes · ${miles(commute.distanceMiles)}` : 'Route unavailable'}</strong>
              <p class="muted">${escapeHtml(commute.destination || "Queen's Medical Centre, Nottingham")}</p>
            </div>
            <div class="transport-panel">
              <small>Public transport access</small>
              <strong>${transportReady ? `${Math.round(transport.score)}/100` : 'Access score unavailable'}</strong>
              <p class="muted">${raw?.publicTransport?.formula ? escapeHtml(raw.publicTransport.formula) : 'Rail proximity, nearest bus stop and nearby bus-stop choice.'}</p>
            </div>
          </div>
          <p class="muted transport-footnote">QMC drive time uses OSRM/OpenStreetMap routing and does not include live traffic. Public transport access uses Department for Transport NaPTAN stop locations. V1.1 uses national rail data and deduplicates bus boarding points by stop name; it measures access, not service frequency, punctuality or public-transport journey times.</p>
          <button class="ghost transport-retry" type="button" data-transport-retry="${property.id}">Refresh transport data</button>
        </section>`;
    }

    const status = commute.status === 'error' && transport.status === 'error'
      ? 'error'
      : commute.status === 'needs_location' || transport.status === 'needs_location'
        ? 'needs_location'
        : 'pending';
    const messages = {
      pending: 'This property is waiting for its first QMC commute and public-transport access lookup.',
      needs_location: 'House Ranker needs a full postcode or coordinates before it can calculate commute and transport scores.',
      error: 'The transport lookup could not complete. The property remains saved and can be retried.'
    };

    return `
      <section class="transport-detail-card ${status}">
        <p class="eyebrow">AUTOMATIC TRANSPORT DATA</p>
        <h3>${status === 'needs_location' ? 'Waiting for location' : status === 'error' ? 'Transport lookup unavailable' : 'Transport lookup pending'}</h3>
        <p class="muted">${messages[status]}</p>
        <button class="ghost transport-retry" type="button" data-transport-retry="${property.id}">Try transport lookup again</button>
      </section>`;
  }

  function injectTransportDetail(propertyId) {
    const detail = document.getElementById('propertyDetail');
    if (!detail || detail.querySelector('.transport-detail-card')) return;
    const property = state.properties.find(item => item.id === propertyId);
    if (!property || property.demo) return;
    const anchor = detail.querySelector('.connectivity-detail-card')
      || detail.querySelector('.flood-detail-card')
      || detail.querySelector('.schools-detail-card')
      || detail.querySelector('.crime-detail-card')
      || detail.querySelector('.epc-detail-card');
    const breakdown = detail.querySelector('.breakdown');
    if (anchor) anchor.insertAdjacentHTML('afterend', renderTransportDetail(property));
    else if (breakdown) breakdown.insertAdjacentHTML('afterend', renderTransportDetail(property));
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

  async function enrichPropertyTransport(propertyId, { quiet = false } = {}) {
    if (!cloud.client || !cloud.session) {
      if (!quiet) toast('Sign in to run automatic transport scoring');
      return { ok: false, code: 'SIGNED_OUT' };
    }

    attempted.add(propertyId);
    if (!quiet) toast('Checking QMC commute and public transport access…');

    const { data, error } = await cloud.client.functions.invoke('transport-enrich', {
      body: { propertyId }
    });

    if (error) {
      const payload = await parseFunctionError(error);
      if (!quiet) toast(`Transport lookup failed: ${payload.detail || payload.error || error.message || 'unknown error'}`);
      return { ok: false, code: 'FUNCTION_ERROR', error };
    }

    let property = replaceProperty(data?.property);
    if (!property) property = state.properties.find(item => item.id === propertyId) || null;

    if (!quiet) {
      if (['matched', 'partial'].includes(data?.status)) {
        const commuteText = data.commuteMinutes !== null && data.commuteMinutes !== undefined ? `QMC ${Math.round(data.commuteMinutes)} min` : 'QMC unavailable';
        const transportText = data.transportScore !== null && data.transportScore !== undefined ? `transport ${Math.round(data.transportScore)}/100` : 'transport unavailable';
        toast(`${commuteText} · ${transportText}`);
      } else if (data?.status === 'needs_location') {
        toast('Transport scoring is waiting for a full postcode or property coordinates');
      } else if (data?.status === 'already_running') {
        toast('Transport lookup is already running');
      }
    }
    return { ok: true, status: data?.status, property };
  }

  async function hydrateTransportMetadata() {
    if (!cloud.client || !cloud.session) return;

    const [propertyResult, areaResult] = await Promise.all([
      cloud.client.from('properties').select('id,commute_status,commute_score,commute_minutes,commute_distance_miles,commute_destination,commute_enriched_at,transport_status,transport_score,transport_nearest_rail_name,transport_nearest_rail_miles,transport_nearest_bus_miles,transport_bus_stops_half_mile,transport_enriched_at,metrics,postcode,latitude,longitude'),
      cloud.client.from('area_metrics').select('property_id,transport_score,raw_data')
    ]);

    if (propertyResult.error) return;
    const areaById = new Map((areaResult.data || []).map(row => [row.property_id, row]));

    for (const row of propertyResult.data || []) {
      const property = state.properties.find(item => item.id === row.id);
      if (!property) continue;
      const data = transportFromRow(row);
      property.commuteInfo = data.commute;
      property.transportInfo = data.transport;
      property.commute = numberOrNull(row.commute_minutes) ?? property.commute ?? 0;
      property.metrics = { ...(property.metrics || {}), ...(row.metrics || {}) };
      property.postcode = row.postcode || property.postcode || '';
      property.latitude = numberOrNull(row.latitude);
      property.longitude = numberOrNull(row.longitude);
      property.transportInfo.raw = areaById.get(row.id)?.raw_data?.transport || null;
    }
    renderDashboard();
  }

  function isStale(info) {
    const dates = [info?.commuteInfo?.enrichedAt, info?.transportInfo?.enrichedAt].filter(Boolean);
    if (!dates.length) return false;
    const oldest = Math.min(...dates.map(value => new Date(value).getTime()).filter(Number.isFinite));
    return Number.isFinite(oldest) && Date.now() - oldest > 30 * 24 * 60 * 60 * 1000;
  }

  async function autoEnrichPending() {
    if (!cloud.session || !cloud.client) return;
    await hydrateTransportMetadata();
    const candidates = state.properties.filter(property => {
      if (property.demo || attempted.has(property.id)) return false;
      const commuteStatus = property.commuteInfo?.status || 'pending';
      const transportStatus = property.transportInfo?.status || 'pending';
      if (commuteStatus === 'pending' || transportStatus === 'pending') return true;
      if ((commuteStatus === 'needs_location' || transportStatus === 'needs_location') && (property.postcode || (property.latitude !== null && property.longitude !== null))) return true;
      if ((commuteStatus === 'matched' || transportStatus === 'matched' || transportStatus === 'partial') && isStale(property)) return true;
      return false;
    });

    for (const property of candidates.slice(0, 1)) {
      const result = await enrichPropertyTransport(property.id, { quiet: true });
      if (!result.ok) break;
    }
    await hydrateTransportMetadata();
  }

  function updateFormCopy() {
    const scoringText = document.querySelector('#propertyForm .form-section:nth-of-type(2) .muted');
    if (scoringText) scoringText.textContent = 'Energy, Crime, Schools, Flood, Connectivity, Commute and Transport are automatic after enrichment. The remaining 0–100 inputs are manual fallbacks until their live sources are added.';
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) setTimeout(() => injectTransportDetail(detailButton.dataset.detail), 100);

    const retry = event.target.closest?.('[data-transport-retry]');
    if (retry) {
      event.preventDefault();
      attempted.delete(retry.dataset.transportRetry);
      enrichPropertyTransport(retry.dataset.transportRetry).then(async () => {
        await hydrateTransportMetadata();
        const detailId = retry.dataset.transportRetry;
        const detail = document.getElementById('propertyDetail');
        if (detail) {
          detail.querySelector('.transport-detail-card')?.remove();
          injectTransportDetail(detailId);
        }
      });
    }
  });

  const form = document.getElementById('propertyForm');
  if (form) {
    form.addEventListener('submit', () => {
      setTimeout(() => autoEnrichPending(), 10500);
      setTimeout(() => autoEnrichPending(), 26000);
    }, true);
  }

  updateFormCopy();
  setTimeout(() => autoEnrichPending(), 4500);
  setTimeout(() => autoEnrichPending(), 17000);

  window.houseRankerTransport = {
    enrich: enrichPropertyTransport,
    hydrate: hydrateTransportMetadata,
    autoEnrich: autoEnrichPending
  };
})();