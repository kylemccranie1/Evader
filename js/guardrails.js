import { findBothSidesZones } from './geo.js';

// Corridor: I-10 from Holt (exit 56) to DeFuniak Springs (exit 85, US-331), Florida panhandle.
export const CORRIDOR = {
  bbox: { south: 30.66, west: -86.76, north: 30.78, east: -86.08 },
  // Fallback clip if the exit nodes can't be found in OSM; roughly the two interchanges.
  fallbackClipLon: [-86.7225, -86.1160],
  exits: ['56', '85'],
};

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];
const CACHE_KEY = 'evader.zones.v1';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const ATTEMPT_TIMEOUT_MS = 45000;

// Only fetch guardrails within 40 m of I-10 (not the whole bbox): far lighter for public
// Overpass servers, which reject or time out heavy queries.
function query({ south, west, north, east }) {
  const b = `${south},${west},${north},${east}`;
  return `[out:json][timeout:40];
way["highway"="motorway"]["ref"~"(^|;)I[ -]?10($|;)"](${b})->.road;
.road out geom;
way["barrier"="guard_rail"](around.road:40);out geom;
node["highway"="motorway_junction"]["ref"~"^(${CORRIDOR.exits.join('|')})$"](${b});out;`;
}

const host = (url) => new URL(url).hostname;

async function overpassOnce(url, q) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // Overpass can answer 200 with a runtime error and partial/no data.
    if (/runtime error|timed out|out of memory/i.test(json.remark || '')) throw new Error(json.remark);
    return json;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : e.message);
  } finally { clearTimeout(timer); }
}

/** Try each mirror in turn; on total failure the error lists what every server said. */
async function overpass(q) {
  const errors = [];
  for (const url of ENDPOINTS) {
    try { return await overpassOnce(url, q); }
    catch (e) { errors.push(`${host(url)}: ${e.message}`); }
  }
  throw new Error(errors.join(' | '));
}

export function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    return c && c.zones ? c : null;
  } catch { return null; }
}

function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* quota/private mode */ }
}

export function isFresh(c) { return c && Date.now() - c.fetchedAt < MAX_AGE_MS; }

/** Fetch OSM data and compute both-sides guardrail zones. Returns {zones, roads, clipLon, fetchedAt}. */
export async function loadZones() {
  const json = await overpass(query(CORRIDOR.bbox));
  const roads = [], rails = [], junctions = {};
  for (const el of json.elements) {
    if (el.type === 'way' && el.geometry) {
      const nodes = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
      if (el.tags?.barrier === 'guard_rail') rails.push({ nodes });
      else roads.push({ id: el.id, nodes, oneway: el.tags?.oneway === 'yes' });
    } else if (el.type === 'node' && el.tags?.ref) junctions[el.tags.ref] = el;
  }
  if (!roads.length) throw new Error('No I-10 ways returned by Overpass');

  const [a, b] = CORRIDOR.exits.map((r) => junctions[r]?.lon);
  const clipLon = a != null && b != null ? [Math.min(a, b), Math.max(a, b)] : CORRIDOR.fallbackClipLon;

  const zones = findBothSidesZones(roads, rails, { clipLon });
  const result = {
    zones, clipLon, fetchedAt: Date.now(),
    railCount: rails.length, usedExitNodes: a != null && b != null,
    // Kept (thinned) so the drive simulator can follow the real road.
    roads: roads.map((r) => ({ id: r.id, nodes: r.nodes.filter((_, i) => i % 3 === 0 || i === r.nodes.length - 1) })),
  };
  writeCache(result);
  return result;
}
