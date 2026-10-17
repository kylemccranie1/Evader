// Pure geometry + guardrail-zone detection. No DOM, no network: testable in Node.

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

export function makeProjector(lat0, lon0) {
  const k = Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: (lat, lon) => ({ x: (lon - lon0) * k * M_PER_DEG_LON, y: (lat - lat0) * M_PER_DEG_LAT }),
    toLatLon: (x, y) => ({ lat: lat0 + y / M_PER_DEG_LAT, lon: lon0 + x / (k * M_PER_DEG_LON) }),
  };
}

export function haversine(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Initial bearing in degrees [0,360), clockwise from north.
export function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

export function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// Closest point on segment AB to P (all {x,y}); returns {x,y,d}.
function closestOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  const x = a.x + t * dx, y = a.y + t * dy;
  return { x, y, d: Math.hypot(p.x - x, p.y - y) };
}

// Spatial grid over guardrail segments for fast "what is near this point" queries.
class SegmentGrid {
  constructor(cell = 100) { this.cell = cell; this.map = new Map(); }
  key(cx, cy) { return cx * 73856093 ^ cy * 19349663; }
  add(a, b) {
    const c = this.cell, seg = [a, b];
    const x0 = Math.floor(Math.min(a.x, b.x) / c), x1 = Math.floor(Math.max(a.x, b.x) / c);
    const y0 = Math.floor(Math.min(a.y, b.y) / c), y1 = Math.floor(Math.max(a.y, b.y) / c);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = this.key(cx, cy);
      (this.map.get(k) || this.map.set(k, []).get(k)).push(seg);
    }
  }
  near(p, r) {
    const c = this.cell, out = new Set();
    for (let cx = Math.floor((p.x - r) / c); cx <= Math.floor((p.x + r) / c); cx++)
      for (let cy = Math.floor((p.y - r) / c); cy <= Math.floor((p.y + r) / c); cy++)
        for (const s of this.map.get(this.key(cx, cy)) || []) out.add(s);
    return out;
  }
}

// Points along a polyline every `step` metres, with unit tangent. Points are {x,y}.
function sampleLine(pts, step) {
  const out = [];
  let carry = 0, dist = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    const tx = (b.x - a.x) / len, ty = (b.y - a.y) / len;
    for (let s = carry; s <= len; s += step) {
      out.push({ x: a.x + tx * s, y: a.y + ty * s, tx, ty, dist: dist + s });
      carry = s + step - len;
    }
    dist += len;
  }
  return out;
}

/**
 * Find stretches of road where a guardrail runs along BOTH sides of a carriageway.
 *
 * roads:      [{ id, oneway, nodes: [{lat,lon}] }]  (node order = direction of travel)
 * guardrails: [{ nodes: [{lat,lon}] }]
 * opts:       step (m between samples), maxOffset (m from centreline to count a rail),
 *             minLength (m), mergeGap (m), clipLon: [west, east]
 *
 * "Side" is relative to the direction of travel, so on a divided highway the left
 * rail is the median barrier and the right rail is the outside barrier.
 * Returns [{ id, roadId, length, bearing, path: [{lat,lon}] }]
 */
export function findBothSidesZones(roads, guardrails, opts = {}) {
  const { step = 15, maxOffset = 22, minLength = 60, mergeGap = 45, clipLon = null } = opts;
  const first = roads.find((r) => r.nodes.length)?.nodes[0];
  if (!first) return [];
  const proj = makeProjector(first.lat, first.lon);

  const grid = new SegmentGrid(100);
  for (const g of guardrails) {
    const p = g.nodes.map((n) => proj.toXY(n.lat, n.lon));
    for (let i = 0; i < p.length - 1; i++) grid.add(p[i], p[i + 1]);
  }

  const runs = [];
  for (const road of roads) {
    const pts = road.nodes.map((n) => proj.toXY(n.lat, n.lon));
    const samples = sampleLine(pts, step);
    let run = null;
    const flush = () => { if (run && run.pts.length) runs.push(run); run = null; };
    for (const s of samples) {
      const ll = proj.toLatLon(s.x, s.y);
      if (clipLon && (ll.lon < clipLon[0] || ll.lon > clipLon[1])) { flush(); continue; }
      let left = false, right = false;
      for (const [a, b] of grid.near(s, maxOffset)) {
        const q = closestOnSegment(s, a, b);
        if (q.d > maxOffset) continue;
        // Ignore rails that cross the road (terminals/ramps): need to run roughly parallel.
        const sx = b.x - a.x, sy = b.y - a.y, sl = Math.hypot(sx, sy) || 1;
        if (Math.abs((sx * s.tx + sy * s.ty) / sl) < 0.5) continue;
        const cross = s.tx * (q.y - s.y) - s.ty * (q.x - s.x);
        if (cross > 0) left = true; else right = true;
        if (left && right) break;
      }
      if (left && right) {
        if (!run) run = { roadId: road.id, pts: [], start: s.dist, end: s.dist };
        run.pts.push(ll); run.end = s.dist;
      } else flush();
    }
    flush();
  }

  // Merge runs of the same road separated by a short gap (e.g. one missing rail node),
  // and runs on different ways that join end-to-end.
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && haversine(prev.pts[prev.pts.length - 1], r.pts[0]) <= mergeGap) {
      prev.pts.push(...r.pts);
    } else merged.push({ roadId: r.roadId, pts: [...r.pts] });
  }

  return merged
    .map((z, i) => {
      let length = 0;
      for (let j = 1; j < z.pts.length; j++) length += haversine(z.pts[j - 1], z.pts[j]);
      return {
        id: `z${i}`, roadId: z.roadId, length: Math.round(length),
        bearing: bearing(z.pts[0], z.pts[z.pts.length - 1]), path: z.pts,
      };
    })
    .filter((z) => z.length >= minLength);
}
