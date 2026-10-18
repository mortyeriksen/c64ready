// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/userport/scan.js – a look through a device file before it is installed,
// for the ten things a harmful device would most likely do. It reads the code
// as text: anything it finds is shown in the install dialog. Code can always
// hide what it does, so finding nothing is not a guarantee.

// Comments become spaces (newlines kept, so line numbers stay right); strings
// stay, because a URL or an event name lives in one.
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i]; i++;
      }
      if (i < src.length) { out += c; i++; }
    } else {
      out += c; i++;
    }
  }
  return out;
}

const RULES = [
  {
    id: 'network', severity: 'high', title: 'Sends or fetches data over the network',
    why: 'could send your ROMs, saved states or typing to someone else',
    test: /\b(fetch|XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|sendBeacon)\b|\bnew\s+Image\s*\(/,
  },
  {
    id: 'storage', severity: 'high', title: 'Reads the browser\'s storage directly',
    why: 'could read your ROMs, saved states and other devices (host.storage is the safe way)',
    test: /\b(localStorage|sessionStorage|indexedDB)\b|\bdocument\s*\.\s*cookie\b/,
  },
  {
    id: 'dynamic-code', severity: 'high', title: 'Runs code made at run time',
    why: 'could run code that is not in this file',
    test: /\beval\s*\(|\bnew\s+Function\b|(^|[^.\w$])Function\s*\(|\bimport\s*\(|\bset(Timeout|Interval)\s*\(\s*['"`]/,
  },
  {
    id: 'input', severity: 'high', title: 'Listens to the keyboard or clipboard',
    why: 'could record what you type or copy',
    test: /addEventListener\s*\(\s*['"`](key(down|up|press)|paste|copy|cut|input|beforeinput)['"`]|\bnavigator\s*\.\s*clipboard\b|\bonkey(down|up|press)\b/,
  },
  {
    id: 'internals', severity: 'high', title: 'Reaches into the emulator itself',
    why: 'could read or change the C64 beyond the user port',
    test: /\b(window|globalThis|self)\s*\.\s*(machine|c64)\b/,
  },
  {
    id: 'persistence', severity: 'high', title: 'Uses service workers or the cache',
    why: 'could keep running or change the app after it is removed',
    test: /\bserviceWorker\b|\bcaches\s*\.|\bregisterProtocolHandler\b/,
  },
  {
    id: 'navigation', severity: 'high', title: 'Opens or changes pages',
    why: 'could send you to a fake page or open pop-ups',
    test: /\blocation\s*(\.\s*(href|assign|replace)\b|=(?!=))|\bwindow\s*\.\s*open\s*\(|\bhistory\s*\.\s*(pushState|replaceState)\b|\.submit\s*\(/,
  },
  {
    id: 'hidden', severity: 'high', title: 'Hides what it does',
    why: 'disguised code is a common sign of a harmful file',
    test: /\b(globalThis|window|self|top|parent)\s*\[|\batob\s*\(|String\s*\.\s*fromCharCode\s*\(\s*\d+\s*(,\s*\d+\s*){5,}\)|['"`][A-Za-z0-9+/=]{200,}['"`]|(\\x[0-9a-fA-F]{2}){8,}/,
    lineTest: (line) => line.length > 1000,
  },
  {
    id: 'page', severity: 'medium', title: 'Changes the page outside its own panel',
    why: 'could put up a fake dialog or change the app\'s controls',
    test: /\bdocument\s*\.\s*(body|documentElement|head|forms|write|querySelector(All)?|getElementById|getElementsBy\w+|addEventListener)\b|\bwindow\s*\.\s*(parent|top|opener)\b/,
  },
  {
    id: 'background', severity: 'medium', title: 'Starts background work or asks for devices',
    why: 'could use your computer for other things, or your camera and location',
    test: /\bnew\s+(Shared)?Worker\b|\bWebAssembly\b|\bgetUserMedia\b|\bnavigator\s*\.\s*(geolocation|mediaDevices|usb|serial|hid|bluetooth)\b|\bNotification\b/,
  },
];

const ADDRESS = /\b(https?|wss?):\/\/[^\s'"`)<>]+/g;

/**
 * Look through a device's source. Returns findings, most serious first:
 * { id, severity: 'high'|'medium', title, why, lines: [line numbers] }.
 * Network findings also carry `addresses`, any URLs written in the code.
 */
export function scanDeviceSource(source) {
  const lines = stripComments(String(source)).split('\n');
  const findings = [];
  for (const rule of RULES) {
    const hit = [];
    lines.forEach((line, i) => {
      if (rule.test.test(line) || (rule.lineTest && rule.lineTest(line))) hit.push(i + 1);
    });
    if (hit.length) findings.push({ id: rule.id, severity: rule.severity, title: rule.title, why: rule.why, lines: hit });
  }
  const addresses = [...new Set(lines.join('\n').match(ADDRESS) || [])];
  if (addresses.length) {
    const net = findings.find((f) => f.id === 'network');
    if (net) net.addresses = addresses;
    else findings.unshift({ id: 'network', severity: 'high', title: 'Contains web addresses', why: 'may contact these servers', lines: [], addresses });
  }
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}
