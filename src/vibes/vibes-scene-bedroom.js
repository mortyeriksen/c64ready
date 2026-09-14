// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { roomTextures, markShared } from './vibes-scene-common.js';

// One frame of what is on the television: a black Trans-Am-ish car head-on on a
// night highway, red scanner sweeping across its nose. `phase` (radians) drives
// the sweep, so animate() can call this per frame. Deliberately blocky — it is
// 128x96 seen across a dark room through a CRT bezel, and crisp detail would
// read as a photo taped to the tube.
// The picture is split in two so the sweep costs nothing per frame: everything
// static is painted ONCE into a backdrop canvas, and the scanner is a small
// pre-rendered glow blitted at its current x. Per frame that is two drawImage
// calls and no allocation — no gradients, no paths, no strings. This scene runs
// inside the same rAF as the emulator, and the project keeps idle allocation at
// ~0 KiB/frame; a fresh createRadialGradient every frame would undo that.
export function drawTvBackdrop(x, w, h) {
  // An overcast desert highway, not a night road. A daylight picture keeps its
  // mid-tones when the tube is shown dim across a dark room; a night scene shown
  // dim collapses to black with two headlights floating in it.
  //
  // The car sits LOW and LARGE, straddling the road in the near field, with the
  // highway running away behind it. Drawn small and high it read as parked on
  // the horizon rather than driving at you.
  const sky = x.createLinearGradient(0, 0, 0, h * 0.46);
  sky.addColorStop(0, '#5f6c7d'); sky.addColorStop(1, '#87919b');       // hazy overcast
  x.fillStyle = sky; x.fillRect(0, 0, w, h * 0.46);
  x.fillStyle = '#5c6472';                                              // distant hills
  x.beginPath(); x.moveTo(0, h * 0.46);
  for (let i = 0; i <= 8; i++) x.lineTo(w * i / 8, h * (0.40 + 0.04 * Math.sin(i * 1.7)));
  x.lineTo(w, h * 0.46); x.closePath(); x.fill();
  x.fillStyle = '#7d7360'; x.fillRect(0, h * 0.46, w, h * 0.54);        // scrub desert
  x.fillStyle = '#59595f';                                              // asphalt, opening toward camera
  x.beginPath(); x.moveTo(w * 0.47, h * 0.46); x.lineTo(w * 0.53, h * 0.46);
  x.lineTo(w * 1.15, h); x.lineTo(-w * 0.15, h); x.closePath(); x.fill();
  x.strokeStyle = '#8e8b84'; x.lineWidth = 1;                           // painted verges
  x.beginPath(); x.moveTo(w * 0.47, h * 0.46); x.lineTo(-w * 0.15, h);
  x.moveTo(w * 0.53, h * 0.46); x.lineTo(w * 1.15, h); x.stroke();
  x.fillStyle = '#c9c2a6';                                              // centre dashes running under the car
  for (let i = 0; i < 4; i++) {
    const t = i / 4, yy = h * (0.48 + t * 0.13), ww = 1 + t * 2;
    x.fillRect(w / 2 - ww / 2, yy, ww, 1 + t * 2);
  }
  // ── the car, head-on and close ──
  const cx = w / 2;
  // Low and wide: a tall cabin on a short body reads as an SUV, which this very
  // much is not. The roof is a shallow slot above a long bonnet line.
  const bodyW = w * 0.50, bodyT = h * 0.645, bodyH = h * 0.165;
  const roofW = w * 0.26, roofT = h * 0.565, roofH = h * 0.080;
  x.fillStyle = 'rgba(30,28,24,0.34)';                                  // shadow on the tarmac
  x.fillRect(cx - bodyW * 0.56, h * 0.845, bodyW * 1.12, h * 0.040);
  x.fillStyle = '#101116';                                              // wheels, just proud of the body
  x.fillRect(cx - bodyW / 2 - w * 0.015, h * 0.790, w * 0.070, h * 0.065);
  x.fillRect(cx + bodyW / 2 - w * 0.055, h * 0.790, w * 0.070, h * 0.065);
  x.fillStyle = '#191a20';                                              // cabin
  x.fillRect(cx - roofW / 2, roofT, roofW, roofH);
  x.fillStyle = '#77828f';                                              // windscreen catching the overcast sky
  x.fillRect(cx - roofW / 2 + w * 0.020, roofT + h * 0.016, roofW - w * 0.040, roofH - h * 0.028);
  x.fillStyle = '#17181c';                                              // bodywork
  x.fillRect(cx - bodyW / 2, bodyT, bodyW, bodyH);
  x.fillStyle = '#0e0f13';                                              // grille shadow + bumper
  x.fillRect(cx - bodyW * 0.52, bodyT + bodyH * 0.72, bodyW * 1.04, bodyH * 0.30);
  // Air dam: closes the daylight gap under the car. Sitting up on visible wheels
  // with road showing beneath is exactly what made it read as a truck.
  x.fillStyle = '#0a0b0e';
  x.fillRect(cx - bodyW * 0.46, bodyT + bodyH * 0.98, bodyW * 0.92, h * 0.030);
  x.fillStyle = '#c8bda0';                                              // headlights, off in daylight
  x.fillRect(cx - bodyW * 0.44, bodyT + bodyH * 0.34, bodyW * 0.20, bodyH * 0.22);
  x.fillRect(cx + bodyW * 0.24, bodyT + bodyH * 0.34, bodyW * 0.20, bodyH * 0.22);
  x.fillStyle = '#0b0c10';                                              // scanner recess across the nose
  x.fillRect(cx - bodyW * 0.40, bodyT + bodyH * 0.04, bodyW * 0.80, bodyH * 0.24);
  x.fillStyle = 'rgba(0,0,0,0.22)';                                     // scanlines
  for (let y = 0; y < h; y += 2) x.fillRect(0, y, w, 1);
  // The tube face itself: a CRT is not a rectangle. Rounded corners and a
  // darkened edge are most of what separates "screen" from "poster", and they
  // cost nothing baked into the texture.
  const vig = x.createRadialGradient(w / 2, h / 2, h * 0.30, w / 2, h / 2, h * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(0.75, 'rgba(0,0,0,0.28)');
  vig.addColorStop(1, 'rgba(0,0,0,0.70)');
  x.fillStyle = vig; x.fillRect(0, 0, w, h);
  x.fillStyle = '#05050a';                                              // corner masks
  const rr = 13;
  for (const [ox, oy, sx, sy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
    x.beginPath(); x.moveTo(ox, oy);
    x.lineTo(ox + sx * rr, oy);
    x.quadraticCurveTo(ox, oy, ox, oy + sy * rr);
    x.closePath(); x.fill();
  }
}

// The scanner blob, rendered once into its own little canvas.
export function makeTvScanner(doc, w, h) {
  const c = doc.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,70,45,0.92)'); g.addColorStop(0.4, 'rgba(200,18,8,0.34)');
  g.addColorStop(1, 'rgba(180,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.fillStyle = '#d98070'; x.fillRect(w / 2 - 2, h / 2 - 2, 4, 4);      // hot core
  return c;
}

// 80s-bedroom scene textures (cached): navy/beige geometric wallpaper, a garish
// neon-grid duvet, three era posters (synthwave car / sci-fi / rock band), a
// CRT game frame, a silver boombox face, and a red-LED alarm-clock readout.
let _bedTex = null;
function bedroomTextures() {
  if (_bedTex) return _bedTex;
  if (typeof document === 'undefined') { _bedTex = {}; return _bedTex; }
  const cv = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return c; };
  const mk = (c, rx = 1, ry = 1) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.colorSpace = THREE.SRGBColorSpace; t._shared = true; return t; };
  // Navy/beige geometric repeating wallpaper (faded 80s).
  const wallpaper = mk(cv(128, 128, (x, w, h) => {
    x.fillStyle = '#1d2740'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#b7a279'; x.fillStyle = '#b7a279'; x.lineWidth = 2;
    for (let yy = 0; yy < h; yy += 32) for (let xx = 0; xx < w; xx += 32) {
      x.beginPath(); x.moveTo(xx + 16, yy + 3); x.lineTo(xx + 29, yy + 16); x.lineTo(xx + 16, yy + 29); x.lineTo(xx + 3, yy + 16); x.closePath(); x.stroke();
      x.fillRect(xx + 15, yy + 15, 3, 3);
    }
  }), 5, 3);
  // Garish neon-grid duvet (spaceship-era).
  const duvet = mk(cv(128, 128, (x, w, h) => {
    x.fillStyle = '#0b0f2a'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#ff2fbf'; x.lineWidth = 2;
    for (let i = 0; i <= w; i += 16) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); }
    x.strokeStyle = '#22e0ff';
    for (let i = 0; i <= h; i += 16) { x.beginPath(); x.moveTo(0, i); x.lineTo(w, i); x.stroke(); }
    x.fillStyle = '#ffe24a'; for (let i = 0; i < 22; i++) x.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 3, 3);
  }), 3, 2);
  // Poster: synthwave sunset + grid + car.
  const posterSynth = mk(cv(128, 176, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#2a0a3a'); g.addColorStop(0.5, '#a01e6e'); g.addColorStop(0.68, '#ff5a3c'); g.addColorStop(1, '#ffd24a');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = '#ffe24a'; x.beginPath(); x.arc(w / 2, h * 0.4, 24, 0, 7); x.fill();
    x.fillStyle = g; for (let yy = h * 0.34; yy < h * 0.44; yy += 6) x.fillRect(w / 2 - 24, yy, 48, 3);
    x.strokeStyle = 'rgba(60,220,255,0.85)'; x.lineWidth = 1.4;
    for (let i = -6; i <= 18; i++) { x.beginPath(); x.moveTo(w / 2 + (i - 6) * 6, h * 0.62); x.lineTo(w / 2 + (i - 6) * 42, h); x.stroke(); }
    for (let yy = h * 0.62; yy < h; yy += 9) { x.beginPath(); x.moveTo(0, yy); x.lineTo(w, yy); x.stroke(); }
    x.fillStyle = '#101018'; x.fillRect(w * 0.34, h * 0.56, w * 0.32, 9); x.fillRect(w * 0.41, h * 0.51, w * 0.18, 7);
  }));
  // Poster: sci-fi (planet + starfield + title).
  const posterSciFi = mk(cv(128, 176, (x, w, h) => {
    x.fillStyle = '#05060f'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 130; i++) { x.fillStyle = `rgba(255,255,255,${0.4 + Math.random() * 0.6})`; x.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1); }
    const g = x.createRadialGradient(w * 0.68, h * 0.32, 4, w * 0.68, h * 0.32, 32); g.addColorStop(0, '#8fb0ff'); g.addColorStop(1, '#12204a');
    x.fillStyle = g; x.beginPath(); x.arc(w * 0.68, h * 0.32, 28, 0, 7); x.fill();
    x.fillStyle = '#ffcc33'; x.font = 'bold 15px sans-serif'; x.textAlign = 'center'; x.fillText('STAR', w / 2, h * 0.82); x.fillText('QUEST', w / 2, h * 0.92);
  }));
  // Poster: rock band (lightning bolt + logo).
  const posterBand = mk(cv(128, 176, (x, w, h) => {
    x.fillStyle = '#0a0a0c'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#e6e6e6'; x.lineWidth = 5; x.beginPath(); x.moveTo(w * 0.52, 10); x.lineTo(w * 0.4, h * 0.46); x.lineTo(w * 0.56, h * 0.46); x.lineTo(w * 0.42, h - 12); x.stroke();
    x.fillStyle = '#d61f2b'; x.font = 'bold 22px sans-serif'; x.textAlign = 'center'; x.fillText('VOLT', w / 2, h * 0.9);
  }));
  // CRT TV: the show that was on every screen in 1984 — a black sports car on a
  // night highway, its nose scanner sweeping. Redrawn each frame from
  // drawTvFrame so the scanner actually moves; the canvas is kept so the scene's
  // animate() can reach the 2d context.
  const crtCanvas = document.createElement('canvas'); crtCanvas.width = 128; crtCanvas.height = 96;
  const crtCtx = crtCanvas.getContext('2d');
  const crtBack = document.createElement('canvas'); crtBack.width = 128; crtBack.height = 96;
  drawTvBackdrop(crtBack.getContext('2d'), 128, 96);
  const crtScan = makeTvScanner(document, 24, 11);
  crtCtx.drawImage(crtBack, 0, 0);
  const crt = mk(crtCanvas);
  // Silver dual-cassette boombox face.
  const boombox = mk(cv(160, 80, (x, w, h) => {
    x.fillStyle = '#b8bcc4'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#8a8e96'; x.fillRect(2, 2, w - 4, h - 4);
    x.fillStyle = '#181c22'; x.beginPath(); x.arc(w * 0.2, h * 0.5, h * 0.34, 0, 7); x.fill(); x.beginPath(); x.arc(w * 0.8, h * 0.5, h * 0.34, 0, 7); x.fill();
    x.fillStyle = '#0a0c10'; x.fillRect(w * 0.4, h * 0.3, w * 0.2, h * 0.22); x.fillRect(w * 0.4, h * 0.56, w * 0.2, h * 0.14);
    x.fillStyle = '#3aa0c0'; x.fillRect(w * 0.4, h * 0.08, w * 0.2, h * 0.12);
  }));
  // Red-LED alarm-clock readout ("11:42").
  const clock = mk(cv(128, 48, (x, w, h) => {
    x.fillStyle = '#160806'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#ff2a1a'; x.font = 'bold 34px monospace'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('11:42', w / 2, h / 2 + 3);
  }));
  // Corkboard snapshots. At 18x20 cm across a dark room these have to read as
  // silhouettes, so: bold shapes, era palette, and an instant print's fat border.
  const photo = (draw) => mk(cv(72, 80, (x, w, h) => {
    x.fillStyle = '#efece2'; x.fillRect(0, 0, w, h);
    const ix = 5, iy = 5, iw = w - 10, ih = h - 20;                   // deep bottom border
    x.save(); x.beginPath(); x.rect(ix, iy, iw, ih); x.clip();
    draw(x, ix, iy, iw, ih);
    x.restore();
    x.fillStyle = 'rgba(0,0,0,0.10)'; x.fillRect(ix, iy + ih - 1, iw, 1);
  }));
  const photoBeach = photo((x, ix, iy, iw, ih) => {
    const g = x.createLinearGradient(0, iy, 0, iy + ih);
    g.addColorStop(0, '#3b2a6a'); g.addColorStop(0.45, '#e0663c'); g.addColorStop(1, '#f0b463');
    x.fillStyle = g; x.fillRect(ix, iy, iw, ih);
    x.fillStyle = '#ffe9a8'; x.beginPath(); x.arc(ix + iw * 0.58, iy + ih * 0.52, iw * 0.13, 0, 7); x.fill();
    x.fillStyle = '#20143a'; x.fillRect(ix, iy + ih * 0.66, iw, ih * 0.34);           // sea
    x.fillStyle = 'rgba(255,220,150,0.5)'; x.fillRect(ix + iw * 0.54, iy + ih * 0.66, iw * 0.08, ih * 0.34);
    x.fillStyle = '#140c22';                                                          // palm
    x.fillRect(ix + iw * 0.16, iy + ih * 0.34, 2, ih * 0.5);
    for (let i = -2; i <= 2; i++) { x.beginPath(); x.moveTo(ix + iw * 0.17, iy + ih * 0.34);
      x.lineTo(ix + iw * 0.17 + i * 5, iy + ih * 0.22); x.lineTo(ix + iw * 0.17 + i * 7, iy + ih * 0.30); x.closePath(); x.fill(); }
  });
  const photoCar = photo((x, ix, iy, iw, ih) => {
    x.fillStyle = '#8fa6bd'; x.fillRect(ix, iy, iw, ih);                              // sky
    x.fillStyle = '#6d6a62'; x.fillRect(ix, iy + ih * 0.55, iw, ih * 0.45);           // tarmac
    x.fillStyle = '#c8352c';                                                          // red coupe, side on
    x.fillRect(ix + iw * 0.12, iy + ih * 0.44, iw * 0.76, ih * 0.20);
    x.fillRect(ix + iw * 0.28, iy + ih * 0.33, iw * 0.42, ih * 0.13);
    x.fillStyle = '#22303c'; x.fillRect(ix + iw * 0.32, iy + ih * 0.35, iw * 0.34, ih * 0.09);
    x.fillStyle = '#15161a';                                                          // wheels
    x.fillRect(ix + iw * 0.22, iy + ih * 0.60, iw * 0.13, ih * 0.10);
    x.fillRect(ix + iw * 0.65, iy + ih * 0.60, iw * 0.13, ih * 0.10);
  });
  const photoMates = photo((x, ix, iy, iw, ih) => {
    x.fillStyle = '#2a1f3a'; x.fillRect(ix, iy, iw, ih);
    for (let i = 0; i < 26; i++) {                                                    // streamers
      x.fillStyle = ['#ffd54a', '#4ad2ff', '#ff5aa8'][i % 3];
      x.fillRect(ix + Math.random() * iw, iy + Math.random() * ih * 0.6, 2, 4);
    }
    const head = (cx2, cy2, r, skin, hair) => {
      x.fillStyle = skin; x.beginPath(); x.arc(cx2, cy2, r, 0, 7); x.fill();
      x.fillStyle = hair; x.beginPath(); x.arc(cx2, cy2 - r * 0.35, r, Math.PI, 0); x.fill();
    };
    x.fillStyle = '#d84a7a'; x.fillRect(ix + iw * 0.06, iy + ih * 0.66, iw * 0.40, ih * 0.34);   // shoulders
    x.fillStyle = '#3f7ad8'; x.fillRect(ix + iw * 0.52, iy + ih * 0.66, iw * 0.42, ih * 0.34);
    head(ix + iw * 0.26, iy + ih * 0.55, iw * 0.13, '#e8b98d', '#2b1a12');
    head(ix + iw * 0.72, iy + ih * 0.55, iw * 0.13, '#dfa87c', '#4a3020');
  });
  // Handwriting: a script face is only half of it, so each glyph gets its own rise
  // and tilt. Off the character index, not random, so a note is stable per build.
  const noteSlip = (bg, ink, text) => mk(cv(234, 81, (x, w, h) => {
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(0,0,0,0.07)'; x.fillRect(0, h - 3, w, 3);        // curl
    x.fillStyle = ink;
    x.font = 'italic 600 30px "Segoe Script", "Bradley Hand", "Brush Script MT", cursive';
    x.textBaseline = 'middle';
    const total = x.measureText(text).width;
    let cx2 = (w - total) / 2;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const rise = Math.sin(i * 1.7) * 2.2 + Math.sin(i * 0.6) * 1.4;
      x.save();
      x.translate(cx2, h / 2 + rise);
      x.rotate(Math.sin(i * 2.3) * 0.05);
      x.fillText(ch, 0, 0);
      x.restore();
      cx2 += x.measureText(ch).width;
    }
  }));
  const noteYellow = noteSlip('#e8b64a', '#3a2708', 'DJ Kat on Friday');
  const noteBlue = noteSlip('#5aa8d8', '#0e2438', 'Transformers rulez!');

  // Grime: soft blotches used as a roughnessMap so the big flat surfaces stop
  // sharing one perfectly even specular. Non-colour data.
  const grime = mk(cv(256, 256, (x, w, h) => {
    x.fillStyle = '#b4b4b4'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 220; i++) {
      const r = 6 + Math.random() * 34, gx = Math.random() * w, gy = Math.random() * h;
      const v = Math.random() < 0.5 ? 255 : 90;
      const g = x.createRadialGradient(gx, gy, 0, gx, gy, r);
      g.addColorStop(0, `rgba(${v},${v},${v},0.20)`); g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      x.fillStyle = g; x.fillRect(gx - r, gy - r, r * 2, r * 2);
    }
  }), 3, 3);
  if (grime) grime.colorSpace = THREE.NoColorSpace;

  // A soft diagonal band, used as the reflection sliding across the CRT glass.
  const sheen = mk(cv(64, 32, (x, w, h) => {
    const g = x.createLinearGradient(0, h, w * 0.75, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.45, 'rgba(210,230,255,0.55)');
    g.addColorStop(0.62, 'rgba(210,230,255,0.22)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  }));

  // Soft radial glow (white → transparent) for light halos — no hard edge.
  const glow = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.26)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t._shared = true; return t;
  })();
  // Lengthwise fade for the moonlight volume. The shaft itself is a shallow
  // frustum, so it keeps its width from every orbit angle.
  const moonBeam = mk(cv(128, 256, (x, w, h) => {
    const fade = x.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(255,255,255,0.18)');
    fade.addColorStop(0.18, 'rgba(255,255,255,0.72)');
    fade.addColorStop(0.78, 'rgba(255,255,255,0.42)');
    fade.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = fade; x.fillRect(0, 0, w, h);
  }));
  // Horizontal laminate grain for the desk. Colour and roughness variation are
  // broad enough to survive the dark practical lighting without looking noisy.
  const deskWood = mk(cv(256, 128, (x, w, h) => {
    x.fillStyle = '#765033'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 150; i++) {
      const yy = Math.random() * h, bend = Math.random() * 7 - 3.5;
      x.strokeStyle = `rgba(${65 + (i % 4) * 10},${35 + (i % 3) * 7},${18 + (i % 2) * 5},${0.08 + Math.random() * 0.12})`;
      x.lineWidth = 0.5 + Math.random() * 1.5;
      x.beginPath(); x.moveTo(0, yy);
      x.bezierCurveTo(w * 0.3, yy + bend, w * 0.7, yy - bend, w, yy + bend * 0.4); x.stroke();
    }
    const wear = x.createRadialGradient(w * 0.58, h * 0.48, 2, w * 0.58, h * 0.48, w * 0.34);
    wear.addColorStop(0, 'rgba(215,170,120,0.12)'); wear.addColorStop(1, 'rgba(215,170,120,0)');
    x.fillStyle = wear; x.fillRect(0, 0, w, h);
  }), 2.4, 1.2);
  // Uneven age and fading over the geometric wallpaper. This is layered only
  // around the window and posters instead of repeating across every wall.
  const wallWear = mk(cv(256, 256, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    const faded = x.createRadialGradient(w * 0.44, h * 0.45, 4, w * 0.44, h * 0.45, w * 0.5);
    faded.addColorStop(0, 'rgba(184,151,103,0.30)');
    faded.addColorStop(0.55, 'rgba(105,76,48,0.10)'); faded.addColorStop(1, 'rgba(30,20,24,0)');
    x.fillStyle = faded; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const gx = Math.random() * w, gy = Math.random() * h, r = 4 + Math.random() * 22;
      const stain = x.createRadialGradient(gx, gy, 0, gx, gy, r);
      stain.addColorStop(0, 'rgba(42,27,20,0.18)'); stain.addColorStop(1, 'rgba(42,27,20,0)');
      x.fillStyle = stain; x.fillRect(gx - r, gy - r, r * 2, r * 2);
    }
  }));
  // Rubik's-cube faces: a 3×3 grid of colour stickers with black gaps, one per
  // side (solved). Box material order is [+x, -x, +y, -y, +z, -z].
  const rubFace = (col) => {
    const c = document.createElement('canvas'); c.width = c.height = 96; const x = c.getContext('2d');
    x.fillStyle = '#0a0a0a'; x.fillRect(0, 0, 96, 96);
    const g = 7, s = (96 - 4 * g) / 3; x.fillStyle = col;
    for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) x.fillRect(g + cc * (s + g), g + r * (s + g), s, s);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t._shared = true; return t;
  };
  const rubik = ['#c41e3a', '#ff5800', '#ffffff', '#ffd500', '#0051ba', '#009e60'].map(rubFace);   // red/orange/white/yellow/blue/green
  // Contact occlusion for the grounding decals. A shadow map answers "does the key
  // reach here", not "how much sky can this crack see" — so unlit furniture floats.
  const contact = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,0.50)'); gr.addColorStop(0.42, 'rgba(0,0,0,0.34)');
    gr.addColorStop(0.72, 'rgba(0,0,0,0.10)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;   // else the rim wraps onto the core
    t.colorSpace = THREE.SRGBColorSpace; t._shared = true; return t;
  })();
  _bedTex = markShared({ wallpaper, duvet, posterSynth, posterSciFi, posterBand, crt, boombox, clock, glow, moonBeam, deskWood, wallWear, sheen, grime, contact, photoBeach, photoCar, photoMates, noteYellow, noteBlue, rubik });
  _bedTex.crtCtx = crtCtx; _bedTex.crtBack = crtBack; _bedTex.crtScan = crtScan;   // for the per-frame sweep
  return _bedTex;
}

export const scene = {
    // A messy 1980s teenage boy's bedroom, late evening. The C64 keeps its fixed
    // anchor — here it sits on a faux-wood desk, and the whole room is built
    // around/below it (carpet a desk-height beneath the model base). Practical
    // lights only: a warm amber Luxo desk lamp (the key), a flickering cyan CRT
    // TV, a faint red alarm-clock glow, and cool moonlight through venetian
    // blinds. Room meshes live in a metres-scaled group; lights are world-space with
    // decay 2, intensities quoted per square metre (see IL) to stay scale-independent.
    // Post is ON for this scene (no `basic` flag): the room is lit by practicals
    // in the dark, which is exactly what bloom, vignette and grain are for. The
    // threshold is high so only the bulb, the CRT and the LEDs bleed — lit walls
    // must not. Bloom itself is skipped on phones (see _lowPowerDevice).
    name: '80s Bedroom', css: 'scene-bedroom', envInt: 0.07, exposure: 1.2,
    bloom: { strength: 0.55, radius: 0.85, threshold: 0.88 },
    // The teal/amber split, carried into the shadows and highlights the two keys
    // can't reach. Gentle on purpose: it passes over the monitor picture too.
    grade: { split: 0.55, shadow: [0.88, 0.98, 1.10], highlight: [1.09, 1.00, 0.88] },
    screenOff: true,        // the model's pale stock glass reads as "on" in a dark room
    halation: [[1, 1, 1], [1, 0.95, 0.90], [1, 0.86, 0.75], [1, 0.77, 0.60], [1, 0.70, 0.50]],
    bg: [[0, '#08060d'], [1, '#08060d']],
    build(g, { sphere, box }) {
      const R = sphere.radius, cx = sphere.center.x, cz = sphere.center.z, gy = box.min.y;
      const S = R * 1.04;                    // world units per metre (smaller → the fixed C64 reads larger in the room)
      const DESKH = 0.72;                    // desk-top height (m); the C64 base sits here
      const floorY = gy - DESKH * S;         // carpet level, one desk-height below the model
      const W = 5.0, D = 5.4, H = 2.7;       // room size (m)
      const wc = (lx, ly, lz) => new THREE.Vector3(cx + lx * S, floorY + ly * S, cz + lz * S);

      const room = new THREE.Group(); room.scale.setScalar(S); room.position.set(cx, floorY, cz); g.add(room);
      const tex = roomTextures(), btex = bedroomTextures();

      const std = (c, r, m) => new THREE.MeshStandardMaterial({ color: c, roughness: r == null ? 0.85 : r, metalness: m || 0 });
      const emis = (c, amt) => { const m = std(c, 0.5); m.emissive = new THREE.Color(c).multiplyScalar(amt == null ? 1 : amt); return m; };
      const bx = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      const rbx = (w, h, d, r, m) => new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), m);
      const cyl = (rt, rb, h, m, s = 14) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, s), m);
      const add = (mesh, x, y, z, ry, parent) => { mesh.position.set(x, y, z); if (ry) mesh.rotation.y = ry; (parent || room).add(mesh); return mesh; };

      // A single roughness value over a whole desk or wall gives one flat, even
      // specular — the "computer render" tell. The grime map varies it so light
      // grazes unevenly, the way a real surface wears.
      const rough = (m, r) => { m.roughnessMap = btex.grime; m.roughness = r; return m; };
      const trimMat = std(0x6b4426, 0.6);
      const woodDesk = rough(new THREE.MeshStandardMaterial({ map: btex.deskWood, color: 0x8a6a50, roughness: 0.82 }), 0.82);   // worn faux-wood laminate
      const metalMat = std(0x35383f, 0.5, 0.65);
      const blackPl = std(0x14151a, 0.6);            // black plastic

      // ── Shell: shag carpet (tinted burnt-orange), popcorn ceiling ──
      // `noCast`: the room shell receives shadows but must never throw them. The
      // moon is OUTSIDE the window — let the back wall cast and it shadows the
      // whole room, and the stripes the blinds are there to make never arrive.
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: tex.carpet, bumpMap: tex.carpetBump, bumpScale: 0.5, color: 0xd98a3a, roughness: 1, roughnessMap: btex.grime }));
      floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.userData.noCast = true; room.add(floor);
      const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: tex.ceiling, color: 0xb8b2a4, roughness: 1 }));
      ceiling.rotation.x = Math.PI / 2; ceiling.position.y = H; ceiling.userData.noCast = true; room.add(ceiling);

      // ── Walls: navy geometric wallpaper, faux-wood paneling on the LEFT wall ──
      const RAIL = 0.95;
      // `hole` cuts an aperture out of the upper wall (wall-local x, and a height
      // measured from the rail). A wall with a hole CASTS: that is what turns the
      // moon outside into a window-shaped patch on the floor, with the blinds
      // striping it. A solid wall can only do one of two useless things — block
      // the moon entirely, or (as `noCast`) let it through as if the wall weren't
      // there. Only the back wall needs it, so the other three stay one quad.
      const wall = (width, x, z, ry, paneled, hole) => {
        const wg = new THREE.Group();
        const upMap = paneled ? tex.panel : btex.wallpaper;
        // A piece of wall smaller than the whole wall must still show the SAME
        // stretch of wallpaper it would have covered. PlaneGeometry always maps
        // uv 0..1 across itself, so three strips around a window each rescaled
        // the pattern to their own width — visibly different sizes left of the
        // glass, above it, and on the far side. `uv` is that sub-rectangle of the
        // full wall, in 0..1, and the geometry's uvs are remapped into it.
        const face = (w, h, px, py, map, cast, uv) => {
          const geo = new THREE.PlaneGeometry(w, h);
          if (uv) {
            const a = geo.attributes.uv;
            for (let i = 0; i < a.count; i++) {
              a.setXY(i, uv.u0 + a.getX(i) * (uv.u1 - uv.u0), uv.v0 + a.getY(i) * (uv.v1 - uv.v0));
            }
            a.needsUpdate = true;
          }
          const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, roughness: map === tex.panel ? 0.95 : 1, roughnessMap: btex.grime }));
          m.position.set(px, py, 0); m.receiveShadow = true;
          if (cast) m.castShadow = true; else m.userData.noCast = true;
          wg.add(m); return m;
        };
        face(width, RAIL, 0, RAIL / 2, tex.panel, !!hole);
        if (!hole) {
          face(width, H - RAIL, 0, RAIL + (H - RAIL) / 2, upMap, false);
        } else {
          // Left, right and the header strip above the opening.
          const hx0 = hole.x - hole.w / 2, hx1 = hole.x + hole.w / 2;
          const lw = hx0 + width / 2, rw = width / 2 - hx1;
          const top = RAIL + hole.h, upH = H - RAIL;
          const uOf = (lx) => (lx + width / 2) / width;          // wall-local x → u
          const vOf = (ly) => (ly - RAIL) / upH;                 // wall-local y → v
          if (lw > 0.01) face(lw, upH, -width / 2 + lw / 2, RAIL + upH / 2, upMap, true,
            { u0: 0, u1: uOf(hx0), v0: 0, v1: 1 });
          if (rw > 0.01) face(rw, upH, width / 2 - rw / 2, RAIL + upH / 2, upMap, true,
            { u0: uOf(hx1), u1: 1, v0: 0, v1: 1 });
          face(hole.w, H - top, hole.x, top + (H - top) / 2, upMap, true,
            { u0: uOf(hx0), u1: uOf(hx1), v0: vOf(top), v1: 1 });
        }
        const rail = bx(width, 0.045, 0.025, trimMat); rail.position.set(0, RAIL, 0.013); wg.add(rail);
        const base = bx(width, 0.1, 0.02, trimMat); base.position.set(0, 0.05, 0.011); wg.add(base);
        wg.position.set(x, 0, z); wg.rotation.y = ry; room.add(wg);
      };
      // The window is 1.3 wide at x -1.3, its sill on the rail — so the aperture
      // is exactly the upper-wall span the glass occupies.
      wall(W, 0, -D / 2, 0, false, { x: -1.3, w: 1.3, h: 1.1 });   // back — with the window opening
      wall(W, 0, D / 2, Math.PI, false);       // front (behind camera)
      wall(D, -W / 2, 0, Math.PI / 2, true);   // left — faux-wood paneling
      wall(D, W / 2, 0, -Math.PI / 2, false);  // right

      // Localized wallpaper patina: the window has faded its surround while
      // taped posters have left uneven darker patches. It remains light-reactive
      // so the marks disappear naturally into the room's unlit corners.
      const wearMat = new THREE.MeshStandardMaterial({ map: btex.wallWear, transparent: true, opacity: 0.34, roughness: 1, depthWrite: false });
      const backWear = new THREE.Mesh(new THREE.PlaneGeometry(3.9, 2.35), wearMat);
      backWear.position.set(-0.25, 1.52, -D / 2 + 0.018); backWear.userData.noCast = true; room.add(backWear);

      // ── Window + dusty venetian blinds on the back wall ──
      const winG = new THREE.Group(); winG.position.set(-1.3, 1.5, -D / 2 + 0.02); room.add(winG);
      const winW = 1.3, winH = 1.1;
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH), new THREE.MeshBasicMaterial({ map: tex.sky }));
      pane.userData.noCast = true;                 // the aperture, not an occluder
      winG.add(pane);
      const alu = std(0x9aa0a8, 0.5, 0.4);
      [[winW + 0.1, 0.06, 0, winH / 2], [winW + 0.1, 0.06, 0, -winH / 2], [0.06, winH + 0.1, -winW / 2, 0], [0.06, winH + 0.1, winW / 2, 0]]
        .forEach(([w, h, x, y]) => add(bx(w, h, 0.05, alu), x, y, 0.02, 0, winG));
      const slatMat = std(0xd8d3c4, 0.85);
      for (let i = 0; i < 9; i++) { const sl = bx(winW - 0.02, 0.055, 0.02, slatMat); sl.rotation.x = 0.35; add(sl, 0, winH / 2 - 0.09 - i * 0.12, 0.05, 0, winG); }
      // Where the moon actually APPEARS: it is painted into the sky texture at
      // u 0.72 / v 0.24 (the `sky` canvas in vibes-scene-common.js), i.e. up and
      // to the right of the window's centre. Both the moonlight spotlight and the
      // moonlight spotlight is sited from this one point, so the stripes it casts
      // through the slats line up with the moon you can see in the glass.
      const MOON_LX = -1.3 + (0.72 - 0.5) * winW;
      const MOON_LY = 1.5 + (0.5 - 0.24) * winH;
      const MOON_TARGET = [-0.7, 0, -0.4];          // where the beam lands on the carpet

      // ── Door on the right wall ──
      const doorG = new THREE.Group(); doorG.position.set(W / 2 - 0.02, 0, 1.7); doorG.rotation.y = -Math.PI / 2; room.add(doorG);
      add(bx(0.84, 2.02, 0.04, std(0x7a5230, 0.6)), 0, 1.01, 0, 0, doorG);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 10), std(0xb08d3e, 0.25, 0.9)), -0.33, 1.0, 0.05, 0, doorG);

      // ── The desk — sized and centred on the C64's ACTUAL footprint (its world
      //    bounding box → room-local metres) so the machine always sits fully on
      //    the top with a working margin, and clutter gets clear lanes to either
      //    side. The model never moves; the desk fits itself to the model. ──
      const fMinX = (box.min.x - cx) / S, fMaxX = (box.max.x - cx) / S;
      const fMinZ = (box.min.z - cz) / S, fMaxZ = (box.max.z - cz) / S;
      const fCX = (fMinX + fMaxX) / 2, fCZ = (fMinZ + fMaxZ) / 2;
      const dPadX = 0.4, dPadZ = 0.28;                                             // margin around the C64 (tighter → fills more of the desktop)
      const deskW = (fMaxX - fMinX) + dPadX * 2, deskD = (fMaxZ - fMinZ) + dPadZ * 2;
      const deskL = fCX - deskW / 2, deskR = fCX + deskW / 2, deskB = fCZ - deskD / 2, deskF = fCZ + deskD / 2;
      const deskTop = rbx(deskW, 0.05, deskD, 0.018, woodDesk); deskTop.castShadow = true; deskTop.receiveShadow = true;
      deskTop.userData.ground = true;   // legs are too thin to ground; the top shades the floor
      add(deskTop, fCX, DESKH - 0.025, fCZ);                                       // top face at y=DESKH; shades the floor + catches the cable shadows
      const leg = () => cyl(0.022, 0.022, DESKH - 0.05, metalMat, 8);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => add(leg(), fCX + sx * (deskW / 2 - 0.08), (DESKH - 0.05) / 2, fCZ + sz * (deskD / 2 - 0.08)));
      add(bx(deskW - 0.12, 0.28, 0.03, woodDesk), fCX, DESKH - 0.2, deskB + 0.03);   // modesty panel at back
      const RX = Math.min(fMaxX + 0.24, deskR - 0.14), LX = Math.max(fMinX - 0.24, deskL + 0.14);   // clutter lanes, clear of the C64

      // ── Rolling office chair with a draped denim jacket (in front of the desk) ──
      const chair = new THREE.Group(); add(chair, fCX, 0, deskF + 0.24);
      const seatMat = std(0x772f2a, 0.9);
      add(rbx(0.44, 0.07, 0.42, 0.028, seatMat), 0, 0.5, 0, 0, chair);
      add(rbx(0.44, 0.5, 0.07, 0.026, seatMat), 0, 0.74, 0.19, 0, chair);
      add(cyl(0.03, 0.03, 0.44, metalMat, 8), 0, 0.27, 0, 0, chair);
      for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; const spoke = bx(0.26, 0.03, 0.04, blackPl); spoke.rotation.y = a; add(spoke, Math.sin(a) * 0.13, 0.05, Math.cos(a) * 0.13, 0, chair); }
      const denim = std(0x3a557f, 0.9);                                             // faded denim jacket over the backrest
      add(rbx(0.5, 0.34, 0.1, 0.035, denim), 0, 0.78, 0.24, 0, chair);
      add(rbx(0.12, 0.3, 0.09, 0.025, denim), -0.28, 0.7, 0.24, 0, chair);
      add(rbx(0.12, 0.3, 0.09, 0.025, denim), 0.28, 0.7, 0.24, 0, chair);

      // ── Desk clutter: Luxo lamp, Walkman + headphones, Rubik's cube, soda,
      //    floppies + cassettes, homework paper ──
      // Luxo-style articulated desk lamp (beige) — the key light. Arms are bones
      // drawn between explicit joints so the base, elbow and head stay connected.
      // The group origin is where the base meets the desk, so scaling grows the
      // lamp about that point and the base stays put.
      const LAMP_S = 1.15;
      const LAMP_X = deskL + 0.2, LAMP_Z = deskB + 0.14;
      const LAMP_BULB = [0.34, 0.44, 0.07];   // lamp-local: J2 + the bulb inside the head
      const lamp = new THREE.Group(); add(lamp, LAMP_X, DESKH, LAMP_Z);
      lamp.scale.setScalar(LAMP_S);
      // Matte painted metal, not white plastic. The arm is the nearest surface to
      // the bulb, so it is legitimately the brightest thing in frame — but at
      // near-white/low-roughness it clipped and bloomed into a light sabre.
      const lampMat = std(0xd2c9b4, 0.78);
      const lbone = (a, b, r) => {
        const av = new THREE.Vector3(...a), d = new THREE.Vector3(...b).sub(av), len = d.length();
        const seg = cyl(r, r, len, lampMat, 8); seg.position.copy(av).addScaledVector(d, 0.5);
        seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()); lamp.add(seg);
      };
      add(cyl(0.09, 0.11, 0.03, lampMat, 18), 0, 0.015, 0, 0, lamp);           // weighted base
      const J1 = [0.05, 0.34, 0.01], J2 = [0.32, 0.48, 0.05];
      lbone([0, 0.03, 0], J1, 0.013); lbone(J1, J2, 0.013);                    // lower + upper arm
      add(new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), lampMat), J1[0], J1[1], J1[2], 0, lamp);   // elbow knuckle
      const head = new THREE.Group(); add(head, J2[0], J2[1], J2[2], 0, lamp);
      // A shade with a bulb in it glows. The spot's cone deliberately misses the
      // inner wall (that is the point of the snoot), so the glow is emissive
      // rather than lit — which is also what stops it blowing out.
      const shadeMat = std(0xd8d0bd, 0.7); shadeMat.side = THREE.DoubleSide;
      shadeMat.emissive = new THREE.Color(0xffb060); shadeMat.emissiveIntensity = 0.085;
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.095, 0.15, 18, 1, true), shadeMat);
      shade.castShadow = true;                                                    // hoods the bulb: without this the "shade" is decoration and the bare bulb lights the arm, the ceiling and everything else
      add(shade, 0.02, -0.06, 0.02, 0, head);                                     // cone shade: wide opening straight DOWN
      const cap = cyl(0.033, 0.033, 0.01, lampMat, 18); cap.castShadow = true;
      add(cap, 0.02, 0.015, 0.02, 0, head);                                       // top cap closes the shade over the bulb
      const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false });
      bulbMat.color.multiplyScalar(2.2);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), bulbMat), 0.02, -0.04, 0.02, 0, head);   // recessed hot bulb; bloom supplies the halo without a camera-facing sprite
      // Walkman + orange-foam headphones (right lane).
      add(bx(0.11, 0.03, 0.16, std(0xe8c23a, 0.5)), RX, DESKH + 0.015, deskB + 0.2);
      const hp = new THREE.Group();                                               // headphones: headband arc + padded earcups (not a full ring)
      add(new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.013, 8, 22, Math.PI), blackPl), 0, 0.035, 0, 0, hp);   // band (∩ arc)
      [-1, 1].forEach((sx) => {
        const cup = cyl(0.038, 0.038, 0.032, blackPl, 16); cup.rotation.z = Math.PI / 2; add(cup, sx * 0.09, 0.035, 0, 0, hp);
        const pad = cyl(0.03, 0.03, 0.014, std(0xe07a1e, 0.85), 16); pad.rotation.z = Math.PI / 2; add(pad, sx * 0.078, 0.035, 0, 0, hp);   // orange foam (inner face)
      });
      add(hp, RX, DESKH + 0.006, deskF - 0.2, -0.5);                              // resting on the desk, angled
      // Rubik's cube — proper 3×3 sticker faces (one colour per side, solved);
      // a touch of emissive so the colours read in the dim room.
      const rubMats = btex.rubik.map((t) => new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.18, roughness: 0.55 }));
      add(bx(0.09, 0.09, 0.09, rubMats), RX, DESKH + 0.045, fCZ, 0.5);
      // Half-empty soda glass. Its x comes off the lamp, not the lane: the lane's left
      // edge sits under the base, and the base grows with LAMP_S. Solve the base
      // circle for the x that clears it at this z, then clamp short of the machine.
      const glassZ = deskB + 0.26, glassR = 0.035;
      const clearR = 0.11 * LAMP_S + glassR + 0.012;
      const glassClearX = LAMP_X + Math.sqrt(Math.max(0, clearR * clearR - (glassZ - LAMP_Z) ** 2));
      const glassX = Math.min(glassClearX + 0.06, fMinX - 0.06);   // nudged toward the drive
      add(cyl(0.035, 0.03, 0.11, new THREE.MeshStandardMaterial({ color: 0x6a3a12, roughness: 0.2, metalness: 0, transparent: true, opacity: 0.8 })), glassX, DESKH + 0.055, glassZ);
      // Scattered floppies (right lane + floor) and cassette cases.
      const floppyMat = [std(0x1a1a20, 0.7), std(0x243a6a, 0.7), std(0x6a1f2a, 0.7)];
      const floppy = (x, y, z, ry, p) => { const f = bx(0.13, 0.006, 0.13, floppyMat[(Math.random() * 3) | 0]); add(f, x, y, z, ry, p); add(bx(0.06, 0.007, 0.03, std(0xcfcfcf, 0.5)), x, y + 0.005, z + 0.05, ry, p); };
      floppy(RX - 0.03, DESKH + 0.01, deskF - 0.06, 0.3); floppy(RX + 0.05, DESKH + 0.02, deskF - 0.02, -0.5); floppy(-0.55, 0.02, 0.9, 0.9); floppy(-0.35, 0.02, 1.02, 0.2);
      const cass = (x, y, z, ry, p) => add(bx(0.1, 0.02, 0.065, std([0x202028, 0x30506a, 0x703040][(Math.random() * 3) | 0], 0.5)), x, y, z, ry, p);
      cass(RX + 0.03, DESKH + 0.012, deskB + 0.36, 0.2); cass(RX - 0.05, DESKH + 0.012, deskB + 0.48, -0.3); cass(-0.2, 0.02, 1.05, 0.6);
      // Homework paper stack (left lane).
      add(bx(0.22, 0.01, 0.28, std(0xece7d8, 0.9)), LX, DESKH + 0.006, fCZ, 0.15);

      // ── Corkboard above the desk (back wall): polaroids + concert tickets ──
      const cork = new THREE.Group(); add(cork, 0.3, 1.62, -D / 2 + 0.03);
      add(bx(1.0, 0.66, 0.03, std(0xb98a4a, 0.85)), 0, 0, 0, 0, cork);
      // A box, so it has an edge against the cork; artwork on face 4 (front) only.
      const pin = (w, h, x, y, c, r, map) => {
        const m = map ? new THREE.MeshStandardMaterial({ map, roughness: 0.82 }) : std(c, 0.6);
        const p = bx(w, h, 0.006, map ? [std(c, 0.6), std(c, 0.6), std(c, 0.6), std(c, 0.6), m, std(c, 0.6)] : m);
        p.rotation.z = r; add(p, x, y, 0.02, 0, cork);
      };
      pin(0.18, 0.2, -0.32, 0.08, 0xefece2, 0.1, btex.photoBeach);
      pin(0.18, 0.2, -0.08, 0.11, 0xefece2, -0.12, btex.photoMates);
      pin(0.18, 0.2, 0.18, 0.06, 0xefece2, 0.05, btex.photoCar);
      pin(0.26, 0.09, 0.3, -0.15, 0xe0a83a, -0.08, btex.noteYellow);
      pin(0.26, 0.09, 0.0, -0.18, 0x3a9ad0, 0.07, btex.noteBlue);

      // ── Posters, taped up at the corners ──
      const poster = (map, w, h, x, y, z, ry) => {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map, roughness: 0.92 }));
        add(p, x, y, z, ry);
        const tape = std(0xe8e6d0, 0.7);
        [[-w / 2 + 0.04, h / 2 - 0.04], [w / 2 - 0.04, h / 2 - 0.04]].forEach(([tx, ty]) => { const t = bx(0.07, 0.05, 0.004, tape); add(t, x + (ry ? 0 : tx), y + ty, z + (ry ? tx * Math.sign(ry) : 0.004), ry); });
        return p;
      };
      poster(btex.posterSynth, 0.86, 1.18, -W / 2 + 0.03, 1.55, 0.35, Math.PI / 2);   // left (wood-panel) wall — clear of the window
      poster(btex.posterSciFi, 0.8, 1.1, 1.3, 1.7, -D / 2 + 0.03, 0);            // back wall
      poster(btex.posterBand, 0.82, 1.12, W / 2 - 0.03, 1.75, -1.0, -Math.PI / 2); // right wall

      // ── Bed in the back-left corner: frame + mattress + garish duvet + pillow ──
      const bedG = new THREE.Group(); add(bedG, -1.82, 0, -1.35);
      const bedW = 0.98, bedL = 1.95;
      add(bx(bedW + 0.06, 0.3, bedL + 0.06, std(0x5a3a1e, 0.7)), 0, 0.2, 0, 0, bedG);   // frame
      add(bx(bedW + 0.06, 0.5, 0.08, std(0x5a3a1e, 0.7)), 0, 0.42, -bedL / 2, 0, bedG);  // headboard
      add(bx(bedW, 0.16, bedL, std(0xece7d8, 0.95)), 0, 0.4, 0, 0, bedG);                // mattress
      const duvetGeo = new THREE.PlaneGeometry(bedW + 0.04, bedL * 0.72, 12, 18);
      {
        const p = duvetGeo.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i);
          const fold = Math.sin(x * 19 + y * 4.5) * 0.018 + Math.sin(y * 12) * 0.012;
          const edgeDrop = Math.pow(Math.abs(x) / (bedW * 0.52), 5) * 0.055;
          p.setZ(i, fold - edgeDrop);
        }
        p.needsUpdate = true; duvetGeo.computeVertexNormals();
      }
      const duvetMesh = new THREE.Mesh(duvetGeo, new THREE.MeshStandardMaterial({ map: btex.duvet, roughness: 0.9, side: THREE.DoubleSide }));
      duvetMesh.rotation.x = -Math.PI / 2; add(duvetMesh, 0, 0.56, bedL * 0.12, 0, bedG);   // soft, folded duvet
      const pillow = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 12), std(0xf2eede, 0.95));
      pillow.scale.set(0.5, 0.13, 0.32); add(pillow, 0, 0.52, -bedL / 2 + 0.28, 0, bedG);

      // ── Bedside table: comics + wood-grain alarm clock (red LED) ──
      const nite = new THREE.Group(); add(nite, -2.12, 0, 0.06);   // beside the bed foot, clear of the frame
      add(bx(0.44, 0.5, 0.4, std(0x4a3016, 0.7)), 0, 0.25, 0, 0, nite);
      for (let i = 0; i < 4; i++) add(bx(0.18, 0.018, 0.13, std([0xd0402a, 0x2a6ad0, 0xe0b020, 0x30a040][i], 0.7)), -0.12 + (Math.random() - 0.5) * 0.03, 0.51 + i * 0.018, (Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.4, nite);   // comic stack (left of the clock)
      const clockG = new THREE.Group(); add(clockG, 0.09, 0.555, 0, 0.15, nite);   // seated on the nightstand, beside the comics
      add(bx(0.24, 0.11, 0.12, std(0x3a2a1a, 0.6)), 0, 0, 0, 0, clockG);
      // Over 1.0 on purpose: a MeshBasicMaterial outputs map x color, so pushing
      // the colour past white is the only way an unlit material can cross the
      // bloom threshold and let the LEDs actually bleed.
      const clockFace = new THREE.MeshBasicMaterial({ map: btex.clock });
      clockFace.color.setScalar(1.5);
      add(new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.075), clockFace), 0, 0.005, 0.067, 0, clockG);

      // ── Entertainment area (right): TV stand, wood-grain CRT + rabbit ears,
      //    game console, two joysticks, a deflated bean bag ──
      const tvStand = new THREE.Group(); add(tvStand, 1.7, 0, -1.05);
      const stW = 1.5, stD = 0.72, stH = 0.42;
      add(bx(stW, stH, stD, std(0x3a2a1a, 0.7)), 0, stH / 2, 0, 0, tvStand);       // stand box, top at stH
      // CRT TV resting ON the stand top (group origin AT the stand top so the
      // cabinet's bottom sits exactly on it), angled toward the room.
      const tv = new THREE.Group(); add(tv, -0.28, stH, 0, -0.4, tvStand);
      const CW = 0.66, CH = 0.54, CD = 0.48;
      add(rbx(CW, CH, CD, 0.028, std(0x5a4632, 0.6)), 0, CH / 2, 0, 0, tv);        // softened wood-grain cabinet, bottom at y=0
      add(bx(CW - 0.08, CH - 0.12, 0.04, blackPl), 0, CH / 2, CD / 2 - 0.004, 0, tv);   // recessed bezel
      // Bulged glass. A CRT's face is a section of a sphere, and the flat plane
      // this used to be is why it read as a photo taped to the cabinet: the
      // picture never bent, and no highlight ever travelled across it.
      const crtGeo = new THREE.PlaneGeometry(CW - 0.16, CH - 0.2, 12, 12);
      {
        const pos = crtGeo.attributes.position, hw = (CW - 0.16) / 2, hh = (CH - 0.2) / 2;
        for (let i = 0; i < pos.count; i++) {
          const u = pos.getX(i) / hw, v = pos.getY(i) / hh;
          pos.setZ(i, (1 - u * u * 0.55 - v * v * 0.55) * 0.022);       // shallow dome
        }
        pos.needsUpdate = true; crtGeo.computeVertexNormals();
      }
      const crtScreen = new THREE.Mesh(crtGeo, new THREE.MeshBasicMaterial({ map: btex.crt }));
      add(crtScreen, 0, CH / 2, CD / 2 + 0.02, 0, tv);                            // screen clearly in front of the bezel
      // The scanner's bleed. The picture itself is a MeshBasicMaterial capped at
      // its texture value, so nothing in it can ever cross the bloom threshold —
      // a separate additive sprite is the only way to get the red to actually
      // glow out of the tube. It rides in front of the glass and tracks the
      // sweep (see animate).
      const scanGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: btex.glow, color: 0xff4526, transparent: true, opacity: 0.125,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      const SCRW = CW - 0.16, SCRH = CH - 0.2;
      scanGlow.scale.set(SCRW * 0.17, SCRW * 0.17, 1);
      add(scanGlow, 0, CH / 2 - SCRH * 0.156, CD / 2 + 0.035, 0, tv);             // at the nose, just off the glass
      const scanSpill = new THREE.Sprite(new THREE.SpriteMaterial({
        map: btex.glow, color: 0xff3822, transparent: true, opacity: 0.028,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      scanSpill.scale.set(SCRW * 0.5, SCRH * 0.42, 1);
      add(scanSpill, 0, CH / 2 - SCRH * 0.13, CD / 2 + 0.031, 0, tv);             // broad red kiss across the tube/cabinet
      // Phosphor bleed: a soft wash across the whole glass, so the tube glows as
      // a tube rather than only where the scanner is. Kept low — this is the
      // difference between "lit screen" and "lamp in the corner".
      // Glass sheen: a soft diagonal reflection across the top-left of the tube.
      // Real CRT glass is glossy and always catches something; without it the
      // surface has no material at all.
      const sheen = new THREE.Mesh(
        new THREE.PlaneGeometry((CW - 0.16) * 0.40, (CH - 0.2) * 0.26),
        new THREE.MeshBasicMaterial({ map: btex.sheen, transparent: true, opacity: 0.085,
          blending: THREE.AdditiveBlending, depthWrite: false }));
      // Upper-left corner only. Spanning the tube, it stopped being a reflection
      // and became fog over the picture.
      add(sheen, -(CW - 0.16) * 0.26, CH / 2 + (CH - 0.2) * 0.27, CD / 2 + 0.042, 0, tv);
      const crtBleed = new THREE.Sprite(new THREE.SpriteMaterial({
        map: btex.glow, color: 0xbfd8ea, transparent: true, opacity: 0.038,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      crtBleed.scale.set(SCRW * 1.04, SCRH * 1.08, 1);
      add(crtBleed, 0, CH / 2, CD / 2 + 0.03, 0, tv);
      [-0.16, 0.16].forEach((dx, i) => { const ant = cyl(0.004, 0.004, 0.42 + i * 0.06, std(0xc0c0c0, 0.3, 0.8), 6); ant.rotation.z = dx > 0 ? -0.5 : 0.5; add(ant, dx, CH + 0.02, -0.1, 0, tv); });
      // Game console on the stand top, to the RIGHT of the TV (clear of it).
      add(bx(0.34, 0.08, 0.24, blackPl), 0.5, stH + 0.04, 0.02, 0.12, tvStand);
      add(bx(0.3, 0.02, 0.07, std(0x5a4632, 0.6)), 0.5, stH + 0.09, 0.03, 0.12, tvStand);   // wood switch strip on top
      const joystick = (x, z, ry, p, y0) => { const j = new THREE.Group(); add(bx(0.14, 0.05, 0.12, blackPl), 0, 0.025, 0, 0, j); add(cyl(0.012, 0.014, 0.09, blackPl, 8), 0, 0.07, 0, 0, j); add(new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), std(0xd6252b, 0.6)), 0, 0.12, 0, 0, j); add(j, x, y0 == null ? -0.008 : y0, z, ry, p); };   // default rests on the floor (base settled into the shag)
      joystick(0.75, deskF + 0.45, 0.4);               // on the floor in front of the desk
      const beanbag = new THREE.Group(); add(beanbag, 0.4, 0, deskF + 0.75);   // open floor in front of the desk
      const bbMat = std(0x3a2418, 0.85);               // dark brown vinyl, deflated
      add((() => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), bbMat); m.scale.set(1, 0.5, 1); return m; })(), 0, 0.2, 0, 0, beanbag);
      add((() => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), bbMat); m.scale.set(1, 0.6, 1); return m; })(), 0.02, 0.34, 0.05, 0, beanbag);
      joystick(1.05, deskF + 0.55, -0.6);              // the other controller, on the floor by the bean bag

      // ── Milk-crate shelving + boombox (left-front, against the left wall) ──
      const crates = new THREE.Group(); add(crates, -2.05, 0, 1.1);
      const crateMat = [std(0xc23a2a, 0.8), std(0x2a5ac2, 0.8), std(0xe0a020, 0.8)];
      const crate = (x, y, z, c) => { const cr = bx(0.42, 0.34, 0.42, crateMat[c]); add(cr, x, y, z, 0, crates); add(bx(0.34, 0.24, 0.34, std(0x2a2a30, 0.9)), x, y, z + 0.001, 0, crates); };  // dark interior (books/mags)
      crate(0, 0.17, 0, 0); crate(0, 0.51, 0, 1); crate(0.44, 0.17, 0, 2);
      // Detailed black boombox on top of the crates, angled toward the desk.
      const bb = new THREE.Group();
      const bbBlk = std(0x131317, 0.5), bbSil = std(0x9a9ea6, 0.35, 0.6), bbGril = std(0x26262c, 0.7), bbDk = std(0x090a0c, 0.6);
      const BW = 0.54, BH = 0.28, BD = 0.18;
      add(bx(BW, BH, BD, bbBlk), 0, 0, 0, 0, bb);                                   // body
      add(bx(BW + 0.02, 0.028, BD + 0.02, bbBlk), 0, BH / 2 - 0.014, 0, 0, bb);     // top ridge
      [-1, 1].forEach((sx) => {                                                     // speakers, facing +z
        const px = sx * (BW / 2 - 0.13);
        const ring = cyl(0.1, 0.1, 0.016, bbSil, 22); ring.rotation.x = Math.PI / 2; add(ring, px, -0.01, BD / 2 - 0.002, 0, bb);
        const grille = cyl(0.085, 0.085, 0.012, bbGril, 22); grille.rotation.x = Math.PI / 2; add(grille, px, -0.01, BD / 2 + 0.006, 0, bb);
        const cone = cyl(0.045, 0.06, 0.02, bbDk, 18); cone.rotation.x = -Math.PI / 2; add(cone, px, -0.01, BD / 2 + 0.012, 0, bb);
        add(new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), bbBlk), px, -0.01, BD / 2 + 0.016, 0, bb);   // dust cap
      });
      add(bx(0.2, 0.24, 0.012, bbDk), 0, 0, BD / 2 - 0.004, 0, bb);                 // recessed centre panel
      add(bx(0.15, 0.08, 0.02, bbBlk), 0, 0.05, BD / 2 + 0.004, 0, bb);             // cassette door
      add(bx(0.12, 0.055, 0.006, std(0x33434a, 0.3, 0.2)), 0, 0.05, BD / 2 + 0.014, 0, bb);   // cassette window
      add(bx(0.17, 0.028, 0.006, emis(0x2ad07a, 1.5)), 0, 0.095, BD / 2 + 0.008, 0, bb);      // tuner display (green), hot enough to bleed
      add(bx(0.004, 0.026, 0.007, std(0xff3020, 0.4)), 0.03, 0.095, BD / 2 + 0.012, 0, bb);   // tuner needle
      for (let i = -2; i <= 2; i++) add(bx(0.018, 0.022, 0.014, bbSil), i * 0.028, -0.075, BD / 2 + 0.006, 0, bb);   // transport buttons
      [-0.06, 0.06].forEach((kx) => { const k = cyl(0.02, 0.02, 0.016, bbSil, 12); k.rotation.x = Math.PI / 2; add(k, kx, -0.03, BD / 2 + 0.006, 0, bb); });   // dial knobs
      add(new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.013, 8, 22, Math.PI), bbBlk), 0, BH / 2 - 0.02, 0, 0, bb);   // carry handle
      const ant = cyl(0.004, 0.006, 0.36, bbSil, 6); ant.rotation.z = -0.5; add(ant, BW / 2 - 0.05, BH / 2 + 0.14, -BD / 2 + 0.04, 0, bb);   // antenna
      [-0.12, 0.12].forEach((kx) => add(cyl(0.016, 0.018, 0.02, bbSil, 12), kx, BH / 2 + 0.006, 0.02, 0, bb));   // top knobs
      add(bb, 0, 0.82, 0, 2.05, crates);   // on the crate stack, front toward the desk

      // ── Skateboard standing UPRIGHT against the right wall (deck vertical,
      //    wheels toward the wall), well clear of the door. ──
      const skate = new THREE.Group(); add(skate, W / 2 - 0.26, 0, 0.55, 0); skate.rotation.z = -0.2;   // lean the top into the wall
      add(bx(0.03, 0.82, 0.2, std(0x2a2a30, 0.7)), 0, 0.41, 0, 0, skate);              // deck (thin x, tall y)
      add(bx(0.006, 0.78, 0.18, emis(0xff2fbf, 0.22)), -0.02, 0.41, 0, 0, skate);      // neon grip tape (room-facing side)
      [0.14, 0.68].forEach((yy) => [-0.07, 0.07].forEach((dz) => { const w = cyl(0.045, 0.045, 0.03, std(0xe8e2d0, 0.5), 12); w.rotation.x = Math.PI / 2; add(w, 0.035, yy, dz, 0, skate); }));   // trucks + wheels (wall side)

      // ── Everyday mess: trashcan + crumpled paper, striped tube socks ──
      add(cyl(0.15, 0.12, 0.34, std(0x6a6e76, 0.6, 0.3), 16), 0.9, 0.17, 0.75);       // wire trashcan
      const wad = (x, z) => add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), std(0xece7d8, 0.95)), x, 0.05, z, Math.random());
      wad(0.9, 0.75); wad(1.05, 0.68); wad(0.78, 0.9); wad(1.15, 0.85);
      const sock = (x, z, ry) => { const s = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.12, 4, 8), std(0xf0ece0, 0.95)); s.rotation.z = Math.PI / 2; add(s, x, 0.04, z, ry); add(bx(0.02, 0.065, 0.065, std(0xd0402a, 0.9)), x + 0.06, 0.04, z, ry); };
      sock(0.5, 0.5, 0.4); sock(0.62, 0.62, -0.7);
      // A few action figures near the TV.
      [[1.2, 0.55, 0xd0402a], [1.35, 0.45, 0x2a6ad0], [1.28, 0.68, 0x30a040]].forEach(([x, z, c]) => { const fig = new THREE.Group(); add(bx(0.05, 0.1, 0.03, std(c, 0.6)), 0, 0.08, 0, 0, fig); add(new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), std(0xe0b48a, 0.7)), 0, 0.15, 0, 0, fig); add(fig, x, 0, z, Math.random() * 3); });

      // ── Lights (world space, inverse-square falloff) ──
      // decay 2 is what makes a desk lamp read as a desk lamp: the pool on the
      // desk falls away into a dark room instead of lighting the far wall just
      // as brightly. Falloff costs scale independence — illuminance is I/d², so
      // I has to be quoted per square metre — which IL restores: every intensity
      // below is "at one metre", whatever world units a metre happens to be.
      const IL = S * S;
      // Amber tungsten desk lamp — the warm key, pooled on the desk + C64.
      //
      // A SPOTLIGHT at the bulb, not a point light, because a shade is a snoot:
      // a point light inside a 9 cm cone blasts its inner wall (inverse-square at
      // 3 cm) to white, and a point light hung below the shade — which is what
      // this was — is a bare bulb that lights the arm from underneath and leaves
      // the fixture looking switched off. A cone aimed down does what the shade
      // does: a defined pool on the desk, the arm and ceiling left alone.
      // It is also far cheaper — a spot shadow is one 2D map where a point light
      // needs a six-face cube (1024² × 6 = 24 MB against 4).
      // LAMP_S² because the bulb rides up with the lamp: with decay 2, a 15% taller
      // lamp would otherwise dim the pool on the desk by 24%.
      const lampLight = new THREE.SpotLight(0xffa552, 0.58 * IL * LAMP_S * LAMP_S, R * 9, 0.82, 0.58, 2);
      const BX = LAMP_X + LAMP_BULB[0] * LAMP_S, BZ = LAMP_Z + LAMP_BULB[2] * LAMP_S;
      lampLight.position.copy(wc(BX, DESKH + LAMP_BULB[1] * LAMP_S, BZ));      // at the bulb, up inside the shade
      lampLight.target.position.copy(wc(BX, DESKH, BZ));                       // straight down onto the desk
      lampLight.castShadow = true;
      lampLight.shadow.mapSize.set(1024, 1024); lampLight.shadow.bias = -0.0008; lampLight.shadow.radius = 2;
      lampLight.shadow.camera.near = R * 0.05; lampLight.shadow.camera.far = R * 9;
      g.add(lampLight, lampLight.target);
      // The desktop itself returns a very small, broad warm bounce. This lifts
      // the keyboard and nearby clutter without touching the room perimeter.
      const lampBounce = new THREE.PointLight(0xff8f45, 0.052 * IL, R * 2.5, 2);
      lampBounce.position.copy(wc(BX + 0.08, DESKH + 0.1, BZ + 0.11)); g.add(lampBounce);
      // Cool flickering CRT glow spilling into the room.
      const crtLight = new THREE.PointLight(0x8fcfe5, 0.56 * IL, R * 8, 2);
      crtLight.position.copy(wc(1.35, 0.66, -0.7)); g.add(crtLight);
      // Faint red alarm-clock glow — a bedside ember, reaches almost nothing.
      const clockLight = new THREE.PointLight(0xff3020, 0.075 * IL, R * 2.5, 2);
      clockLight.position.copy(wc(-2.05, 0.66, 0.12)); g.add(clockLight);
      // Moonlight through the blinds — the second key, and the one that throws
      // the slat stripes. A spotlight decays like a point light, so it is quoted
      // per square metre too, from ~3.5 m up and outside the window.
      // Less red, relatively more green: opposite the lamp's amber, so the two keys
      // separate rather than merely differ. Rec.709 luminance held to within 1%.
      const moon = new THREE.SpotLight(0x72bfe8, 14 * IL, R * 26, 0.66, 0.82, 2);
      // Sited on the line through the moon's APPARENT position in the glass and
      // the spot on the carpet it lights, then backed off outside the wall — so
      // the stripes it throws line up with the moon visible in the glass.
      {
        const aim = new THREE.Vector3(MOON_TARGET[0] - MOON_LX, -MOON_LY, MOON_TARGET[2] - (-D / 2 + 0.02)).normalize();
        moon.position.copy(wc(MOON_LX - aim.x * 1.9, MOON_LY - aim.y * 1.9, -D / 2 + 0.02 - aim.z * 1.9));
        moon.target.position.copy(wc(MOON_TARGET[0], MOON_TARGET[1], MOON_TARGET[2]));
      }
      // Casting is the whole point: without it the blinds are a prop, with it
      // they stripe the floor and the bed — the shot the room is built around.
      moon.castShadow = true;
      moon.shadow.mapSize.set(1024, 1024);        // 4 MB; 2048 would be 16
      moon.shadow.bias = -0.003; moon.shadow.radius = 0.75;
      moon.shadow.camera.near = R * 0.5; moon.shadow.camera.far = R * 26;
      g.add(moon, moon.target);

      // A shallow volume reveals the moon's path without global fog. Its window
      // end is narrow and the carpet end broad; the view-facing shader fades its
      // silhouette before the volume can read as a solid cone.
      const beamStart = new THREE.Vector3(MOON_LX, MOON_LY, -D / 2 + 0.09);
      const beamEnd = new THREE.Vector3(MOON_TARGET[0], 0.035, MOON_TARGET[2]);
      const beamDir = beamEnd.clone().sub(beamStart), beamLen = beamDir.length();
      const beamMid = beamStart.clone().add(beamEnd).multiplyScalar(0.5);
      const beamMat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: btex.moonBeam }, uColor: { value: new THREE.Color(0x8cccec) }, uOpacity: { value: 0.022 } },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vNormalView;
          varying vec3 vViewDir;
          void main() {
            vUv = uv;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vNormalView = normalize(normalMatrix * normal);
            vViewDir = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          uniform sampler2D uMap;
          uniform vec3 uColor;
          uniform float uOpacity;
          varying vec2 vUv;
          varying vec3 vNormalView;
          varying vec3 vViewDir;
          void main() {
            float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
            float softEdge = smoothstep(0.02, 0.72, facing);
            float alpha = texture2D(uMap, vUv).a * softEdge * uOpacity;
            gl_FragColor = vec4(uColor, alpha);
          }
        `,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide,
      });
      const beamGeo = new THREE.CylinderGeometry(0.38, 0.82, beamLen, 16, 1, true);
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.copy(beamMid);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), beamDir.clone().negate().normalize());
      beam.renderOrder = -2; beam.userData.noCast = true; room.add(beam);
      // Kept very low: any lift here flattens what the falloff above just bought.
      // Sky side cool, bounce off the burnt-orange shag warm.
      g.add(new THREE.AmbientLight(0x1b2430, 0.030));
      g.add(new THREE.HemisphereLight(0x223440, 0x1e130a, 0.042));

      // ── Soft CRT + tuner glow halos — radial sprites that fade to
      //    transparent at the rim (no hard-edged additive sphere). ──
      const haze = (color, x, y, z, size, op) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: btex.glow, color, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })); s.scale.set(size, size, 1); add(s, x, y, z); return s; };
      const crtHaze = haze(0x9fd0ea, 1.4, 0.62, -0.7, 1.45, 0.038);
      haze(0x32d88a, -2.05, 0.91, 1.1, 0.32, 0.026);                              // tuner glow, no scene-wide point-light cost

      // ── Dust motes drifting in the light ──
      const DUST = 150, dp = new Float32Array(DUST * 3), seed = new Float32Array(DUST);
      const dust = new THREE.InstancedMesh(new THREE.SphereGeometry(R * 0.00077, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffe0b0, transparent: true, opacity: 0.18, depthWrite: false }), DUST);
      dust.frustumCulled = false;
      const dm = new THREE.Object3D();
      for (let i = 0; i < DUST; i++) {
        const r = Math.random() * R * 2.5, a = Math.random() * Math.PI * 2;
        dp[i * 3] = cx + Math.cos(a) * r; dp[i * 3 + 1] = floorY + R * 0.3 + Math.random() * (H * S - R); dp[i * 3 + 2] = cz + Math.sin(a) * r;
        seed[i] = Math.random() * 100;
        dm.position.set(dp[i * 3], dp[i * 3 + 1], dp[i * 3 + 2]); dm.updateMatrix(); dust.setMatrixAt(i, dm.matrix);
      }
      dust.instanceMatrix.needsUpdate = true; g.add(dust);

      // A smaller, cooler dust population stays inside the moon shaft. These
      // particles make the volume readable while the room-wide dust remains a
      // subtle warm practical-light detail.
      const MOON_DUST = 48;
      const mdp = new Float32Array(MOON_DUST * 3), mseed = new Float32Array(MOON_DUST);
      const moonDust = new THREE.InstancedMesh(
        dust.geometry,
        new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.32, depthWrite: false }),
        MOON_DUST,
      );
      moonDust.frustumCulled = false;
      for (let i = 0; i < MOON_DUST; i++) {
        const t = 0.08 + Math.random() * 0.82;
        const spread = 0.08 + t * 0.3;
        mdp[i * 3] = cx + (beamStart.x + beamDir.x * t + (Math.random() - 0.5) * spread) * S;
        mdp[i * 3 + 1] = floorY + (beamStart.y + beamDir.y * t + (Math.random() - 0.5) * spread * 0.45) * S;
        mdp[i * 3 + 2] = cz + (beamStart.z + beamDir.z * t + (Math.random() - 0.5) * spread * 0.38) * S;
        mseed[i] = Math.random() * 100;
        dm.position.set(mdp[i * 3], mdp[i * 3 + 1], mdp[i * 3 + 2]); dm.updateMatrix(); moonDust.setMatrixAt(i, dm.matrix);
      }
      moonDust.instanceMatrix.needsUpdate = true; g.add(moonDust);

      // ── Shadows: who casts ──────────────────────────────────────────────
      // Everything receives — that is a texture lookup. Casting is rationed by
      // size: 176 meshes through two shadow passes would cost far more than a
      // floppy disk's shadow is worth, and the clutter's contribution is noise
      // at this resolution. Geometry bounds are already in metres (the group
      // carries the scale), so the threshold is a real-world 25 cm.
      const _sz = new THREE.Vector3();
      room.traverse((o) => {
        if (!o.isMesh) return;
        o.receiveShadow = true;
        if (o.userData.noCast) return;             // shell: receives only
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        o.geometry.boundingBox.getSize(_sz);
        if (Math.max(_sz.x, _sz.y, _sz.z) > 0.25) o.castShadow = true;
      });

      // ── Grounding: contact occlusion where furniture meets the carpet ────
      // From each child's own bounds, so a decal cannot drift from what it grounds
      // and anything added later is grounded for free.
      {
        // setFromObject refreshes only the subtree it is handed, and build() runs
        // before the group is added — without this every box misses room's scale.
        room.updateMatrixWorld(true);
        const box = new THREE.Box3(), sz = new THREE.Vector3(), mid = new THREE.Vector3();
        const eps = 0.004 * S;                     // clear of the carpet, under everything else
        for (const child of room.children.slice()) {
          if (child.isMesh && child.userData.noCast) continue;    // the shell is not furniture
          if (child.isSprite) continue;   // billboards: bounds are a zero-depth quad
          box.setFromObject(child);
          if (box.isEmpty()) continue;
          box.getSize(sz); box.getCenter(mid);
          // Opting in waives both the on-the-carpet and not-a-flat-sheet tests.
          const opted = !!child.userData.ground;
          if (!opted && box.min.y - floorY > 0.08 * S) continue;
          if (!opted && sz.y < 0.06 * S) continue;               // floppies, paper
          // Neither wall-sized nor a stray cassette, and nothing edge-on.
          const foot = Math.max(sz.x, sz.z);
          if (foot < 0.18 * S || foot > 3.0 * S) continue;
          if (sz.x < 0.02 * S || sz.z < 0.02 * S) continue;
          const d = new THREE.Mesh(
            new THREE.PlaneGeometry(sz.x * 1.3, sz.z * 1.3),
            new THREE.MeshBasicMaterial({
              map: btex.contact, transparent: true, depthWrite: false, toneMapped: false,
            }),
          );
          d.rotation.x = -Math.PI / 2;
          d.position.set(mid.x, floorY + eps, mid.z);
          d.renderOrder = -1;                      // before the clutter, so it never veils it
          g.add(d);
        }
      }

      g.userData.bedCrtMat = crtScreen.material; g.userData.bedCrtLight = crtLight;
      g.userData.bedCrtHaze = crtHaze;              // the halo has to go dark with the tube
      g.userData.bedScanGlow = scanGlow; g.userData.bedScanSpan = (CW - 0.16) * 0.25;
      g.userData.bedScanSpill = scanSpill;
      g.userData.bedCrtBleed = crtBleed;
      g.userData.bedCrtBase = crtLight.intensity;   // so animate scales the built value, not a stale literal
      g.userData.bedLampLight = lampLight; g.userData.bedLampBase = lampLight.intensity;
      g.userData.bedLampBounce = lampBounce; g.userData.bedLampBounceBase = lampBounce.intensity;
      g.userData.bedCrtTex = btex.crt;
      g.userData.bedCrtCtx = btex.crtCtx; g.userData.bedCrtBack = btex.crtBack; g.userData.bedCrtScan = btex.crtScan;
      g.userData.bedTvPhase = 0; g.userData.bedTvNext = 0;
      g.userData.bedDust = dust; g.userData.bedDustPos = dp; g.userData.bedSeed = seed; g.userData.bedDustObj = dm; g.userData.bedDrift = S;
      g.userData.bedMoonDust = moonDust; g.userData.bedMoonDustPos = mdp; g.userData.bedMoonSeed = mseed;
    },
    animate(g, t, powered) {
      // Barely perceptible tungsten drift. Scalar updates only: all lights and
      // sprites are built once, and the loop keeps the scene group's shape fixed.
      const lamp = g.userData.bedLampLight, lampBounce = g.userData.bedLampBounce;
      const lampF = 0.99 + Math.sin(t * 1.37) * 0.008 + Math.sin(t * 3.11) * 0.003;
      if (lamp) lamp.intensity = g.userData.bedLampBase * lampF;
      if (lampBounce) lampBounce.intensity = g.userData.bedLampBounceBase * lampF;
      // The CRT TV only lives while the C64 is powered on: off, the tube is dark
      // and still (no flicker, no cast light); on, it flickers (screen brightness
      // + the cool light it spills into the room).
      const cl = g.userData.bedCrtLight, cm = g.userData.bedCrtMat, hz = g.userData.bedCrtHaze;
      if (powered) {
        const f = 0.91 + Math.sin(t * 7.3) * 0.035 + Math.sin(t * 17.1) * 0.018;
        // Scale the intensity the scene was BUILT with. A literal here silently
        // overrode the falloff-scaled value the moment decay changed.
        if (cl) cl.intensity = (g.userData.bedCrtBase || 0) * f;
        // The tube is set dressing across a dark room, not the subject — kept
        // well under the desk lamp so the eye still goes to the C64.
        if (cm) cm.color.setScalar(0.68 + 0.16 * f);
        if (hz) hz.material.opacity = 0.038 * f;
        // Sweep the scanner. Throttled to ~16 fps — it is a slow sweep across 40
        // texels, and every redraw is a texture upload. Two drawImage calls, no
        // allocation.
        const ctx = g.userData.bedCrtCtx;
        if (ctx && t >= g.userData.bedTvNext) {
          g.userData.bedTvNext = t + 0.06;
          g.userData.bedTvPhase = t * 2.2;
          const scan = g.userData.bedCrtScan, sweep = Math.sin(g.userData.bedTvPhase);
          ctx.drawImage(g.userData.bedCrtBack, 0, 0);
          ctx.drawImage(scan, 64 + sweep * 16 - scan.width / 2, 63 - scan.height / 2);
          g.userData.bedCrtTex.needsUpdate = true;
          const sg = g.userData.bedScanGlow;                                      // the bleed rides along
          if (sg) { sg.position.x = sweep * g.userData.bedScanSpan; sg.material.opacity = 0.065 + 0.03 * f; }
          const spill = g.userData.bedScanSpill;
          if (spill) { spill.position.x = sweep * g.userData.bedScanSpan * 0.65; spill.material.opacity = (0.018 + (1 - Math.abs(sweep)) * 0.014) * f; }
          const bl = g.userData.bedCrtBleed;                                      // phosphor wash flickers with the tube
          if (bl) bl.material.opacity = 0.033 + 0.015 * f;
        }
      } else {
        if (cl) cl.intensity = 0;              // TV dark with the machine
        // Not black: a switched-off CRT is dark grey glass that still catches
        // the room, and MeshBasicMaterial takes no light, so a low floor here is
        // the only thing standing between "off" and a hole cut in the cabinet.
        if (cm) cm.color.setScalar(0.16);
        // ...and so is its halo. A glow hanging in the room off a black tube was
        // the giveaway that this sprite never checked `powered`.
        if (hz) hz.material.opacity = 0;
        const sg = g.userData.bedScanGlow;
        if (sg) sg.material.opacity = 0;   // dead tube, dead scanner
        const spill = g.userData.bedScanSpill;
        if (spill) spill.material.opacity = 0;
        const bl = g.userData.bedCrtBleed;
        if (bl) bl.material.opacity = 0;
      }
      const dust = g.userData.bedDust, seed = g.userData.bedSeed, dp = g.userData.bedDustPos, dm = g.userData.bedDustObj, drift = g.userData.bedDrift || 1;
      if (dust && seed) {
        for (let i = 0; i < seed.length; i++) {
          dp[i * 3 + 1] += Math.sin(t * 0.5 + seed[i]) * 0.0006 * drift;
          dp[i * 3] += Math.cos(t * 0.3 + seed[i]) * 0.0004 * drift;
          dm.position.set(dp[i * 3], dp[i * 3 + 1], dp[i * 3 + 2]); dm.updateMatrix(); dust.setMatrixAt(i, dm.matrix);
        }
        dust.instanceMatrix.needsUpdate = true;
      }
      const moonDust = g.userData.bedMoonDust, mdp = g.userData.bedMoonDustPos, mseed = g.userData.bedMoonSeed;
      if (moonDust && mdp && mseed) {
        for (let i = 0; i < moonDust.count; i++) {
          const s = mseed[i];
          dm.position.set(
            mdp[i * 3] + Math.sin(t * 0.17 + s) * drift * 0.012,
            mdp[i * 3 + 1] + Math.sin(t * 0.11 + s * 1.7) * drift * 0.018,
            mdp[i * 3 + 2] + Math.cos(t * 0.14 + s * 0.8) * drift * 0.01,
          );
          dm.updateMatrix(); moonDust.setMatrixAt(i, dm.matrix);
        }
        moonDust.instanceMatrix.needsUpdate = true;
      }
    },
};
