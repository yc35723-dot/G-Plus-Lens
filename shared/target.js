export function clipToViewport(box, vw, vh) {
  const x = Math.max(0, box.left);
  const y = Math.max(0, box.top);
  const right = Math.min(vw, box.left + box.width);
  const bottom = Math.min(vh, box.top + box.height);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

export function pickLargestImage(descriptors, srcUrl, vw, vh) {
  let best = null;
  for (const item of descriptors || []) {
    const isMatch = item.currentSrc === srcUrl || item.src === srcUrl;
    if (!isMatch) continue;
    if (!item.visible) continue;
    if (!(item.naturalWidth > 0)) continue;
    if (!(item.width >= 1 && item.height >= 1)) continue;
    const area = item.width * item.height;
    if (!best || area > best.area) {
      best = { area, box: { left: item.left, top: item.top, width: item.width, height: item.height } };
    }
  }
  if (!best) return null;
  const rect = clipToViewport(best.box, vw, vh);
  if (rect.w < 1 || rect.h < 1) return null;
  return rect;
}
