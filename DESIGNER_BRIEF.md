# Pictinder: Designer Project Description (UI Redesign Brief)

Built from the current `README.md` and codebase behavior.

## Product in one line
`Pictinder` is a local-first photo/video curation app: a laptop hosts media from external drives, and one or more phones swipe to shortlist keepers fast.

## What users are trying to do
- Review huge event/wedding libraries (often 10k+ photos/videos, including RAW and MP4).
- Decide "keep" vs "skip" quickly on mobile, without copying everything to phones.
- Collaborate with multiple people in the same session.
- End with a clean shortlist for sharing/export, while originals remain untouched.

## Current experience (to preserve functionally)
- Desktop app (Electron): add folders, start local server, show URL + QR, show connected devices/logs/progress/cache.
- Phone web app: join/create album, swipe left/right, undo, switch albums.
- Album detail/review screen: filterable grid, reclassify items, reveal/open/share/copy file path.
- Two collaboration modes:
  - **Shared**: everyone can vote on same items.
  - **Distributed**: workload split automatically across devices.

## Non-negotiable product principles
- **No destructive edits to source files** (no delete/move/overwrite originals).
- **Local network workflow** (phone connects to laptop on same Wi-Fi/LAN).
- **Fast interaction on large libraries** (preview generation, buffering, pagination, caching).
- **Clear multi-device collaboration state** (who is connected, what is assigned, progress by album).

## Redesign goals
- Make first-time setup foolproof (folder -> start server -> connect phone).
- Unify visual language across desktop, phone swipe, and album-detail surfaces.
- Improve confidence/status messaging for network and sync edge cases.
- Modernize interaction polish (motion, hierarchy, typography, states) without adding complexity.
- Keep high throughput for power users reviewing thousands of assets.

## UX states the redesign must explicitly handle
- No folders yet / empty folder.
- Invalid or expired join token.
- Device disconnected/reconnecting.
- "Waiting for items" in distributed mode.
- Media preview/transcode failure.
- Undo success/failure and conflict cases.
- Album not found / permission mismatch behavior.
- Background processing and cache-related messaging.

## Deliverables requested from design
- End-to-end user flow maps (desktop host + phone participant + album reviewer).
- Wireframes and high-fidelity UI for:
  - Desktop host dashboard
  - Phone onboarding + swipe interface
  - Album detail/review management
- Design system: type scale, colors, spacing, controls, motion, empty/error/success states.
- Clickable prototype for key flows.
- Handoff specs for Electron + mobile web implementation.
