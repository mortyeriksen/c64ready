// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

const SECTOR = Math.PI / 4;

export function isTouchCapable(navigatorLike, coarsePointer = false) {
  return (navigatorLike?.maxTouchPoints || 0) > 0 || coarsePointer;
}

export function hostTouchControls(element, host) {
  if (!element || !host || element.parentNode === host) return null;
  const home = { parent: element.parentNode, nextSibling: element.nextSibling };
  host.appendChild(element);
  return home;
}

export function restoreTouchControls(element, home) {
  if (!element || !home?.parent) return;
  if (home.nextSibling?.parentNode === home.parent) {
    home.parent.insertBefore(element, home.nextSibling);
  } else {
    home.parent.appendChild(element);
  }
}

// A joystick press is a game gesture, not a text one: the handlers preventDefault,
// so nothing moves focus off the soft-keyboard input on its own and the device
// raises its keyboard again on the next tap. Hand focus back to the screen.
export function dropSoftKeyboardFocus(activeElement, softKeyboard, fallback) {
  if (!softKeyboard || activeElement !== softKeyboard) return false;
  softKeyboard.blur();
  fallback?.focus();
  return true;
}

export function resolveTouchStickInto(dx, dy, radius, out, deadZoneRatio = 0.18) {
  out.up = false;
  out.down = false;
  out.left = false;
  out.right = false;
  out.visualX = 0;
  out.visualY = 0;
  if (!(radius > 0)) return out;

  const distanceSq = dx * dx + dy * dy;
  const radiusSq = radius * radius;
  if (distanceSq > radiusSq) {
    const scale = radius / Math.sqrt(distanceSq);
    out.visualX = dx * scale;
    out.visualY = dy * scale;
  } else {
    out.visualX = dx;
    out.visualY = dy;
  }
  const deadZone = radius * deadZoneRatio;
  if (distanceSq <= deadZone * deadZone) return out;

  const sector = Math.round(Math.atan2(dy, dx) / SECTOR);
  switch (sector) {
    case 0:  out.right = true; break;
    case 1:  out.down = out.right = true; break;
    case 2:  out.down = true; break;
    case 3:  out.down = out.left = true; break;
    case 4:
    case -4: out.left = true; break;
    case -3: out.up = out.left = true; break;
    case -2: out.up = true; break;
    case -1: out.up = out.right = true; break;
  }
  return out;
}

export function resolveTouchStick(dx, dy, radius, deadZoneRatio = 0.18) {
  return resolveTouchStickInto(dx, dy, radius, {
    up: false, down: false, left: false, right: false,
    visualX: 0, visualY: 0,
  }, deadZoneRatio);
}
