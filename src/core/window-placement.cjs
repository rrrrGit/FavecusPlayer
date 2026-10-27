'use strict';
// Electronの座標はDIP。負の座標を持つモニターや縦置き画面でも作業領域に収める。
function MiniBounds(work, anchor, expanded = false) {
  const width = Math.min(500, work.width), height = Math.min(expanded ? 144 : 64, work.height);
  const clamp = (value, low, high) => Math.round(Math.max(low, Math.min(high, value)));
  return { x: clamp(anchor ? anchor.x + anchor.width - width : work.x + work.width - width - 8, work.x, work.x + work.width - width),
    y: clamp(work.y + work.height - height - 8, work.y, work.y + work.height - height), width, height };
}
function ExpandBounds(bounds, work, expanded) {
  const height = Math.min(expanded ? 144 : 64, work.height), width = Math.min(bounds.width, work.width);
  return { x: Math.round(Math.max(work.x, Math.min(bounds.x, work.x + work.width - width))),
    y: Math.round(Math.max(work.y, Math.min(bounds.y + bounds.height - height, work.y + work.height - height))), width, height };
}
module.exports = { MiniBounds, ExpandBounds };
