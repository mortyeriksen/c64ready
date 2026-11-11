// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/new-game.js – tells when a new game starts, so what was
// waiting to be shown about the game before it can be let go.
//
// A new game is the next attempt (the first leaderboard to start after the
// game ended), another game loaded or none, or a reset machine. A game ends
// at the set's game over, or, for a set without one, when a score is posted:
// the same end attract mode follows. A board that starts during play, as a
// level's speedrun does, is not a new game.

/**
 * @param {() => void} onNewGame  told once for each new game
 */
export function createNewGameWatch(onNewGame) {
  let ended = false;      // the game ended: the next board to start is the next attempt
  let game = null;        // the loaded game's id

  const start = () => { ended = false; onNewGame(); };

  return {
    /**
     * A leaderboard's news (engine onLeaderboard), with whether the set has a
     * game over of its own. Read only for a start or a post.
     * @param {'started'|'updated'|'canceled'|'submitted'} type
     * @param {boolean} hasGameOver
     */
    leaderboard(type, hasGameOver) {
      if (type === 'started') { if (ended) start(); }
      else if (type === 'submitted' && !hasGameOver) ended = true;
    },
    /** The set's game over (engine onGameOver). */
    gameOver() { ended = true; },
    /**
     * The loaded game, by its id, or null (engine onChange). By id, not by the
     * loaded file's hash: a tape's second side is the same game.
     */
    gameChanged(next) {
      if (next === game) return;
      game = next;
      start();
    },
    /** The machine was reset, or made anew. */
    reset() { start(); },
  };
}
