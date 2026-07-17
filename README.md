# 🎵 Apple Music for Steam Deck

A [Decky Loader](https://decky.xyz) plugin that plays **full-length Apple Music** right from the Steam Deck's Quick Access Menu — including while you game. Sign in with your own Apple ID; no developer token or account setup required.

> **Beta.** Expect rough edges. Requires an active Apple Music subscription.

---

## Features

| | |
|---|---|
| ▶️ Full-length DRM playback (not 30s previews) | Widevine via a bundled castlabs Electron engine |
| 🎧 Background playback | Keeps playing when the QAM closes and games launch |
| 🔐 In-plugin Apple ID sign-in | Password **or QR / phone sign-in** — scan with your iPhone, credentials never touch the plugin |
| 🔎 Search, library, For You, artist radio | Browse and queue anything |
| 📃 Full playlists & albums | Plays and lists every track, even for playlists with **100+ songs** |
| ❤️ Favorite + Add to Library | |
| 🔀 Shuffle / repeat / seek / volume | Native-feeling transport controls |
| 🎚️ Music level trim | Balance music against game loudness (default −8 dB) |
| 🎮 Auto-duck for games | Lowers music when game audio gets loud — per-stream toggles, sensitivity, dialogue-only mode |
| ⏭️ Autoplay similar songs | Optional; off by default |
| 🔁 Offline-boot recovery | If the engine starts with no internet, it auto-reconnects when the network returns instead of getting stuck |

---

## Install (testers)

1. Install **[Decky Loader](https://decky.xyz)** if you haven't.
2. In Decky → **Settings** → enable **Developer mode**.
3. Go to the **Developer** tab → **Install Plugin from URL** and paste:
   ```
   https://github.com/BrielleG116/decky-apple-music/releases/latest/download/apple-music-plugin.zip
   ```
4. Open **Apple Music** in the QAM. On first run it shows **Player setup → Install Player** — tap it (a one-time ~120 MB download of the playback engine).
5. **Sign in** with your Apple ID — either type your password (2FA prompt arrives on your trusted device), or tap **Sign in with your phone (QR)** and scan the code with your iPhone so your credentials never go through the plugin.
6. Start listening 🎶

The plugin itself is tiny; the large playback engine is downloaded on first run rather than bundled.

---

## How it works

Steam's built-in browser can't decrypt Apple Music (its Chromium has no Widevine CDM), so playback runs in a **hidden, bundled [castlabs Electron](https://github.com/castlabs/electron-releases) process** that *does* have Widevine. The Decky panel drives it, and audio goes out through PipeWire — surviving the QAM closing and games launching.

```
 Steam QAM panel (React/TS)
        │  Decky callables
        ▼
 Python backend (main.py) ──CDP──►  Hidden castlabs Electron player
        │                              │  MusicKit JS + Widevine
        │                              ▼
        └─ browsing/API proxied ──►  Apple Music  ──audio──► PipeWire
```

- **No developer token is shipped.** Apple's own web-player token is harvested at runtime; the frontend routes all catalog/library calls through the player (which carries the correct origin).
- **Your credentials stay on your Deck.** Sign-in is driven locally into Apple's login; only the resulting media-user-token is stored.

---

## Development

```bash
npm install
npm run build          # builds dist/index.js
./package-plugin.sh    # -> apple-music-plugin.zip (Decky "Install from ZIP")
```

Project layout:

```
├── src/index.tsx        # React QAM UI (Steam CEF)
├── main.py              # Python backend: player control (CDP), settings, install
├── ducker.py            # Auto-duck daemon
├── player/              # castlabs Electron player (main.js + MusicKit page)
├── plugin.json          # Decky metadata
└── package-plugin.sh    # Builds the distributable plugin zip
```

Maintainer distribution steps (creating releases, updating the player) are in **[DISTRIBUTION.md](DISTRIBUTION.md)**.

---

## Troubleshooting

- **Stuck on "Install Player" / download fails** — make sure the Deck is online; the engine downloads from GitHub Releases.
- **Signed in but library/browse is empty** — the engine likely started before the network was up. It reconnects automatically once you're online (a "Reconnecting…" banner shows); reopen the QAM after a few seconds.
- **Sign-in says "Check the account information"** — wrong Apple ID or password; try again.
- **Only previews / no full playback** — an active Apple Music subscription is required.
- **Music much louder than the game** — that's normal loudness mastering; use the **Music level** slider in Settings (or the volume slider).

---

## License

**[PolyForm Noncommercial License 1.0.0](LICENSE)** — free to use, modify, and
share for **non-commercial** purposes, and you **must keep the attribution
notice**. You may **not** sell it or use it commercially, or strip the credit.
For a commercial license, contact the author.

> This plugin uses Apple's official MusicKit and a Widevine-enabled Electron build for DRM playback; it does **not** circumvent DRM. Use is subject to [Apple's MusicKit terms](https://developer.apple.com/musickit/). Not affiliated with or endorsed by Apple.
