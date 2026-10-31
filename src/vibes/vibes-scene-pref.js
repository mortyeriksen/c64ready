// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// The remembered Retro Vibes scene is stored by name, so adding or removing a
// scene never moves anyone to another one. Earlier versions stored the scene's
// position in this list, which is kept to read them.
export const LEGACY_SCENE_ORDER = ['Synthwave', 'Starry Plain', 'Spotlight', 'Foggy Spotlight', 'IK+ Sunset', '80s Bedroom'];

// A removed scene opens as the one that took its place.
const REPLACED = { Spotlight: 'Foggy Spotlight' };

// The index in `names` (the current scene list) of a stored value: a scene name,
// or a legacy position. Anything unknown opens the first scene.
export function sceneIndexFromStored(value, names) {
  if (value == null || value === '') return 0;
  let name = value;
  if (/^\d+$/.test(value)) {
    const i = Number(value);
    name = LEGACY_SCENE_ORDER[Math.min(i, LEGACY_SCENE_ORDER.length - 1)];
  }
  name = REPLACED[name] ?? name;
  const i = names.indexOf(name);
  return i >= 0 ? i : 0;
}
