# 🎵 Decky Apple Music

A Decky Loader plugin for the Steam Deck that streams Apple Music in the background while you game, using **MusicKit JS** embedded inside Steam's Chromium-based UI.

---

## How It Works

The plugin embeds a hidden `<iframe>` that loads Apple's official **MusicKit JS v3** library. This keeps audio playback fully within Apple's DRM sandbox (no DRM bypass needed), while the Decky Quick Access panel gives you native-feeling controls — play/pause, skip, seek, shuffle, repeat, volume, and search.

```
Steam Deck QAM (React/TypeScript)
        │  postMessage
        ▼
  Hidden <iframe> (MusicKit JS v3)
        │  Apple FairPlay DRM
        ▼
  Apple Music CDN ─── audio → PipeWire/PulseAudio
```

---

## Prerequisites

- **Decky Loader** installed ([decky.xyz](https://decky.xyz))
- **Apple Music subscription**
- **Apple Developer Program membership** ($99/year) — required to generate a MusicKit developer token

---

## Setup: Getting a Developer Token

1. Log in to [developer.apple.com](https://developer.apple.com)
2. Go to **Certificates, Identifiers & Profiles → Keys**
3. Click **+** to create a new key
4. Enable **MusicKit** and click **Continue → Register**
5. Download the `.p8` private key file — **save it, you can only download it once**
6. Note your **Key ID** and **Team ID** (top right of your developer account)

### Generate the JWT token

On your PC (requires Node.js):

```bash
npm install -g jsonwebtoken
```

```js
// generate-token.js
const jwt = require("jsonwebtoken");
const fs  = require("fs");

const privateKey = fs.readFileSync("AuthKey_XXXXXXXXXX.p8");
const teamId     = "YOUR_TEAM_ID";
const keyId      = "YOUR_KEY_ID";

const token = jwt.sign({}, privateKey, {
  algorithm:  "ES256",
  expiresIn:  "180d",       // max 6 months
  issuer:     teamId,
  header: { alg: "ES256", kid: keyId },
});

console.log(token);
```

```bash
node generate-token.js
```

Copy the printed JWT — that's your developer token.

---

## Installation

### Option A — Manual install (sideload)

1. Build the plugin (see Development section below)
2. Copy the output folder to your Steam Deck:
   ```bash
   scp -r decky-apple-music deck@steamdeck:/home/deck/homebrew/plugins/
   ```
3. Restart Decky Loader or reboot into Game Mode

### Option B — Install from ZIP

1. Download the latest release ZIP from the Releases page
2. In Desktop Mode, open Decky Loader settings → **Install from ZIP**

---

## First Run

1. Open the Quick Access Menu (⋯) → tap the **Apple Music** plugin (🎵 icon)
2. Paste your **Developer Token** and set your **Storefront** (e.g. `us`, `gb`, `jp`, `au`)
3. Tap **Save & Connect**
4. Re-open the plugin and tap **Sign in with Apple ID** — a browser popup will appear
5. Complete the sign-in flow — you'll be redirected back automatically
6. Start listening 🎶

---

## Features

| Feature | Status |
|---|---|
| Play / Pause | ✅ |
| Skip forward / back | ✅ |
| Seek (tap progress bar) | ✅ |
| Shuffle | ✅ |
| Repeat (none / all / one) | ✅ |
| Volume control | ✅ |
| Search catalog (songs) | ✅ |
| Album artwork | ✅ |
| Background playback while gaming | ✅ |
| Persisted login between sessions | ✅ |
| System volume sync (pactl) | ✅ |

---

## Development

### Requirements

- Node.js ≥ 16.14
- pnpm v9: `npm i -g pnpm@9`
- Docker (for Python backend compilation, optional)

### Build

```bash
pnpm install
pnpm build
```

### Deploy to Steam Deck (hot-reload)

```bash
# In .vscode/tasks.json the "deploy" task handles this, or manually:
rsync -av --delete dist/ main.py plugin.json package.json \
  deck@steamdeck:/home/deck/homebrew/plugins/Apple\ Music/
```

Then restart Decky from the QAM settings or reboot.

### Project Structure

```
decky-apple-music/
├── src/
│   └── index.tsx          # React UI + MusicKit iframe bridge
├── main.py                # Python backend (settings, system volume)
├── plugin.json            # Decky metadata
├── package.json
├── rollup.config.js
└── tsconfig.json
```

---

## Troubleshooting

**MusicKit never loads**
- Check that your developer token hasn't expired (max 6 months)
- Make sure the Steam Deck has internet access — MusicKit JS is loaded from Apple's CDN

**Sign-in popup doesn't appear / closes immediately**
- Try opening the plugin fresh after a full Deck reboot
- Apple's auth popup requires pop-ups to not be blocked in the CEF browser

**Audio plays but no sound**
- Check the Deck volume isn't muted — MusicKit JS controls its own volume within PipeWire
- Try the volume slider in the plugin

**Search returns no results**
- Confirm your storefront code is correct (e.g. `us` not `US`)
- Apple Music search requires an active subscription

---

## License

MIT — see LICENSE

> **Note:** This plugin uses Apple's official MusicKit JS API and does not circumvent DRM. Usage is subject to [Apple's MusicKit developer terms](https://developer.apple.com/musickit/).
