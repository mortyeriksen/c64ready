// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/value-bounds.mjs — the least and the greatest value a leaderboard's
// VAL (an rcheevos value expression) can take, from the expression alone: the
// range each memory read can hold, through its multipliers, sums and
// alternatives. A board whose set gives no `max` or `min` is held to these, so
// a posted value the game could never produce is flagged for review.
//
// It reads the subset of the syntax the sets use. Anything else (a pointer, a
// float, a modifier it does not know), or a sum that can pass 32 bits and wrap
// round, gives no bound at all, never a wrong one.

const INT_MIN = -(2 ** 31), INT_MAX = 2 ** 31 - 1;

// A memory read's size letter → its largest raw value. No letter is 16 bits.
const SIZE_MAX = {
  M: 1, N: 1, O: 1, P: 1, Q: 1, R: 1, S: 1, T: 1,
  L: 0xf, U: 0xf, H: 0xff, '': 0xffff, I: 0xffff, W: 0xffffff, J: 0xffffff, X: 0xffffffff, G: 0xffffffff, K: 8,
};
// BCD of a read of that many hex digits, every digit 15 at most: rcheevos reads each digit as a decimal one.
const bcdMax = (raw) => { let n = 0, d = 1; for (let v = raw; v > 0; v = Math.floor(v / 16)) { n += 15 * d; d *= 10; } return n; };

class Unknown extends Error {}
const unknown = () => { throw new Unknown(); };

/** One operand: a memory read, its delta or prior, BCD or inverted, or a constant. As [lo, hi]. */
function operand(text) {
  let m = /^([dpb~]?)0x([A-Z]?)[0-9a-fA-F]+$/.exec(text);
  if (m) {
    const raw = SIZE_MAX[m[2]] ?? unknown();
    return [0, m[1] === 'b' ? bcdMax(raw) : raw];
  }
  if ((m = /^v(-?\d+)$/.exec(text)) || (m = /^(\d+)$/.exec(text))) { const v = Number(m[1]); return [v, v]; }
  if ((m = /^h([0-9a-fA-F]+)$/.exec(text))) { const v = parseInt(m[1], 16); return [v, v]; }
  return unknown();
}
const constant = (text) => { const [lo, hi] = operand(text); return lo === hi ? lo : unknown(); };

/** An operand with an optional `*` or `/` by a constant. */
function term(text) {
  const m = /^([^*/]+)(?:([*/])(.+))?$/.exec(text) ?? unknown();
  const [lo, hi] = operand(m[1]);
  if (!m[2]) return [lo, hi];
  const k = constant(m[3]);
  if (m[2] === '*') return k >= 0 ? [lo * k, hi * k] : [hi * k, lo * k];
  if (k <= 0) unknown();
  return [Math.floor(lo / k), Math.floor(hi / k)];
}

const COMPARE = /[=!<>]/;
// Flags that only decide when the measured value counts: conditions, not part of the sum.
const CONDITION_FLAGS = new Set(['P', 'R', 'T', 'N', 'O', 'Q', 'Z']);

/** One alternative of a value: an old sum of terms, or flagged lines that end in M:. */
function alternative(text) {
  const parts = text.split('_');
  if (!parts.some((p) => /^[A-Z]:/.test(p))) {
    // The old form: the terms added up.
    let lo = 0, hi = 0;
    for (const p of parts) { if (COMPARE.test(p)) unknown(); const [a, b] = term(p); lo += a; hi += b; }
    return [lo, hi];
  }
  let lo = 0, hi = 0, hitsGoDown = false, measured = null;
  for (const p of parts) {
    const m = /^(?:([A-Z]):)?(.+)$/.exec(p);
    const flag = m[1] ?? '', body = m[2];
    if (measured) unknown();
    if (flag === 'A' || flag === 'B') {
      if (COMPARE.test(body)) unknown();
      const [a, b] = term(body);
      if (flag === 'A') { lo += a; hi += b; } else { lo -= b; hi -= a; }
    } else if (flag === 'M') {
      // A comparison counts its hits, without end. An operand is the sum so far plus it.
      if (COMPARE.test(body)) measured = [hitsGoDown ? -Infinity : 0, Infinity];
      else { const [a, b] = term(body); measured = [lo + a, hi + b]; }
    } else if (flag === 'C') { if (!COMPARE.test(body)) unknown(); }
    else if (flag === 'D') { if (!COMPARE.test(body)) unknown(); hitsGoDown = true; }
    else if (!CONDITION_FLAGS.has(flag)) unknown();
  }
  return measured ?? unknown();
}

/**
 * The range a leaderboard's value can take, from its definition's VAL part: { min, max }, each a
 * whole number within 32 bits, or null where the expression sets no bound (or is not understood).
 */
export function valueBounds(definition) {
  const val = /::VAL:(.*)$/s.exec(String(definition ?? ''))?.[1];
  if (!val) return { min: null, max: null };
  try {
    // Alternatives: the greatest of them is the value.
    let lo = -Infinity, hi = -Infinity;
    for (const alt of val.split('$')) { const [a, b] = alternative(alt); lo = Math.max(lo, a); hi = Math.max(hi, b); }
    // rcheevos adds in 32 bits: a sum that can pass them wraps round, to anything.
    if ((Number.isFinite(hi) && hi > INT_MAX) || lo < INT_MIN) return { min: null, max: null };
    // A hit count has no top, and is never below its least.
    return { min: lo, max: Number.isFinite(hi) ? hi : null };
  } catch (e) {
    if (e instanceof Unknown) return { min: null, max: null };
    throw e;
  }
}
