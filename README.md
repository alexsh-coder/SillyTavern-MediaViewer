# MediaViewer

![preview](https://i.imgur.com/1KmoNmp.gif)

A floating, multi-instance media viewer for [SillyTavern](https://github.com/SillyTavern/SillyTavern).

Click any media — **chat images/videos, message avatars, or image‑gallery thumbnails** — to pop
it out into a draggable floating window. Open as many as you like at once. While the extension is
enabled it **replaces SillyTavern's built‑in lightbox / avatar zoom / gallery popup**; disable it
and the native behavior returns.

Page behind stays visible and usable, the chat keeps scrolling,
and SillyTavern's swipe gestures keep working. Each window's position/zoom/crop is remembered and
restored when you reopen the same media.

> Works on desktop and mobile (including iOS Safari). Tested on SillyTavern 1.18.x.

---

## Features

- 🖼️ Floating, **multi‑window** viewer (open several at once) — no screen dimming.
- 🔍 **Zoom & pan** with a press‑and‑hold magnifier (rubber‑band resistance at the edges).
- 🔒 **Lock** a window in place.
- 📐 **Resize** with aspect‑locked corner handles (or pinch / mouse wheel).
- ✂️ **Crop** — non‑destructive and re‑editable; the cropped‑away area is shown dimmed.
- ↺ **Reset** to the original view.
- 🎬 **Video**: tap to play/pause, double‑tap to seek ±5s, centered pause indicator, and a
  scrubbable progress bar with current time / duration.
- 💾 Remembers each media's position, zoom and crop across reopen.
- ⚙️ Settings panel (per‑source toggles, zoom limits, fade time, edge resistance).
- 🪶 Pure vanilla JS — no external dependencies, no core files patched.

---

## Install

**Manual:** copy this folder to your SillyTavern user data:

```
SillyTavern/data/<your-user>/extensions/MediaViewer/
```

then reload SillyTavern. It survives updates (it lives in user data, not the app code).

**From the Extensions manager:** Extensions → *Install extension* → paste the repository URL.

Enable/disable it any time under **Extensions → MediaViewer**.

---

## Usage

Tap/click any chat image or video, a message avatar, or an image‑gallery thumbnail.

### Free mode (default)
- **Drag** — move the window (one finger / mouse).
- **Pinch** or **mouse wheel** — resize the window.
- Controls (top‑right) show on **touch** (mobile) or **hover** (desktop).

### Tools (top‑right)
🔒 lock · ⤢ resize · ✂️ crop · ↺ reset · ✕ close · (`Esc` closes the top window)

- **Resize** ⤢ — four corner handles scale the window keeping its aspect ratio; you can also
  drag the body to move it. Confirm ✓ or cancel ✗.
- **Crop** ✂️ — the whole image appears with the current crop as a bright selection (rest dimmed).
  Drag the edges/corners, or drag the selection itself to move it, then ✓ apply / ✗ cancel.
  Re‑open crop any time to adjust or expand it back. Visual only — your files are never modified.
- **Reset** ↺ — clears crop/zoom/scale back to the original fit (keeps the window position).

### Locked mode (🔒)
The window is frozen.
- **Image:** press‑and‑hold to magnify at that point; drag to look around (it gets *heavier* near
  the edges and never leaves the image / crop), release to return exactly as it was. A quick tap
  briefly flashes the tools.
- **Video:** see below — playback controls work the same in any mode.

### Video
- **Single tap** — play / pause (works in any mode).
- **Double tap** — seek −5s (left half) / +5s (right half), with a flash.
- On **pause** the menu stays visible and a centered ▶ indicator appears.
- **Progress bar** (bottom): current time · scrubbable track (click or drag) · duration.

---

## Settings (Extensions → MediaViewer)

| Setting | Description |
| --- | --- |
| Enabled | Master on/off |
| Chat media / Avatars / Image gallery | Which sources to intercept |
| Controls fade (ms) | How long the tools stay before fading |
| Hold zoom | Magnification factor for press‑and‑hold |
| Max zoom | Upper bound for wheel zoom |
| Edge resistance | How "heavy" panning gets near the image/crop edges (px; 0 = hard stop) |

---

## Notes

- **Swipe‑safe.** SillyTavern detects swipes via `swiped-events` inside `#sheld`. MediaViewer's
  windows live on `<body>` (outside `#sheld`), carry `data-swipe-ignore="true"`, and stop event
  propagation — so message swiping keeps working.
- **iOS‑friendly.** Windows are positioned with `transform: translate()` (not `left/top`), which is
  stable on iOS Safari.
- Interception is scoped to the live `#chat` (and the gallery), so it won't hijack chat‑select
  previews.

## License

MIT — see [LICENSE](LICENSE).
