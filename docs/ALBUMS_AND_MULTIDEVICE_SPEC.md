# Pictinder: Albums & Multi-Device — Tech & UX Specification

## 1. Product summary

Pictinder becomes a **multi-device shortlisting product** centered on **albums**. One person runs the app on a laptop, starts the server, and creates or continues an album. Others join by scanning a QR code (one device per QR). Each joiner either **creates a new album** or **joins an existing album**. Albums have two modes: **shared** (everyone sees all media and has their own swipe history) or **distributed** (media is split across devices so each item is seen by only one person until they swipe, with re-assignment when devices disconnect). The Electron app shows all connected devices in a clear, pleasing way.

---

## 2. Feature definitions

### 2.1 One QR per device, rotating QR, connected devices

**Behavior**

- Each **QR code** encodes a one-time **join URL** (e.g. includes a short-lived token or unique session id).
- When a **device** opens that URL and completes the join flow (choose/create album), that QR is **consumed**. The server generates a **new** QR/join URL and the Electron app updates the displayed QR.
- So: **one device per QR scan**; after a scan, the next person sees a different QR.
- The Electron app keeps a **connected devices** list: for each device we show a friendly label (e.g. “iPhone”, “Chrome on Android”, or “Device 2”) and optionally status (e.g. “In album: Wedding picks”, “Idle”). Multiple devices can be connected at once; the list is always visible and visually clear (cards or rows, maybe with a small icon or color).

**Tech**

- Server maintains: **join tokens** (one-time use, map token → create session when URL is hit).
- On first load of join URL: consume token, create **device session** (cookie or token), then show “Create album” vs “Join existing album”.
- After each consumption, server generates a new join token; Electron gets new URL (and optionally new QR image) via existing log/events or a small “get current join URL” API, and re-renders the QR.
- **Connected devices**: server tracks device id (from cookie/token or fingerprint) and last-seen (heartbeat). API for “list connected devices” that Electron polls or receives via events; Electron UI renders this list.

---

### 2.2 Albums: concept and lifecycle

**Concept**

- An **album** is a named container for one shortlisting “session” over the same **media root** (the folder the server is using).
- An album has:
  - **Name** (chosen at creation).
  - **Mode**: **shared** or **distributed** (chosen at creation, fixed for that album).
  - **Media list**: same recursive scan of the server’s media root (all items in scope for that album).
  - **State**: swipe outcomes and progress; format depends on mode (see below).

**Lifecycle**

- **Create album**: Creator (first device that used the join URL, or the one who clicked “Create new”) chooses name and mode (shared vs distributed). Album is created and that device (and any others that later “join” this album) are **members** of that album.
- **Join existing album**: Device picks from a list of **existing albums** (ongoing or previously created). After joining, the device is a member and sees the album’s media according to the album’s mode.
- **Ongoing vs previously created**: “Existing albums” list can show both albums that are currently “open” (at least one device connected) and albums that were created earlier and have no one connected (so users can resume or review). No deletion of albums in this spec; we only create and join.

**UX**

- After opening the join URL (and token consumed), the user sees a single screen:
  - **Create new album** (then: enter name, choose mode: “Show all photos to everyone” vs “Distribute photos across devices”).
  - **Join existing album** (then: list of albums to pick from; after picking, enter the album and see media as per mode).

---

### 2.3 Mode A: Distribute photos across devices

**Behavior**

- Each **media item** is in a **pool**. At any time, each item is either:
  - **Unassigned**, or
  - **Assigned to exactly one connected device** (that device is the only one that can see and swipe it).
- When a device is **connected and in this album**, the server **assigns** items from the pool to that device one-by-one (or in a small batch). When the device swipes left or right, the assignment is released and the item is marked as **swiped** (with the choice: selected/skipped) and removed from the pool. The next unassigned/unswiped item can be assigned to that device.
- **Fairness**: No strict 25/25 split; faster swipers get more items. When a device disconnects or times out, all items **currently assigned to that device** and not yet swiped are **released** back to the pool and can be assigned to other connected devices.
- **“Already swiped” feedback**: If an item was **assigned** to device A and was in A’s cache (e.g. preloaded), but in the meantime **another device** swiped it (e.g. it was reassigned after A disconnected and then B got it and swiped), then when A next sees that item (or when we would have shown it), we **don’t** let A swipe it. Instead we show a **feedback**: the card goes **up** (or another clear gesture) to mean “already swiped by someone else”. No left/right swipe is recorded for A for that item.

**Tech**

- **Pool**: list of media item ids (or paths) with state: `unassigned` | `assigned(deviceId)` | `swiped(choice)`.
- **Assignments**: when a device requests “next item” for a distributed album, server picks an unassigned item (or one just released), assigns it to that device, returns it. When device sends swipe, server marks item as swiped and clears assignment.
- **Heartbeat / timeout**: each device sends a periodic heartbeat (e.g. every 15–30 s). If no heartbeat for e.g. 60 s, server treats device as **disconnected**: all items assigned to that device are released back to pool (unswiped). Swipe history is already persisted when they swipe; we don’t “lose” swipes.
- **Already-swiped check**: when assigning, server only assigns items that are unswiped. When a device later gets an item (e.g. after reconnect) that was in a previous assignment to them but was swiped by someone else in the meantime, the “next item” or “current item” API can return a flag like `alreadySwipedByOther: true` and the client shows the “up” animation instead of accepting left/right.

---

### 2.4 Mode B: Show all photos to all devices

**Behavior**

- Every device **in that album** sees the **same full list** of media (same order, e.g. by path or scan order).
- Each device has its **own** swipe history for that album: device A’s right/left choices are independent of device B’s. So we maintain **per-device, per-album** swipe state.
- Progress (e.g. “where am I in the list”) is also per device: each device can resume from its own last index. No assignment pool; just a shared media list and per-device `lastIndex` + `choices[]`.

**Tech**

- State per album (shared mode): `{ albumId, mediaPaths[], deviceStates: { [deviceId]: { lastIndex, choices: [{ path, direction }] } } }`.
- When a device requests “list” or “next” for a shared album, server returns the full path list and that device’s own `lastIndex` and `choices`. No assignment; no release logic.

---

## 2.5 Where swipes are saved (persistence)

### Current implementation (single-session only)

- **Location**: One file on the laptop:  
  `{Electron userData}/pictinder-state.json`  
  (e.g. on Mac: `~/Library/Application Support/pictinder/pictinder-state.json`; on Windows: `%APPDATA%/pictinder/pictinder-state.json`.)
- **Shape**: A single global state object:
  - `lastIndex`: one progress position for the whole media list
  - `choices`: one array of `{ path, direction, at }` for every swipe
  - `order`: list of media paths (refreshed from scan)
- **Behavior**: Every device and every “session” reads and writes this same file. There is no device id and no album; progress and choices are shared by everyone.

**Conclusion:** This **does not work** for multi-user, multi-device, or multi-session. With multiple devices, they would overwrite each other’s progress and mix all swipes into one list. Albums and per-device state require a different persistence model.

---

### New architecture: multi-user, multi-device, multi-session

All swipe-related state is **per album** and stored on the server (laptop), under the same app userData (or a dedicated data directory). No file deletion; only metadata is written.

**1) Shared mode (show all to everyone)**

- **Where**: Inside that album’s state, under a **per-device** key.
- **Shape**:  
  `albums[albumId].deviceStates[deviceId] = { lastIndex, choices: [{ path, direction, at }] }`
- **Semantics**: Each device has its own progress and its own swipe history for that album. Multiple devices and multiple sessions (rejoin same album later) work: the device is identified by a stable device id (cookie/token), and the server loads/saves only that device’s `lastIndex` and `choices` for that album.

**2) Distributed mode (distribute across devices)**

- **Where**: Inside that album’s state: a **pool** of items plus a **global** list of completed swipes for export.
- **Shape**:  
  - `albums[albumId].pool`: for each media path, state is one of:  
    `unassigned` | `assigned(deviceId)` | `swiped(choice)`
  - Optionally `albums[albumId].swipedList`: `[{ path, direction, at, deviceId? }]` for “selected” export and logging.
- **Semantics**: Swipes are recorded when a device submits a swipe; that item moves from `assigned(deviceId)` to `swiped(choice)` and is no longer assignable. Each swipe is persisted immediately so it is not lost on disconnect. Progress is “where the pool is” (which items are still unswiped/assigned), not a single lastIndex.

**3) Files on disk**

- **Suggested layout**:  
  - `{userData}/pictinder-data/albums.json` — album metadata and, for each album, either:
    - (shared) `deviceStates`, or  
    - (distributed) `pool` (+ optional `swipedList`)
  - Or one file per album: `albums/{albumId}.json` for easier concurrency.
- **Backward compatibility**: The current single `pictinder-state.json` can remain for the “legacy” single-session flow (no album, no join URL), or be phased out once all clients use albums. For the new flows, all swipe state lives under the album-based model above so multi-user, multi-device, and multi-session work correctly.

---

## 3. User flows (concise)

**Creator / first joiner**

1. Scan QR on phone → open join URL (token consumed, new QR shown on laptop).
2. See “Create new album” or “Join existing album”.
3. Choose “Create new album” → enter name → choose “Show all to everyone” or “Distribute across devices” → create.
4. Enter album; see media (shared: full list from last index; distributed: get next assigned item). Swipe as today; desktop shows connected device and log.

**Subsequent joiners**

1. Scan (new) QR → join URL.
2. Create new album **or** join existing (list of albums).
3. If join existing: pick album → enter album; behavior same as creator for that album (shared vs distributed).

**Electron (desktop)**

- Always show: Server on/off, media folder, current join QR (updates after each scan), and **Connected devices** list (name/label, album if any, status). Optional: live log of swipes/events per album or global.

---

## 4. Data model (summary)

- **Join tokens**: one-time, map token → used flag; on use, create device session and return new token to server/Electron for new QR.
- **Devices**: id, label (optional), lastHeartbeat, currentAlbumId (if any).
- **Albums**: id, name, mode (shared | distributed), mediaRoot (reference), createdAt. For **shared**: deviceStates[deviceId] = { lastIndex, choices[] }. For **distributed**: pool (item states: unassigned / assigned(deviceId) / swiped(choice)), plus global swipe list for “selected” export.
- **Media list**: still from recursive scan of server media root; album doesn’t copy files, it references the same list (or a snapshot of paths at album creation).

---

## 5. Edge cases and rules

- **QR rotation**: Only after a device **completes** the join (has chosen create or join and entered an album), we consume the token and rotate QR. If they close the page before that, token can stay valid (optional: short TTL for tokens).
- **Distributed + disconnect**: On timeout/disconnect, release only that device’s **current** (and any in-flight) assignments; don’t double-assign. Heartbeat interval and timeout should be tuned so we don’t release too early (e.g. 30 s heartbeat, 60–90 s timeout).
- **Already swiped (distributed)**: When assigning, never assign an item that’s already in `swiped`. When showing “already swiped by other”, we only need to detect that the item the client thought was “theirs” is now in `swiped` by someone else; then show up animation and give them the next item.
- **No deletion**: Still no file deletion anywhere; album and device state are metadata only. “Selected” list for an album is still just stored paths for later copy/export.

---

## 6. What we will build (implementation scope)

1. **Server**: Join tokens (generate, consume, rotate); device registry and heartbeat; album CRUD; album modes (shared vs distributed); per-device state for shared; pool and assignment for distributed; “next item” and “swipe” APIs that take device + album; “list connected devices” and “current join URL” for Electron.
2. **Phone web app**: After load, detect “join URL” (token in path) → show Create vs Join album; create (name + mode) or join (list); then current album view (shared: same as today but with device id and album id; distributed: request “next” from pool, show “up” on already-swiped; heartbeat calls).
3. **Electron**: UI for connected devices (list/cards); subscribe or poll for new join URL and refresh QR; optional “current album” or “devices in album” in log.

This spec is the single source of truth for the albums and multi-device feature set before writing code.
