# DeckyAM — Beta Distribution Guide

The plugin ships in two pieces:

1. **The plugin** (~48 KB zip) — installed via Decky "Install from ZIP".
2. **The Electron player** (~120 MB tarball) — downloaded on first run by the
   in-plugin **Install Player** button. Too big for the plugin zip.

Both are hosted as **GitHub Release assets**.

---

## One-time setup (you, the maintainer)

### 1. Create a GitHub repo
Create a repo, e.g. `github.com/jeffmartinez/decky-apple-music`.

### 2. Create the release + upload the player
- Cut a release tagged **`v1.0.0`**.
- Upload the player tarball as a release asset (the release tag stays `v1.0.0`;
  new player builds are added as versioned assets alongside it):
  `release/deckyam-player-1.0.1.tar.gz`
  (current; sha256 `005fa978…1ffe45`).
- Copy the asset's **download URL**. It looks like:
  `https://github.com/<OWNER>/<REPO>/releases/download/v1.0.0/deckyam-player-1.0.1.tar.gz`

### 3. Point the plugin at the player
Edit `main.py` and set:
```python
PLAYER_DOWNLOAD_URL = "https://github.com/<OWNER>/<REPO>/releases/download/v1.0.0/deckyam-player-1.0.1.tar.gz"
```
(Also set `PLAYER_VERSION` and `PLAYER_SHA256` to match the tarball you uploaded.)

### 4. Build the plugin zip
```bash
./package-plugin.sh
```
Produces `apple-music-plugin.zip`. (It warns if you forgot step 3.)

### 5. Host the plugin zip
Upload `apple-music-plugin.zip` to the **same release** as a second asset. Its
URL becomes the "Install from ZIP" link you give testers:
`https://github.com/<OWNER>/<REPO>/releases/download/v1.0.0/apple-music-plugin.zip`

---

## Tester instructions

1. Install **Decky Loader** (if not already).
2. In Decky settings, enable **Developer mode**.
3. Developer tab → **Install Plugin from URL** → paste the `apple-music-plugin.zip` URL.
4. Open the **Apple Music** plugin in the QAM. On first run it shows
   **"One-time setup" → Install Player**. Tap it; it downloads (~120 MB) and installs.
5. Sign in with your Apple ID (email + password, then the 2FA code). Requires an
   active Apple Music subscription.

---

## Updating later

- **Changed only the frontend/backend** (`src/index.tsx` / `main.py` / `ducker.py`):
  bump `version` in `package.json`, run `./package-plugin.sh`, replace the plugin
  zip asset. Testers reinstall the zip. The player download is untouched.
- **Changed the player** (`player/` — Electron or `app.asar`):
  1. Rebuild the player, then repackage the tarball on the Deck:
     `tar -czf deckyam-player-<ver>.tar.gz -C ~/homebrew/data/apple-music-plugin player`
  2. `sha256sum` it; bump `PLAYER_VERSION` + `PLAYER_SHA256` + `PLAYER_DOWNLOAD_URL`
     in `main.py` (new tag/filename).
  3. Upload the new tarball to a new release, rebuild + reship the plugin zip.
  Installed testers auto-reinstall the player when `player_installed()` reports a
  version mismatch — or they can re-trigger it (see below).

## Notes
- The player tarball (`release/…tar.gz`) is large — upload it to Releases, don't
  commit it to git. Add `release/` to `.gitignore`.
- The install extracts to `~/homebrew/data/apple-music-plugin/player/` and is
  fully self-contained (bundled castlabs Electron + Widevine).
- No developer token or credentials are embedded — each user signs in with their
  own Apple ID, and Apple's own web-player token is harvested at runtime.
