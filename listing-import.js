(() => {
  const imports = new Map();
  let busy = false;

  const canon = value => {
    try { const u = new URL(String(value || '').trim()); u.hash = ''; u.search = ''; return u.toString().replace(/\/$/, ''); }
    catch { return String(value || '').trim(); }
  };

  const rightmove = value => {
    try { const u = new URL(String(value || '').trim()); return /(^|\.)rightmove\.co\.uk$/i.test(u.hostname) && /\/properties\/\d+/.test(u.pathname); }
    catch { return false; }
  };

  const num = value => value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  const bandScore = band => ({ A:95, B:85, C:72, D:60, E:47, F:32, G:15 })[String(band || '').toUpperCase()] ?? null;

  function status(message, tone = '') {
    const el = document.getElementById('listingImportStatus');
    if (el) { el.textContent = message; el.dataset.tone = tone; }
  }

  function setValue(id, value) {
    if (value === null || value === undefined || value === '') return;
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
  }

  function populate(listing) {
    setValue('address', listing.address);
    setValue('postcode', listing.postcode);
    setValue('price', listing.price);
    setValue('bedrooms', listing.bedrooms);

    const type = document.getElementById('propertyType');
    if (type && listing.propertyType) {
      const option = [...type.options].find(o => o.value.toLowerCase() === String(listing.propertyType).toLowerCase());
      if (option) type.value = option.value;
    }

    const parking = document.getElementById('parking');
    if (parking && listing.parking !== null && listing.parking !== undefined) parking.checked = Boolean(listing.parking);

    const energy = num(listing.advertisedEpcRating) ?? bandScore(listing.advertisedEpcBand);
    if (energy !== null) setValue('metric-energy', Math.round(energy));

    const bits = [];
    if (listing.postcode) bits.push(listing.postcode);
    if (listing.bathrooms !== null && listing.bathrooms !== undefined) bits.push(`${listing.bathrooms} bathrooms`);
    if (listing.tenure) bits.push(String(listing.tenure).toLowerCase());
    if (listing.councilTaxBand) bits.push(`council tax ${listing.councilTaxBand}`);
    if (listing.floorAreaM2) bits.push(`${Math.round(Number(listing.floorAreaM2))} m²`);
    status(`Imported${bits.length ? ` · ${bits.join(' · ')}` : ''}`, 'success');
  }

  async function importListing({ quiet = false } = {}) {
    const input = document.getElementById('listingUrl');
    const url = input?.value?.trim() || '';
    if (busy || !rightmove(url)) return null;
    if (!cloud?.client || !cloud?.session) {
      status('Sign in first, then paste the Rightmove link again.', 'warning');
      if (!quiet) toast('Sign in to import Rightmove listings');
      return null;
    }

    busy = true;
    status('Reading the Rightmove advert…', 'working');
    const button = document.getElementById('listingImportButton');
    if (button) button.disabled = true;

    try {
      const { data, error } = await cloud.client.functions.invoke('listing-import', { body: { url } });
      if (error || !data?.listing) {
        let detail = error?.message || 'Could not read this listing';
        try { detail = (await error?.context?.clone?.().json())?.error || detail; } catch {}
        status(detail, 'error');
        if (!quiet) toast(`Rightmove import failed: ${detail}`);
        return null;
      }

      const listing = data.listing;
      imports.set(canon(url), listing);
      if (listing.url) imports.set(canon(listing.url), listing);
      if (input && listing.url) input.value = listing.url;
      populate(listing);
      if (!quiet) toast('Rightmove details imported');
      return listing;
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  }

  if (typeof toDbProperty === 'function') {
    const base = toDbProperty;
    toDbProperty = function(property, userId) {
      const row = base(property, userId);
      const listing = imports.get(canon(property.listingUrl));
      if (!listing) return row;
      Object.assign(row, {
        listing_source: listing.source || 'rightmove',
        listing_id: listing.listingId || null,
        bathrooms: num(listing.bathrooms),
        tenure: listing.tenure || null,
        council_tax_band: listing.councilTaxBand || null,
        latitude: num(listing.latitude),
        longitude: num(listing.longitude),
        garden: listing.garden ?? null,
        listing_data: listing,
        listing_imported_at: new Date().toISOString()
      });
      if (listing.floorAreaM2) row.floor_area_m2 = num(listing.floorAreaM2);
      if (listing.postcode) row.postcode = listing.postcode;
      return row;
    };
  }

  if (typeof fromDbProperty === 'function') {
    const base = fromDbProperty;
    fromDbProperty = function(row) {
      const property = base(row);
      property.listing = row.listing_data || {};
      return property;
    };
  }

  function setup() {
    const input = document.getElementById('listingUrl');
    if (!input || document.getElementById('listingImportControls')) return;
    input.placeholder = 'Paste a Rightmove property URL';
    const controls = document.createElement('div');
    controls.id = 'listingImportControls';
    controls.innerHTML = '<button id="listingImportButton" class="ghost" type="button">Import listing</button><span id="listingImportStatus">Paste a Rightmove link and the advert details will fill automatically.</span>';
    input.insertAdjacentElement('afterend', controls);
    document.getElementById('listingImportButton').addEventListener('click', () => importListing());
    input.addEventListener('paste', () => setTimeout(() => importListing({ quiet:true }), 40));
    input.addEventListener('change', () => importListing({ quiet:true }));
    const heading = document.querySelector('#add .page-heading .muted');
    if (heading) heading.textContent = 'Paste a Rightmove URL. House Ranker will pull the advert details and then enrich it with official data.';
  }

  const style = document.createElement('style');
  style.textContent = '#listingImportControls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}#listingImportStatus{font-size:.82rem;color:var(--muted,#8792a6)}#listingImportStatus[data-tone="success"]{color:#73d7a5}#listingImportStatus[data-tone="warning"]{color:#e5bd68}#listingImportStatus[data-tone="error"]{color:#f08b8b}#listingImportStatus[data-tone="working"]{color:#9db8ff}';
  document.head.appendChild(style);
  setup();
  window.houseRankerImportListing = importListing;
})();
