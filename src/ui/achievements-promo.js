// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/ui/achievements-promo.js – the one-time splash after the theme picker
// that shows what Achievements is: one board for everyone, with The Last
// Ninja's Wastelands speedrun as the example, its top times read live, a place
// on it for you, and a run to watch. The video is a click-to-play facade:
// nothing is fetched from YouTube until the play button is pressed, and then
// only from youtube-nocookie.com. The page is cross-origin isolated (COEP
// require-corp, for the SID worklet's SharedArrayBuffer), which blocks a
// YouTube frame unless it is credentialless. A browser without credentialless
// frames opens the video on YouTube in a new tab instead.
import { createDialog, el, button } from '../assembly64/dom.js';

export const ACHIEVEMENTS_PROMO_SEEN = 'c64emu.achievementsPromoShown';
export const PROMO_VIDEO_ID = 'XCAIGjXj_7I';
/** The board shown: The Last Ninja's Wastelands Speedrun (server/sets/last-ninja.json). */
export const PROMO_BOARD = { hash: '504708239b910d8dd5c75e29e3dc346f', id: 1, title: 'Wastelands Speedrun' };
export const PROMO_BOARD_ROWS = 3;
const VIDEO_TITLE = 'The Last Ninja speedrun in C64 READY.';
const POSTER = '/screens/splash-achievements-lastninja.webp';
/** A YouTube frame can load here: the page is not cross-origin isolated, or the browser has credentialless frames. */
const canEmbed = () => !globalThis.crossOriginIsolated || 'credentialless' in HTMLIFrameElement.prototype;

/**
 * @param {object} o
 * @param {() => void} [o.openAchievements]  TRY IT NOW: the Achievements window
 * @param {() => Promise<{ title: string, entries: { rank: number, name: string, value: string, you: boolean }[],
 *   me: { rank: number, name: string, value: string }|null }|null>} [o.loadBoard]
 *   the board's top PROMO_BOARD_ROWS, values as shown, and the account's own place below them
 */
export function createAchievementsPromo({ openAchievements = () => {}, loadBoard = async () => null } = {}) {
  let dialog = null;
  let shownThisSession = false;
  return {
    get isOpen() { return !!dialog; },
    hasBeenShown() { if (shownThisSession) return true; try { return localStorage.getItem(ACHIEVEMENTS_PROMO_SEEN) === '1'; } catch { return false; } },
    /**
     * @param {{ onClose?: () => void, remember?: boolean }} [o]  remember: false previews it
     *   without marking it seen
     */
    open({ onClose = () => {}, remember = true } = {}) {
      if (dialog) return;
      let tryIt = false;
      dialog = createDialog('Your name on the board', () => {
        dialog = null;
        shownThisSession = true;
        if (remember) try { localStorage.setItem(ACHIEVEMENTS_PROMO_SEEN, '1'); } catch { /* session only */ }
        if (tryIt) openAchievements(); else onClose();
      });
      const { card } = dialog;
      card.classList.add('achievements-promo');
      const intro = el('p', 'One board for everyone who plays, your friends included. Free, and no sign-up needed to start.', { class: 'achievements-promo-intro' });

      // The video, behind a still of the Wastelands until it is asked for.
      const video = el('div', null, { class: 'achievements-promo-video' });
      const play = el('button', null, { type: 'button', class: 'achievements-promo-play', 'aria-label': `Play the video: ${VIDEO_TITLE}` });
      play.append(
        el('img', null, { src: POSTER, alt: '', width: 960, height: 600, decoding: 'async' }),
        el('span', null, { class: 'achievements-promo-play-icon', 'aria-hidden': 'true' }),
        el('span', 'Watch a Last Ninja speedrun', { class: 'achievements-promo-play-title' }),
      );
      play.addEventListener('click', () => {
        if (!canEmbed()) { window.open(`https://www.youtube.com/watch?v=${PROMO_VIDEO_ID}`, '_blank', 'noopener'); return; }
        const frame = el('iframe', null, {
          title: VIDEO_TITLE,
          allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
          allowfullscreen: '',
          referrerpolicy: 'strict-origin-when-cross-origin',
        });
        // Before the src: a frame is credentialless only if it is set before it navigates.
        frame.credentialless = true;
        frame.src = `https://www.youtube-nocookie.com/embed/${PROMO_VIDEO_ID}?autoplay=1&rel=0&playsinline=1`;
        video.replaceChildren(frame);
        frame.focus();
      });
      video.append(play);
      const media = el('div', null, { class: 'achievements-promo-media' });
      media.append(video, el('p', 'Every level of The Last Ninja has its own speedrun board. The video plays from YouTube.', { class: 'achievements-promo-note' }));

      // The board, as it stands, with an open place for you until you are on it.
      const board = el('section', null, { class: 'achievements-promo-board', 'aria-label': `The Last Ninja, ${PROMO_BOARD.title}` });
      const boardHead = el('div', null, { class: 'achievements-promo-board-head' });
      boardHead.append(el('span', PROMO_BOARD.title.toUpperCase(), { class: 'achievements-promo-board-title' }), el('span', 'THE LAST NINJA', { class: 'achievements-promo-board-game' }));
      const list = el('ol', null, { class: 'achievements-promo-rows', 'aria-busy': 'true' });
      const status = el('p', null, { class: 'achievements-promo-board-status', role: 'status' });
      const footnote = el('p', 'Same board, same game file, same rules for everyone. Post a time and see where you place.', { class: 'achievements-promo-note' });
      board.append(boardHead, list, status, footnote);
      const row = (rank, name, value, cls = '') => {
        const li = el('li', null, { class: `achievements-promo-row ${cls}`.trim() });
        li.append(el('span', rank, { class: 'achievements-promo-rank' }), el('span', name, { class: 'achievements-promo-name' }), el('span', value, { class: 'achievements-promo-value' }));
        return li;
      };
      function show(result) {
        list.removeAttribute('aria-busy');
        const rows = [];
        const entries = result?.entries ?? [];
        for (const e of entries.slice(0, PROMO_BOARD_ROWS)) rows.push(row(String(e.rank), e.name, e.value, e.you ? 'is-you' : ''));
        if (result?.me) rows.push(row(String(result.me.rank), result.me.name || 'YOU', result.me.value, 'is-you'));
        if (!entries.some((e) => e.you) && !result?.me) rows.push(row('?', 'YOU', '--:--', 'is-open'));
        list.replaceChildren(...rows);
        status.textContent = !result ? 'The board is offline right now.' : entries.length ? '' : 'No times yet. Be the first.';
        status.hidden = !status.textContent;
      }
      for (let i = 0; i < PROMO_BOARD_ROWS; i++) list.append(row('·', '· · ·', '·:··', 'is-loading'));
      status.hidden = true;
      Promise.resolve().then(loadBoard).then((r) => { if (dialog?.card === card) show(r); }, () => { if (dialog?.card === card) show(null); });

      const grid = el('div', null, { class: 'achievements-promo-grid' });
      grid.append(media, board);
      const actions = el('div', null, { class: 'achievements-promo-actions' });
      const buttons = el('div', null, { class: 'achievements-promo-buttons' });
      buttons.append(
        button('MAYBE LATER', () => dialog.close()),
        button('TRY IT NOW', () => { tryIt = true; dialog.close(); }, { class: 'btn btn-primary', 'data-promo-try': '' }),
      );
      actions.append(el('span', 'Trophies in every game too, from a first level cleared to a perfect run.', { class: 'achievements-promo-note' }), buttons);
      dialog.body.append(intro, grid, actions);
      play.focus();
    },
  };
}
