import assert from 'node:assert/strict';
import { findBothSidesZones, haversine } from '../js/geo.js';

// Eastbound straight road at lat 30.7, 3 km long. 1 deg lon ~ 95.9 km here.
const lat = 30.7, lon0 = -86.5, dLon = (m) => m / (111320 * Math.cos(lat * Math.PI / 180));
const dLat = (m) => m / 110540;
const line = (x0, x1, off) => ({ nodes: [
  { lat: lat + dLat(off), lon: lon0 + dLon(x0) }, { lat: lat + dLat(off), lon: lon0 + dLon(x1) }] });
const road = { id: 'r', nodes: [{ lat, lon: lon0 }, { lat, lon: lon0 + dLon(3000) }] };

// Left (north) rail 500-2500 m, right (south) rail 1000-2000 m, both 10 m off.
let z = findBothSidesZones([road], [line(500, 2500, 10), line(1000, 2000, -10)]);
assert.equal(z.length, 1);
assert.ok(Math.abs(z[0].length - 1000) < 40, `length ${z[0].length}`);
assert.ok(Math.abs(z[0].bearing - 90) < 1);

// Rail on one side only -> no zones.
assert.equal(findBothSidesZones([road], [line(0, 3000, 10)]).length, 0);

// Rail too far away (40 m) -> no zones.
assert.equal(findBothSidesZones([road], [line(0, 3000, 40), line(0, 3000, -40)]).length, 0);

// Perpendicular rail (crossing) shouldn't count.
const cross = { nodes: [{ lat: lat - dLat(15), lon: lon0 + dLon(1500) }, { lat: lat + dLat(15), lon: lon0 + dLon(1500) }] };
assert.equal(findBothSidesZones([road], [cross]).length, 0);

// Small gap in one rail gets merged into a single zone.
z = findBothSidesZones([road], [line(500, 1400, 10), line(1430, 2500, 10), line(500, 2500, -10)]);
assert.equal(z.length, 1);

// Westbound travel flips sides but both-sides result is the same.
const wb = { id: 'w', nodes: [...road.nodes].reverse() };
z = findBothSidesZones([wb], [line(500, 2500, 10), line(500, 2500, -10)]);
assert.equal(z.length, 1);
assert.ok(Math.abs(z[0].bearing - 270) < 1);

// Clip to a longitude window.
z = findBothSidesZones([road], [line(0, 3000, 10), line(0, 3000, -10)],
  { clipLon: [lon0 + dLon(1000), lon0 + dLon(2000)] });
assert.equal(z.length, 1);
assert.ok(Math.abs(z[0].length - 1000) < 40);
console.log('geo tests passed');
