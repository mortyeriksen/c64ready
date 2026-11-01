// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Shared steps for guide shots that show the Achievements window: players who
// sign up with a virtual passkey and post results through the games API, and a
// game loaded with its window docked. Run against a dev server with accounts in
// memory (VITE_ACCOUNTS_IN_MEMORY=1), so no real player shows; the accounts are
// deleted again afterwards.

import { createGuideContext } from './guide-context.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An account made with a virtual passkey in `page`: { token, user, name }, the
 * token also pushed to `tokens`. A name taken by an earlier run gets a digit.
 */
export async function signUpWith(tokens, ctx, page, name, tries = 0) {
  if (!tries) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  }
  for (const n of [name, `${name}2`, `${name}3`]) {
    const r = await page.evaluate(async (nm) => {
      const { createAccount } = await import('/src/account/account.js');
      const a = createAccount();
      try { await a.register(nm); return { token: a.token, user: a.user, name: nm }; } catch (e) { return { error: e.message }; }
    }, n);
    if (r.token) { tokens.push(r.token); return r; }
    // Over the server's sign-in limit: wait for it to refill and try the same name again.
    if (/too many/.test(r.error) && tries++ < 6) { await sleep(20000); return signUpWith(tokens, ctx, page, name, tries); }
    if (!/taken/.test(r.error)) throw new Error(`sign-up ${n}: ${r.error}`);
  }
  throw new Error(`no free name for ${name}`);
}

/** Deletes the accounts a scene made, so the dev server keeps none of them. */
export const deleteAccounts = (base, tokens) => Promise.all(tokens.map((t) => fetch(`${base}/api/me`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}`, Origin: new URL(base).origin } }).catch(() => {})));

/** A POST to the games API; over the server's limit (ten at once, then one each 2 seconds) it waits and tries again. */
export async function postApi(base, token, url, body) {
  for (;;) {
    const r = await fetch(`${base}/api${url}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: new URL(base).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429) { await sleep(2100); continue; }
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return;
  }
}

/** Posts a player's unlocks and best score on leaderboard 1 of the game with `hash`. */
export async function play(base, token, hash, ids, score) {
  for (const id of ids) await postApi(base, token, `/games/${hash}/unlocks`, { achievementId: id, hardcore: false });
  if (score) await postApi(base, token, `/games/${hash}/leaderboards/1/entries`, { value: score, hardcore: false });
}

/**
 * Signs up `players` ([name, ids, score]) and the shot's own player `me`
 * ([name, ids, score]) in pages of their own, with their results posted:
 * { token, user } of `me`, for a context to sign in with (signedIn()).
 */
export async function seedPlayers(browser, base, hash, players, me, tokens) {
  let mine = null;
  for (const [name, ids, score] of [...players, me]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const r = await signUpWith(tokens, ctx, page, name);
    await ctx.close();
    await play(base, r.token, hash, ids, score);
    if (name === me[0]) mine = { token: r.token, user: r.user };
  }
  return mine;
}

/** An init script's arguments that sign a context in as `account` ({ token, user }). */
export const signedIn = (account) => ({ token: account.token, user: JSON.stringify(account.user) });
export function applySignIn({ token, user }) {
  try { localStorage.setItem('c64emu.account.token', token); localStorage.setItem('c64emu.account.user', user); } catch {}
}

/**
 * Loads `file` (a game with a set) into a powered-on page and waits for its
 * Achievements window, docked on the right, on the GAME tab.
 */
export async function loadGameDocked(page, file) {
  await page.setInputFiles('#prg-input', file);
  const offer = page.locator('#confirm-modal:not([hidden])');
  if (await offer.waitFor({ timeout: 3000 }).then(() => true, () => false)) await page.locator('#btn-confirm-ok').click();
  await page.locator('#online-window .ach-screen').first().waitFor({ timeout: 20000 });
  if (!(await page.evaluate(() => document.body.classList.contains('has-docked-window')))) await page.locator('#btn-online-dock').click();
  await page.waitForFunction(() => document.body.classList.contains('has-docked-window'), null, { timeout: 5000 });
}

/** Commando Arcade's players for the overview shots: [name, achievement ids, best score]. */
export const COMMANDO_ARCADE_PLAYERS = [
  ['Ruby', [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14], 112400],
  ['Zak', [1, 2, 3, 4, 10, 11, 12, 13], 74250],
  ['Hubbard', [1, 2, 3, 10, 11, 12, 13], 61800],
  ['Nova', [1, 10, 11], 18300],
];
export const COMMANDO_ARCADE_ME = ['Pixel', [1, 2, 10, 11, 12], 38900];

/**
 * The overview scene, as a PNG: the interface 1720px wide with the C64 screen
 * at 2.5X, cropped with as much room below the screen as above it. With `game`
 * (a cartridge with a set), its title screen with the Achievements window
 * docked, signed in as `account` ({ token, user }) when given; without, the
 * blue READY. screen.
 */
export async function captureScene(browser, { base, theme = 'phosphor', mode = 'dark', dpr = 2, game = null, account = null }) {
  const width = 1720;
  const ctx = await createGuideContext(browser, { colorScheme: mode, viewport: { width, height: 1180 }, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
  await ctx.addInitScript(({ theme, mode }) => {
    try {
      localStorage.setItem('c64emu.installDismissed', '1');
      localStorage.setItem('c64emu.splashSeen', '1');
      localStorage.setItem('c64emu.appearance', mode);
      localStorage.setItem('c64emu.sizeMode', '25x');   // the C64 screen at 2.5X
      if (theme === 'classic') localStorage.removeItem('c64emu.theme'); else localStorage.setItem('c64emu.theme', theme);
    } catch {}
  }, { theme, mode });
  if (game && account) await ctx.addInitScript(applySignIn, signedIn(account));
  try {
    const page = await ctx.newPage();
    await page.goto(`${base}/?CRT_SHADER_SOFTWARE=1`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#btn-power:not([disabled])', { timeout: 20000 });
    await page.locator('#btn-power').click();
    await sleep(4200);                                   // blue screen settles to READY.
    if (game) {
      await loadGameDocked(page, game);
      await sleep(12000);                                // the cartridge's title picture
    }
    await page.mouse.move(5, 1175);
    await sleep(400);
    const screen = await page.evaluate(() => { const r = document.querySelector('.crt-bezel').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    return await page.screenshot({ clip: { x: 0, y: 0, width, height: Math.min(1180, Math.ceil(screen.bottom + screen.top)) } });
  } finally {
    await ctx.close();
  }
}
