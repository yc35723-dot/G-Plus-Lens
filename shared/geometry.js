export const MIN_SELECTION = 12;

export function resolveBasis({ naturalWidth, clientWidth, clientHeight, innerWidth, innerHeight, dpr }) {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const natural = Number.isFinite(naturalWidth) && naturalWidth > 0 ? naturalWidth : clientWidth;
  const estimatedCss = natural / safeDpr;
  const useInner =
    Math.abs(estimatedCss - innerWidth) < Math.abs(estimatedCss - clientWidth);
  const w = useInner ? innerWidth : clientWidth;
  const h = useInner ? innerHeight : clientHeight;
  return { w: Math.max(1, w), h: Math.max(1, h), useInner };
}

export function computeCrop({ rect, basisW, basisH }, { naturalWidth, naturalHeight }) {
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null;
  const sx = naturalWidth / basisW;
  const sy = naturalHeight / basisH;
  const x = Math.round(Math.max(0, Math.min(rect.x, basisW)) * sx);
  const y = Math.round(Math.max(0, Math.min(rect.y, basisH)) * sy);
  const w = Math.max(1, Math.round(Math.min(rect.w, basisW) * sx));
  const h = Math.max(1, Math.round(Math.min(rect.h, basisH) * sy));
  return {
    x: Math.min(x, Math.max(0, naturalWidth - 1)),
    y: Math.min(y, Math.max(0, naturalHeight - 1)),
    w: Math.min(w, Math.max(1, naturalWidth - x)),
    h: Math.min(h, Math.max(1, naturalHeight - y)),
  };
}
