// The fullscreen framer's glide (src/vibes/vibes-camera-path.js): from in front
// it flies straight in; from the side or behind it swings around the monitor,
// never through its cabinet, and arrives facing the glass; from far out it
// first closes in, then swings.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { screenApproach, bezierAt } from '../src/vibes/vibes-camera-path.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);
const center = v(0, 2, 0), normal = v(0, 0, 1);         // glass facing +z
const to = center.clone().addScaledVector(normal, 3);   // the head-on framing
const body = new THREE.Sphere(v(0, 2, -1.5), 2.2);       // the cabinet behind the glass
const NEAR = 12;                                          // close in from further than this
const along = (path, n = 400) => Array.from({ length: n + 1 }, (_, i) => bezierAt(path, i / n, new THREE.Vector3()));
const flat = (p) => Math.hypot(p.x - center.x, p.z - center.z);

{
  const path = screenApproach(v(1, 3, 8), to, center, normal, body, NEAR);
  assert.ok(path.angle < Math.PI / 3, 'a camera in front of the glass is within 60 degrees of its normal');
  assert.equal(path.segments.length, 1, 'from in front the glide is one piece');
  const p0 = path.segments[0][0], dir = to.clone().sub(p0).normalize();
  for (const p of along(path)) {
    const off = p.clone().sub(p0);
    assert.ok(off.clone().sub(dir.clone().multiplyScalar(off.dot(dir))).length() < 1e-9, 'from in front the glide is a straight line to the framing');
  }
}

for (const [name, from] of [
  ['behind', v(0, 3, -9)], ['behind, off to the right', v(2, 3, -9)], ['beside', v(-9, 2.5, -1)], ['behind and close', v(0.5, 2.5, -4.2)],
  ['far behind', v(1, 6, -30)], ['far beside', v(-28, 4, -2)],
]) {
  const path = screenApproach(from, to, center, normal, body, NEAR);
  const clear = Math.min(body.radius, Math.min(from.distanceTo(body.center), NEAR), to.distanceTo(body.center));
  for (const p of along(path)) assert.ok(p.distanceTo(body.center) >= clear - 1e-6, `from ${name} the glide stays outside the monitor's cabinet`);
  assert.ok(bezierAt(path, 0, v(0, 0, 0)).equals(from) && bezierAt(path, 1, v(0, 0, 0)).equals(to), `from ${name} the glide starts at the camera and ends at the head-on framing`);
  const last = path.segments[path.segments.length - 1];
  assert.ok(last[3].clone().sub(last[2]).normalize().dot(normal) < -0.999, `from ${name} the glide arrives along the glass normal, facing the screen`);
  // Only a start further out than NEAR closes in first.
  assert.equal(path.segments.length, flat(from) > NEAR ? 2 : 1, `from ${name} the glide closes in first exactly when it starts further out than the near distance`);
}

{
  // Far out: the first piece closes in, ends at the near distance, and hands
  // over to the swing without a kink.
  const from = v(1, 6, -30);
  const path = screenApproach(from, to, center, normal, body, NEAR);
  const [a, b] = path.segments;
  assert.ok(Math.abs(flat(a[3]) - NEAR) < 1e-9, 'closing in stops at the near distance from the screen');
  assert.ok(flat(bezierAt(path, 0.02, v(0, 0, 0))) < flat(from), 'from far out the glide starts by moving closer');
  const outDir = a[3].clone().sub(a[2]).normalize(), inDir = b[1].clone().sub(b[0]).normalize();
  assert.ok(outDir.dot(inDir) > 0.9999, 'closing in and the swing meet in one direction (no kink)');
  // One speed across the join: equal steps in t cover about equal distances.
  const e = path.ends[0], d = 1e-3;
  const before = bezierAt(path, e - d, v(0, 0, 0)).distanceTo(bezierAt(path, e, v(0, 0, 0)));
  const after = bezierAt(path, e, v(0, 0, 0)).distanceTo(bezierAt(path, e + d, v(0, 0, 0)));
  assert.ok(Math.abs(before - after) / Math.max(before, after) < 0.35, 'the glide keeps its pace through the join');
}

{
  // From behind and to the right (+x), the shorter way round is the right side.
  const path = screenApproach(v(3, 3, -9), to, center, normal, body, NEAR);
  assert.ok(bezierAt(path, 0.5, new THREE.Vector3()).x > 0, 'the glide swings round the shorter side');
}

console.log('ok  - fullscreen framer glide: straight from in front, closes in from far out, around the cabinet from behind, arrives head-on');
