/*
 * MediaViewer — floating, multi-instance media viewer for SillyTavern.
 *
 * Click any media (chat images/videos, message avatars, image gallery thumbs) to pop it
 * out as a draggable floating window. Multiple can be open at once. While enabled it
 * replaces SillyTavern's built-in lightbox / avatar zoom / gallery popup.
 *
 * No backdrop dim: the layer is click-through, the page behind stays visible/usable, and
 * ST swipes keep working (windows live outside #sheld + data-swipe-ignore).
 *
 * The window is positioned with CSS `transform: translate()` (not left/top) — stable on
 * iOS Safari. Geometry: frame (fw×fh, the visible window) + image (iw×ih) + offset (ox,oy).
 * Crop apply shrinks the window to the crop region so the window always equals what you see.
 *
 * Modes: free (drag move / pinch / wheel resize) · locked (hold = temp zoom, two-finger /
 * wheel = persistent zoom, video tap=play/pause & double-tap ±5s) · resize (4 corner handles,
 * aspect-locked, move + apply/cancel) · crop (drag edges or the selection, apply/cancel).
 * Controls (top-right): lock · resize · crop · reset · close.
 *
 * Per-media state (position/zoom/crop) is remembered and restored on reopen.
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
    holdZoom: 1.5,
    maxZoom: 6,
    imageHoldMs: 190,
    videoHoldMs: 300,
};

const VIDEO_EXT = ['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v'];
const TAP_MAX_MS = 250;
const TAP_MOVE_SLOP = 8;
const DBL_TAP_MS = 300;
const MIN_WIN = 200;   // min window width — keeps the top-right controls from overflowing
const MIN_CROP_PX = 210;
const WHEEL_STEP = 1.1;

let zBase = 2147482000;
let layerEl = null;

function getSettings() {
    // IMPORTANT: keep the SAME object reference (the settings panel binds to it). Recreating
    // it each call made UI changes write to a stale copy → settings appeared to do nothing.
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    const s = extension_settings[MODULE];
    for (const k in DEFAULTS) if (s[k] === undefined) s[k] = DEFAULTS[k];
    // one-time migration: reset the stale holdZoom (2.5) persisted by older versions
    if (s._mvMig !== 1) { s.holdZoom = 1.5; s._mvMig = 1; try { saveSettingsDebounced(); } catch { } }
    return s;
}

const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

function isVideoUrl(url) {
    try {
        const clean = String(url).split('?')[0].split('#')[0].toLowerCase();
        return VIDEO_EXT.some(ext => clean.endsWith('.' + ext));
    } catch { return false; }
}

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
    constructor({ url, type, fallback }) {
        this.url = url;
        this.type = type;
        this.fallback = fallback || '';
        this.mode = 'free';

        this.A = 1;
        this.fw = 0; this.fh = 0;
        this.iw = 0; this.ih = 0;
        this.ox = 0; this.oy = 0;
        this.posX = 0; this.posY = 0;
        this.holdScale = 1; this.holdTX = 0; this.holdTY = 0; this.holdOrigin = '0 0';
        this._placed = false;
        this.orig = null;

        this.crop = { t: 0, r: 0, b: 0, l: 0 };

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
        win.className = 'mv_win';
        win.tabIndex = 0;
        win.style.visibility = 'hidden'; // shown once correctly sized (no square flash)
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
        let triedFallback = false;
        media.addEventListener('error', () => {
            if (!triedFallback && this.fallback && this.fallback !== this.url) {
                triedFallback = true; media.src = this.fallback;
            } else { console.warn('[MediaViewer] media failed:', this.url); }
        });

        viewport.appendChild(media);
        win.appendChild(viewport);

        const controls = document.createElement('div');
        controls.className = 'mv_controls';
        this.btnLock = this._mkBtn('fa-lock-open', 'Lock / unlock', () => this.toggleLock());
        this.btnResize = this._mkBtn('fa-expand', 'Resize', () => this.toggleResize());
        this.btnCrop = this._mkBtn('fa-crop-simple', 'Crop', () => this.toggleCrop());
        this.btnReset = this._mkBtn('fa-rotate-left', 'Reset', () => this.reset());
        this.btnClose = this._mkBtn('fa-xmark', 'Close', () => this.close());
        controls.append(this.btnLock, this.btnResize, this.btnCrop, this.btnReset, this.btnClose);
        win.appendChild(controls);

        this.win = win; this.viewport = viewport; this.media = media; this.controls = controls;

        ensureLayer().appendChild(win);
        this.bringToFront();

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

    _show() { this.win.style.visibility = 'visible'; }

    _fitFor(natW, natH) {
        const A = (natW && natH) ? natW / natH : 1;
        const vb = viewportBox();
        const maxW = Math.min(vb.w * 0.92, 1000);
        const maxH = vb.h * 0.88;
        let w = Math.min(natW || maxW, maxW);
        let h = w / A;
        if (h > maxH) { h = maxH; w = h * A; }
        w = clamp(w, MIN_WIN, maxW);
        return { A, fw: w, fh: w / A };
    }

    _initSizeAndPlace() {
        const saved = FloatItem.saved[this.url];
        if (saved) {
            this.A = saved.A; this.fw = saved.fw; this.fh = saved.fh;
            this.iw = saved.iw; this.ih = saved.ih; this.ox = saved.ox; this.oy = saved.oy;
            this.posX = saved.posX; this.posY = saved.posY;
            this._applyFrame(); this._applyMedia(); this._clampWindowIntoView();
            this._placed = true; this._show();
            if (saved.mode === 'locked') {
                this.mode = 'locked';
                this.win.classList.add('mv_locked');
                this.btnLock.classList.add('mv_active');
                this.btnLock.innerHTML = '<i class="fa-solid fa-lock"></i>';
            }
        }

        const onMeta = (natW, natH) => {
            this.orig = this._fitFor(natW, natH); // natural fit, used by Reset
            if (!this._placed) {
                this.A = this.orig.A; this.fw = this.orig.fw; this.fh = this.orig.fh;
                this.iw = this.fw; this.ih = this.fh; this.ox = 0; this.oy = 0;
                this._applyFrame(); this._applyMedia(); this._centerInView();
                this._placed = true;
            }
            this._show();
        };

        if (this.type === 'video') {
            if (this.media.readyState >= 1 && this.media.videoWidth) onMeta(this.media.videoWidth, this.media.videoHeight);
            else this.media.addEventListener('loadedmetadata', () => onMeta(this.media.videoWidth, this.media.videoHeight), { once: true });
            this.media.play?.().catch(() => { });
        } else {
            if (this.media.complete && this.media.naturalWidth) onMeta(this.media.naturalWidth, this.media.naturalHeight);
            else this.media.addEventListener('load', () => onMeta(this.media.naturalWidth, this.media.naturalHeight), { once: true });
        }
    }

    _applyFrame() {
        this.win.style.width = this.fw + 'px';
        this.win.style.height = this.fh + 'px';
    }
    _applyPos() {
        this.win.style.transform = `translate(${this.posX}px, ${this.posY}px)`;
    }
    _applyMedia(animate = false) {
        this.media.classList.toggle('mv_anim', !!animate);
        this.media.style.width = this.iw + 'px';
        this.media.style.height = this.ih + 'px';
        this.media.style.transformOrigin = this.holdOrigin;
        this.media.style.transform = `translate(${this.ox + this.holdTX}px, ${this.oy + this.holdTY}px) scale(${this.holdScale})`;
        if (animate) setTimeout(() => this.media.classList.remove('mv_anim'), 240);
    }

    _centerInView() {
        const vb = viewportBox();
        const off = this.spawnIdx * 20;
        this.posX = (vb.w - this.fw) / 2 + off;
        this.posY = (vb.h - this.fh) / 2 + off;
        if (!isFinite(this.posX)) this.posX = 6;
        if (!isFinite(this.posY)) this.posY = 6;
        this._clampWindowIntoView();
    }

    /* Hard guarantee: the window can never leave the screen (keeps a slice always visible). */
    _clampWindowIntoView() {
        const vb = viewportBox();
        const m = Math.max(48, Math.min(140, this.fw * 0.6, this.fh * 0.6));
        this.posX = clamp(this.posX, m - this.fw, vb.w - m);
        this.posY = clamp(this.posY, m - this.fh, vb.h - m);
        this._applyPos();
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

    scaleAround(cx, cy, ratio) {
        const vb = viewportBox();
        const newFw = clamp(this.fw * ratio, MIN_WIN, vb.w * 3);
        const r = newFw / this.fw;
        this.fw *= r; this.fh *= r; this.iw *= r; this.ih *= r; this.ox *= r; this.oy *= r;
        this.posX = cx - (cx - this.posX) * r;
        this.posY = cy - (cy - this.posY) * r;
        this._applyFrame(); this._applyMedia(); this._clampWindowIntoView();
    }

    /* ---- reset (keeps current position) ---- */
    reset() {
        if (this.mode === 'crop') this._exitCrop(false);
        if (this.mode === 'resize') this._exitResize(false);
        if (this.mode === 'locked') {
            this.mode = 'free';
            this.win.classList.remove('mv_locked');
            this.btnLock.classList.remove('mv_active');
            this.btnLock.innerHTML = '<i class="fa-solid fa-lock-open"></i>';
        }
        this.crop = { t: 0, r: 0, b: 0, l: 0 };
        this.viewport.style.clipPath = '';
        if (this.orig) { this.A = this.orig.A; this.fw = this.orig.fw; this.fh = this.orig.fh; }
        this.iw = this.fw; this.ih = this.fh; this.ox = 0; this.oy = 0;
        this.holdScale = 1; this.holdTX = 0; this.holdTY = 0; this.holdOrigin = '0 0';
        this._applyFrame(); this._applyMedia(true); this._clampWindowIntoView(); // keep position
        this.showControls(); this.scheduleHide();
    }

    /* ---- mode switches ---- */
    toggleLock() {
        if (this.mode === 'crop') this._exitCrop(false);
        if (this.mode === 'resize') this._exitResize(true);
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
        if (this.mode === 'resize') { this._exitResize(true); return; }
        if (this.mode === 'crop') this._exitCrop(false);
        this.prevMode = this._baseMode();
        this.mode = 'resize';
        this.btnResize.classList.add('mv_active');
        this.showControls();
        this.geomBackup = { fw: this.fw, fh: this.fh, iw: this.iw, ih: this.ih, ox: this.ox, oy: this.oy, posX: this.posX, posY: this.posY };
        const layer = document.createElement('div');
        layer.className = 'mv_resize';
        const handles = {};
        ['nw', 'ne', 'sw', 'se'].forEach(pos => {
            const h = document.createElement('div');
            h.className = 'mv_handle mv_h_' + pos;
            h.addEventListener('pointerdown', e => this._resizeCornerDown(e, pos));
            layer.appendChild(h); handles[pos] = h;
        });
        const actions = document.createElement('div');
        actions.className = 'mv_crop_actions';
        const ok = this._mkBtn('fa-check', 'Apply', () => this._exitResize(true));
        const cancel = this._mkBtn('fa-xmark', 'Cancel', () => this._exitResize(false));
        ok.classList.add('mv_active');
        actions.append(ok, cancel);
        layer.appendChild(actions);
        this.resizeActions = actions;
        this.win.appendChild(layer);
        this.resizeLayer = layer; this.resizeHandles = handles;
        this._renderResize();
    }
    _renderResize() {
        if (!this.resizeHandles) return;
        const set = (k, x, y) => Object.assign(this.resizeHandles[k].style, { left: x + 'px', top: y + 'px' });
        set('nw', 0, 0); set('ne', this.fw, 0); set('sw', 0, this.fh); set('se', this.fw, this.fh);
        if (this.resizeActions) Object.assign(this.resizeActions.style, { left: (this.fw / 2) + 'px', top: (this.fh - 46) + 'px' });
    }
    _resizeCornerDown(e, pos) {
        e.preventDefault(); e.stopPropagation();
        const sx = e.clientX;
        const sX = this.posX, sY = this.posY;
        const sFw = this.fw, sFh = this.fh, sIw = this.iw, sIh = this.ih, sOx = this.ox, sOy = this.oy;
        const right = sX + sFw, bottom = sY + sFh;
        const vb = viewportBox();
        const move = ev => {
            const dx = ev.clientX - sx;
            let newFw = (pos === 'se' || pos === 'ne') ? sFw + dx : sFw - dx;
            newFw = clamp(newFw, MIN_WIN, vb.w * 3);
            const r = newFw / sFw;
            this.fw = sFw * r; this.fh = sFh * r; this.iw = sIw * r; this.ih = sIh * r; this.ox = sOx * r; this.oy = sOy * r;
            this.posX = sX; this.posY = sY;
            if (pos === 'nw') { this.posX = right - this.fw; this.posY = bottom - this.fh; }
            else if (pos === 'ne') { this.posY = bottom - this.fh; }
            else if (pos === 'sw') { this.posX = right - this.fw; }
            this._applyFrame(); this._applyMedia(); this._applyPos(); this._renderResize();
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            this._clampWindowIntoView(); this._renderResize();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }
    _exitResize(apply) {
        if (!apply && this.geomBackup) {
            const g = this.geomBackup;
            this.fw = g.fw; this.fh = g.fh; this.iw = g.iw; this.ih = g.ih; this.ox = g.ox; this.oy = g.oy;
            this.posX = g.posX; this.posY = g.posY;
            this._applyFrame(); this._applyMedia(); this._applyPos();
        }
        this.geomBackup = null;
        this.resizeLayer?.remove();
        this.resizeLayer = this.resizeHandles = this.resizeActions = null;
        this.btnResize.classList.remove('mv_active');
        this.mode = this.prevMode || 'free';
        this.scheduleHide();
    }

    /* ---- crop ---- */
    toggleCrop() {
        if (this.mode === 'crop') { this._exitCrop(true); return; }
        if (this.mode === 'resize') this._exitResize(true);
        this._enterCrop();
    }
    _enterCrop() {
        this.prevMode = this._baseMode();
        this.mode = 'crop';
        this.btnCrop.classList.add('mv_active');
        this.showControls();

        // current visible region as fractions of the full media (so an existing crop shows up
        // as the selection, with the cropped-away area dimmed and editable / expandable)
        const selL = clamp(-this.ox / this.iw, 0, 1);
        const selT = clamp(-this.oy / this.ih, 0, 1);
        const selR = clamp((this.iw - this.fw + this.ox) / this.iw, 0, 1);
        const selB = clamp((this.ih - this.fh + this.oy) / this.ih, 0, 1);
        this.cropBackup = { A: this.A, fw: this.fw, fh: this.fh, iw: this.iw, ih: this.ih, ox: this.ox, oy: this.oy, posX: this.posX, posY: this.posY };
        // expand to the full image AT THE CURRENT SCALE, keeping the visible region exactly in
        // place (photo doesn't jump); the cropped-away area appears dimmed around it
        const cropWFrac = Math.max(0.001, 1 - selL - selR);
        const cropHFrac = Math.max(0.001, 1 - selT - selB);
        const fullW = this.fw / cropWFrac;
        const fullH = this.fh / cropHFrac;
        this.posX -= selL * fullW;
        this.posY -= selT * fullH;
        this.fw = fullW; this.fh = fullH; this.iw = fullW; this.ih = fullH;
        this.ox = 0; this.oy = 0;
        this.holdScale = 1; this.holdTX = 0; this.holdTY = 0; this.holdOrigin = '0 0';
        this.crop = { l: selL, t: selT, r: selR, b: selB };
        this._applyFrame(); this._applyMedia(); this._applyPos();

        const layer = document.createElement('div');
        layer.className = 'mv_crop';
        const dim = document.createElement('div');
        dim.className = 'mv_crop_dim';
        const shade = document.createElement('div');
        shade.className = 'mv_shade';
        dim.appendChild(shade);
        layer.appendChild(dim);
        const moveZone = document.createElement('div');
        moveZone.className = 'mv_crop_move';
        moveZone.addEventListener('pointerdown', e => this._cropMoveDown(e));
        layer.appendChild(moveZone);
        this.cropMove = moveZone;
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
        if (this.cropMove) Object.assign(this.cropMove.style,
            { left: l + 'px', top: t + 'px', width: (w - l - r) + 'px', height: (h - t - b) + 'px' });
        if (this.cropActions) Object.assign(this.cropActions.style,
            { left: ((l + rx) / 2) + 'px', top: clamp(by - 46, t + 6, h - 46) + 'px' });
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
    _cropMoveDown(e) {
        e.preventDefault(); e.stopPropagation();
        const w = this.fw, h = this.fh;
        const sx = e.clientX, sy = e.clientY;
        const start = { ...this.crop };
        const width = 1 - start.l - start.r;
        const height = 1 - start.t - start.b;
        const move = ev => {
            const ddx = (ev.clientX - sx) / w, ddy = (ev.clientY - sy) / h;
            const nl = clamp(start.l + ddx, 0, 1 - width);
            const nt = clamp(start.t + ddy, 0, 1 - height);
            this.crop = { l: nl, r: 1 - width - nl, t: nt, b: 1 - height - nt };
            this._renderCrop();
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
            this.posX += l * this.fw;
            this.posY += t * this.fh;
            this.ox = -l * this.iw;
            this.oy = -t * this.ih;
            this.fw = this.fw * (1 - l - r);
            this.fh = this.fh * (1 - t - b);
            this._applyFrame(); this._applyMedia(); this._applyPos(); this._clampWindowIntoView();
        } else if (this.cropBackup) {
            const g = this.cropBackup;
            this.A = g.A; this.fw = g.fw; this.fh = g.fh; this.iw = g.iw; this.ih = g.ih;
            this.ox = g.ox; this.oy = g.oy; this.posX = g.posX; this.posY = g.posY;
            this._applyFrame(); this._applyMedia(); this._applyPos();
        }
        this.cropBackup = null;
        this.cropLayer?.remove();
        this.cropLayer = this.cropShade = this.cropHandles = this.cropActions = this.cropMove = null;
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
        if (this.mode === 'crop') return;
        e.preventDefault(); e.stopPropagation();
        this.bringToFront();
        const f = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
        if (this.mode === 'locked') this.zoomTo(e.clientX, e.clientY, this.iw * f, false);
        else this.scaleAround(e.clientX, e.clientY, f);
        this.showControls(); this.scheduleHide();
    }

    _onDown(e) {
        if (this.mode === 'crop') return;
        e.preventDefault();
        this.win.setPointerCapture?.(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.bringToFront();
        if (this.mode !== 'locked') this.showControls(); // in locked, the menu shows only on double-tap

        if (this.pointers.size === 2) { this._startPinch(); this._cancelHold(); return; }

        this.downInfo = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
        this.lastPos = { x: e.clientX, y: e.clientY };

        if (this.mode === 'free' || this.mode === 'resize') {
            this.dragStart = { x: this.posX, y: this.posY };
        } else if (this.mode === 'locked') {
            const delay = this.type === 'video' ? getSettings().videoHoldMs : getSettings().imageHoldMs;
            this.holdTimer = setTimeout(() => this._engageHold(this.lastPos.x, this.lastPos.y), delay);
        }
    }
    _engageHold(x, y) {
        // Hold zoom = a CSS scale around the press point (smooth in & out, reverts exactly).
        const rect = this.media.getBoundingClientRect();
        const fx = clamp(x - rect.left, 0, this.iw);
        const fy = clamp(y - rect.top, 0, this.ih);
        this.holdOrigin = `${fx}px ${fy}px`;
        this.holdScale = getSettings().holdZoom; this.holdTX = 0; this.holdTY = 0;
        this.holdActive = true;
        this._applyMedia(true);
    }
    /* Pan the magnified view, getting "heavier" near the edges of the image (or crop) and
       never crossing them. */
    _panHold(dx, dy) {
        const s = this.holdScale;
        if (s <= 1) return;
        const parts = (this.holdOrigin || '0 0').split(' ');
        const fox = parseFloat(parts[0]) || 0, foy = parseFloat(parts[1]) || 0;
        const EDGE = 120; // within this many px of a bound, movement slows toward 0
        const resist = (cur, d, lo, hi) => {
            if (d > 0) { const rem = hi - cur; return rem <= 0 ? cur : cur + d * Math.min(1, rem / EDGE); }
            if (d < 0) { const rem = cur - lo; return rem <= 0 ? cur : cur + d * Math.min(1, rem / EDGE); }
            return cur;
        };
        this.holdTX = resist(this.holdTX, dx, (s - 1) * (fox + this.ox - this.fw), (s - 1) * (fox + this.ox));
        this.holdTY = resist(this.holdTY, dy, (s - 1) * (foy + this.oy - this.fh), (s - 1) * (foy + this.oy));
    }
    _cancelHold() { if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; } }

    _startPinch() {
        const pts = [...this.pointers.values()];
        this.pinch = { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), iw0: this.iw };
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
            if (this.mode === 'locked') {
                // two-finger zoom in locked mode is disabled (commented out per request)
                // this.zoomTo(mid.x, mid.y, this.pinch.iw0 * ratio);
            } else {
                this.scaleAround(mid.x, mid.y, ratio); this.pinch.dist = dist;
                if (this.mode === 'resize') this._renderResize();
            }
            return;
        }

        if (this.pointers.size !== 1 || !this.downInfo) return;
        const dx = e.clientX - this.lastPos.x, dy = e.clientY - this.lastPos.y;
        this.lastPos = { x: e.clientX, y: e.clientY };
        if (Math.hypot(e.clientX - this.downInfo.x, e.clientY - this.downInfo.y) > TAP_MOVE_SLOP) {
            if (!this.downInfo.moved) { this.downInfo.moved = true; if (!this.holdActive) this._cancelHold(); }
        }

        if (this.mode === 'free' || this.mode === 'resize') {
            this.dragStart.x += dx; this.dragStart.y += dy;
            this.posX = this.dragStart.x; this.posY = this.dragStart.y;
            this._clampWindowIntoView();
            this.dragStart.x = this.posX; this.dragStart.y = this.posY;
            if (this.mode === 'resize') this._renderResize();
        } else if (this.mode === 'locked' && this.holdActive) {
            // pan the magnified view while holding — heavier near the image/crop edges; reverts on release
            this._panHold(dx, dy); this._applyMedia();
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
            if (this.mode === 'free' || this.mode === 'resize') this.dragStart = { x: this.posX, y: this.posY };
            return;
        }
        if (this.pointers.size > 1) return;

        this._cancelHold();
        this.pinch = null;

        if (this.mode === 'locked') {
            if (this.holdActive) {
                this.holdScale = 1; this.holdTX = 0; this.holdTY = 0;
                this._applyMedia(true); // smooth zoom-out around the same point
                this.holdActive = false;
            } else if (this.downInfo && !this.downInfo.moved && (Date.now() - this.downInfo.t) < TAP_MAX_MS) {
                this._handleTap(e.clientX);
            }
        }
        this.scheduleHide();
        this.downInfo = null;
    }

    _handleTap(x) {
        const now = Date.now();
        if (now - this.lastTap < DBL_TAP_MS) {
            // double tap → reveal the menu (the only way to get it in locked mode)
            if (this.singleTapTimer) { clearTimeout(this.singleTapTimer); this.singleTapTimer = null; }
            this.lastTap = 0;
            this.showControls(); this.scheduleHide();
            if (this.type === 'video') {
                const rect = this.viewport.getBoundingClientRect();
                const left = (x - rect.left) < rect.width / 2;
                try { this.media.currentTime = clamp(this.media.currentTime + (left ? -5 : 5), 0, this.media.duration || 1e9); } catch { }
            }
        } else {
            this.lastTap = now;
            this.singleTapTimer = setTimeout(() => {
                this.singleTapTimer = null;
                if (this.type === 'video') {
                    if (this.media.paused) this.media.play?.().catch(() => { });
                    else this.media.pause?.();
                }
                // image single tap: nothing
            }, DBL_TAP_MS);
        }
    }

    _exportState() {
        return {
            A: this.A, fw: this.fw, fh: this.fh, iw: this.iw, ih: this.ih, ox: this.ox, oy: this.oy,
            posX: this.posX, posY: this.posY, mode: this._baseMode(),
        };
    }

    close() {
        if (this.mode === 'crop') this._exitCrop(false);
        if (this.mode === 'resize') this._exitResize(false);
        try { FloatItem.saved[this.url] = this._exportState(); } catch { }
        this._cancelHold();
        if (this.singleTapTimer) clearTimeout(this.singleTapTimer);
        if (this.fadeTimer) clearTimeout(this.fadeTimer);
        try { this.media.pause?.(); } catch { }
        this.win.remove();
    }
}
FloatItem._spawn = 0;
FloatItem.saved = {};

/* ------------------------------------------------------------------ */

function avatarFullRes(thumb, mes) {
    if (!thumb || thumb.startsWith('data:') || /^\/?img\//.test(thumb)) return thumb;
    const i = thumb.lastIndexOf('=');
    if (i < 0) return thumb;
    const file = thumb.substring(i + 1);
    if (!file) return thumb;
    const isUser = mes?.getAttribute('is_user') === 'true';
    const isSystem = mes?.getAttribute('is_system') === 'true';
    return (isUser || isSystem) ? ('/User Avatars/' + file) : ('/characters/' + file);
}

function resolveMedia(target) {
    const s = getSettings();
    const srcOf = el => el?.currentSrc || el?.getAttribute('src') || el?.src || '';
    const inChat = target.closest?.('#chat'); // only the live message stream, never chat-select previews

    if (s.avatars && inChat) {
        const av = target.closest('.mes .avatar');
        if (av) {
            const thumb = srcOf(av.querySelector('img'));
            if (thumb) {
                const full = avatarFullRes(thumb, av.closest('.mes'));
                return { url: full || thumb, type: 'image', fallback: thumb };
            }
        }
    }
    if (s.gallery) {
        const thumb = target.closest?.('#dragGallery .nGY2GThumbnail, .nGY2GThumbnail');
        if (thumb) {
            const url = srcOf(thumb.querySelector('img.nGY2GThumbnailImg, img')) || thumb.getAttribute('data-ngsrc') || '';
            if (url) return { url, type: isVideoUrl(url) ? 'video' : 'image' };
        }
    }
    if (s.chat && inChat) {
        const cont = target.closest(
            '.mes_text img, .mes_text video, .mes_text p img, .mes_text p video, ' +
            '.mes_media_container, .mes_img, .mes_media_enlarge, .mes_video');
        if (cont) {
            const el = cont.matches?.('img, video') ? cont : cont.querySelector('img, video');
            const url = srcOf(el);
            if (url) return { url, type: (el && el.tagName === 'VIDEO') || isVideoUrl(url) ? 'video' : 'image' };
        }
    }
    return null;
}

let touchStart = null;
let openLock = 0;

function onTouchStartCap(e) {
    if (e.touches && e.touches.length === 1) {
        const t = e.touches[0];
        touchStart = { x: t.clientX, y: t.clientY, time: Date.now() };
    } else {
        touchStart = null;
    }
}
function onTouchEndCap(e) {
    if (!getSettings().enabled || !touchStart) return;
    const t = e.changedTouches[0];
    const moved = Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y);
    const dt = Date.now() - touchStart.time;
    touchStart = null;
    if (moved > 14 || dt > 600) return;
    const el = document.elementFromPoint(t.clientX, t.clientY) || e.target;
    if (!el || (el.closest && el.closest('#mediaviewer_layer'))) return;
    const info = resolveMedia(el);
    if (!info || !info.url) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openLock = Date.now();
    new FloatItem(info);
}
function onCaptureClick(e) {
    if (!getSettings().enabled) return;
    const t = e.target;
    if (!t || !t.closest || t.closest('#mediaviewer_layer')) return;
    const info = resolveMedia(t);
    if (!info || !info.url) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (Date.now() - openLock < 700) return;
    new FloatItem(info);
}

let installed = false;
function installInterception() {
    if (installed) return;
    document.addEventListener('touchstart', onTouchStartCap, { capture: true, passive: true });
    document.addEventListener('touchend', onTouchEndCap, { capture: true, passive: false });
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
          <label>Hold zoom<input type="number" id="mv_holdzoom" class="text_pole" min="1.05" max="6" step="0.05" style="width:90px"></label>
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
