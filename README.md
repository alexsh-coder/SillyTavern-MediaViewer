# MediaViewer

A floating, multi-instance media viewer for [SillyTavern](https://github.com/SillyTavern/SillyTavern).

Click any media — **chat images/videos, message avatars, or image-gallery thumbnails** — to
pop it out into a draggable floating window. Open as many as you like at once. While the
extension is enabled it replaces SillyTavern's built-in lightbox / avatar zoom (disable it
and the built-in behavior returns).

There is **no backdrop dim**: the layer is click-through, so the chat and text behind the
media stay visible and usable, and SillyTavern's swipe gestures keep working.

## Usage

**Free mode (default)**
- Drag — move the window (one finger / mouse).
- Pinch or mouse wheel — resize the window.
- Controls (top-right 🔒 ✂️ ✕) show on **hover** (desktop) or on **touch** (mobile).

**Locked mode (tap 🔒)** — the window is frozen.
- *Image:* hold = temporary zoom at that point (pan within bounds, release to revert);
  two fingers / wheel = persistent zoom (kept; pinch back out to undo). You can't pan past
  the image edges.
- *Video:* single tap = play/pause · double-tap left = −5s · double-tap right = +5s;
  hold = zoom. A quick tap never zooms — it only reveals the controls.

**Crop (tap ✂️)** — drag the edges/corners, then ✓ apply or ✕ cancel. Visual crop only; the
original file is never modified.

**Close** — the ✕ button, or `Esc` (closes the top-most window).

## Settings

Extensions → **MediaViewer**: master enable, per-source toggles (chat / avatars / gallery),
control fade time, and max zoom.

## Install

Copy this folder to `data/<user>/extensions/MediaViewer/` (it survives SillyTavern updates),
then refresh. Pure vanilla JS — no external dependencies, no core files patched.

## Swipe safety

The old "edit index.html" approach broke message swipes because SillyTavern detects swipes
via `swiped-events` inside `#sheld`. MediaViewer avoids this: the windows live on `<body>`
(outside `#sheld`), carry `data-swipe-ignore="true"`, and all gesture handlers stop
propagation. Swiping messages keeps working as normal.
