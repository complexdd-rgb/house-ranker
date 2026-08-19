const STORAGE = {
  properties: 'house-ranker-properties-v1',
  weights: 'house-ranker-weights-v1',
  rules: 'house-ranker-rules-v1'
};

const CATEGORIES = [
  ['value', 'Price & value'],
  ['property', 'Property'],
  ['commute', 'Commute'],
  ['schools', 'Schools'],
  ['crime', 'Crime & safety'],
  ['amenities', 'Amenities'],
  ['transport', 'Transport'],
  ['environment', 'Environment'],
  ['energy', 'Energy']
];

const OBJECTIVE_WEIGHTS = {
  value: 25,
  property: 20,
  commute: 15,
  schools: 10,
  crime: 10,
  amenities: 7,
  transport: 5,
  environment: 5,
  energy: 3
};

const DEFAULT_WEIGHTS = { ...OBJECTIVE_WEIGHTS };
const DEFAULT_RULES = {
  maxBudget: 350000,
  minBedrooms: 3,
  maxCommute: 35,
  avoidHighFlood: true,
  requireParking: true
};

const DEMO_PROPERTIES = [
  {
    id: crypto.randomUUID(), demo: true,
    address: 'Demo House A · West Nottingham', listingUrl: '', price: 325000, bedrooms: 4,
    propertyType: 'Detached', commute: 26, floodRisk: 'low', parking: true,
    metrics: { value: 88, property: 91, commute: 86, schools: 88, crime: 80, amenities: 79, transport: 82, environment: 90, energy: 72 },
    createdAt: new Date().toISOString()
  },
  {
    id: crypto.randomUUID(), demo: true,
    address: 'Demo House B · South Nottingham', listingUrl: '', price: 299950, bedrooms: 3,
    propertyType: 'Semi-detached', commute: 22, floodRisk: 'medium', parking: true,
    metrics: { value: 94, property: 78, commute: 94, schools: 83, crime: 74, amenities: 90, transport: 92, environment: 73, energy: 86 },
    createdAt: new Date().toISOString()
  },
  {
    id: crypto.randomUUID(), demo: true,
    address: 'Demo House C · North Nottingham', listingUrl: '', price: 345000, bedrooms: 4,
    propertyType: 'Detached', commute: 38, floodRisk: 'low', parking: true,
    metrics: { value: 76, property: 95, commute: 63, schools: 93, crime: 91, amenities: 75, transport: 68, environment: 94, energy: 65 },
    createdAt: new Date().toISOString()
  }
];

const state = {
  properties: load(STORAGE.properties, DEMO_PROPERTIES),
  weights: load(STORAGE.weights, DEFAULT_WEIGHTS),
  rules: load(STORAGE.rules, DEFAULT_RULES),
  sortKey: 'yourScore'
};

function load(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function score(metrics, weights) {
  return Math.round(CATEGORIES.reduce((total, [key]) => {
    const metric = Number(metrics[key] ?? 0);
    const weight = Number(weights[key] ?? 0);
    return total + (Math.max(0, Math.min(100, metric)) / 100) * weight;
  }, 0));
}

function propertyScores(property) {
  return {
    houseScore: score(property.metrics, OBJECTIVE_WEIGHTS),
    yourScore: score(property.metrics, state.weights)
  };
}

function dealBreakers(property) {
  const issues = [];
  if (state.rules.maxBudget && property.price > state.rules.maxBudget) {
    issues.push(`£${formatNumber(property.price - state.rules.maxBudget)} over budget`);
  }
  if (state.rules.minBedrooms && property.bedrooms < state.rules.minBedrooms) {
    issues.push(`Only ${property.bedrooms} bedroom${property.bedrooms === 1 ? '' : 's'}`);
  }
  if (state.rules.maxCommute && property.commute > state.rules.maxCommute) {
    issues.push(`${property.commute} min commute`);
  }
  if (state.rules.avoidHighFlood && property.floodRisk === 'high') {
    issues.push('High flood risk');
  }
  if (state.rules.requireParking && !property.parking) {
    issues.push('No off-street parking');
  }
  return issues;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-GB').format(value);
}

function formatPrice(value) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(value);
}

function showView(name) {
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === name));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => showView(button.dataset.go)));

function renderMetricInputs() {
  const root = document.getElementById('metricInputs');
  root.innerHTML = CATEGORIES.map(([key, label]) => `
    <div class="metric-box">
      <label for="metric-${key}"><span>${label}</span><span id="metric-${key}-value" class="metric-value">75</span></label>
      <input id="metric-${key}" data-metric="${key}" type="range" min="0" max="100" value="75" />
    </div>
  `).join('');
  root.querySelectorAll('[data-metric]').forEach(input => {
    input.addEventListener('input', () => document.getElementById(`${input.id}-value`).textContent = input.value);
  });
}

function renderWeightControls() {
  const root = document.getElementById('weightControls');
  root.innerHTML = CATEGORIES.map(([key, label]) => `
    <div class="weight-row">
      <label for="weight-${key}">${label}</label>
      <input id="weight-${key}" data-weight-range="${key}" type="range" min="0" max="40" value="${state.weights[key]}" />
      <input aria-label="${label} weight" data-weight-number="${key}" type="number" min="0" max="100" value="${state.weights[key]}" />
    </div>
  `).join('');

  root.querySelectorAll('[data-weight-range]').forEach(input => input.addEventListener('input', () => syncWeight(input.dataset.weightRange, input.value, 'range')));
  root.querySelectorAll('[data-weight-number]').forEach(input => input.addEventListener('input', () => syncWeight(input.dataset.weightNumber, input.value, 'number')));
  updateWeightTotal();
}

function syncWeight(key, value, source) {
  const clean = Math.max(0, Number(value || 0));
  const range = document.querySelector(`[data-weight-range="${key}"]`);
  const number = document.querySelector(`[data-weight-number="${key}"]`);
  if (source !== 'range') range.value = Math.min(clean, 40);
  if (source !== 'number') number.value = clean;
  updateWeightTotal();
}

function currentFormWeights() {
  return Object.fromEntries(CATEGORIES.map(([key]) => [key, Number(document.querySelector(`[data-weight-number="${key}"]`).value || 0)]));
}

function updateWeightTotal() {
  const total = Object.values(currentFormWeights()).reduce((a, b) => a + b, 0);
  const el = document.getElementById('weightTotal');
  el.textContent = `${total}%`;
  el.classList.toggle('invalid', total !== 100);
}

function renderRules() {
  document.getElementById('maxBudget').value = state.rules.maxBudget || '';
  document.getElementById('minBedrooms').value = state.rules.minBedrooms || '';
  document.getElementById('maxCommute').value = state.rules.maxCommute || '';
  document.getElementById('avoidHighFlood').checked = Boolean(state.rules.avoidHighFlood);
  document.getElementById('requireParking').checked = Boolean(state.rules.requireParking);
}

function sortedProperties() {
  const rows = state.properties.map(property => ({ ...property, ...propertyScores(property) }));
  if (state.sortKey === 'price') return rows.sort((a, b) => a.price - b.price);
  return rows.sort((a, b) => b[state.sortKey] - a[state.sortKey]);
}

function renderDashboard() {
  const rows = sortedProperties();
  const leaderboard = document.getElementById('leaderboard');
  const summary = document.getElementById('summaryGrid');

  if (!rows.length) {
    summary.innerHTML = [
      ['Shortlisted', '0'], ['Best score', '—'], ['Average price', '—'], ['Within budget', '0']
    ].map(([label, value]) => `<div class="panel stat-card"><small>${label}</small><strong>${value}</strong></div>`).join('');
    leaderboard.innerHTML = `<div class="empty-state"><strong>No houses yet.</strong><br>Add your first property to start the ranking.</div>`;
    return;
  }

  const best = [...rows].sort((a,b) => b.yourScore - a.yourScore)[0];
  const averagePrice = Math.round(rows.reduce((sum, p) => sum + p.price, 0) / rows.length);
  const withinBudget = rows.filter(p => !state.rules.maxBudget || p.price <= state.rules.maxBudget).length;
  summary.innerHTML = [
    ['Shortlisted', rows.length],
    ['Best Your Score', `${best.yourScore}/100`],
    ['Average price', formatPrice(averagePrice)],
    ['Within budget', `${withinBudget}/${rows.length}`]
  ].map(([label, value]) => `<div class="panel stat-card"><small>${label}</small><strong>${value}</strong></div>`).join('');

  leaderboard.innerHTML = rows.map((p, index) => {
    const issues = dealBreakers(p);
    return `
      <article class="property-row">
        <div class="rank ${index === 0 ? 'top' : ''}">${index === 0 ? '★' : index + 1}</div>
        <div class="property-title">
          <strong>${escapeHtml(p.address)}</strong>
          <small>${escapeHtml(p.propertyType)} · ${p.bedrooms} bed · ${p.commute} min commute${p.demo ? ' · Demo' : ''}</small>
        </div>
        <div class="price">${formatPrice(p.price)}</div>
        <div class="score-pill"><strong>${p.yourScore}</strong><span>/100</span></div>
        <div class="score-pill secondary"><strong>${p.houseScore}</strong><span>/100</span></div>
        <div class="flags">
          ${issues.length ? issues.slice(0,2).map(issue => `<span class="flag danger">${escapeHtml(issue)}</span>`).join('') : '<span class="flag good">No deal-breakers</span>'}
          ${issues.length > 2 ? `<span class="flag">+${issues.length - 2}</span>` : ''}
        </div>
        <button class="ghost details-btn" data-detail="${p.id}">View breakdown</button>
      </article>
    `;
  }).join('');

  leaderboard.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => openDetail(button.dataset.detail)));
}

function openDetail(id) {
  const property = state.properties.find(p => p.id === id);
  if (!property) return;
  const scores = propertyScores(property);
  const issues = dealBreakers(property);
  const detail = document.getElementById('propertyDetail');
  detail.innerHTML = `
    <div class="detail-head">
      <p class="eyebrow">PROPERTY BREAKDOWN</p>
      <h2>${escapeHtml(property.address)}</h2>
      <p class="muted">${formatPrice(property.price)} · ${escapeHtml(property.propertyType)} · ${property.bedrooms} bedrooms · ${property.commute} min commute</p>
    </div>
    <div class="detail-scores">
      <div class="detail-score"><small>Your Score</small><strong>${scores.yourScore}/100</strong><span class="muted">Using your current weights</span></div>
      <div class="detail-score"><small>House Score</small><strong>${scores.houseScore}/100</strong><span class="muted">Using the fixed V1 baseline</span></div>
    </div>
    <h3>Why it scores this way</h3>
    <div class="breakdown">
      ${CATEGORIES.map(([key, label]) => `
        <div class="breakdown-row">
          <span>${label}</span>
          <div class="bar"><span style="width:${property.metrics[key]}%"></span></div>
          <strong>${property.metrics[key]}</strong>
        </div>
      `).join('')}
    </div>
    <h3>Deal-breaker check</h3>
    <div class="flags">${issues.length ? issues.map(issue => `<span class="flag danger">${escapeHtml(issue)}</span>`).join('') : '<span class="flag good">Passes all current rules</span>'}</div>
    <div class="dialog-actions">
      <div>${property.listingUrl ? `<a class="ghost" href="${escapeAttribute(property.listingUrl)}" target="_blank" rel="noopener">Open listing ↗</a>` : ''}</div>
      <button class="danger-btn" data-delete="${property.id}">Remove property</button>
    </div>
  `;
  detail.querySelector('[data-delete]').addEventListener('click', () => deleteProperty(property.id));
  document.getElementById('propertyDialog').showModal();
}

function deleteProperty(id) {
  state.properties = state.properties.filter(p => p.id !== id);
  save(STORAGE.properties, state.properties);
  document.getElementById('propertyDialog').close();
  renderDashboard();
  toast('Property removed');
}

document.getElementById('closeDialog').addEventListener('click', () => document.getElementById('propertyDialog').close());
document.getElementById('propertyDialog').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

document.querySelectorAll('.sort-btn').forEach(button => button.addEventListener('click', () => {
  state.sortKey = button.dataset.sort;
  document.querySelectorAll('.sort-btn').forEach(btn => btn.classList.toggle('active', btn === button));
  renderDashboard();
}));

document.getElementById('propertyForm').addEventListener('submit', event => {
  event.preventDefault();
  const metrics = Object.fromEntries(CATEGORIES.map(([key]) => [key, Number(document.getElementById(`metric-${key}`).value)]));
  const property = {
    id: crypto.randomUUID(),
    demo: false,
    listingUrl: document.getElementById('listingUrl').value.trim(),
    address: document.getElementById('address').value.trim(),
    price: Number(document.getElementById('price').value),
    bedrooms: Number(document.getElementById('bedrooms').value),
    propertyType: document.getElementById('propertyType').value,
    commute: Number(document.getElementById('commute').value || 0),
    floodRisk: document.getElementById('floodRisk').value,
    parking: document.getElementById('parking').checked,
    metrics,
    createdAt: new Date().toISOString()
  };
  state.properties.push(property);
  save(STORAGE.properties, state.properties);
  event.currentTarget.reset();
  document.getElementById('bedrooms').value = 4;
  document.getElementById('commute').value = 30;
  document.getElementById('parking').checked = true;
  document.querySelectorAll('[data-metric]').forEach(input => {
    input.value = 75;
    document.getElementById(`${input.id}-value`).textContent = '75';
  });
  renderDashboard();
  showView('dashboard');
  toast('House added to your shortlist');
});

document.getElementById('weightsForm').addEventListener('submit', event => {
  event.preventDefault();
  const next = currentFormWeights();
  const total = Object.values(next).reduce((a,b) => a + b, 0);
  if (total !== 100) {
    toast(`Weights currently total ${total}% — make them 100%`);
    return;
  }
  state.weights = next;
  save(STORAGE.weights, state.weights);
  renderDashboard();
  toast('Scoring weights saved');
});

document.getElementById('resetWeights').addEventListener('click', () => {
  state.weights = { ...DEFAULT_WEIGHTS };
  save(STORAGE.weights, state.weights);
  renderWeightControls();
  renderDashboard();
  toast('Weights reset to V1 defaults');
});

document.getElementById('rulesForm').addEventListener('submit', event => {
  event.preventDefault();
  state.rules = {
    maxBudget: Number(document.getElementById('maxBudget').value || 0),
    minBedrooms: Number(document.getElementById('minBedrooms').value || 0),
    maxCommute: Number(document.getElementById('maxCommute').value || 0),
    avoidHighFlood: document.getElementById('avoidHighFlood').checked,
    requireParking: document.getElementById('requireParking').checked
  };
  save(STORAGE.rules, state.rules);
  renderDashboard();
  toast('Deal-breakers saved');
});

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

renderMetricInputs();
renderWeightControls();
renderRules();
renderDashboard();
