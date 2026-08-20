(() => {
  let checkedThisSession = false;

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

  document.addEventListener('click', event => {
    const detailButton = event.target.closest?.('[data-detail]');
    if (detailButton) {
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

  setTimeout(() => retryLegacyConnectivitySetup(), 12000);
  setTimeout(() => retryLegacyConnectivitySetup(), 42000);

  window.houseRankerConnectivityRetry = { retryLegacyConnectivitySetup, enhanceConnectivityV2Detail, enhanceValueV12Detail };
})();
