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
 * Geometry model (so the window ALWAYS equals what you see — crop shrinks the window):
 *   frame  : fw × fh   (the visible window box; overflow hidden)
 *   image  : iw × ih   (the displayed media), offset (ox, oy) inside the frame
 *   uncropped & unzoomed → iw=fw, ih=fh, ox=oy=0 (image exactly fills frame)
 *
 * Modes: free (drag move / pinch / wheel resize) · locked (hold = temp zoom, two-finger /
 * wheel = persistent zoom, video tap=play/pause & double-tap ±5s) · resize (4 corner
 * handles, aspect-locked) · crop (drag edges, apply shrinks the window to the crop).
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
    holdZoom: 1.7,
    maxZoom: 6,
    imageHoldMs: 190,
    videoHoldMs: 300,
};

const VIDEO_EXT = ['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v'];
const TAP_MAX_MS = 250;
const TAP_MOVE_SLOP = 8;
const DBL_TAP_MS = 300;
const MIN_WIN = 90;
const MIN_CROP_PX = 175;   // smallest crop region — keeps both action buttons inside
const WHEEL_STEP = 1.1;

let zBase = 2147482000;
let layerEl = null;

function getSettings() {
    extension_settings[MODULE] = Object.assign({}, DEFAULTS, extension_settings[MODULE] || {});
    return extension_settings[MODULE];
}

const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

function isVideoUrl(url) {
    try {
        const clean = String(url).split('?')[0].split('#')[0].toLowerCase();
        return VIDEO_EXT.some(ext => clean.endsWith('.' + ext));
    } catch { return false; }
}

/* Visible viewport in CSS px — matches the fixed `inset:0` layer (and works under
   DevTools device emulation, where visualViewport misreports). */
function viewportBox() {
    return {
        w: window.innerWidth || document.documentElement.clientWidth,
        h: window.innerHeight || document.documentElement.clientHeight,
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
    constructor({ url, type }) {
        this.url = url;
        this.type = type;
        this.mode = 'free';

        this.A = 1;                 // aspect ratio
        this.fw = 0; this.fh = 0;   // frame (window) size
        this.iw = 0; this.ih = 0;   // displayed image size
        this.ox = 0; this.oy = 0;   // image offset within frame

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

        this.spawnIdx = FloatItem._spawn++ % 6;
        this._build();
    }

    _build() {
        const win = document.createElement('div');
        win.className = 'mv_win mv_in';
        win.tabIndex = 0;
        win.setAttribute('data-swipe-ignore', 'true');

        const viewport = document.createElement('div');
        viewport.className = 'mv_viewport';

        let media;
        if (this.type === 'video') {
            media = document.createElement('video');
            media.src = this.url;
            media.autoplay = true; media.loop = true; media.playsInline = true;
            media.setAttribute('playsinline', ''); media.controls = false;
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

        this.win = win; this.viewport = viewport; this.media = media; this.controls = controls;

        ensureLayer().appendChild(win);
        this.bringToFront();
        win.addEventListener('animationend', () => win.classList.remove('mv_in'), { once: true });

        this._initSizeAndPlace();
        this._bindGestures();
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
            this.A = (natW && natH) ? natW / natH : 1;
            const vb = viewportBox();
            const maxW = Math.min(vb.w * 0.92, 1000);
            const maxH = vb.h * 0.88;
            let w = Math.min(natW || maxW, maxW);
            let h = w / this.A;
            if (h > maxH) { h = maxH; w = h * this.A; }
            w = clamp(w, MIN_WIN, maxW);
            this.fw = w; this.fh = w / this.A;
            this.iw = this.fw; this.ih = this.fh; this.ox = 0; this.oy = 0;
            this._applyFrame(); this._applyMedia(); this._centerInView();
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

    _applyFrame() {
        this.win.style.width = this.fw + 'px';
        this.win.style.height = this.fh + 'px';
    }
    _applyMedia(animate = false) {
        this.media.classList.toggle('mv_anim', !!animate);
        this.media.style.width = this.iw + 'px';
        this.media.style.height = this.ih + 'px';
        this.media.style.transform = `translate(${this.ox}px, ${this.oy}px)`;
        if (animate) setTimeout(() => this.media.classList.remove('mv_anim'), 240);
    }

    _centerInView() {
        const vb = viewportBox();
        const off = this.spawnIdx * 20;
        let left = (vb.w - this.fw) / 2 + off;
        let top = (vb.h - this.fh) / 2 + off;
        left = clamp(left, 4, vb.w - this.fw - 4);
        top = clamp(top, 4, vb.h - this.fh - 4);
        if (!isFinite(left)) left = 6;
        if (!isFinite(top)) top = 6;
        this.win.style.left = left + 'px';
        this.win.style.top = top + 'px';
    }

    bringToFront() { this.win.style.zIndex = String(++zBase); }

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

    _minImgW() { return Math.max(this.fw, this.fh * this.A); }
    _clampOffset() {
        this.ox = (this.iw <= this.fw) ? (this.fw - this.iw) / 2 : clamp(this.ox, this.fw - this.iw, 0);
        this.oy = (this.ih <= this.fh) ? (this.fh - this.ih) / 2 : clamp(this.oy, this.fh - this.ih, 0);
    }

    /* zoom the image to a focal screen point, by setting a new image width */
    zoomTo(screenX, screenY, newIw, animate = false) {
        const rect = this.viewport.getBoundingClientRect();
        const px = screenX - rect.left, py = screenY - rect.top;
        newIw = clamp(newIw, this._minImgW(), this._minImgW() * getSettings().maxZoom);
        const ratio = newIw / this.iw;
        this.ox = px - (px - this.ox) * ratio;
        this.oy = py - (py - this.oy) * ratio;
        this.iw = newIw; this.ih = newIw / this.A;
        this._clampOffset();
        this._applyMedia(animate);
    }

    /* scale the whole thing (frame + image) by a ratio around a focal screen point */
    scaleAround(cx, cy, ratio) {
        const vb = viewportBox();
        const newFw = clamp(this.fw * ratio, MIN_WIN, vb.w * 3);
        const r = newFw / this.fw;
        const left = parseFloat(this.win.style.left) || 0, top = parseFloat(this.win.style.top) || 0;
        this.fw *= r; this.fh *= r; this.iw *= r; this.ih *= r; this.ox *= r; this.oy *= r;
        this.win.style.left = (cx - (cx - left) * r) + 'px';
        this.win.style.top = (cy - (cy - top) * r) + 'px';
        this._applyFrame(); this._applyMedia();
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
            layer.appendChild(h); handles[pos] = h;
        });
        this.win.appendChild(layer);
        this.resizeLayer = layer; this.resizeHandles = handles;
        this._renderResize();
    }
    _renderResize() {
        if (!this.resizeHandles) return;
        const set = (k, x, y) => Object.assign(this.resizeHandles[k].style, { left: x + 'px', top: y + 'px' });
        set('nw', 0, 0); set('ne', this.fw, 0); set('sw', 0, this.fh); set('se', this.fw, this.fh);
    }
    _resizeCornerDown(e, pos) {
        e.preventDefault(); e.stopPropagation();
        const sx = e.clientX;
        const sLeft = parseFloat(this.win.style.left) || 0, sTop = parseFloat(this.win.style.top) || 0;
        const sFw = this.fw, sFh = this.fh, sIw = this.iw, sIh = this.ih, sOx = this.ox, sOy = this.oy;
        const right = sLeft + sFw, bottom = sTop + sFh;
        const vb = viewportBox();
        const move = ev => {
            const dx = ev.clientX - sx;
            let newFw = (pos === 'se' || pos === 'ne') ? sFw + dx : sFw - dx;
            newFw = clamp(newFw, MIN_WIN, vb.w * 3);
            const r = newFw / sFw;
            this.fw = sFw * r; this.fh = sFh * r; this.iw = sIw * r; this.ih = sIh * r; this.ox = sOx * r; this.oy = sOy * r;
            let nl = sLeft, nt = sTop;
            if (pos === 'nw') { nl = right - this.fw; nt = bottom - this.fh; }
            else if (pos === 'ne') { nt = bottom - this.fh; }
            else if (pos === 'sw') { nl = right - this.fw; }
            this.win.style.left = nl + 'px'; this.win.style.top = nt + 'px';
            this._applyFrame(); this._applyMedia(); this._renderResize();
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
        this.crop = { t: 0, r: 0, b: 0, l: 0 };
        this.showControls();

        const layer = document.createElement('div');
        layer.className = 'mv_crop';
        const dim = document.createElement('div');
        dim.className = 'mv_crop_dim';
        const shade = document.createElement('div');
        shade.className = 'mv_shade';
        dim.appendChild(shade);
        layer.appendChild(dim);
        const handles = {};
        ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'].forEach(pos => {
            const h = document.createElement('div');
            h.className = 'mv_handle mv_h_' + pos;
            h.addEventListener('pointerdown', e => this._cropHandleDown(e, pos));
            layer.appendChild(h); handles[pos] = h;
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
        const w = this.fw, h = this.fh;
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
            Object.assign(this.cropActions.style, { left: ((l + rx) / 2) + 'px', top: clamp(by - 46, t + 6, h - 46) + 'px' });
        }
        // controls follow the crop rect's top-right corner during crop
        this.controls.style.top = (t + 6) + 'px';
        this.controls.style.right = (r + 6) + 'px';
    }
    _cropHandleDown(e, pos) {
        e.preventDefault(); e.stopPropagation();
        const w = this.fw, h = this.fh;
        const sx = e.clientX, sy = e.clientY;
        const start = { ...this.crop };
        const minFx = clamp(MIN_CROP_PX / w, 0.05, 0.95);
        const minFy = clamp(MIN_CROP_PX / h, 0.05, 0.95);
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
        if (apply) {
            const { l, t, r, b } = this.crop;
            const left = parseFloat(this.win.style.left) || 0, top = parseFloat(this.win.style.top) || 0;
            // shrink the window to the crop rect; image keeps its size, offset shifts
            this.ox -= l * this.fw;
            this.oy -= t * this.fh;
            this.win.style.left = (left + l * this.fw) + 'px';
            this.win.style.top = (top + t * this.fh) + 'px';
            this.fw = this.fw * (1 - l - r);
            this.fh = this.fh * (1 - t - b);
            this._applyFrame(); this._clampOffset(); this._applyMedia();
        }
        this.cropLayer?.remove();
        this.cropLayer = this.cropShade = this.cropHandles = this.cropActions = null;
        this.btnCrop.classList.remove('mv_active');
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
        if (this.mode === 'locked') this.zoomTo(e.clientX, e.clientY, this.iw * f, true);
        else this.scaleAround(e.clientX, e.clientY, f);
        this.showControls(); this.scheduleHide();
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
        this.persist = { iw: this.iw, ox: this.ox, oy: this.oy };
        this.holdActive = true;
        this.zoomTo(x, y, this.iw * getSettings().holdZoom, true);
    }
    _cancelHold() { if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; } }

    _startPinch() {
        const pts = [...this.pointers.values()];
        this.pinch = {
            dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
            iw0: this.iw,
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
            if (this.mode === 'locked') this.zoomTo(mid.x, mid.y, this.pinch.iw0 * ratio);
            else if (this.mode === 'free') {
                this.scaleAround(mid.x, mid.y, ratio);
                this.pinch.dist = dist; // incremental for free resize
            }
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
        } else if (this.mode === 'locked' && (this.holdActive || this.iw > this.fw + 0.5 || this.ih > this.fh + 0.5)) {
            this.ox += dx; this.oy += dy; this._clampOffset(); this._applyMedia();
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
                this.iw = this.persist.iw; this.ih = this.iw / this.A;
                this.ox = this.persist.ox; this.oy = this.persist.oy;
                this._clampOffset(); this._applyMedia(true);
                this.holdActive = false; this.persist = null;
            } else if (this.downInfo && !this.downInfo.moved && (Date.now() - this.downInfo.t) < TAP_MAX_MS) {
                this._handleTap(e.clientX, e.clientY);
            }
        }
        this.scheduleHide();
        this.downInfo = null;
    }

    _handleTap(x) {
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
            if (url) return { url, type: (el && el.tagName === 'VIDEO') || isVideoUrl(url) ? 'video' : 'image' };
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
