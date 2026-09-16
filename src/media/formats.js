// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
// The types the app can open. Two of them are not the loader's own formats: a
// .t64 is an archive and a .sid is a tune, and both become a .prg on the way in
// (see openT64 and openSid). They belong here all the same — they are offered,
// run and saved like the rest.
export const SUPPORTED_MEDIA = Object.freeze(['prg', 'd64', 'crt', 'tap', 't64', 'sid', 'reu']);
export const mediaTypeOf = name => {
  const type = String(name).split('.').pop().toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(type) ? type : 'unknown';
};
export function safeFilename(name) {
  return String(name || 'media').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^\.+/, '').slice(-180) || 'media';
}
export function safeExternalUrl(value, hosts) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (hosts && !hosts.includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
export function allowedActions(type) {
  if (type === 'd64') return ['mount', 'run', 'save', 'download'];
  if (SUPPORTED_MEDIA.includes(type)) return ['run', 'save', 'download'];
  if (type === 'zip') return ['extract', 'download'];
  return ['download'];
}
export function directRunFile(item) {
  return item.files?.length === 1 && SUPPORTED_MEDIA.includes(item.files[0].mediaType) ? item.files[0] : null;
}
export function singleLoadableFile(item) {
  const files = (item.files || []).filter(file => SUPPORTED_MEDIA.includes(file.mediaType));
  return files.length === 1 ? files[0] : null;
}
