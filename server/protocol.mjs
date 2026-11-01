// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/protocol.mjs — the chat's shared rules: limits, text cleaning, and
// the games a message mentions. The app imports this file too, so both sides
// agree.

export const PROTOCOL = 2;

export const LIMITS = Object.freeze({
  nick: 16,
  roomName: 32,
  text: 280,
  mentions: 3,
  channelSize: 500,
  history: 100,
  reportMessages: 20,
});

// Unambiguous letters and digits (no 0/O, 1/I), six of them: about 10^9 codes.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

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

/** Whether a name is the admin's, or reads as one: folded like a name key (NFKC), so "ＳＹＳＯＰ" is reserved too. */
export function isReservedNick(nick) {
  return RESERVED.has(String(nick).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export function isRoomCode(value) {
  return typeof value === 'string' && CODE_RE.test(value);
}

const GAME_ID = /^[a-z0-9-]{1,48}$/;

/**
 * The games a message mentions, as sent: game ids (a set's slug), each once,
 * at most LIMITS.mentions. The server keeps only those it knows, whose
 * `@Title` is in the text.
 */
export function cleanMentions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && GAME_ID.test(id)))].slice(0, LIMITS.mentions);
}

/** Whether `text` names `title` as a mention: "@Bomb Jack", in any case. */
export function mentions(text, title) {
  return String(text).toLowerCase().includes(`@${String(title).toLowerCase()}`);
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
