// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/game-icons.js — the games with an icon in public/gameicons/, written by
// tools/game-icons.mjs from tools/game-icons-art.mjs. A game without one shows its initial.

export const GAME_ICONS = new Set([
  '1943',
  'action-biker',
  'arkanoid',
  'arkanoid-revenge-of-doh',
  'barbarian',
  'beach-head',
  'blue-max',
  'bomb-jack',
  'boulder-dash',
  'bruce-lee',
  'bubble-bobble',
  'buggy-boy',
  'chuckie-egg',
  'commando',
  'commando-arcade',
  'cybernoid',
  'cybernoid-ii',
  'defender-of-the-crown',
  'exploding-fist',
  'forbidden-forest',
  'galaga',
  'ghosts-n-goblins',
  'ghosts-n-goblins-arcade',
  'giana-sisters',
  'green-beret',
  'gribblys-day-out',
  'hitchhikers-guide',
  'ik-plus',
  'impossible-mission',
  'last-ninja',
  'maniac-mansion',
  'marios-cement-factory',
  'mole-attack',
  'munchy-worm',
  'nemesis',
  'out-run',
  'panther',
  'paperboy',
  'paradroid',
  'pirates',
  'rainbow-islands',
  'rambo',
  'road-runner',
  'spy-vs-spy',
  'spy-vs-spy-ii',
  'spy-vs-spy-iii',
  'stix',
  'super-mario-bros-64',
  'thrust',
  'turrican',
  'turrican-ii',
  'uridium',
  'vegetables-deluxe',
  'wizball',
  'yie-ar-kung-fu',
  'zork-i',
]);
/** An icon's width and height in its own pixels, its outline included. */
export const ICON_GRID = 18;

const BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
/** A game's icon as a URL, or null for a game without one. */
export const gameIconUrl = (id) => (GAME_ICONS.has(id) ? `${BASE}gameicons/${id}.svg` : null);
