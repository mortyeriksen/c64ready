// Synthetic line fixtures reuse the production segment renderers.
import { VIC2 } from '../../src/vic2.js';
import { CANVAS_H, CANVAS_W, CYCLES_PER_LINE, GRAPHICS_WINDOW_END, GRAPHICS_WINDOW_START, PALETTE_RGBA, ACCESS_C, ACCESS_G, ACCESS_IDLE, ACCESS_REFRESH, SPRITE_BA_BASE, SPRITE_BA_CANDIDATES, SPRITE_PTR_ACCESS, SPRITE_PTR_CYCLE, SPRITE_ROW_ACCESS } from '../../src/vic2-tables.js';
const referenceLine = {
_cloneRasterSeg(src) {
    const dst = this._makeEmptyRasterSeg();
    this._copyRasterSeg(src, dst);
    return dst;
  },
_buildCycleSpriteSegments() {
    const segments = [];
    for (let cycle = 11; cycle <= 58; cycle++) {
      this._buildCycleSpriteSegment(cycle);
      segments.push(this._cloneSpriteSeg(this._scratchSpriteSeg));
    }
    return segments;
  },
_cloneSpriteSeg(src) {
    const dst = this._makeEmptySpriteSeg();
    dst.start = src.start;
    dst.end = src.end;
    dst.regs = src.regs;
    dst.bank = src.bank;
    dst.spriteDisplayOn = src.spriteDisplayOn;
    dst.spriteDataRow = src.spriteDataRow;
    dst.spriteDataBase = src.spriteDataBase;
    dst.spriteDataBank = src.spriteDataBank;
    dst.spritePointerValue = src.spritePointerValue;
    dst.spriteRowByteMask = src.spriteRowByteMask;
    dst.spriteShiftReg = src.spriteShiftReg;
    return dst;
  },
_renderSpriteLine(raster, canvasY) {
    const spriteSegments = this._buildCycleSpriteSegments();
    for (let s = 0; s < 8; s++) {
      for (let i = 0; i < spriteSegments.length; i++) {   // (A2) indexed, not for-of
        this._renderSpriteSegmentForSprite(spriteSegments[i], s, canvasY);
      }
    }
  },
_renderRasterLine(raster) {
    if (!this.ram || !this.colorRam) return;
    const canvasY = raster - 15;
    if (canvasY < 0 || canvasY >= CANVAS_H) return;

    this._initRenderRasterLine(raster, canvasY);

    const cycleSegments = this._buildCycleRasterSegments();
    const spriteSegments = this._buildCycleSpriteSegments();
    for (let i = 0; i < cycleSegments.length; i++) {
      this._renderCycleSegmentGraphics(cycleSegments[i], canvasY);
    }
    for (let s = 0; s < 8; s++) {
      for (let i = 0; i < spriteSegments.length; i++) {   // (A2) indexed, not for-of
        this._renderSpriteSegmentForSprite(spriteSegments[i], s, canvasY);
      }
    }
    this._recolorBorderRow(canvasY);
  },
_buildCycleRasterSegments() {
    // Batch path (legacy / tests). Snapshot the scratch into fresh
    // objects per cycle so the array can be held across calls — the
    // single-cycle path mutates _scratchRasterSeg.
    const segments = [];
    for (let cycle = 11; cycle <= 58; cycle++) {
      this._buildCycleRasterSegment(cycle);
      segments.push(this._cloneRasterSeg(this._scratchRasterSeg));
    }
    return segments;
  },
};
for (const [name, value] of Object.entries(referenceLine)) Object.defineProperty(VIC2.prototype, name, {value, writable:true, configurable:true});
