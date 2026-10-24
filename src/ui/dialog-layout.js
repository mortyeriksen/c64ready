// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen

// Scrollbars occupy the dialog's padding gutter. Content keeps the same right
// edge as the fixed header and footer with either overlay or classic scrollbars.
export function initDialogLayout(root = document) {
  const scrollers = [...root.querySelectorAll('.dialog-scroll')];
  const widths = new WeakMap();
  let frame = 0;
  function update() {
    frame = 0;
    const measured = [];
    for (const element of scrollers) {
      if (!element.getClientRects().length) continue;
      const css = getComputedStyle(element);
      const width = Math.max(0, element.offsetWidth - element.clientWidth
        - parseFloat(css.borderLeftWidth) - parseFloat(css.borderRightWidth));
      if (widths.get(element) !== width) measured.push({ element, width });
    }
    for (const { element, width } of measured) {
      widths.set(element, width);
      element.style.setProperty('--dialog-scrollbar-size', `${width}px`);
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const observer = new ResizeObserver(schedule);
  for (const element of scrollers) observer.observe(element);
  schedule();
  return () => { observer.disconnect(); cancelAnimationFrame(frame); };
}
