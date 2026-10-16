// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';

// The glide the fullscreen framer flies to face the monitor: a chain of cubic
// Béziers from the camera to the head-on view. From in front it is a straight
// line. From the side or behind it swings around the screen's vertical axis
// like a circular arc (control lengths 4/3·tan(θ/4)·r) and turns in along the
// glass normal, so it arrives head-on. The further behind it starts, the wider
// the swing: up to a third more reach from straight behind. A camera further
// out than `near` first closes in to that distance, its path bending from
// straight inward into the swing, so the arc stays a turn around the monitor
// rather than a lap of the room. The arc's control arms grow until every point
// stays outside `body` (a sphere around the monitor), so the camera never
// passes through the cabinet.
//
// Returns { segments: [[p0, p1, p2, p3], ...], ends: cumulative length share
// per segment, angle: the swing in radians }; bezierAt() walks it by distance.
const UP = new THREE.Vector3(0, 1, 0);

export function screenApproach(from, to, center, normal, body, near = Infinity) {
  const p0 = from.clone(), p3 = to.clone();
  const h = from.clone().sub(center); h.y = 0;
  const n = normal.clone(); n.y = 0;
  const angle = (h.lengthSq() > 1e-12 && n.lengthSq() > 1e-12) ? h.angleTo(n) : 0;
  if (angle < Math.PI / 3) {
    // Already in front: straight in, the controls on the line.
    return chain([[p0, p0.clone().lerp(p3, 1 / 3), p0.clone().lerp(p3, 2 / 3), p3]], angle);
  }
  // Swing the shorter way around (left when exactly behind), tangent to the
  // circle through the camera.
  const side = h.clone().cross(n).y >= 0 ? 1 : -1;
  const tangent = UP.clone().cross(h).normalize().multiplyScalar(side);
  let start = p0, startDir = tangent, inward = null;
  if (h.length() > near) {
    // Close in first: to `near` from the screen on the same bearing, a third
    // of the way down to the framing's height, arriving already turning.
    inward = h.clone().normalize().negate();
    start = center.clone().addScaledVector(h.clone().normalize(), near);
    start.y = from.y + (to.y - from.y) / 3;
    startDir = tangent.clone().addScaledVector(inward, 0.35).normalize();
  }
  const r0 = start.distanceTo(center), r3 = to.distanceTo(center);
  let k = (4 / 3) * Math.tan(angle / 4) * (1 + (angle - Math.PI / 3) / (2 * Math.PI));
  // Never ask for more clearance than the ends themselves have.
  const clear = body ? Math.min(body.radius, start.distanceTo(body.center), to.distanceTo(body.center)) : 0;
  const p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), q = new THREE.Vector3();
  for (let tries = 0; tries < 12; tries++) {
    p1.copy(start).addScaledVector(startDir, k * r0);
    p2.copy(p3).addScaledVector(normal, k * Math.max(r0, r3));
    if (!body || minDistance([start, p1, p2, p3], body.center, q) >= clear) break;
    k *= 1.2;
  }
  const arc = [start, p1.clone(), p2.clone(), p3];
  if (!inward) return chain([arc], angle);
  // The closing-in piece leaves straight inward and meets the swing in its
  // direction and at its speed: over the chain each piece runs for its share
  // of the length, so the meeting arm is the swing's first arm scaled by the
  // pieces' length ratio, settled in a few rounds.
  const arcLen = length(arc), out = start.distanceTo(p0) / 3;
  const piece = [p0, p0.clone().addScaledVector(inward, out), start.clone(), start];
  let arm = out;
  for (let i = 0; i < 4; i++) {
    piece[2].copy(start).addScaledVector(startDir, -arm);
    arm = k * r0 * length(piece) / arcLen;
  }
  piece[2].copy(start).addScaledVector(startDir, -arm);
  return chain([piece, arc], angle);
}

function length(p) {
  const q = new THREE.Vector3(), prev = p[0].clone();
  let len = 0;
  for (let i = 1; i <= 32; i++) { cubicAt(p, i / 32, q); len += q.distanceTo(prev); prev.copy(q); }
  return len;
}

// Each segment's share of the whole length, so a glide over the chain moves
// at one speed from end to end.
function chain(segments, angle) {
  const lengths = segments.map(length);
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  let sum = 0;
  return { segments, ends: lengths.map((l) => (sum += l) / total), angle };
}

// Components written straight into `out`: passing computed numbers through a
// set() call would box them every frame of the glide.
function cubicAt(p, t, out) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  const p0 = p[0], p1 = p[1], p2 = p[2], p3 = p[3];
  out.x = a * p0.x + b * p1.x + c * p2.x + d * p3.x;
  out.y = a * p0.y + b * p1.y + c * p2.y + d * p3.y;
  out.z = a * p0.z + b * p1.z + c * p2.z + d * p3.z;
  return out;
}

// Point at t (0..1 over the whole chain) into `out` (no allocation).
export function bezierAt(path, t, out) {
  const { segments, ends } = path;
  let i = 0;
  while (i < ends.length - 1 && t > ends[i]) i++;
  const lo = i ? ends[i - 1] : 0;
  return cubicAt(segments[i], Math.min(1, Math.max(0, (t - lo) / ((ends[i] - lo) || 1))), out);
}

// Closest approach of one cubic's inner points to `c`, sampled.
export function minDistance(p, c, scratch = new THREE.Vector3()) {
  let m = Infinity;
  for (let i = 1; i < 64; i++) m = Math.min(m, cubicAt(p, i / 64, scratch).distanceTo(c));
  return m;
}
