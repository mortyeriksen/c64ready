// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export class MatrixKeyOwnership {
  constructor(codes) {
    this.codeIndex = Object.create(null);
    this.owned = new Uint8Array(codes.length);
    for (let i = 0; i < codes.length; i++) this.codeIndex[codes[i]] = i + 1;
  }

  claim(code) {
    const index = this.codeIndex[code] | 0;
    if (index) this.owned[index - 1] = 1;
  }

  release(code) {
    const index = this.codeIndex[code] | 0;
    if (!index || this.owned[index - 1] === 0) return false;
    this.owned[index - 1] = 0;
    return true;
  }

  clear() {
    this.owned.fill(0);
  }
}

export class SoftKeyboardInsertState {
  constructor() {
    this.previousWasSpace = false;
  }

  normalize(text) {
    // Gboard reports its double-Space punctuation as ". " after the first
    // Space was already dispatched. Preserve the user's second Space tap.
    const normalized = this.previousWasSpace && text === '. ' ? ' ' : text;
    this.previousWasSpace = normalized === ' ';
    return normalized;
  }

  reset() {
    this.previousWasSpace = false;
  }
}
