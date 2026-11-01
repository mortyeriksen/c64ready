// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/account/picture.js — a profile picture as the server keeps it: any image
// the browser can read, whole (never cropped), shrunk to fit 256x256 and
// encoded as WebP (PNG where the browser cannot), here in the browser. Only
// that small copy is uploaded, never the file chosen.

export const PICTURE_SIDE = 256;
const MAX_BYTES = 96 * 1024;   // the server's limit (server/accounts.mjs)

const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A chosen image file as the base64 picture to upload. Throws when the file is not an image. */
export async function shrinkPicture(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('That file is not an image this browser can read.'); }
  const scale = Math.min(1, PICTURE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const encode = (type, quality) => new Promise((r) => canvas.toBlob(r, type, quality));
  for (const quality of [0.86, 0.7, 0.5]) {
    const blob = await encode('image/webp', quality);
    if (blob?.type === 'image/webp' && blob.size <= MAX_BYTES) return toBase64(await blob.arrayBuffer());
  }
  const png = await encode('image/png');
  if (!png || png.size > MAX_BYTES) throw new Error('That image is too detailed to keep small. Try another.');
  return toBase64(await png.arrayBuffer());
}
