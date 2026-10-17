import { CORRIDOR, loadZones, readCache, isFresh } from './guardrails.js';
import { fetchWaze, demoPolice, ageText } from './police.js';
import { haversine, bearing, angleDiff } from './geo.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('evader.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('evader.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const settings = { feedUrl: store.get('feedUrl', ''), alertPolice: store.get('alertPolice', 3) };
const { south, west, north, east } = CORRIDOR.bbox;

// ---- Map ---------------------------------------------------------------
const map = L.map('map', { zoomControl: false }).setView([(south + north) / 2, (west + east) / 2], 11);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const zoneLayer = L.layerGroup().addTo(map);
const policeLayer = L.layerGroup().addTo(map);
let me = null, meMarker = null, accCircle = null, follow = true;
let zones = [], police = [], simTimer = null;

const meIcon = (heading) => L.divIcon({
  className: 'me', iconSize: [28, 28], iconAnchor: [14, 14],
  html: `<div class="me-arrow" style="transform:rotate(${heading ?? 0}deg)${heading == null ? ';opacity:.5' : ''}"></div>`,
});

// ---- Guardrail zones ---------------------------------------------------
function drawZones() {
  zoneLayer.clearLayers();
  for (const z of zones) {
    const ll = z.path.map((p) => [p.lat, p.lon]);
    L.polyline(ll, { color: '#fff', weight: 11, opacity: 0.9 }).addTo(zoneLayer);
    L.polyline(ll, { color: '#ff7a00', weight: 7, opacity: 0.95 })
      .bindTooltip(`Guardrail both sides · ${(z.length / 1609.34).toFixed(2)} mi · ${compass(z.bearing)}bound`)
      .addTo(zoneLayer);
  }
  $('zoneCount').textContent = zones.length;
}
const compass = (b) => ['North', 'East', 'South', 'West'][Math.round(b / 90) % 4];

async function initZones() {
  const cached = readCache();
  if (cached) { zones = cached.zones; drawZones(); setStatus(`Zones: cached ${new Date(cached.fetchedAt).toLocaleDateString()}`); simRoads = cached.roads; }
  if (isFresh(cached)) return;
  setStatus(cached ? 'Zones: refreshing…' : 'Zones: loading from OpenStreetMap…');
  try {
    const r = await loadZones();
    zones = r.zones; simRoads = r.roads; drawZones();
    setStatus(`Zones: ${zones.length} found (${r.railCount} rails mapped${r.usedExitNodes ? '' : ', exit bounds approx.'})`);
  } catch (e) {
    setStatus(cached ? 'Zones: offline, using cache' : `Zones failed: ${e.message}`, !cached);
  }
}

// ---- Police ------------------------------------------------------------
function drawPolice() {
  policeLayer.clearLayers();
  for (const p of police) {
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: 'cop', iconSize: [30, 30], iconAnchor: [15, 15], html: '<span>🚔</span>' }),
    }).bindPopup(`<b>Police ${p.subtype}</b><br>${ageText(p.ts)} · ${p.source}`).addTo(policeLayer);
  }
  $('copCount').textContent = police.length;
}

async function refreshPolice() {
  try {
    if (settings.feedUrl) {
      const b = map.getBounds();
      police = await fetchWaze(settings.feedUrl, { north: b.getNorth(), south: b.getSouth(), west: b.getWest(), east: b.getEast() });
      $('copSource').textContent = 'Waze feed';
    } else {
      police = demoPolice();
      $('copSource').textContent = 'DEMO data';
    }
  } catch (e) {
    $('copSource').textContent = `feed error: ${e.message}`;
  }
  drawPolice(); updateHud();
}

// ---- Position + HUD ----------------------------------------------------
function setPosition(lat, lon, heading, speed, acc) {
  const prev = me;
  // Derive heading from movement when the device doesn't report one.
  if (heading == null && prev && haversine(prev, { lat, lon }) > 5) heading = bearing(prev, { lat, lon });
  me = { lat, lon, heading: heading ?? prev?.heading ?? null, speed };
  if (!meMarker) meMarker = L.marker([lat, lon], { icon: meIcon(me.heading), zIndexOffset: 1000 }).addTo(map);
  else { meMarker.setLatLng([lat, lon]); meMarker.setIcon(meIcon(me.heading)); }
  if (acc) (accCircle ||= L.circle([lat, lon], { radius: acc, weight: 1, fillOpacity: 0.08 }).addTo(map)).setLatLng([lat, lon]).setRadius(acc);
  if (follow) map.setView([lat, lon], Math.max(map.getZoom(), 14), { animate: true });
  updateHud();
}

function ahead(p) {
  const d = haversine(me, p);
  if (me.heading == null) return { d, ok: true };
  return { d, ok: angleDiff(me.heading, bearing(me, p)) < 75 };
}

function updateHud() {
  if (!me) return;
  $('speed').textContent = me.speed != null ? Math.round(me.speed * 2.23694) : '--';

  let msg = null, level = '';
  // Guardrail zones: only ones travelling the same way as us.
  let best = null;
  for (const z of zones) {
    if (me.heading != null && angleDiff(me.heading, z.bearing) > 60) continue;
    for (let i = 0; i < z.path.length; i += 2) {
      const a = ahead(z.path[i]);
      if (!a.ok && a.d > 40) continue;
      if (!best || a.d < best.d) best = { d: a.d, z };
    }
  }
  if (best) {
    if (best.d < 40) { msg = `In guardrail zone (${(best.z.length / 1609.34).toFixed(1)} mi)`; level = 'zone'; }
    else if (best.d < 3000) { msg = `Guardrail zone ahead · ${fmtDist(best.d)}`; level = 'zone'; }
  }
  // Police: nearest ahead within alert radius takes priority.
  let cop = null;
  for (const p of police) {
    const a = ahead(p);
    if (a.ok && a.d <= settings.alertPolice * 1000 && (!cop || a.d < cop.d)) cop = { d: a.d, p };
  }
  if (cop) { msg = `🚔 Police ${cop.p.subtype} ahead · ${fmtDist(cop.d)} · ${ageText(cop.p.ts)}`; level = 'cop'; }

  const el = $('alert');
  el.hidden = !msg; el.textContent = msg || ''; el.className = 'alert ' + level;
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1609.34).toFixed(1)} mi`);

// ---- GPS + drive simulator ---------------------------------------------
let watchId = null, simRoads = null;
function startGps() {
  if (!('geolocation' in navigator)) return setStatus('Geolocation unavailable', true);
  watchId = navigator.geolocation.watchPosition(
    (p) => setPosition(p.coords.latitude, p.coords.longitude, Number.isFinite(p.coords.heading) ? p.coords.heading : null, p.coords.speed, p.coords.accuracy),
    (e) => setStatus(`GPS: ${e.message}`, true),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
}

function simPath() {
  // Stitch eastbound ways west→east; fall back to a straight line across the corridor.
  const ways = (simRoads || []).filter((r) => r.nodes[r.nodes.length - 1].lon > r.nodes[0].lon)
    .sort((a, b) => a.nodes[0].lon - b.nodes[0].lon);
  const pts = [];
  for (const w of ways) for (const n of w.nodes) if (!pts.length || n.lon > pts[pts.length - 1].lon) pts.push(n);
  const [w0, e0] = CORRIDOR.fallbackClipLon;
  return pts.length > 10 ? pts : [{ lat: 30.725, lon: w0 }, { lat: 30.725, lon: e0 }];
}

function toggleSim() {
  if (simTimer) { clearInterval(simTimer); simTimer = null; $('sim').classList.remove('on'); startGps(); return; }
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  const path = simPath(), speedMps = 31; // ~70 mph
  let i = 0, off = 0;
  $('sim').classList.add('on');
  simTimer = setInterval(() => {
    const a = path[i], b = path[Math.min(i + 1, path.length - 1)];
    const seg = haversine(a, b) || 1;
    off += speedMps * 4; // 4x time-lapse, 1 tick/s
    while (off > seg && i < path.length - 2) { off -= seg; i++; }
    if (i >= path.length - 2 && off > seg) { i = 0; off = 0; }
    const A = path[i], B = path[i + 1], t = Math.min(off / (haversine(A, B) || 1), 1);
    setPosition(A.lat + (B.lat - A.lat) * t, A.lon + (B.lon - A.lon) * t, bearing(A, B), speedMps, null);
  }, 1000);
}

// ---- UI ----------------------------------------------------------------
function setStatus(t, err = false) { const s = $('status'); s.textContent = t; s.classList.toggle('err', err); }

$('follow').onclick = () => { follow = !follow; $('follow').classList.toggle('on', follow); if (follow && me) map.setView([me.lat, me.lon], 15); };
map.on('dragstart', () => { follow = false; $('follow').classList.remove('on'); });
$('follow').classList.add('on');
$('corridor').onclick = () => { follow = false; $('follow').classList.remove('on'); map.fitBounds([[south, west], [north, east]]); };
$('sim').onclick = toggleSim;
$('toggleZones').onchange = (e) => (e.target.checked ? zoneLayer.addTo(map) : map.removeLayer(zoneLayer));
$('togglePolice').onchange = (e) => (e.target.checked ? policeLayer.addTo(map) : map.removeLayer(policeLayer));

const dlg = $('settings');
$('openSettings').onclick = () => { $('feedUrl').value = settings.feedUrl; $('alertPolice').value = settings.alertPolice; dlg.showModal(); };
$('saveSettings').onclick = () => {
  settings.feedUrl = $('feedUrl').value.trim(); settings.alertPolice = Number($('alertPolice').value) || 3;
  store.set('feedUrl', settings.feedUrl); store.set('alertPolice', settings.alertPolice);
  refreshPolice();
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

initZones();
refreshPolice();
setInterval(refreshPolice, 45000);
startGps();
