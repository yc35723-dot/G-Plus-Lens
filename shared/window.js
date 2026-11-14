export const POPUP = {
  widthRatio: 0.3,
  minWidth: 360,
  maxWidth: 560,
  heightRatio: 0.85,
  minHeight: 420,
  edgeMargin: 16,
  minWidthSlack: 24,
};

export function computePopupBounds(win) {
  const base = win && Number.isFinite(win.width) && Number.isFinite(win.height)
    ? win
    : { left: 0, top: 0, width: 1280, height: 800 };

  const left0 = Number.isFinite(base.left) ? base.left : 0;
  const top0 = Number.isFinite(base.top) ? base.top : 0;
  const winWidth = Math.max(POPUP.minWidthSlack + 32, base.width);
  const winHeight = Math.max(240, base.height);

  let width = Math.round(winWidth * POPUP.widthRatio);
  width = Math.min(Math.max(width, POPUP.minWidth), POPUP.maxWidth);
  width = Math.min(width, winWidth - POPUP.minWidthSlack);

  let height = Math.round(winHeight * POPUP.heightRatio);
  height = Math.max(Math.min(height, winHeight - POPUP.edgeMargin * 2), Math.min(POPUP.minHeight, winHeight));

  const left = Math.round(left0 + winWidth - width - POPUP.edgeMargin);
  const top = Math.round(top0 + Math.max(POPUP.edgeMargin, (winHeight - height) / 2));

  return {
    left: Math.max(left0, left),
    top: Math.max(top0, top),
    width,
    height,
  };
}
