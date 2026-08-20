(() => {
  let checkedThisSession = false;
  let refreshingAll = false;

  async function retryLegacyConnectivitySetup() {
    if (checkedThisSession || !cloud?.session || !cloud?.client || !window.houseRankerConnectivity) return;
    checkedThisSession = true;

    await window.houseRankerConnectivity.hydrateConnectivityMetadata();
    const waiting = state.properties.filter(property => !property.demo && property.connectivity?.status === 'needs_api_keys');
    if (!waiting.length) return;

    for (const property of waiting.slice(0, 3)) {
      const result = await window.houseRankerConnectivity.enrichPropertyConnectivity(property.id, { quiet: true });
      if (!result?.ok) break;
    }

    await window.houseRankerConnectivity.hydrateConnectivityMetadata();
  }

  function pct(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${Math.round(n)}%` : '—';
  }

  function cleanDisplayAddress(value) {
    const parts = String(value || '').split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return String(value || '').trim();

    for (let index = 1; index < parts.length; index++) {
      const fullPostcode = parts[index].toUpperCase().replace(/\s+/g, ' ').trim();
      if (!/^[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}$/.test(fullPostcode)) continue;
      const outward = fullPostcode.split(' ')[0];
      if (parts[index - 1].toUpperCase() === outward) {
        parts.splice(index - 1, 1);
      }
      break;
    }

    return parts.join(', ');
  }

  function applyUiPolish() {
    document.querySelectorAll('.property-title strong').forEach(title => {
      const cleaned = cleanDisplayAddress(title.textContent);
      if (cleaned && cleaned !== title.textContent) title.textContent = cleaned;
    });

    const detailTitle = document.querySelector('#propertyDetail .detail-head h2');
    if (detailTitle) {
      const cleaned = cleanDisplayAddress(detailTitle.textContent);
      if (cleaned && cleaned !== detailTitle.textContent) detailTitle.textContent = cleaned;
    }
  }

  function setupUiPolish() {
    if (!document.getElementById('houseRankerUiPolishStyle')) {
      const style = document.createElement('style');
      style.id = 'houseRankerUiPolishStyle';
      style.textContent = `
        .property-row .details-btn{grid-column:2;justify-self:start;white-space:nowrap;width:max-content}
        @media (max-width:680px){.property-row .details-btn{grid-column:2 / -1}}
      `;
      document.head.appendChild(style);
    }

    applyUiPolish();
    ['leaderboard', 'propertyDetail'].forEach(id => {
      const root = document.getElementById(id);
      if (!root || root.dataset.uiPolishObserved === '1') return;
      root.dataset.uiPolishObserved = '1';
      new MutationObserver(() => applyUiPolish()).observe(root, { childList: true, subtree: true });
    });
  }

  function enhanceConnectivityV2Detail(propertyId) {
    const property = state.properties.find(item => item.id === propertyId);
    const connectivity = property?.connectivity;
    const broadband = connectivity?.broadband;
    const mobile = connectivity?.mobile;
    const openData = broadband?.mode === 'open_dataset' || mobile?.mode === 'open_dataset_area';
    if (!openData) return;

    const detail = document.getElementById('propertyDetail');
    const card = detail?.querySelector('.connectivity-detail-card');
    if (!card) return;

    const warning = card.querySelector('.connectivity-warning');
    if (warning) {
      warning.textContent = 'Free Ofcom open data: broadband is postcode-level and mobile is local-authority-level, so this is deliberately shown as a lower-confidence match.';
    }

    const panels = card.querySelectorAll('.connectivity-panel');
    const broadbandPanel = panels[0];
    const mobilePanel = panels[1];

    if (broadbandPanel && broadband?.coverage) {
      const coverage = broadband.coverage;
      const heading = broadbandPanel.querySelector('h4');
      if (heading) heading.textContent = `Gigabit coverage ${pct(coverage.gigabit)}`;
      const facts = broadbandPanel.querySelector('.connectivity-facts');
      if (facts) facts.innerHTML = `
        <span>300+ Mbps availability <b>${pct(coverage.ufbb300)}</b></span>
        <span>100+ Mbps availability <b>${pct(coverage.ufbb100)}</b></span>
        <span>30+ Mbps availability <b>${pct(coverage.sfbb30)}</b></span>
      `;
    }

    if (mobilePanel && mobile?.mode === 'open_dataset_area') {
      const heading = mobilePanel.querySelector('h4');
      if (heading) heading.textContent = `Indoor 4G: ${pct(mobile.indoor4gAnyPct)} with at least one network`;
      const facts = mobilePanel.querySelector('.connectivity-facts');
      if (facts) facts.innerHTML = `
        <span>Indoor 4G from all four networks <b>${pct(mobile.indoor4gAllFourPct)}</b></span>
        <span>Outdoor 5G from at least one network <b>${pct(mobile.outdoor5gAnyPct)}</b></span>
        <span>Mobile area <b>${escapeHtml(mobile.localAuthority?.name || 'Local authority')}</b></span>
      `;
      mobilePanel.querySelector('.connectivity-networks')?.remove();
      mobilePanel.querySelector('.connectivity-empty')?.remove();
    }

    const footnote = card.querySelector('.connectivity-footnote');
    if (footnote) {
      footnote.textContent = 'Source: Ofcom Connected Nations Spring 2026 open data (Open Government Licence). Broadband uses residential postcode availability. Mobile uses local-authority coverage because Ofcom’s free download does not provide address-level mobile results. Connectivity V2 weights postcode broadband 75% and area-level mobile 25%.';
    }
  }

  function enhanceValueV12Detail() {
    const detail = document.getElementById('propertyDetail');
    const card = detail?.querySelector('.value-detail-card');
    if (!card) return;

    const benchmarkLabel = card.querySelector('.value-confidence > div:nth-child(3) small');
    if (benchmarkLabel) benchmarkLabel.textContent = 'Adjusted local benchmark';

    const method = card.querySelector('.value-method');
    if (method) {
      const title = method.querySelector('strong');
      if (title) title.textContent = 'How Price & Value V1.2 is scored';
      const paragraphs = method.querySelectorAll('p.muted');
      if (paragraphs[0]) paragraphs[0].textContent = '80% compares the asking price with HM Land Registry sold-price evidence. V1.2 first prefers same-type sales on the same street and postcode, then widens to nearby postcodes before mixing property types. Suspicious one-off sales are filtered when the surrounding evidence strongly disagrees, EPC floor area is used to adjust comparable prices where available, and recent sales still carry more weight.';
      if (paragraphs[1]) paragraphs[1].textContent = 'The remaining 20% is your saved budget score. When sold-price evidence is thin or mixed, the market score is pulled toward neutral rather than letting a weak comparable set dominate the House Score.';
    }
  }

  const refreshSources = [
    ['EPC & energy', 'epc-enrich'],
    ['Crime', 'crime-enrich'],
    ['Schools', 'schools-enrich'],
    ['Flood', 'flood-enrich'],
    ['Connectivity', 'connectivity-enrich'],
    ['Transport & commute', 'transport-enrich'],
    ['Amenities', 'amenities-enrich'],
    ['Environment', 'environment-enrich'],
    ['Property', 'property-enrich'],
    ['Price & value', 'value-enrich']
  ];

  const refreshRetryDelays = [650, 1600];

  function refreshButton() {
    return document.getElementById('refreshAllData');
  }

  function setRefreshButton(text, disabled = false) {
    const button = refreshButton();
    if (!button) return;
    button.textContent = text;
    button.disabled = disabled;
    button.setAttribute('aria-busy', disabled ? 'true' : 'false');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function invokeRefreshSource(functionName, propertyId) {
    let lastResult = null;

    for (let attempt = 0; attempt <= refreshRetryDelays.length; attempt++) {
      try {
        const result = await cloud.client.functions.invoke(functionName, {
          body: { propertyId }
        });
        lastResult = result;

        const failed = Boolean(result?.error || result?.data?.error || result?.data?.transientError);
        if (!failed) return { ok: true, result, attempts: attempt + 1 };
      } catch (error) {
        lastResult = { error };
      }

      if (attempt < refreshRetryDelays.length) await sleep(refreshRetryDelays[attempt]);
    }

    return { ok: false, result: lastResult, attempts: refreshRetryDelays.length + 1 };
  }

  async function refreshAllData() {
    if (refreshingAll) return;
    if (!cloud?.client || !cloud?.session) {
      toast('Sign in to refresh automatic house data');
      return;
    }

    const properties = state.properties.filter(property => !property.demo);
    if (!properties.length) {
      toast('Add a house before refreshing data');
      return;
    }

    refreshingAll = true;
    const failures = [];
    let completed = 0;
    const total = properties.length * refreshSources.length;
    toast(`Refreshing all data for ${properties.length} house${properties.length === 1 ? '' : 's'}…`);

    try {
      for (let propertyIndex = 0; propertyIndex < properties.length; propertyIndex++) {
        const property = properties[propertyIndex];
        for (const [label, functionName] of refreshSources) {
          setRefreshButton(`↻ ${propertyIndex + 1}/${properties.length} · ${label}`, true);
          const outcome = await invokeRefreshSource(functionName, property.id);
          if (!outcome.ok) failures.push({ propertyId: property.id, label });

          completed += 1;
          if (completed < total) await sleep(180);
        }
      }

      setRefreshButton('↻ Updating leaderboard…', true);
      if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
      else if (typeof renderDashboard === 'function') renderDashboard();
      applyUiPolish();

      if (failures.length) {
        toast(`Refresh finished · ${total - failures.length}/${total} checks updated. ${failures.length} retained their previous data or can be retried later.`);
      } else {
        toast('All house data refreshed');
      }
    } finally {
      refreshingAll = false;
      setRefreshButton('↻ Refresh all data', false);
    }
  }

  function setupRefreshAllButton() {
    const hero = document.querySelector('#dashboard .hero');
    const addButton = hero?.querySelector('[data-go="add"]');
    if (!hero || !addButton || refreshButton()) return;

    const actions = document.createElement('div');
    actions.className = 'hero-refresh-actions';
    addButton.replaceWith(actions);

    const button = document.createElement('button');
    button.id = 'refreshAllData';
    button.className = 'ghost refresh-all-data';
    button.type = 'button';
    button.textContent = '↻ Refresh all data';
    button.title = 'Re-run every automatic data source for all shortlisted houses';
    button.addEventListener('click', refreshAllData);

    actions.append(button, addButton);

    if (!document.getElementById('refreshAllDataStyle')) {
      const style = document.createElement('style');
      style.id = 'refreshAllDataStyle';
      style.textContent = `
        .hero-refresh-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}
        .refresh-all-data{min-width:150px}
        .refresh-all-data[disabled]{opacity:.68;cursor:wait}
        @media (max-width:720px){.hero-refresh-actions{width:100%;justify-content:stretch}.hero-refresh-actions button{flex:1 1 150px}}
      `;
      document.head.appendChild(style);
    }
  }

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) {
      setTimeout(() => applyUiPolish(), 50);
      setTimeout(() => enhanceConnectivityV2Detail(detailButton.dataset.detail), 700);
      setTimeout(() => enhanceConnectivityV2Detail(detailButton.dataset.detail), 1800);
      setTimeout(() => enhanceValueV12Detail(), 900);
      setTimeout(() => enhanceValueV12Detail(), 1900);
    }

    const retry = event.target.closest?.('[data-connectivity-retry]');
    if (retry) {
      [5000, 15000, 30000].forEach(delay => setTimeout(() => enhanceConnectivityV2Detail(retry.dataset.connectivityRetry), delay));
    }

    const valueRetry = event.target.closest?.('[data-value-retry]');
    if (valueRetry) {
      [3000, 8000, 15000].forEach(delay => setTimeout(() => enhanceValueV12Detail(), delay));
    }
  });

  setupRefreshAllButton();
  setupUiPolish();
  setTimeout(() => setupRefreshAllButton(), 1200);
  setTimeout(() => setupUiPolish(), 1200);
  setTimeout(() => retryLegacyConnectivitySetup(), 12000);
  setTimeout(() => retryLegacyConnectivitySetup(), 42000);

  window.houseRankerConnectivityRetry = {
    retryLegacyConnectivitySetup,
    enhanceConnectivityV2Detail,
    enhanceValueV12Detail,
    applyUiPolish,
    refreshAllData
  };
})();
