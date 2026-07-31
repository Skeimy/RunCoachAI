/* global Chart, L */

// ── State ──────────────────────────────────────────────────────────────────
let currentSport = 'all';
let allActivities = [];
let weeklyChart = null;
let paceChart = null;
let leafletMap = null;

const SPORT_ICONS = {
  Run: '🏃', Ride: '🚴', Swim: '🏊', Tennis: '🎾', Badminton: '🏸',
};

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupSportFilter();
  setupSyncBtn();
  setupModals();
  setupUpload();
  setupManualForm();
  setupObjectiveForm();
  setupChat();
  registerSW();
  loadAll();
});

async function loadAll() {
  await Promise.all([loadStatus(), loadDashboard(), loadActivities(), loadObjectives()]);
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
    });
  });
}

function goToTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach((c) => {
    c.classList.toggle('active', c.id === `tab-${tab}`);
  });
}

// ── Sport filter ───────────────────────────────────────────────────────────
function setupSportFilter() {
  document.getElementById('sport-filter').addEventListener('change', (e) => {
    currentSport = e.target.value;
    loadDashboard();
    renderActivitiesList();
  });
}

// ── Sync ───────────────────────────────────────────────────────────────────
function setupSyncBtn() {
  document.getElementById('sync-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sync-btn');
    btn.classList.add('spinning');
    try {
      const data = await api('/api/sync', { method: 'POST' });
      document.getElementById('sync-status').textContent =
        `Synced — ${data.added} new ${data.added === 1 ? 'activity' : 'activities'}`;
      await loadAll();
    } catch (err) {
      document.getElementById('sync-status').textContent = `Sync failed: ${err.message}`;
    } finally {
      btn.classList.remove('spinning');
    }
  });
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    const el = document.getElementById('sync-status');
    if (s.lastSync) {
      const d = new Date(s.lastSync);
      el.textContent = `Last sync: ${d.toLocaleString()} · ${s.totalActivities} activities`;
    } else {
      el.textContent = s.garminConfigured
        ? 'Waiting for first sync…'
        : 'Garmin not configured — upload FIT/GPX files';
    }
  } catch {
    document.getElementById('sync-status').textContent = 'Could not load status';
  }
}

// ── Dashboard ──────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const s = await api(`/api/summary?sport=${currentSport}&days=90`);
    renderStats(s);
    renderWeeklyChart(s.weeklyDistances || []);
    renderPaceChart(s.recentActivities || []);
  } catch (err) {
    console.error('Dashboard:', err);
  }
}

function renderStats(s) {
  const grid = document.getElementById('stats-grid');
  if (!s || s.total === 0) {
    grid.innerHTML = `<div class="stat-card empty" style="grid-column:1/-1; text-align:center; padding:24px">
      <span style="font-size:32px">🏃</span>
      <p style="margin-top:8px;color:var(--muted);font-size:14px">No activities yet — sync Garmin or upload a file</p>
    </div>`;
    return;
  }
  grid.innerHTML = `
    ${stat('Activities', s.total, '', '')}
    ${stat('Distance', s.totalDistanceKm, 'km', '')}
    ${s.avgPace ? stat('Avg Pace', s.avgPace, '', '/km') : stat('Time', s.totalTimeHours, 'h', '')}
    ${s.longestActivity ? stat('Longest', s.longestActivity.distanceKm, 'km', s.longestActivity.date) : stat('Avg HR', s.avgHR || '—', s.avgHR ? 'bpm' : '', '')}
  `;
}

function stat(label, value, unit, sub) {
  return `<div class="stat-card">
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}<span class="stat-unit">${unit}</span></div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  </div>`;
}

function renderWeeklyChart(weeks) {
  const canvas = document.getElementById('weekly-chart');
  if (!canvas) return;
  const data = weeks.slice(-10);
  const labels = data.map((w) => `W${w.week.split('-W')[1] || w.week}`);
  const values = data.map((w) => parseFloat(w.km));
  if (weeklyChart) weeklyChart.destroy();
  weeklyChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: '#f97316bb', borderColor: '#f97316', borderWidth: 1, borderRadius: 5 }] },
    options: baseChartOptions('km'),
  });
}

function renderPaceChart(activities) {
  const canvas = document.getElementById('pace-chart');
  if (!canvas) return;
  const runs = activities.filter((a) => a.sport === 'Run' && a.paceMinPerKm).slice(0, 20).reverse();
  if (runs.length === 0) { canvas.parentElement.innerHTML = '<p style="text-align:center;color:var(--text-3);padding:24px;font-size:13px">No run pace data yet</p>'; return; }
  const labels = runs.map((r) => r.date.slice(5));
  const values = runs.map((r) => paceToFloat(r.paceMinPerKm));
  if (paceChart) paceChart.destroy();
  paceChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [{ data: values, borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.08)', tension: 0.3, fill: true, pointRadius: 4, pointBackgroundColor: '#60a5fa' }] },
    options: {
      ...baseChartOptions('min/km'),
      scales: {
        y: {
          reverse: true,
          ticks: { callback: (v) => { const m = Math.floor(v); const s = Math.round((v - m) * 60); return `${m}:${String(s).padStart(2,'0')}`; }, font: { size: 11 }, color: '#64748b' },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        x: { grid: { display: false }, ticks: { font: { size: 11 }, color: '#64748b' } },
      },
    },
  });
}

function baseChartOptions(unit) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#1a2235',
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1,
        titleColor: '#f1f5f9',
        bodyColor: '#94a3b8',
        callbacks: { label: (c) => ` ${c.parsed.y} ${unit}` },
      },
    },
    scales: {
      y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 11 }, color: '#64748b' } },
      x: { grid: { display: false }, ticks: { font: { size: 11 }, color: '#64748b' } },
    },
  };
}

// ── Activities ─────────────────────────────────────────────────────────────
async function loadActivities() {
  try {
    const data = await api(`/api/activities?sport=${currentSport}&days=90`);
    allActivities = data.activities || [];
    renderActivitiesList();
  } catch (err) {
    document.getElementById('activities-list').innerHTML = '<div class="empty"><p>Failed to load activities</p></div>';
  }
}

function renderActivitiesList(filter = '') {
  const container = document.getElementById('activities-list');
  const list = filter
    ? allActivities.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase()))
    : allActivities;

  if (list.length === 0) {
    container.innerHTML = `<div class="empty"><span class="big">${SPORT_ICONS[currentSport] || '🏃'}</span><p>No activities found</p></div>`;
    return;
  }
  container.innerHTML = list.map(activityCard).join('');
  container.querySelectorAll('.activity-card').forEach((card) => {
    card.addEventListener('click', () => openDetail(card.dataset.id));
  });
}

function activityCard(a) {
  const meta = [
    a.durationMin ? `⏱ ${a.durationMin}min` : '',
    a.paceMinPerKm ? `⚡ ${a.paceMinPerKm}/km` : '',
    a.avgHeartrate ? `❤️ ${a.avgHeartrate}bpm` : '',
    a.elevationGainM ? `⛰ ${a.elevationGainM}m` : '',
  ].filter(Boolean);

  return `<div class="activity-card" data-id="${a.id}">
    <div class="activity-sport-icon">${SPORT_ICONS[a.sport] || '🏃'}</div>
    <div class="activity-name">${esc(a.name)}</div>
    <div class="activity-dist">${a.distanceKm ?? a.durationMin + '<small>min</small>'}<small>${a.distanceKm ? ' km' : ''}</small></div>
    <div class="activity-date">${a.date}</div>
    <div class="activity-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
  </div>`;
}

document.getElementById('search-input').addEventListener('input', (e) => {
  renderActivitiesList(e.target.value);
});

// ── Activity Detail ────────────────────────────────────────────────────────
async function openDetail(id) {
  goToTab('detail');
  const container = document.getElementById('detail-content');
  container.innerHTML = '<div class="skeleton" style="height:260px;margin-bottom:14px"></div>';

  try {
    const { activity: a } = await api(`/api/activities/${id}`);
    renderDetail(a);
  } catch {
    container.innerHTML = '<div class="empty"><p>Could not load activity</p></div>';
  }
}

document.getElementById('back-btn').addEventListener('click', () => goToTab('activities'));

function renderDetail(a) {
  const container = document.getElementById('detail-content');

  const stats = [
    { val: a.distanceKm ? `${a.distanceKm} km` : `${a.durationMin} min`, lbl: a.distanceKm ? 'Distance' : 'Duration' },
    { val: a.paceMinPerKm ? `${a.paceMinPerKm}` : (a.avgSpeedKmh ? `${a.avgSpeedKmh}km/h` : '—'), lbl: a.paceMinPerKm ? 'Pace /km' : 'Speed' },
    { val: a.avgHeartrate ? `${a.avgHeartrate}` : '—', lbl: 'Avg HR' },
    { val: a.elevationGainM ? `${a.elevationGainM}m` : '—', lbl: 'Elevation' },
    { val: a.calories ? `${a.calories}` : '—', lbl: 'Calories' },
    { val: a.avgCadence ? `${a.avgCadence}` : '—', lbl: 'Cadence' },
  ];

  container.innerHTML = `
    <h2 style="font-size:18px;font-weight:700;margin-bottom:4px">${esc(a.name)}</h2>
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">${SPORT_ICONS[a.sport] || ''} ${a.sport} · ${a.date}</p>
    ${a.gpxData ? '<div id="detail-map"></div>' : ''}
    <div class="detail-stats">${stats.map((s) => `<div class="detail-stat"><div class="detail-stat-val">${s.val}</div><div class="detail-stat-lbl">${s.lbl}</div></div>`).join('')}</div>
    ${a.notes ? `<div class="chart-card" style="font-size:14px;color:var(--muted)">${esc(a.notes)}</div>` : ''}
  `;

  if (a.gpxData?.coordinates?.length > 1) {
    renderMap(a.gpxData.coordinates);
  }
}

function renderMap(coords) {
  // Destroy existing map instance before creating a new one
  if (leafletMap) { leafletMap.remove(); leafletMap = null; }

  const mapEl = document.getElementById('detail-map');
  if (!mapEl) return;

  const latLngs = coords.map((c) => [c.lat, c.lon]);
  leafletMap = L.map(mapEl, { zoomControl: true, attributionControl: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(leafletMap);

  const route = L.polyline(latLngs, { color: '#f97316', weight: 4, opacity: 0.85 }).addTo(leafletMap);

  // Start (green) and end (red) markers
  L.circleMarker(latLngs[0], { radius: 8, fillColor: '#22c55e', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(leafletMap);
  L.circleMarker(latLngs[latLngs.length - 1], { radius: 8, fillColor: '#ef4444', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(leafletMap);

  leafletMap.fitBounds(route.getBounds(), { padding: [20, 20] });
}

// ── Objectives ─────────────────────────────────────────────────────────────
async function loadObjectives() {
  try {
    const { objectives } = await api('/api/objectives');
    renderObjectives(objectives);
  } catch {
    document.getElementById('objectives-list').innerHTML = '<div class="empty"><p>Failed to load objectives</p></div>';
  }
}

function renderObjectives(list) {
  const container = document.getElementById('objectives-list');
  if (!list || list.length === 0) {
    container.innerHTML = `<div class="obj-empty"><span class="big">🎯</span><p>No objectives yet — add one to track your progress!</p></div>`;
    return;
  }
  container.innerHTML = list.map(objCard).join('');
  container.querySelectorAll('.btn-del-obj').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this objective?')) return;
      await api(`/api/objectives/${btn.dataset.id}`, { method: 'DELETE' });
      loadObjectives();
    });
  });
}

function objCard(o) {
  const pct = Math.min(100, o.progress ?? 0);
  const done = pct >= 100;
  let progressText = '';
  if (o.type === 'distance') progressText = `${o.current} / ${o.target} km`;
  else if (o.type === 'frequency') progressText = `${o.current} / ${o.target} sessions`;
  else if (o.type === 'race') progressText = `Longest: ${o.current} km / ${o.target} km`;
  else if (o.type === 'pace') progressText = `Best: ${o.current || '—'}`;

  return `<div class="obj-card">
    <div class="obj-header">
      <div>
        <div class="obj-title">${esc(o.title)}</div>
        <div class="obj-sport">${SPORT_ICONS[o.sport] || '🏅'} ${o.sport} · ${o.type}</div>
      </div>
      <button class="btn-del-obj" data-id="${o.id}" title="Delete">🗑</button>
    </div>
    <div class="progress-bar-bg">
      <div class="progress-bar-fill ${done ? 'done' : ''}" style="width:${pct}%"></div>
    </div>
    <div class="obj-meta">
      <span>${progressText}</span>
      <span>${done ? '✅ Done!' : pct + '%'}${o.daysLeft !== null ? ` · ${o.daysLeft}d left` : ''}</span>
    </div>
  </div>`;
}

// ── Modals ─────────────────────────────────────────────────────────────────
function setupModals() {
  document.getElementById('open-upload').addEventListener('click', () => openModal('upload-modal'));
  document.getElementById('open-manual').addEventListener('click', () => openModal('manual-modal'));
  document.getElementById('open-add-obj').addEventListener('click', () => openModal('obj-modal'));

  document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.modal));
  });
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Objective type change → show/hide fields
  document.getElementById('obj-type').addEventListener('change', updateObjFields);
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function updateObjFields() {
  const type = document.getElementById('obj-type').value;
  document.getElementById('obj-value-row').classList.toggle('hidden', type === 'race' || type === 'pace');
  document.getElementById('obj-race-row').classList.toggle('hidden', type !== 'race');
  document.getElementById('obj-pace-row').classList.toggle('hidden', type !== 'pace');
  const label = document.getElementById('obj-value-label');
  if (type === 'distance') label.textContent = 'Target (km)';
  if (type === 'frequency') label.textContent = 'Target (sessions)';
}

// ── File upload ────────────────────────────────────────────────────────────
function setupUpload() {
  const zone = document.getElementById('drop-zone');
  const input = document.getElementById('file-input');

  zone.addEventListener('dragover', () => zone.classList.add('drag-over'));
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));

  input.addEventListener('change', () => {
    if (input.files[0]) uploadFile(input.files[0]);
  });
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
}

async function uploadFile(file) {
  const resultEl = document.getElementById('upload-result');
  resultEl.className = 'upload-result';
  resultEl.textContent = 'Uploading…';
  resultEl.classList.remove('hidden');

  const form = new FormData();
  form.append('file', file);

  try {
    const { activity } = await fetch('/api/upload', { method: 'POST', body: form })
      .then((r) => r.json());
    resultEl.className = 'upload-result success';
    resultEl.textContent = `✅ ${activity.name} uploaded successfully!`;
    await loadAll();
    setTimeout(() => closeModal('upload-modal'), 1500);
  } catch (err) {
    resultEl.className = 'upload-result error';
    resultEl.textContent = `❌ Upload failed: ${err.message}`;
  }
}

// ── Manual activity form ───────────────────────────────────────────────────
function setupManualForm() {
  // Default date to today
  document.querySelector('#manual-form [name=date]').valueAsDate = new Date();

  document.getElementById('manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/activities/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      closeModal('manual-modal');
      e.target.reset();
      await loadAll();
    } catch (err) {
      alert(`Failed to save: ${err.message}`);
    }
  });
}

// ── Objective form ─────────────────────────────────────────────────────────
function setupObjectiveForm() {
  document.getElementById('obj-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/objectives', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      closeModal('obj-modal');
      e.target.reset();
      await loadObjectives();
    } catch (err) {
      alert(`Failed to save: ${err.message}`);
    }
  });
}

// ── Chat ───────────────────────────────────────────────────────────────────
function setupChat() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  sendBtn.addEventListener('click', sendChat);

  document.getElementById('clear-chat').addEventListener('click', async () => {
    await api('/api/chat', { method: 'DELETE' });
    document.getElementById('chat-messages').innerHTML = `<div class="chat-welcome">
      <div class="chat-welcome-icon">🤖</div>
      <h3>Conversation cleared</h3>
      <p>Start a new conversation with your AI coach.</p>
    </div>`;
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      input.value = chip.dataset.msg;
      sendChat();
    });
  });
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const msg = input.value.trim();
  if (!msg) return;

  const messages = document.getElementById('chat-messages');
  messages.querySelector('.chat-welcome')?.remove();

  appendMsg(messages, msg, 'user');
  input.value = ''; input.style.height = 'auto';
  sendBtn.disabled = true;

  const typing = document.createElement('div');
  typing.className = 'msg msg-typing';
  typing.textContent = 'Coach is thinking…';
  messages.appendChild(typing);
  scrollBottom(messages);

  try {
    const { reply, locations } = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, sport: currentSport }),
    });
    typing.remove();
    appendMsg(messages, reply, 'ai');
    if (locations && locations.length > 0) {
      appendLocationMap(messages, locations);
    }
  } catch (err) {
    typing.remove();
    appendMsg(messages, `⚠️ ${err.message}`, 'ai');
  } finally {
    sendBtn.disabled = false;
    input.focus();
    scrollBottom(messages);
  }
}

function appendMsg(container, text, role) {
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  div.textContent = text;
  container.appendChild(div);
  scrollBottom(container);
}

// ── Chat location map ──────────────────────────────────────────────────────

let chatMapCounter = 0;
const chatMaps = {};

function appendLocationMap(container, locations) {
  const mapId = `chat-map-${++chatMapCounter}`;

  // Location list HTML
  const listHtml = locations.map((loc, i) => `
    <div class="loc-item">
      <span class="loc-num">${i + 1}</span>
      <div>
        <div class="loc-name">${esc(loc.name)}</div>
        <div class="loc-desc">${esc(loc.description || '')}</div>
      </div>
    </div>
  `).join('');

  const wrapper = document.createElement('div');
  wrapper.className = 'msg-map-bubble';
  wrapper.innerHTML = `
    <div class="loc-list">${listHtml}</div>
    <div class="chat-map-container" id="${mapId}"></div>
  `;
  container.appendChild(wrapper);
  scrollBottom(container);

  // Initialise Leaflet map after the element is in the DOM
  requestAnimationFrame(() => {
    const mapEl = document.getElementById(mapId);
    if (!mapEl || !window.L) return;

    const map = L.map(mapEl, { zoomControl: true, attributionControl: false, scrollWheelZoom: false });
    chatMaps[mapId] = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);

    const markers = [];
    locations.forEach((loc, i) => {
      if (loc.lat == null || loc.lon == null) return;

      // Numbered circle marker
      const icon = L.divIcon({
        className: '',
        html: `<div class="map-pin">${i + 1}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const marker = L.marker([loc.lat, loc.lon], { icon })
        .addTo(map)
        .bindPopup(`<strong>${loc.name}</strong><br>${loc.description || ''}`);
      markers.push(marker);
    });

    // Fit all markers in view
    if (markers.length === 1) {
      map.setView([locations[0].lat, locations[0].lon], 14);
    } else if (markers.length > 1) {
      const group = L.featureGroup(markers);
      map.fitBounds(group.getBounds(), { padding: [24, 24] });
    }
  });
}

function scrollBottom(el) { el.scrollTop = el.scrollHeight; }

// ── PWA ────────────────────────────────────────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paceToFloat(pace) {
  if (!pace) return null;
  const [m, s] = pace.split(':').map(Number);
  return m + s / 60;
}
