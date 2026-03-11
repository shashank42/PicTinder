# Pictinder — Designer Brief

## Product
Local-first photo/video curation app. A laptop hosts media from external drives; phones swipe to shortlist keepers. Multiple devices can collaborate in real time.

## Users & goals
- Cull large media libraries (10k+ items, RAW + JPEG + video) quickly on mobile.
- Collaborate — split review across people or vote together.
- End with a clean shortlist to export, while originals stay untouched.

## Surfaces

### Desktop dashboard (Electron)
- Add/remove folders, configure port, start/stop server.
- QR code + join URL (token rotates per device).
- Device list (online/offline, label, current album).
- Album list with stats (selected, discarded, uploaded, total). Create/delete albums.
- Activity log, cache stats, clear cache.
- Cloud settings: connect Google accounts, OAuth credentials, uploaded album links.
- Upload modal: scope (all/selected), strategy (duplicate/distribute), account picker.
- Notifications: upload progress, resume/snooze/dismiss.

### Phone swipe UI (web, mobile browser)
- Join via token → create or join album (name, mode).
- Full-screen swipe cards: touch gestures + keyboard arrows.
- Preloads next 10 images. Videos play inline.
- Bottom actions: undo, rotate, reveal in Finder, open, share.
- Filter overlay: by file type and subfolder tree.
- Album explorer: switch, manage, or open detail view.
- Metadata overlay: path, date, location, camera, dimensions, duration.
- Connection status and auto-reconnect.

### Album detail (opens in new Electron window or via phone)
- Infinite-scroll grid. Filter tabs: All / Selected / Discarded / Unswiped.
- Item overlay: full preview, metadata, per-device vote chips (shared mode).
- Actions: reclassify, rotate, reveal, open, share, copy path.
- Desktop: click = preview, double-click = open file, right-click = reveal.
- Touch: long-press = action sheet (reveal, open, share).

## Collaboration modes
- **Shared** — all devices see all items; per-device votes aggregated.
- **Distributed** — items assigned one-by-one; released on disconnect (75s timeout).

## Non-negotiable constraints
- No destructive file operations (no delete/move/overwrite of originals).
- Local network only (same Wi-Fi/LAN).
- Must stay fast on large libraries (preview caching, preloading, pagination).
- Clear multi-device state (who is connected, what is assigned, progress).

## UX states to handle
- Empty state: no folders added / no albums.
- Expired or invalid join token.
- Device disconnected / reconnecting.
- Waiting for items (distributed mode, pool exhausted).
- Media preview or transcode failure.
- Undo success/failure; conflict (item already swiped by another device).
- Album not found.
- Background processing / cache messaging.

## Redesign goals
- Foolproof first-time setup (folder → start → scan QR).
- Unified visual language across all three surfaces.
- Confidence-building status and error messaging for network/sync edge cases.
- Modern interaction polish (motion, hierarchy, typography) without added complexity.
- High throughput for power users reviewing thousands of items.

## Deliverables
- End-to-end flow maps (desktop host, phone participant, album reviewer).
- Wireframes + high-fidelity UI for all three surfaces.
- Design system: type scale, colors, spacing, controls, motion, empty/error/success states.
- Clickable prototype for key flows.
- Handoff specs for Electron + mobile web.
