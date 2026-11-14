(async () => {
  const INIT = globalThis.__GPLENS_INIT__;
  delete globalThis.__GPLENS_INIT__;
  const HOST_ID = 'gplens-overlay-host';
  if (!INIT || !INIT.shot || document.getElementById(HOST_ID)) return;

  const MIN_SIZE = 12;
  const RESIZE_DELAY = 300;
  const rootEl = document.documentElement;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .root {
      position: absolute; left: 0; top: 0; overflow: hidden; cursor: crosshair;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-user-select: none; user-select: none; touch-action: none;
      -webkit-tap-highlight-color: transparent;
    }
    .shot { position: absolute; left: 0; top: 0; pointer-events: none; }
    .shot img { display: block; pointer-events: none; }
    .shade { position: absolute; background: rgba(0, 0, 0, .4); pointer-events: none; }
    .box {
      position: absolute; box-sizing: border-box; display: none;
      border: 2px solid #fff; border-radius: 6px;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, .25);
      pointer-events: none;
    }
    .corner {
      position: absolute; width: 18px; height: 18px; box-sizing: border-box;
      border: 0 solid #fff;
    }
    .corner.tl { left: -2px; top: -2px; border-left-width: 3px; border-top-width: 3px; border-top-left-radius: 6px; }
    .corner.tr { right: -2px; top: -2px; border-right-width: 3px; border-top-width: 3px; border-top-right-radius: 6px; }
    .corner.bl { left: -2px; bottom: -2px; border-left-width: 3px; border-bottom-width: 3px; border-bottom-left-radius: 6px; }
    .corner.br { right: -2px; bottom: -2px; border-right-width: 3px; border-bottom-width: 3px; border-bottom-right-radius: 6px; }
    .handle { position: absolute; pointer-events: auto; }
    .handle[data-d="n"], .handle[data-d="s"] { left: 12px; right: 12px; height: 10px; cursor: ns-resize; }
    .handle[data-d="n"] { top: -5px; }
    .handle[data-d="s"] { bottom: -5px; }
    .handle[data-d="w"], .handle[data-d="e"] { top: 12px; bottom: 12px; width: 10px; cursor: ew-resize; }
    .handle[data-d="w"] { left: -5px; }
    .handle[data-d="e"] { right: -5px; }
    .handle[data-d="nw"], .handle[data-d="ne"], .handle[data-d="sw"], .handle[data-d="se"] { width: 18px; height: 18px; }
    .handle[data-d="nw"] { left: -6px; top: -6px; cursor: nwse-resize; }
    .handle[data-d="ne"] { right: -6px; top: -6px; cursor: nesw-resize; }
    .handle[data-d="sw"] { left: -6px; bottom: -6px; cursor: nesw-resize; }
    .handle[data-d="se"] { right: -6px; bottom: -6px; cursor: nwse-resize; }
    .close {
      position: absolute; width: 28px; height: 28px;
      padding: 0; margin: 0; border: 0; border-radius: 50%;
      background: rgba(32, 33, 36, .62); color: #fff; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      pointer-events: auto;
    }
    .close:hover { background: rgba(32, 33, 36, .82); }
    .close svg { display: block; width: 14px; height: 14px; }
  `;

  const root = document.createElement('div');
  root.className = 'root';

  const shot = document.createElement('div');
  shot.className = 'shot';
  const img = document.createElement('img');
  img.src = INIT.shot;
  img.draggable = false;
  img.alt = '';
  shot.appendChild(img);

  const shades = [];
  for (let i = 0; i < 4; i += 1) {
    const node = document.createElement('div');
    node.className = 'shade';
    root.appendChild(node);
    shades.push(node);
  }

  const box = document.createElement('div');
  box.className = 'box';
  for (const name of ['tl', 'tr', 'bl', 'br']) {
    const corner = document.createElement('div');
    corner.className = `corner ${name}`;
    box.appendChild(corner);
  }
  for (const dir of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.dataset.d = dir;
    box.appendChild(handle);
  }
  root.appendChild(box);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close';
  closeBtn.type = 'button';
  closeBtn.title = INIT.messages?.close || 'Close';
  closeBtn.setAttribute('aria-label', INIT.messages?.close || 'Close');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>';
  root.appendChild(closeBtn);

  shadow.append(style, shot, root);
  rootEl.appendChild(host);

  let canvasSize = { w: 1, h: 1 };
  let clip = { w: 1, h: 1 };
  let rect = null;
  let drag = null;
  let resizeTimer = 0;
  let closed = false;

  function layout() {
    canvasSize = {
      w: Math.max(1, window.innerWidth),
      h: Math.max(1, window.innerHeight),
    };
    clip = {
      w: Math.max(1, rootEl.clientWidth || canvasSize.w),
      h: Math.max(1, rootEl.clientHeight || canvasSize.h),
    };
    root.style.width = `${clip.w}px`;
    root.style.height = `${clip.h}px`;
    img.style.width = `${canvasSize.w}px`;
    img.style.height = `${canvasSize.h}px`;
    shot.style.width = `${canvasSize.w}px`;
    shot.style.height = `${canvasSize.h}px`;
    if (rect) {
      rect.x = Math.min(rect.x, clip.w);
      rect.y = Math.min(rect.y, clip.h);
      rect.w = Math.max(MIN_SIZE, Math.min(rect.w, clip.w - rect.x));
      rect.h = Math.max(MIN_SIZE, Math.min(rect.h, clip.h - rect.y));
    }
    render();
  }

  function render() {
    const w = clip.w;
    const h = clip.h;
    if (!rect) {
      box.style.display = 'none';
      shades[0].style.cssText = `left:0;top:0;width:${w}px;height:${h}px;`;
      for (let i = 1; i < 4; i += 1) shades[i].style.cssText = 'left:0;top:0;width:0;height:0;';
      closeBtn.style.left = `${w - 40}px`;
      closeBtn.style.top = '12px';
      return;
    }
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const rw = Math.round(rect.w);
    const rh = Math.round(rect.h);

    shades[0].style.cssText = `left:0;top:0;width:${w}px;height:${Math.max(0, y)}px;`;
    shades[1].style.cssText = `left:0;top:${y + rh}px;width:${w}px;height:${Math.max(0, h - y - rh)}px;`;
    shades[2].style.cssText = `left:0;top:${y}px;width:${Math.max(0, x)}px;height:${rh}px;`;
    shades[3].style.cssText = `left:${x + rw}px;top:${y}px;width:${Math.max(0, w - x - rw)}px;height:${rh}px;`;

    box.style.cssText = `display:block;left:${x}px;top:${y}px;width:${rw}px;height:${rh}px;`;

    closeBtn.style.left = `${Math.max(0, Math.min(w - 36, x + rw - 28))}px`;
    closeBtn.style.top = `${Math.max(8, y - 40)}px`;
  }

  function clampPoint(x, y) {
    return {
      x: Math.min(Math.max(0, x), clip.w),
      y: Math.min(Math.max(0, y), clip.h),
    };
  }

  function inside(point) {
    return (
      rect &&
      point.x >= rect.x &&
      point.x <= rect.x + rect.w &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.h
    );
  }

  function onPointerDown(ev) {
    if (ev.button !== 0 || closed) return;
    if (ev.composedPath().includes(closeBtn)) return;
    ev.preventDefault();
    ev.stopPropagation();

    const point = clampPoint(ev.clientX, ev.clientY);
    const dir = ev.target?.dataset?.d || '';

    if (dir && rect) {
      drag = { mode: 'resize', dir, startRect: { ...rect } };
    } else if (rect && inside(point)) {
      drag = { mode: 'inside' };
    } else if (rect && rect.w >= MIN_SIZE && rect.h >= MIN_SIZE) {
      finish(true);
      return;
    } else {
      drag = { mode: 'new', x0: point.x, y0: point.y };
      rect = { x: point.x, y: point.y, w: 0, h: 0 };
    }

    try {
      root.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    render();
  }

  function onPointerMove(ev) {
    if (!drag || closed || drag.mode === 'inside') return;
    ev.preventDefault();
    const point = clampPoint(ev.clientX, ev.clientY);

    if (drag.mode === 'resize') {
      const { startRect, dir } = drag;
      let left = startRect.x;
      let top = startRect.y;
      let right = startRect.x + startRect.w;
      let bottom = startRect.y + startRect.h;

      if (dir.includes('w')) left = Math.min(point.x, right - MIN_SIZE);
      if (dir.includes('e')) right = Math.max(point.x, left + MIN_SIZE);
      if (dir.includes('n')) top = Math.min(point.y, bottom - MIN_SIZE);
      if (dir.includes('s')) bottom = Math.max(point.y, top + MIN_SIZE);

      left = Math.max(0, left);
      top = Math.max(0, top);
      right = Math.min(clip.w, right);
      bottom = Math.min(clip.h, bottom);

      rect = {
        x: left,
        y: top,
        w: Math.max(MIN_SIZE, right - left),
        h: Math.max(MIN_SIZE, bottom - top),
      };
    } else {
      rect = {
        x: Math.min(drag.x0, point.x),
        y: Math.min(drag.y0, point.y),
        w: Math.abs(point.x - drag.x0),
        h: Math.abs(point.y - drag.y0),
      };
    }
    render();
  }

  function onPointerUp(ev) {
    if (!drag || closed) return;
    ev.preventDefault();
    const mode = drag.mode;
    drag = null;

    try {
      root.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }

    if (mode === 'inside') return;

    if (!rect || rect.w < MIN_SIZE || rect.h < MIN_SIZE) {
      rect = null;
      render();
      return;
    }

    if (mode === 'new') {
      search();
      return;
    }

    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => search(), RESIZE_DELAY);
  }

  function onPointerCancel() {
    if (!drag) return;
    drag = null;
    rect = null;
    render();
  }

  function search() {
    if (closed || !rect) return;
    const payload = {
      type: 'gplens:selection',
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h),
      },
      basis: { w: canvasSize.w, h: canvasSize.h },
    };
    chrome.runtime.sendMessage(payload, () => {
      void chrome.runtime.lastError;
    });
  }

  function finish(notify) {
    if (closed) return;
    closed = true;
    clearTimeout(resizeTimer);
    removeListeners();
    host.remove();
    if (notify) {
      chrome.runtime.sendMessage({ type: 'gplens:cancel' }, () => {
        void chrome.runtime.lastError;
      });
    }
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      finish(true);
      return;
    }
    if (scrollKeys.has(ev.key)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  function onWheel(ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }

  function onCloseClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    finish(true);
  }

  function onResize() {
    layout();
  }

  const scrollKeys = new Set([
    ' ', 'PageDown', 'PageUp', 'Home', 'End',
    'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight',
  ]);

  const listeners = [
    [root, 'pointerdown', onPointerDown, true],
    [root, 'pointermove', onPointerMove, true],
    [root, 'pointerup', onPointerUp, true],
    [root, 'pointercancel', onPointerCancel, true],
    [root, 'wheel', onWheel, { capture: true, passive: false }],
    [root, 'touchmove', onWheel, { capture: true, passive: false }],
    [root, 'contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); }, true],
    [root, 'dragstart', (ev) => ev.preventDefault(), true],
    [closeBtn, 'pointerdown', (ev) => ev.stopPropagation(), true],
    [closeBtn, 'click', onCloseClick, true],
    [window, 'keydown', onKeyDown, true],
    [window, 'resize', onResize, true],
  ];

  function removeListeners() {
    for (const [target, type, fn, opt] of listeners) target.removeEventListener(type, fn, opt);
  }

  for (const [target, type, fn, opt] of listeners) target.addEventListener(type, fn, opt);
  img.addEventListener('load', layout, { once: true });
  layout();
  if (img.complete) layout();
})();
