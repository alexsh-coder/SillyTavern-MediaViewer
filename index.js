/*
 * MediaViewer — floating, multi-instance media viewer for SillyTavern.
 *
 * Click any media (chat images/videos, message avatars, image gallery thumbs) to pop it
 * out as a draggable floating window. Multiple can be open at once. While enabled it
 * replaces SillyTavern's built-in lightbox / avatar zoom (disable it → built-in returns).
 *
 * No backdrop dim: the layer is click-through, the page behind stays visible/usable, and
 * ST swipes keep working (windows live outside #sheld + data-swipe-ignore).
 *
 * Modes per window:
 *   free   : drag to move, pinch / wheel to resize the window. (default)
 *   locked : window frozen. image — hold = temporary zoom (revert on release), two-finger /
 *            wheel = persistent zoom (bounded, pan clamped). video — tap = play/pause,
 *            double-tap left = -5s / right = +5s, hold = zoom. A quick tap only reveals controls.
 *   resize : 4 corner handles, proportional (aspect-locked) window scaling.
 *   crop   : drag edges/corners to crop (visual clip), apply / cancel.
 *
 * Controls (top-right): lock / resize / crop / close — desktop on hover, mobile on touch.
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE = 'MediaViewer';

const DEFAULTS = {
    enabled: true,
    chat: true,
    avatars: true,
    gallery: true,
    fadeMs: 1800,
    holdZoom: 1.7,     // gentle fixed magnification for press-hold zoom
    maxZoom: 6,
    imageHoldMs: 190,
    videoHoldMs: 300,
};

const VIDEO_EXT = ['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v'];
const TAP_MAX_MS = 250;
const TAP_MOVE_SLOP = 8;
const DBL_TAP_MS = 300;
const MIN_WIN = 90;
const MIN_CROP_PX = 130;   // smallest crop region — keeps the action buttons visible
const WHEEL_STEP = 1.1;

let zCounter = 10060;
let layerEl = null;

function getSettings() {
    extension_settings[MODULE] = Object.assign({}, DEFAULTS, extension_settings[MODULE] || {});
    return extension_settings[MODULE];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function isVideoUrl(url) {
    try {
        const clean = String(url).split('?')[0].split('#')[0].toLowerCase();
        return VIDEO_EXT.some(ext => clean.endsWith('.' + ext));
    } catch { return false; }
}

/* Layout viewport — matches the fixed `inset:0` layer exactly, and is correct under
   DevTools device emulation (visualViewport is not). */
function viewportBox() {
    const de = document.documentElement;
    return {
        x: 0,
        y: 0,
        w: de.clientWidth || window.innerWidth,
        h: de.clientHeight || window.innerHeight,
    };
}

function ensureLayer() {
    if (layerEl && document.body.contains(layerEl)) return layerEl;
    layerEl = document.createElement('div');
    layerEl.id = 'mediaviewer_layer';
    document.body.appendChild(layerEl);
    return layerEl;
}

/* ------------------------------------------------------------------ */

class FloatItem {
    constructor({ url, type, title }) {
        this.url = url;
        this.type = type;
        this.title = title || '';
        this.mode = 'free';

        this.z = 1; this.tx = 0; this.ty = 0;
        this.crop = { t: 0, r: 0, b: 0, l: 0 };
        this.cropBackup = null;

        this.pointers = new Map();
        this.pinch = null;
        this.holdActive = false;
        this.holdTimer = null;
        this.persist = null;
        this.downInfo = null;
        this.lastTap = 0;
        this.singleTapTimer = null;
        this.fadeTimer = null;

        this.aspect = 1;
        this.spawnIdx = FloatItem._spawn++ % 6;
        this._build();
    }

    _build() {
        const win = document.createElement('div');
        win.className = 'mv_win';
        win.tabIndex = 0;
        win.setAttribute('data-swipe-ignore', 'true');

        const viewport = document.createElement('div');
        viewport.className = 'mv_viewport';

        let media;
        if (this.type === 'video') {
            media = document.createElement('video');
            media.src = this.url;
            media.autoplay = true;
            media.loop = true;
            media.playsInline = true;
            media.setAttribute('playsinline', '');
            media.controls = false;
        } else {
            media = document.createElement('img');
            media.src = this.url;
        }
        media.className = 'mv_media';
        media.setAttribute('data-swipe-ignore', 'true');
        media.draggable = false;
        media.addEventListener('error', () => console.warn('[MediaViewer] media failed:', this.url), { once: true });

        viewport.appendChild(media);
        win.appendChild(viewport);

        const controls = document.createElement('div');
        controls.className = 'mv_controls';
        this.btnLock = this._mkBtn('fa-lock-open', 'Lock / unlock', () => this.toggleLock());
        this.btnResize = this._mkBtn('fa-expand', 'Resize', () => this.toggleResize());
        this.btnCrop = this._mkBtn('fa-crop-simple', 'Crop', () => this.toggleCrop());
        this.btnClose = this._mkBtn('fa-xmark', 'Close', () => this.close());
        controls.append(this.btnLock, this.btnResize, this.btnCrop, this.btnClose);
        win.appendChild(controls);

        this.win = win;
        this.viewport = viewport;
        this.media = media;
        this.controls = controls;

        this._initSizeAndPlace();
        this._bindGestures();

        ensureLayer().appendChild(win);
        this.bringToFront();
    }

    _mkBtn(icon, title, onClick) {
        const b = document.createElement('button');
        b.className = 'mv_btn';
        b.title = title;
        b.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        const stop = e => e.stopPropagation();
        b.addEventListener('pointerdown', stop);
        b.addEventListener('pointerup', stop);
        b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
        return b;
    }

    _initSizeAndPlace() {
        const place = (natW, natH) => {
            this.aspect = (natW && natH) ? natW / natH : 1;
            const vb = viewportBox();
            const maxW = Math.min(vb.w * 0.92, 1000);
            const maxH = vb.h * 0.88;
            let w = Math.min(natW || maxW, maxW);
            let h = w / this.aspect;
            if (h > maxH) { h = maxH; w = h * this.aspect; }
            w = clamp(w, MIN_WIN, maxW);
            this._setWinSize(w);
            this._centerInView();
        };

        if (this.type === 'video') {
            if (this.media.readyState >= 1 && this.media.videoWidth) {
                place(this.media.videoWidth, this.media.videoHeight);
            } else {
                this.media.addEventListener('loadedmetadata',
                    () => place(this.media.videoWidth, this.media.videoHeight), { once: true });
                place(640, 360);
            }
            this.media.play?.().catch(() => { });
        } else {
            if (this.media.complete && this.media.naturalWidth) {
                place(this.media.naturalWidth, this.media.naturalHeight);
            } else {
                this.media.addEventListener('load',
                    () => place(this.media.naturalWidth, this.media.naturalHeight), { once: true });
                place(400, 400);
            }
        }
    }

    _setWinSize(w) {
        this.winW = w;
        this.win.style.width = w + 'px';
        this.win.style.height = (w / this.aspect) + 'px';
    }

    _winH() { return this.winW / this.aspect; }

    _centerInView() {
        const vb = viewportBox();
        const w = this.winW, h = this._winH();
        const off = this.spawnIdx * 22;
        let left = (vb.w - w) / 2 + off;
        let top = (vb.h - h) / 2 + off;
        left = clamp(left, 4, Math.max(4, vb.w - w - 4));
        top = clamp(top, 4, Math.max(4, vb.h - h - 4));
        if (!isFinite(left)) left = 4;
        if (!isFinite(top)) top = 4;
        this.win.style.left = left + 'px';
        this.win.style.top = top + 'px';
    }

    bringToFront() { this.win.style.zIndex = String(++zCounter); }

    showControls() {
        this.controls.classList.add('mv_show');
        if (this.fadeTimer) clearTimeout(this.fadeTimer);
    }
    scheduleHide() {
        if (this.fadeTimer) clearTimeout(this.fadeTimer);
        this.fadeTimer = setTimeout(() => {
            if (this.mode !== 'crop' && this.mode !== 'resize') this.controls.classList.remove('mv_show');
        }, getSettings().fadeMs);
    }

    applyTransform(animate = false) {
        this.media.classList.toggle('mv_anim', !!animate);
        this.media.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.z})`;
        if (animate) setTimeout(() => this.media.classList.remove('mv_anim'), 240);
    }

    clampPan() {
        const vw = this.winW, vh = this._winH();
        this.tx = clamp(this.tx, Math.min(0, vw - this.z * vw), 0);
        this.ty = clamp(this.ty, Math.min(0, vh - this.z * vh), 0);
    }

    zoomAt(screenX, screenY, newZ, animate = false) {
        const rect = this.viewport.getBoundingClientRect();
        const px = screenX - rect.left, py = screenY - rect.top;
        const mx = (px - this.tx) / this.z, my = (py - this.ty) / this.z;
        this.z = clamp(newZ, 1, getSettings().maxZoom);
        this.tx = px - this.z * mx; this.ty = py - this.z * my;
        this.clampPan();
        this.applyTransform(animate);
    }

    /* ---- mode switches ---- */
    toggleLock() {
        if (this.mode === 'crop') this._exitCrop(false);
        if (this.mode === 'resize') this._exitResize();
        if (this.mode === 'locked') {
            this.mode = 'free';
            this.win.classList.remove('mv_locked');
            this.btnLock.classList.remove('mv_active');
            this.btnLock.innerHTML = '<i class="fa-solid fa-lock-open"></i>';
            this.z = 1; this.tx = 0; this.ty = 0; this.applyTransform(true);
        } else {
            this.mode = 'locked';
            this.win.classList.add('mv_locked');
            this.btnLock.classList.add('mv_active');
            this.btnLock.innerHTML = '<i class="fa-solid fa-lock"></i>';
        }
        this.showControls(); this.scheduleHide();
    }

    _baseMode() { return (this.mode === 'free' || this.mode === 'locked') ? this.mode : 'free'; }

    /* ---- proportional resize ---- */
    toggleResize() {
        if (this.mode === 'resize') { this._exitResize(); return; }
        this._enterResize();
    }
    _enterResize() {
        if (this.mode === 'crop') this._exitCrop(false);
        this.prevMode = this._baseMode();
        this.mode = 'resize';
        this.btnResize.classList.add('mv_active');
        this.showControls();

        const layer = document.createElement('div');
        layer.className = 'mv_resize';
        const handles = {};
        ['nw', 'ne', 'sw', 'se'].forEach(pos => {
            const h = document.createElement('div');
            h.className = 'mv_handle mv_h_' + pos;
            h.addEventListener('pointerdown', e => this._resizeCornerDown(e, pos));
            layer.appendChild(h);
            handles[pos] = h;
        });
        this.win.appendChild(layer);
        this.resizeLayer = layer;
        this.resizeHandles = handles;
        this._renderResize();
    }
    _renderResize() {
        if (!this.resizeHandles) return;
        const w = this.winW, h = this._winH();
        const set = (k, x, y) => Object.assign(this.resizeHandles[k].style, { left: x + 'px', top: y + 'px' });
        set('nw', 0, 0); set('ne', w, 0); set('sw', 0, h); set('se', w, h);
    }
    _resizeCornerDown(e, pos) {
        e.preventDefault(); e.stopPropagation();
        const sx = e.clientX;
        const sLeft = parseFloat(this.win.style.left) || 0;
        const sTop = parseFloat(this.win.style.top) || 0;
        const sW = this.winW, sH = this._winH();
        const right = sLeft + sW, bottom = sTop + sH;
        const vb = viewportBox();
        const move = ev => {
            const dx = ev.clientX - sx;
            let newW = (pos === 'se' || pos === 'ne') ? sW + dx : sW - dx;
            newW = clamp(newW, MIN_WIN, vb.w * 3);
            this._setWinSize(newW);
            const newH = this._winH();
            let nl = sLeft, nt = sTop;
            if (pos === 'nw') { nl = right - newW; nt = bottom - newH; }
            else if (pos === 'ne') { nl = sLeft; nt = bottom - newH; }
            else if (pos === 'sw') { nl = right - newW; nt = sTop; }
            this.win.style.left = nl + 'px';
            this.win.style.top = nt + 'px';
            this._renderResize();
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }
    _exitResize() {
        this.resizeLayer?.remove();
        this.resizeLayer = this.resizeHandles = null;
        this.btnResize.classList.remove('mv_active');
        this.mode = this.prevMode || 'free';
        this.scheduleHide();
    }

    /* ---- crop ---- */
    toggleCrop() {
        if (this.mode === 'crop') { this._exitCrop(true); return; }
        if (this.mode === 'resize') this._exitResize();
        this._enterCrop();
    }

    _enterCrop() {
        this.prevMode = this._baseMode();
        this.mode = 'crop';
        this.btnCrop.classList.add('mv_active');
        this.cropBackup = { ...this.crop };
        this.showControls();

        const layer = document.createElement('div');
        layer.className = 'mv_crop';
        const shade = document.createElement('div');
        shade.className = 'mv_shade';
        layer.appendChild(shade);

        const handles = {};
        ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'].forEach(pos => {
            const h = document.createElement('div');
            h.className = 'mv_handle mv_h_' + pos;
            h.addEventListener('pointerdown', e => this._cropHandleDown(e, pos));
            layer.appendChild(h);
            handles[pos] = h;
        });

        const actions = document.createElement('div');
        actions.className = 'mv_crop_actions';
        const ok = this._mkBtn('fa-check', 'Apply', () => this._exitCrop(true));
        const cancel = this._mkBtn('fa-xmark', 'Cancel', () => this._exitCrop(false));
        ok.classList.add('mv_active');
        actions.append(ok, cancel);
        layer.appendChild(actions);
        this.cropActions = actions;

        this.win.appendChild(layer);
        this.cropLayer = layer; this.cropShade = shade; this.cropHandles = handles;
        this._renderCrop();
    }

    _renderCrop() {
        const w = this.winW, h = this._winH();
        const l = this.crop.l * w, r = this.crop.r * w, t = this.crop.t * h, b = this.crop.b * h;
        const rx = w - r, by = h - b;
        if (this.cropShade) Object.assign(this.cropShade.style,
            { left: l + 'px', top: t + 'px', width: (w - l - r) + 'px', height: (h - t - b) + 'px' });
        if (this.cropHandles) {
            const cx = (l + rx) / 2, cy = (t + by) / 2;
            const set = (k, x, y) => Object.assign(this.cropHandles[k].style, { left: x + 'px', top: y + 'px' });
            set('nw', l, t); set('ne', rx, t); set('sw', l, by); set('se', rx, by);
            set('n', cx, t); set('s', cx, by); set('w', l, cy); set('e', rx, cy);
        }
        if (this.cropActions) {
            const cx = (l + rx) / 2;
            const ay = clamp(by - 46, t + 6, h - 46);
            Object.assign(this.cropActions.style, { left: cx + 'px', top: ay + 'px' });
        }
        // move the top control cluster to follow the crop rect's top-right corner
        this.controls.style.top = (t + 6) + 'px';
        this.controls.style.right = (r + 6) + 'px';
        // visual crop preview on the VIEWPORT only — controls/handles stay reachable
        this.viewport.style.clipPath = `inset(${t}px ${r}px ${b}px ${l}px round 10px)`;
    }

    _cropHandleDown(e, pos) {
        e.preventDefault(); e.stopPropagation();
        const w = this.winW, h = this._winH();
        const sx = e.clientX, sy = e.clientY;
        const start = { ...this.crop };
        const minFx = clamp(MIN_CROP_PX / w, 0.05, 0.9);
        const minFy = clamp(MIN_CROP_PX / h, 0.05, 0.9);
        const move = ev => {
            const dx = (ev.clientX - sx) / w, dy = (ev.clientY - sy) / h;
            const c = { ...start };
            if (pos.includes('w')) c.l = clamp(start.l + dx, 0, 1 - start.r - minFx);
            if (pos.includes('e')) c.r = clamp(start.r - dx, 0, 1 - start.l - minFx);
            if (pos.includes('n')) c.t = clamp(start.t + dy, 0, 1 - start.b - minFy);
            if (pos.includes('s')) c.b = clamp(start.b - dy, 0, 1 - start.t - minFy);
            this.crop = c; this._renderCrop();
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    _exitCrop(apply) {
        if (!apply && this.cropBackup) this.crop = { ...this.cropBackup };
        const w = this.winW, h = this._winH();
        const { t, r, b, l } = this.crop;
        this.viewport.style.clipPath = (t || r || b || l)
            ? `inset(${t * h}px ${r * w}px ${b * h}px ${l * w}px round 10px)` : '';
        this.cropLayer?.remove();
        this.cropLayer = this.cropShade = this.cropHandles = this.cropActions = null;
        this.btnCrop.classList.remove('mv_active');
        // restore the control cluster to the window corner
        this.controls.style.top = '';
        this.controls.style.right = '';
        this.mode = this.prevMode || 'free';
        this.scheduleHide();
    }

    /* ---- gestures ---- */
    _bindGestures() {
        const win = this.win;
        win.addEventListener('pointerdown', e => this._onDown(e));
        win.addEventListener('pointermove', e => this._onMove(e));
        win.addEventListener('pointerup', e => this._onUp(e));
        win.addEventListener('pointercancel', e => this._onUp(e));
        win.addEventListener('wheel', e => this._onWheel(e), { passive: false });
        win.addEventListener('dblclick', e => e.preventDefault());
    }

    _onWheel(e) {
        if (this.mode === 'crop' || this.mode === 'resize') return;
        e.preventDefault(); e.stopPropagation();
        this.bringToFront();
        const f = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
        if (this.mode === 'locked') this.zoomAt(e.clientX, e.clientY, this.z * f, true);
        else this._resizeAround(e.clientX, e.clientY, this.winW * f);
        this.showControls(); this.scheduleHide();
    }

    _resizeAround(cx, cy, newW) {
        const vb = viewportBox();
        newW = clamp(newW, MIN_WIN, vb.w * 3);
        const oldW = this.winW, oldH = this._winH();
        const left = parseFloat(this.win.style.left) || 0, top = parseFloat(this.win.style.top) || 0;
        this._setWinSize(newW);
        const newH = this._winH();
        this.win.style.left = (cx - (cx - left) * (newW / oldW)) + 'px';
        this.win.style.top = (cy - (cy - top) * (newH / oldH)) + 'px';
    }

    _onDown(e) {
        if (this.mode === 'crop' || this.mode === 'resize') return;
        e.preventDefault();
        this.win.setPointerCapture?.(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.bringToFront();
        this.showControls();

        if (this.pointers.size === 2) { this._startPinch(); this._cancelHold(); return; }

        this.downInfo = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
        this.lastPos = { x: e.clientX, y: e.clientY };

        if (this.mode === 'free') {
            this.dragStart = {
                left: parseFloat(this.win.style.left) || 0,
                top: parseFloat(this.win.style.top) || 0,
            };
        } else if (this.mode === 'locked') {
            const delay = this.type === 'video' ? getSettings().videoHoldMs : getSettings().imageHoldMs;
            this.holdTimer = setTimeout(() => this._engageHold(e.clientX, e.clientY), delay);
        }
    }

    _engageHold(x, y) {
        this.persist = { z: this.z, tx: this.tx, ty: this.ty };
        this.holdActive = true;
        this.zoomAt(x, y, this.z * getSettings().holdZoom, true);
    }
    _cancelHold() { if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; } }

    _startPinch() {
        const pts = [...this.pointers.values()];
        this.pinch = {
            dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
            z0: this.z, w0: this.winW,
        };
        this.holdActive = false; this.persist = null;
    }

    _onMove(e) {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this.pointers.size >= 2 && this.pinch) {
            const pts = [...this.pointers.values()];
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            const ratio = dist / (this.pinch.dist || dist);
            if (this.mode === 'locked') this.zoomAt(mid.x, mid.y, this.pinch.z0 * ratio);
            else if (this.mode === 'free') this._resizeAround(mid.x, mid.y, this.pinch.w0 * ratio);
            return;
        }

        if (this.pointers.size !== 1 || !this.downInfo) return;
        const dx = e.clientX - this.lastPos.x, dy = e.clientY - this.lastPos.y;
        this.lastPos = { x: e.clientX, y: e.clientY };
        if (Math.hypot(e.clientX - this.downInfo.x, e.clientY - this.downInfo.y) > TAP_MOVE_SLOP) {
            if (!this.downInfo.moved) { this.downInfo.moved = true; if (!this.holdActive) this._cancelHold(); }
        }

        if (this.mode === 'free') {
            this.dragStart.left += dx; this.dragStart.top += dy;
            this.win.style.left = this.dragStart.left + 'px';
            this.win.style.top = this.dragStart.top + 'px';
        } else if (this.mode === 'locked' && (this.holdActive || this.z > 1)) {
            this.tx += dx; this.ty += dy; this.clampPan(); this.applyTransform();
        }
    }

    _onUp(e) {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.delete(e.pointerId);
        this.win.releasePointerCapture?.(e.pointerId);

        if (this.pointers.size === 1) {
            this.pinch = null;
            const rem = [...this.pointers.values()][0];
            this.lastPos = { x: rem.x, y: rem.y };
            this.downInfo = { x: rem.x, y: rem.y, t: Date.now(), moved: true };
            return;
        }
        if (this.pointers.size > 1) return;

        this._cancelHold();
        this.pinch = null;

        if (this.mode === 'locked') {
            if (this.holdActive && this.persist) {
                this.z = this.persist.z; this.tx = this.persist.tx; this.ty = this.persist.ty;
                this.clampPan(); this.applyTransform(true);
                this.holdActive = false; this.persist = null;
            } else if (this.downInfo && !this.downInfo.moved && (Date.now() - this.downInfo.t) < TAP_MAX_MS) {
                this._handleTap(e.clientX, e.clientY);
            }
        }
        this.scheduleHide();
        this.downInfo = null;
    }

    _handleTap(x, y) {
        if (this.type !== 'video') return;
        const now = Date.now();
        if (now - this.lastTap < DBL_TAP_MS) {
            if (this.singleTapTimer) { clearTimeout(this.singleTapTimer); this.singleTapTimer = null; }
            this.lastTap = 0;
            const rect = this.viewport.getBoundingClientRect();
            const left = (x - rect.left) < rect.width / 2;
            try { this.media.currentTime = clamp(this.media.currentTime + (left ? -5 : 5), 0, this.media.duration || 1e9); } catch { }
        } else {
            this.lastTap = now;
            this.singleTapTimer = setTimeout(() => {
                this.singleTapTimer = null;
                if (this.media.paused) this.media.play?.().catch(() => { });
                else this.media.pause?.();
            }, DBL_TAP_MS);
        }
    }

    close() {
        this._cancelHold();
        if (this.singleTapTimer) clearTimeout(this.singleTapTimer);
        if (this.fadeTimer) clearTimeout(this.fadeTimer);
        try { this.media.pause?.(); } catch { }
        this.win.remove();
    }
}
FloatItem._spawn = 0;

/* ------------------------------------------------------------------ */

function resolveMedia(target) {
    const s = getSettings();
    const srcOf = el => el?.currentSrc || el?.getAttribute('src') || el?.src || '';

    if (s.avatars) {
        const av = target.closest?.('.mes .avatar');
        if (av) {
            const url = srcOf(av.querySelector('img'));
            if (url) return { url, type: 'image' };
        }
    }
    if (s.gallery) {
        const thumb = target.closest?.('#dragGallery .nGY2GThumbnail, .nGY2GThumbnail');
        if (thumb) {
            const url = srcOf(thumb.querySelector('img.nGY2GThumbnailImg, img')) || thumb.getAttribute('data-ngsrc') || '';
            if (url) return { url, type: isVideoUrl(url) ? 'video' : 'image' };
        }
    }
    if (s.chat) {
        const cont = target.closest?.('.mes_media_container, .mes_img, .mes_media_enlarge, .mes_video');
        if (cont) {
            const el = cont.matches?.('img, video') ? cont : cont.querySelector('img, video');
            const url = srcOf(el);
            if (url) return { url, type: (el.tagName === 'VIDEO' || isVideoUrl(url)) ? 'video' : 'image' };
        }
    }
    return null;
}

function onCaptureClick(e) {
    if (!getSettings().enabled) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#mediaviewer_layer')) return;
    const info = resolveMedia(t);
    if (!info || !info.url) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    new FloatItem(info);
}

let installed = false;
function installInterception() {
    if (installed) return;
    document.addEventListener('click', onCaptureClick, true);
    installed = true;
}

/* ------------------------------------------------------------------ */

function buildSettingsUI() {
    if (document.getElementById('mediaviewer_settings')) return;
    const host = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!host) return;
    const s = getSettings();
    const html = `
    <div id="mediaviewer_settings" class="extension_settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>MediaViewer</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content mv_flex">
          <label class="checkbox_label"><input type="checkbox" id="mv_enabled"> Enabled</label>
          <label class="checkbox_label"><input type="checkbox" id="mv_chat"> Chat media</label>
          <label class="checkbox_label"><input type="checkbox" id="mv_avatars"> Avatars</label>
          <label class="checkbox_label"><input type="checkbox" id="mv_gallery"> Image gallery</label>
          <label>Controls fade (ms)<input type="number" id="mv_fade" class="text_pole" min="500" max="10000" step="100" style="width:90px"></label>
          <label>Hold zoom<input type="number" id="mv_holdzoom" class="text_pole" min="1.1" max="6" step="0.1" style="width:90px"></label>
          <label>Max zoom<input type="number" id="mv_maxzoom" class="text_pole" min="2" max="12" step="0.5" style="width:90px"></label>
        </div>
      </div>
    </div>`;
    host.insertAdjacentHTML('beforeend', html);
    const bind = (id, key, isNum) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!s[key]; else el.value = s[key];
        el.addEventListener('change', () => {
            s[key] = el.type === 'checkbox' ? el.checked : (isNum ? parseFloat(el.value) : el.value);
            saveSettingsDebounced();
        });
    };
    bind('mv_enabled', 'enabled'); bind('mv_chat', 'chat'); bind('mv_avatars', 'avatars');
    bind('mv_gallery', 'gallery'); bind('mv_fade', 'fadeMs', true);
    bind('mv_holdzoom', 'holdZoom', true); bind('mv_maxzoom', 'maxZoom', true);
}

let inited = false;
function init() {
    if (inited) return;
    inited = true;
    getSettings();
    ensureLayer();
    installInterception();
    buildSettingsUI();
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && layerEl && layerEl.lastElementChild) layerEl.lastElementChild.remove();
    });
    console.log('[MediaViewer] ready');
}

try {
    if (eventSource && event_types?.APP_READY) {
        eventSource.on(event_types.APP_READY, init);
        if (document.getElementById('extensions_settings')) setTimeout(init, 0);
    } else {
        jQuery(() => init());
    }
} catch (err) {
    console.error('[MediaViewer] init error', err);
    jQuery(() => init());
}
