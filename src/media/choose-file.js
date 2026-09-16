// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/media/choose-file.js – One file out of a container, chosen by the person.
//
// A ZIP and a .t64 both hold several things where the app loads one, and both
// want the same answers: nothing loadable is an error the caller words, exactly
// one needs no dialog at all, and several need a list. The single-entry case is
// the common one — of the .t64 archives measured here, 26 of 29 hold one file —
// so the dialog is the exception rather than the flow, and callers are expected
// to take the one entry themselves before importing this at all.

import { el, button, createDialog } from '../assembly64/dom.js';
import { t64Files } from './t64.js';

/**
 * @param {string}   title      what the dialog is called
 * @param {Array}    entries    whatever the container holds
 * @param {object}   o
 * @param {function} o.label    entry → the line on its button
 * @param {string}   [o.note]   a line above the list
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<any|null>} the chosen entry, or null if it was dismissed
 */
export function chooseFile(title, entries, { label, note, signal } = {}) {
  if (entries.length === 1) return Promise.resolve(entries[0]);
  return new Promise(resolve => {
    let choice = null;
    const dialog = createDialog(title, () => {
      signal?.removeEventListener('abort', abort);
      resolve(choice);
    });
    const abort = () => dialog.close();
    signal?.addEventListener('abort', abort, { once: true });
    if (note) dialog.body.append(el('p', note));
    for (const entry of entries) {
      dialog.body.append(button(label(entry), () => { choice = entry; dialog.close(); }));
    }
  });
}

/**
 * The program to load out of a .t64, wherever the archive came from: dropped on
 * the screen, picked with LOAD ANY, replayed from the Library, or downloaded
 * from Assembly64.
 *
 * An archive is not a tape. Its entries are decoded programs, each already a
 * .prg with its load address in front, so what comes back is ready to load with
 * no tape or disk in between. What the Library keeps is the archive itself, so
 * this runs on every replay of it and the next one may take a different program
 * out of the same file.
 *
 * @param {Uint8Array} bytes    the archive
 * @param {string}     archive  what it is called, for the message and the name
 * @returns {Promise<{data: Uint8Array, name: string}|null>} null if dismissed
 * @throws when the archive holds no program at all
 */
export async function openT64(bytes, archive, { signal } = {}) {
  const { files, skipped } = t64Files(bytes);
  if (!files.length) {
    throw new Error(skipped.length
      ? `Nothing to load in "${archive}": ${skipped[0].why}.`
      : `"${archive}" holds no programs.`);
  }
  const picked = await chooseFile('Choose a program', files, {
    label: f => `${f.name} · $${f.start.toString(16).toUpperCase().padStart(4, '0')} · ${(f.bytes.length - 2).toLocaleString()} B`,
    note: `${files.length} programs in this archive. The one you choose is loaded and kept in the Library.`,
    signal,
  });
  if (!picked) return null;
  // The archive's own name for it, falling back to the archive's when an entry
  // carries nothing worth keeping.
  const own = String(picked.name || '').replace(/[\u0000-\u001f]/g, '').trim();
  return { data: picked.bytes, name: `${own || archive.replace(/\.t64$/i, '')}.prg` };
}
