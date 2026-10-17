// Police-report providers. Each returns [{ id, lat, lon, ts, subtype, source }].
//
// Waze has no open public API for consumers. Real data needs either the Waze for Cities
// (partner) data feed or another feed you are entitled to use. Paste its URL in Settings;
// {top} {bottom} {left} {right} are replaced with the map viewport. Responses in the Waze
// georss shape ({alerts:[{type:'POLICE', location:{x,y}, pubMillis, ...}]}) are understood.

import { CORRIDOR } from './guardrails.js';

export function parseWazeAlerts(json) {
  return (json.alerts || [])
    .filter((a) => a.type === 'POLICE' && a.location)
    .map((a) => ({
      id: a.uuid || `${a.location.y},${a.location.x},${a.pubMillis}`,
      lat: a.location.y, lon: a.location.x,
      ts: a.pubMillis || Date.now(),
      subtype: (a.subtype || 'POLICE_VISIBLE').replace('POLICE_', '').toLowerCase().replace(/_/g, ' '),
      source: 'waze',
    }));
}

export async function fetchWaze(template, bounds) {
  const url = template
    .replace('{top}', bounds.north).replace('{bottom}', bounds.south)
    .replace('{left}', bounds.west).replace('{right}', bounds.east);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
  return parseWazeAlerts(await res.json());
}

// Stable fake reports along the corridor so the UI can be exercised without a feed.
export function demoPolice() {
  const { south, north, west, east } = CORRIDOR.bbox;
  const spots = [0.18, 0.37, 0.52, 0.74, 0.9];
  const now = Date.now();
  return spots.map((f, i) => ({
    id: `demo${i}`,
    lat: (south + north) / 2 - 0.004 + (i % 2) * 0.006,
    lon: west + (east - west) * f,
    ts: now - (i + 1) * 7 * 60 * 1000,
    subtype: ['visible', 'hidden', 'visible', 'hidden', 'visible'][i],
    source: 'demo',
  }));
}

export const ageText = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
