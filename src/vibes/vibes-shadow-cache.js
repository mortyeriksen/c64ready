// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// A scene builds its caster list once. Moving a caster, its ancestors, or a
// shadow light invalidates the maps; camera motion and non-casting FX do not.
export class ShadowCache {
  constructor(scene) {
    this.scene = scene;
    this.entries = [];
    this.dirty = true;
    this.rebuild();
  }

  rebuild() {
    const objects = new Set();
    const include = object => {
      for (let o = object; o; o = o.parent) objects.add(o);
    };
    this.scene.traverse(o => {
      if (!o.castShadow) return;
      include(o);
      if (o.isLight && o.target) include(o.target);
    });
    this.entries = Array.from(objects, object => ({
      object, parent: object.parent, matrix: new Float64Array(16),
      visible: object.visible, castShadow: object.castShadow, layers: object.layers.mask,
      geometry: null, position: null, index: null, instances: null,
      positionVersion: -1, indexVersion: -1, instanceVersion: -1, count: -1,
      shadow: new Float64Array(9),
    }));
    this.dirty = true;
  }

  update() {
    let changed = this.dirty;
    this.dirty = false;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i], o = e.object;
      if (o.parent !== e.parent) {
        this.rebuild();
        return true;
      }
      o.updateWorldMatrix(true, false);
      const matrix = o.matrixWorld.elements;
      for (let j = 0; j < 16; j++) {
        if (e.matrix[j] !== matrix[j]) { e.matrix[j] = matrix[j]; changed = true; }
      }
      if (e.visible !== o.visible || e.castShadow !== o.castShadow || e.layers !== o.layers.mask) {
        e.visible = o.visible; e.castShadow = o.castShadow; e.layers = o.layers.mask;
        changed = true;
      }
      if (o.geometry) {
        const geometry = o.geometry, position = geometry.attributes.position, index = geometry.index;
        const instances = o.instanceMatrix;
        const pv = position?.isInterleavedBufferAttribute ? position.data.version : position?.version;
        const iv = index?.version, mv = instances?.version;
        if (e.geometry !== geometry || e.position !== position || e.index !== index || e.instances !== instances ||
            e.positionVersion !== pv || e.indexVersion !== iv || e.instanceVersion !== mv || e.count !== o.count) {
          e.geometry = geometry; e.position = position; e.index = index; e.instances = instances;
          e.positionVersion = pv; e.indexVersion = iv; e.instanceVersion = mv; e.count = o.count;
          changed = true;
        }
      }
      if (o.shadow) {
        const c = o.shadow.camera, s = e.shadow;
        changed = check(s, 0, c.near) || changed;
        changed = check(s, 1, c.far) || changed;
        changed = check(s, 2, c.left ?? o.angle ?? 0) || changed;
        changed = check(s, 3, c.right ?? o.distance ?? 0) || changed;
        changed = check(s, 4, c.top ?? o.shadow.focus ?? 0) || changed;
        changed = check(s, 5, c.bottom ?? 0) || changed;
        changed = check(s, 6, o.shadow.mapSize.x) || changed;
        changed = check(s, 7, o.shadow.mapSize.y) || changed;
        changed = check(s, 8, c.zoom) || changed;
      }
    }
    return changed;
  }
}

function check(values, index, value) {
  if (values[index] === value) return false;
  values[index] = value;
  return true;
}
