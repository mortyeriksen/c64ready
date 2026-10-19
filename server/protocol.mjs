// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/protocol.mjs — the chat's shared rules: limits, text cleaning, room
// codes and topic keys. The app imports this file too, so both sides agree.

export const PROTOCOL = 1;

export const LIMITS = Object.freeze({
  nick: 16,
  roomName: 32,
  topicTitle: 48,
  text: 280,
  roomSize: 32,
  history: 50,
  a64Id: 128,
  fileName: 128,
  reportMessages: 20,
});

// Unambiguous letters and digits (no 0/O, 1/I), six of them: about 10^9 codes.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export const TOPIC_KINDS = Object.freeze(['disk', 'cart', 'tape', 'program', 'tune']);

// Names nobody may take: the admin speaks as SYSOP.
const RESERVED = new Set(['sysop', 'admin', 'administrator', 'moderator', 'system', 'c64ready']);

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// Direction embeddings, overrides and isolates: a message must read in the order it was written.
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
// Invisible characters, removed from names so two nicknames cannot look alike.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2060-\u2064\u3164\ufeff\uffa0]/g;

const length = (s) => [...s].length;

/** Message text: control characters become spaces, direction controls go. null when empty or too long. */
export function cleanText(value, max = LIMITS.text) {
  if (typeof value !== 'string') return null;
  const s = value.replace(CONTROL, ' ').replace(BIDI, '').trim();
  return s && length(s) <= max ? s : null;
}

/** A nickname or room name: also no invisible characters and single spaces. */
export function cleanName(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim();
  return s && length(s) <= max ? s : null;
}

export function isReservedNick(nick) {
  return RESERVED.has(String(nick).toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export function isRoomCode(value) {
  return typeof value === 'string' && CODE_RE.test(value);
}

/** A title folded for comparison: "Commando (1985)" and "COMMANDO" match. */
export function foldTitle(title) {
  return String(title ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\(\d{4}\)|\[[^\]]*\]|\{[^}]*\}/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

const a64Part = (v) => (typeof v === 'string' && v.length > 0 && v.length <= LIMITS.a64Id && !/[\u0000-\u001f/\\]/.test(v) ? v : null);

/**
 * A room's topic as the server keeps it: { title, kind, a64? } or null. a64 is the
 * Assembly64 file the topic was loaded from: { item, cat, file, name }.
 */
export function cleanTopic(value) {
  if (!value || typeof value !== 'object') return null;
  const title = cleanName(value.title, LIMITS.topicTitle);
  if (!title || !TOPIC_KINDS.includes(value.kind)) return null;
  const topic = { title, kind: value.kind };
  const a = value.a64;
  if (a && typeof a === 'object') {
    const item = a64Part(a.item), file = a64Part(a.file);
    const name = cleanName(a.name, LIMITS.fileName);
    if (item && file && name && Number.isSafeInteger(a.cat) && a.cat >= 0 && a.cat < 10000) topic.a64 = { item, cat: a.cat, file, name };
  }
  return topic;
}

/** Rooms about the same thing share a key: the Assembly64 release when known, else the folded title. */
export function topicKey(topic) {
  if (!topic) return '';
  if (topic.a64) return `a64:${topic.a64.cat}:${topic.a64.item}`;
  const folded = foldTitle(topic.title);
  return folded ? `t:${folded}` : '';
}

/** Words the operator has blocked, matched case-insensitively on word boundaries. */
export function wordFilter(words = []) {
  const list = words.map((w) => String(w).trim().toLowerCase()).filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!list.length) return { blocks: () => false, mask: (s) => s };
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return {
    blocks: (s) => { re.lastIndex = 0; return re.test(s); },
    mask: (s) => s.replace(re, (m) => '*'.repeat(length(m))),
  };
}
