// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Encodes one PNG as WebP with sharp, PNG on stdin and WebP on stdout, for
// tools/guide-image.mjs, which runs it as a child process so its own writer
// stays synchronous.
//
//   node tools/webp-encode.mjs [--lossless | --quality N] [--width N] < in.png > out.webp
//
// --width downscales to that many pixels across, keeping the aspect ratio, and
// never enlarges. --lossless is cwebp's -lossless -z 9, --quality N its -q N -m 6.
import sharp from 'sharp';

const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : null; };
const width = value('--width');
const quality = value('--quality') ?? 90;

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let image = sharp(Buffer.concat(chunks));
if (width) image = image.resize({ width, withoutEnlargement: true });
const out = await image.webp(args.includes('--lossless') ? { lossless: true, effort: 6 } : { quality, effort: 6 }).toBuffer();
process.stdout.write(out);
