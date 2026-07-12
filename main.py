import decky
import decky_plugin
import os
import json
import asyncio
import subprocess
import base64
from urllib.parse import urlparse

# No developer token is shipped. The player harvests Apple's own web-player
# token at runtime; everything (frontend config included) uses that.
DEFAULT_STOREFRONT = "us"

# --- Electron player download (installed on first run; too big to ship in the
# plugin zip). Host the tarball as a GitHub Release asset and set the URL below.
PLAYER_VERSION = "1.0.0"
PLAYER_DOWNLOAD_URL = "https://github.com/BrielleG116/decky-apple-music/releases/download/v1.0.0/deckyam-player-1.0.0.tar.gz"
# sha256 of deckyam-player-1.0.0.tar.gz (integrity check; set "" to skip).
PLAYER_SHA256 = "205ab5cd30fcba3db1ca7ec08b5d1bdb3d8aac694339a934d406121dc6ecfd90"

# MPRIS DBUS constants
MP_PATH = "/org/mpris/MediaPlayer2"
MP_MEMB_PLAYER = "org.mpris.MediaPlayer2.Player"
MP_MEMB = "org.mpris.MediaPlayer2"
PROP_IFACE = "org.freedesktop.DBus.Properties"


class ChromeController:
    """Controls the bundled Widevine-enabled player daemon over CDP.

    The player is a castlabs Electron app that hosts MusicKit JS on a local
    page (127.0.0.1:9225) and exposes the Chrome DevTools Protocol on 9224.
    All transport/queue control is done by evaluating MusicKit calls over CDP,
    exactly as with the old Chrome ghost player — but this one can actually
    decrypt Apple Music (Widevine), which the Steam QAM's CEF cannot.
    """

    def __init__(self):
        self.chrome_mpris_name = None
        self.env = self._get_dbus_env()
        self.port = 9224
        # Bundled player daemon location (shipped in the plugin's runtime data dir).
        self.player_dir = self._resolve_player_dir()
        self.player_bin = os.path.join(self.player_dir, "player", "deckyam-player")
        self.player_config = os.path.join(self.player_dir, "player-config.json")
        # The player serves its MusicKit page here; used to find the CDP target.
        self.page_host = "127.0.0.1:9225"
        self._launch_lock = None

    def _resolve_player_dir(self):
        """Locate the plugin runtime data dir that holds the player payload."""
        for attr in ("DECKY_PLUGIN_RUNTIME_DIR",):
            val = getattr(decky, attr, None) or os.environ.get(attr)
            if val and os.path.isdir(val):
                return val
        # Fallback to the conventional Decky data path.
        return "/home/deck/homebrew/data/apple-music-plugin"

    def _get_dbus_env(self):
        # Build a clean deck-user environment from scratch. Decky's PyInstaller
        # runtime injects variables (LD_LIBRARY_PATH pointing at its bundled libs,
        # etc.) that break child processes — copying os.environ and deleting a few
        # keys is not enough (the electron player then fails to launch and no log
        # is even created). A minimal explicit env matches a normal deck session.
        return {
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/bin:/bin",
            "HOME": "/home/deck",
            "USER": "deck",
            "LOGNAME": "deck",
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
            "XDG_RUNTIME_DIR": "/run/user/1000",
            "DISPLAY": ":0",
            "XAUTHORITY": "/home/deck/.Xauthority",
        }

    def _dbus_send(self, dest, path, iface_method, args=""):
        """Execute a dbus-send command and return stdout."""
        cmd = f'dbus-send --print-reply --dest={dest} {path} {iface_method} {args}'
        try:
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True,
                env=self.env, timeout=5
            )
            return result.stdout
        except Exception as e:
            decky.logger.warning(f"[DeckyAM] dbus-send failed: {e}")
            return ""

    def _find_chrome_mpris(self):
        """Discover Chrome's MPRIS bus name from the session bus."""
        try:
            result = subprocess.run(
                "dbus-send --print-reply --dest=org.freedesktop.DBus "
                "/org/freedesktop/DBus org.freedesktop.DBus.ListNames",
                shell=True, capture_output=True, text=True,
                env=self.env, timeout=5
            )
            # Parse the DBUS response — lines look like:  string "org.mpris.MediaPlayer2.chromium.instance2"
            mpris_names = []
            for line in result.stdout.split("\n"):
                line = line.strip()
                if 'string "' in line and "org.mpris.MediaPlayer2" in line:
                    # Extract just the bus name from: string "org.mpris.MediaPlayer2.xxx"
                    name = line.split('"')[1] if '"' in line else line
                    mpris_names.append(name)
            
            decky.logger.info(f"[DeckyAM] MPRIS players found: {mpris_names}")
            
            # Prefer chrome/chromium
            for name in mpris_names:
                lower = name.lower()
                if "chrom" in lower or "google" in lower:
                    decky.logger.info(f"[DeckyAM] Using Chrome MPRIS: {name}")
                    self.chrome_mpris_name = name
                    return name
            
            # Fallback: any non-spotify player
            for name in mpris_names:
                if "spotify" not in name.lower():
                    decky.logger.info(f"[DeckyAM] Fallback MPRIS: {name}")
                    self.chrome_mpris_name = name
                    return name
        except Exception as e:
            decky.logger.warning(f"[DeckyAM] MPRIS discovery failed: {e}")

        self.chrome_mpris_name = None
        return None

    def _get_cdp_ws_url(self):
        """Scan port 9224 for the player's MusicKit page debugger URL."""
        try:
            import urllib.request
            import json
            req = urllib.request.Request(f"http://127.0.0.1:{self.port}/json")
            with urllib.request.urlopen(req, timeout=1.0) as response:
                pages = json.loads(response.read().decode())
                for page in pages:
                    url = page.get("url", "")
                    # Only the local playback page — never the transient
                    # music.apple.com token-harvest window.
                    if self.page_host in url:
                        return page.get("webSocketDebuggerUrl")
        except Exception as e:
            # Only log if it's not a connection refused
            if "Connection refused" not in str(e):
                decky.logger.warning(f"[DeckyAM] CDP WS scan failed: {e}")
        return None

    def _write_player_config(self):
        """Write the player's config (tokens) from the plugin settings file."""
        try:
            settings_path = os.path.join(
                decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "settings.json"
            )
            data = {}
            if os.path.exists(settings_path):
                with open(settings_path, "r") as f:
                    data = json.load(f)
            cfg = {
                "developerToken": str(data.get("developerToken", "")),
                "musicUserToken": str(data.get("musicUserToken", "")),
                "storefront": str(data.get("storefront", DEFAULT_STOREFRONT)) or DEFAULT_STOREFRONT,
                "autoplay": bool(data.get("autoplay", False)),
                "musicTrimDb": float(data.get("musicTrimDb", -8.0)),
            }
            os.makedirs(self.player_dir, exist_ok=True)
            with open(self.player_config, "w") as f:
                json.dump(cfg, f)
            try:
                os.chmod(self.player_config, 0o600)
            except Exception:
                pass
        except Exception as e:
            decky.logger.error(f"[DeckyAM] Failed to write player config: {e}")

    def _build_launch_cmd(self):
        """Build the detached launch command for the player daemon.

        --no-sandbox --no-zygote are mandatory on SteamOS: the Chromium zygote
        chdir's into /proc to harden itself, which breaks in this session
        context so the forked Widevine CDM process gets ESRCH on every syscall
        (can't allocate its shared-memory decrypt buffer) and playback dies with
        "decrypt error 3". Spawning fresh (no zygote) is what makes DRM work.
        These must be real argv, not appendSwitch, for Chromium's early
        zygote/sandbox check to see them together.
        """
        # The plugin backend already runs as the deck user with the session
        # environment (see self.env), so launch directly — do NOT wrap in
        # `sudo -u deck`, which would prompt for a password in this non-root,
        # no-tty context and silently spawn nothing. setsid detaches the player
        # so it outlives this call.
        log_path = os.path.join(self.player_dir, "player-stdout.log")
        # Absolute setsid path so the launch doesn't depend on PATH resolution.
        return (
            f'/usr/bin/setsid "{self.player_bin}" --config="{self.player_config}" '
            f'--no-sandbox --no-zygote '
            f'</dev/null >"{log_path}" 2>&1'
        )

    async def _ensure_cdp_connection(self):
        """Ensure the player daemon is running with CDP enabled on port 9224."""
        ws_url = self._get_cdp_ws_url()
        if ws_url:
            return ws_url

        # Serialize cold starts so overlapping callers don't spawn duplicates.
        if self._launch_lock is None:
            self._launch_lock = asyncio.Lock()
        async with self._launch_lock:
            # Re-check: another caller may have started it while we waited.
            ws_url = self._get_cdp_ws_url()
            if ws_url:
                return ws_url
            return await self._launch_and_wait()

    async def _launch_and_wait(self):
        decky.logger.info(f"[DeckyAM] Player not running, launching on port {self.port}...")

        if not os.path.exists(self.player_bin):
            decky.logger.error(f"[DeckyAM] Player binary missing at {self.player_bin}")
            return None

        # Clear any stale/half-dead instance, then refresh config (tokens).
        try:
            subprocess.run("pkill -9 -f 'player/deckyam-player'", shell=True,
                           env=self.env, timeout=5)
        except Exception:
            pass
        self._write_player_config()

        cmd = self._build_launch_cmd()
        try:
            decky.logger.info(f"[DeckyAM] Executing: {cmd}")
            subprocess.Popen(
                cmd, shell=True, start_new_session=True, env=self.env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception as e:
            decky.logger.error(f"[DeckyAM] Failed to execute launch command: {e}")
            return None

        # Poll for the CDP page (the player also needs a moment to load MusicKit).
        decky.logger.info(f"[DeckyAM] Starting polling loop for port {self.port}...")
        for i in range(1, 26):
            await asyncio.sleep(1.0)
            ws_url = self._get_cdp_ws_url()
            if ws_url:
                decky.logger.info(f"[DeckyAM] SUCCESS: Connected to player on attempt {i}")
                # Give MusicKit a moment to configure/authorize on cold start.
                await asyncio.sleep(2.5)
                return ws_url
            if i % 3 == 0:
                decky.logger.info(f"[DeckyAM] Waiting for player... (Attempt {i}/25)")

        decky.logger.error("[DeckyAM] FAILURE: Timed out waiting for player CDP port.")
        return None

    def _build_ws_frame(self, msg_bytes):
        """Build a masked WebSocket frame."""
        frame = bytearray([0x81])
        mask_key = os.urandom(4)
        length = len(msg_bytes)
        if length < 126:
            frame.append(length | 0x80)
        else:
            frame.append(126 | 0x80)
            frame.extend(length.to_bytes(2, 'big'))
        frame.extend(mask_key)
        for i in range(len(msg_bytes)):
            frame.append(msg_bytes[i] ^ mask_key[i % 4])
        return frame

    async def _read_ws_response(self, reader, expected_id, timeout=10.0):
        """Read WebSocket frames until we find the response matching expected_id."""
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                header = await asyncio.wait_for(reader.readexactly(2), timeout=remaining)
                fin = header[0] & 0x80
                opcode = header[0] & 0x0F
                p_len = header[1] & 0x7F
                
                if p_len == 126:
                    p_len = int.from_bytes(await asyncio.wait_for(reader.readexactly(2), timeout=2.0), 'big')
                elif p_len == 127:
                    p_len = int.from_bytes(await asyncio.wait_for(reader.readexactly(8), timeout=2.0), 'big')
                
                payload = await asyncio.wait_for(reader.readexactly(p_len), timeout=5.0)
                
                if opcode == 0x08:
                    return None
                
                try:
                    resp = json.loads(payload.decode('utf-8', errors='ignore'))
                    if resp.get("id") == expected_id:
                        return resp
                except:
                    pass  # Skip non-JSON or event frames
            except asyncio.TimeoutError:
                break
            except Exception:
                break
        return None

    async def navigate_and_play(self, url):
        """Navigate Chrome tab to URL and auto-click the Play button."""
        decky.logger.info(f"[DeckyAM] Navigate + play: {url}")
        
        ws_url = await self._ensure_cdp_connection()
        if ws_url:
            try:
                import base64
                parsed = urlparse(ws_url)
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(parsed.hostname, parsed.port), timeout=3.0
                )
                
                # WebSocket handshake
                key = base64.b64encode(os.urandom(16)).decode()
                handshake = (
                    f"GET {parsed.path} HTTP/1.1\r\nHost: {parsed.hostname}:{parsed.port}\r\n"
                    "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                    f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
                )
                writer.write(handshake.encode())
                await writer.drain()
                await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), timeout=2.0)
                
                # 1. Navigate
                nav_msg = json.dumps({"id": 1, "method": "Page.navigate", "params": {"url": url}}).encode()
                writer.write(self._build_ws_frame(nav_msg))
                await writer.drain()
                await self._read_ws_response(reader, 1, timeout=5.0)
                decky.logger.info("[DeckyAM] CDP navigation sent, waiting for page load...")
                
                # 2. Wait for page to render
                await asyncio.sleep(4.0)
                
                # 3. Click the Play button
                click_script = """
                (function() {
                    // Try multiple selectors for the Play button
                    const selectors = [
                        'button[aria-label="Play"]',
                        'button[aria-label="Play Station"]',
                        '.play-button',
                        'button[data-testid="play-button"]',
                        '[class*="play-button"]',
                        'button[aria-label*="Play"]'
                    ];
                    for (const sel of selectors) {
                        const btn = document.querySelector(sel);
                        if (btn) {
                            btn.click();
                            return {clicked: true, selector: sel};
                        }
                    }
                    // Try finding by SVG play icon inside buttons
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        const svg = btn.querySelector('svg');
                        if (svg && btn.closest('[class*="product-page"]')) {
                            const text = btn.textContent?.toLowerCase() || '';
                            const label = btn.getAttribute('aria-label')?.toLowerCase() || '';
                            if (text.includes('play') || label.includes('play')) {
                                btn.click();
                                return {clicked: true, selector: 'svg-button'};
                            }
                        }
                    }
                    return {clicked: false, buttons: document.querySelectorAll('button').length};
                })()
                """
                eval_msg = json.dumps({
                    "id": 2, "method": "Runtime.evaluate",
                    "params": {"expression": click_script, "returnByValue": True}
                }).encode()
                writer.write(self._build_ws_frame(eval_msg))
                await writer.drain()
                result = await self._read_ws_response(reader, 2, timeout=5.0)
                
                click_result = result.get("result", {}).get("result", {}).get("value", {}) if result else {}
                decky.logger.info(f"[DeckyAM] Click result: {click_result}")
                
                writer.close()
                return True
            except Exception as e:
                decky.logger.warning(f"[DeckyAM] CDP navigate+play failed, falling back: {e}")
        
        # Fallback: launch Chrome with debugging port
        decky.logger.info("[DeckyAM] Falling back to dedicated profile launch")
        try:
            cmd = (
                f'sudo -u deck env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus '
                f'XDG_RUNTIME_DIR=/run/user/1000 DISPLAY=:0 XAUTHORITY=/home/deck/.Xauthority '
                f'flatpak run com.google.Chrome --remote-debugging-port={self.port} --user-data-dir={self.profile_dir} '
                f'--no-first-run --no-default-browser-check "{url}"'
            )
            subprocess.Popen(
                cmd, shell=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            return True
        except Exception as e:
            decky.logger.error(f"[DeckyAM] Failed to launch Chrome: {e}")
            return False

    async def _cdp_eval(self, expression):
        """Evaluate JavaScript on the active Chrome tab via CDP."""
        ws_url = await self._ensure_cdp_connection()
        if not ws_url:
            return None
        try:
            parsed = urlparse(ws_url)
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(parsed.hostname, parsed.port), timeout=3.0
            )
            key = base64.b64encode(os.urandom(16)).decode()
            handshake = (
                f"GET {parsed.path} HTTP/1.1\r\nHost: {parsed.hostname}:{parsed.port}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            )
            writer.write(handshake.encode())
            await writer.drain()
            await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), timeout=2.0)
            
            msg = json.dumps({
                "id": 1, "method": "Runtime.evaluate",
                "params": {
                    "expression": expression,
                    "returnByValue": True,
                    "awaitPromise": True
                }
            }).encode()
            writer.write(self._build_ws_frame(msg))
            await writer.drain()
            result = await self._read_ws_response(reader, 1, timeout=10.0)
            writer.close()
            
            if result:
                val = result.get("result", {}).get("result", {}).get("value")
                if val is not None:
                    return val
                # Check for exception
                exc = result.get("result", {}).get("exceptionDetails")
                if exc:
                    decky.logger.warning(f"[DeckyAM] CDP eval exception: {exc}")
                return None
            return None
        except Exception as e:
            decky.logger.warning(f"[DeckyAM] CDP eval failed: {e}")
            return None

    async def cdp_play(self):
        res = await self._cdp_eval("""
            (function() {
                try {
                    const mk = window.MusicKit?.getInstance();
                    if (mk) { mk.play(); return true; }
                    const a = document.querySelector('audio,video');
                    if (a) { a.play(); return true; }
                    return false;
                } catch(e) { return e.message; }
            })()
        """)
        return res is not None and res is not False

    async def cdp_pause(self):
        res = await self._cdp_eval("""
            (function() {
                try {
                    const mk = window.MusicKit?.getInstance();
                    if (mk) { mk.pause(); return true; }
                    const a = document.querySelector('audio,video');
                    if (a) { a.pause(); return true; }
                    return false;
                } catch(e) { return e.message; }
            })()
        """)
        return res is not None and res is not False

    async def cdp_play_pause(self):
        res = await self._cdp_eval("""
            (function() {
                try {
                    const mk = window.MusicKit?.getInstance();
                    if (mk) {
                        if (mk.isPlaying) mk.pause();
                        else mk.play();
                        return true;
                    }
                    const a = document.querySelector('audio,video');
                    if (a) { if (a.paused) a.play(); else a.pause(); return true; }
                    return false;
                } catch(e) { return e.message; }
            })()
        """)
        return res is not None and res is not False

    async def cdp_next(self):
        res = await self._cdp_eval("""
            (function() {
                try {
                    const mk = window.MusicKit?.getInstance();
                    if (mk) { mk.skipToNextItem(); return true; }
                    // Fallback: click next button
                    const btn = document.querySelector('button[aria-label="Next"]');
                    if (btn) { btn.click(); return true; }
                    return false;
                } catch(e) { return e.message; }
            })()
        """)
        return res is not None and res is not False

    async def cdp_previous(self):
        res = await self._cdp_eval("""
            (function() {
                try {
                    const mk = window.MusicKit?.getInstance();
                    if (mk) { mk.skipToPreviousItem(); return true; }
                    const btn = document.querySelector('button[aria-label="Previous"]');
                    if (btn) { btn.click(); return true; }
                    return false;
                } catch(e) { return e.message; }
            })()
        """)
        return res is not None and res is not False

    async def cdp_seek(self, position_seconds):
        res = await self._cdp_eval(f"""
            (function() {{
                try {{
                    const mk = window.MusicKit?.getInstance();
                    if (mk) {{ mk.seekToTime({position_seconds}); return true; }}
                    const a = document.querySelector('audio,video');
                    if (a) {{ a.currentTime = {position_seconds}; return true; }}
                    return false;
                }} catch(e) {{ return e.message; }}
            }})()
        """)
        return res is not None and res is not False

    async def cdp_get_status(self):
        """Get playback status and now-playing info via CDP."""
        res = await self._cdp_eval("""
            (function() {
                try {
                    const mk = window.MusicKit?.getInstance();
                    if (mk && mk.nowPlayingItem) {
                        const item = mk.nowPlayingItem;
                        const art = item.attributes?.artwork;
                        let artUrl = '';
                        if (art && art.url) {
                            artUrl = art.url.replace('{w}', '300').replace('{h}', '300');
                        }
                        return {
                            playing: mk.isPlaying,
                            shuffle: (mk.shuffleMode || 0) === 1,
                            repeat: mk.repeatMode || 0,
                            volume: (typeof mk.volume === 'number') ? mk.volume : 1,
                            track: {
                                id: item.id || '',
                                catalogId: item.attributes?.playParams?.catalogId || '',
                                title: item.attributes?.name || '',
                                artist: item.attributes?.artistName || '',
                                album: item.attributes?.albumName || '',
                                artworkUrl: artUrl,
                                duration: (item.attributes?.durationInMillis || 0) / 1000,
                                position: mk.currentPlaybackTime || 0
                            },
                            position: mk.currentPlaybackTime || 0
                        };
                    }
                    // Fallback: check audio element
                    const a = document.querySelector('audio,video');
                    if (a) {
                        return {
                            playing: !a.paused,
                            track: null,
                            position: a.currentTime || 0,
                            volume: a.volume || 1
                        };
                    }
                    return { playing: false, track: null, position: 0, volume: 1 };
                } catch(e) { return { playing: false, track: null, position: 0, volume: 1, error: e.message }; }
            })()
        """)
        return res or {"playing": False, "track": None, "position": 0, "volume": 1}

    async def cdp_set_shuffle(self, on):
        """Set MusicKit shuffle mode (0 = off, 1 = songs)."""
        res = await self._cdp_eval(f"""
            (function() {{
                try {{
                    const mk = window.MusicKit?.getInstance();
                    if (mk) {{ mk.shuffleMode = {1 if on else 0}; return true; }}
                    return false;
                }} catch(e) {{ return e.message; }}
            }})()
        """)
        return res is True

    async def cdp_set_repeat(self, mode):
        """Set MusicKit repeat mode (0 = none, 1 = one, 2 = all)."""
        res = await self._cdp_eval(f"""
            (function() {{
                try {{
                    const mk = window.MusicKit?.getInstance();
                    if (mk) {{ mk.repeatMode = {int(mode)}; return true; }}
                    return false;
                }} catch(e) {{ return e.message; }}
            }})()
        """)
        return res is True

    async def cdp_set_volume(self, volume):
        """Set MusicKit volume (0.0 to 1.0)."""
        res = await self._cdp_eval(f"""
            (function() {{
                try {{
                    const mk = window.MusicKit?.getInstance();
                    if (mk) {{ mk.volume = {volume}; return mk.volume; }}
                    const a = document.querySelector('audio,video');
                    if (a) {{ a.volume = {volume}; return a.volume; }}
                    return false;
                }} catch(e) {{ return e.message; }}
            }})()
        """)
        return res

    async def cdp_get_queue(self):
        """Get the current playback queue/tracklist from MusicKit."""
        res = await self._cdp_eval("""
            (function() {
                try {
                    const mk = window.MusicKit?.getInstance();
                    if (!mk || !mk.queue || !mk.queue.items || mk.queue.items.length === 0) {
                        return { tracks: [], currentIndex: -1 };
                    }
                    const nowId = mk.nowPlayingItem?.id || '';
                    let currentIndex = -1;
                    const tracks = mk.queue.items.map((item, i) => {
                        if (item.id === nowId) currentIndex = i;
                        const art = item.attributes?.artwork;
                        let artUrl = '';
                        if (art && art.url) {
                            artUrl = art.url.replace('{w}', '100').replace('{h}', '100');
                        }
                        return {
                            id: item.id || '',
                            title: item.attributes?.name || 'Unknown',
                            artist: item.attributes?.artistName || '',
                            duration: (item.attributes?.durationInMillis || 0) / 1000,
                            artworkUrl: artUrl,
                            trackNumber: item.attributes?.trackNumber || (i + 1)
                        };
                    });
                    return { tracks, currentIndex };
                } catch(e) { return { tracks: [], currentIndex: -1, error: e.message }; }
            })()
        """)
        return res or {"tracks": [], "currentIndex": -1}

    async def cdp_api(self, path, params, options):
        """Proxy a MusicKit API call through the player (which holds the
        harvested Apple token and rewrites the Origin so Apple accepts it)."""
        script = (
            "(async () => {"
            "  try {"
            "    const mk = window.MusicKit && MusicKit.getInstance();"
            "    if (!mk) return { ok: false, error: 'no MusicKit' };"
            f"    const r = await mk.api.music({json.dumps(path)}, {json.dumps(params or {})}, {json.dumps(options or {})});"
            "    return { ok: true, data: r.data };"
            "  } catch (e) {"
            "    return { ok: false, error: String((e && e.message) || e), status: (e && e.status) || null };"
            "  }"
            "})()"
        )
        return await self._cdp_eval(script)

    def _player_http(self, path, timeout=6):
        """Hit one of the player's local page-server endpoints (/signin, /status)."""
        try:
            import urllib.request
            with urllib.request.urlopen(f"http://127.0.0.1:9225{path}", timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            decky.logger.warning(f"[DeckyAM] player http {path} failed: {e}")
            return None

    def _player_post(self, path, body, timeout=15):
        """POST JSON to a player page-server endpoint (e.g. /logindrive)."""
        try:
            import urllib.request
            data = json.dumps(body or {}).encode()
            req = urllib.request.Request(
                f"http://127.0.0.1:9225{path}", data=data,
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            decky.logger.warning(f"[DeckyAM] player post {path} failed: {e}")
            return None

    def _login_drive(self, action, value=None):
        """Run one login-drive action on the player's sign-in window."""
        return self._player_post("/logindrive", {"action": action, "value": value}) or {"ok": False, "error": "no player response"}

    async def cdp_play_media(self, media_type, media_id):
        """Play a media item directly via MusicKit's setQueue on Chrome."""
        # All logic is in JS so MusicKit can resolve library→catalog IDs
        script = f"""
            (async function() {{
                try {{
                    const mk = window.MusicKit?.getInstance();
                    if (!mk) return {{success: false, error: 'No MusicKit'}};
                    
                    const mediaType = '{media_type}';
                    const mediaId = '{media_id}';
                    const isNumeric = /^\\d+$/.test(mediaId);
                    
                    // Strategy 1: Numeric IDs are catalog IDs — queue directly
                    if (isNumeric) {{
                        if (mediaType.includes('song')) {{
                            await mk.setQueue({{songs: [mediaId]}});
                        }} else if (mediaType.includes('album')) {{
                            await mk.setQueue({{album: mediaId}});
                        }} else if (mediaType.includes('playlist')) {{
                            await mk.setQueue({{playlist: mediaId}});
                        }} else if (mediaType.includes('station')) {{
                            await mk.setQueue({{station: mediaId}});
                        }} else {{
                            await mk.setQueue({{songs: [mediaId]}});
                        }}
                        await mk.play();
                        return {{success: true}};
                    }}
                    
                    // Strategy 2: Library items (l., p., i. prefix)
                    // Try to resolve to catalog equivalent via MusicKit API
                    if (mediaType.includes('song') || mediaId.startsWith('i.')) {{
                        // Fetch the library song to get its catalog ID
                        try {{
                            const res = await mk.api.music('/v1/me/library/songs/' + mediaId);
                            const catalogId = res?.data?.data?.[0]?.attributes?.playParams?.catalogId;
                            if (catalogId) {{
                                await mk.setQueue({{songs: [catalogId]}});
                                await mk.play();
                                return {{success: true}};
                            }}
                        }} catch(e) {{}}
                    }}
                    
                    if (mediaType.includes('playlist') || mediaId.startsWith('p.')) {{
                        // Try fetching catalog relationship for library playlist
                        try {{
                            const res = await mk.api.music('/v1/me/library/playlists/' + mediaId + '/catalog');
                            const catalogId = res?.data?.data?.[0]?.id;
                            if (catalogId) {{
                                await mk.setQueue({{playlist: catalogId}});
                                await mk.play();
                                return {{success: true}};
                            }}
                        }} catch(e) {{}}
                        
                        // Fallback: try fetching playlist tracks and queuing them
                        try {{
                            const res = await mk.api.music('/v1/me/library/playlists/' + mediaId + '/tracks');
                            const tracks = res?.data?.data ?? [];
                            if (tracks.length > 0) {{
                                const catalogIds = tracks
                                    .map(t => t.attributes?.playParams?.catalogId)
                                    .filter(Boolean);
                                if (catalogIds.length > 0) {{
                                    await mk.setQueue({{songs: catalogIds}});
                                    await mk.play();
                                    return {{success: true}};
                                }}
                            }}
                        }} catch(e) {{}}
                    }}
                    
                    if (mediaType.includes('album') || mediaId.startsWith('l.')) {{
                        // Fetch catalog equivalent for library album
                        try {{
                            const res = await mk.api.music('/v1/me/library/albums/' + mediaId + '/catalog');
                            const catalogId = res?.data?.data?.[0]?.id;
                            if (catalogId) {{
                                await mk.setQueue({{album: catalogId}});
                                await mk.play();
                                return {{success: true}};
                            }}
                        }} catch(e) {{}}
                    }}
                    
                    if (mediaType.includes('station') || mediaId.startsWith('ra.')) {{
                        await mk.setQueue({{station: mediaId}});
                        await mk.play();
                        return {{success: true}};
                    }}
                    
                    // Last resort: try as generic song
                    try {{
                        await mk.setQueue({{songs: [mediaId]}});
                        await mk.play();
                        return {{success: true}};
                    }} catch(e) {{
                        return {{success: false, error: 'All strategies failed: ' + e.message}};
                    }}
                }} catch(e) {{ return {{success: false, error: e.message}}; }}
            }})()
        """
        
        decky.logger.info(f"[DeckyAM] cdp_play_media: type={media_type}, id={media_id}")
        res = await self._cdp_eval(script)
        decky.logger.info(f"[DeckyAM] cdp_play_media result: {res}")
        return res or {"success": False, "error": "CDP eval returned None"}

    async def cdp_play_track_at(self, index):
        """Skip to a specific track in the queue by index."""
        res = await self._cdp_eval(f"""
            (function() {{
                try {{
                    const mk = window.MusicKit?.getInstance();
                    if (mk && mk.queue && mk.queue.items && mk.queue.items.length > {index}) {{
                        mk.changeToMediaAtIndex({index});
                        return true;
                    }}
                    return false;
                }} catch(e) {{ return e.message; }}
            }})()
        """)
        return res is not None and res is not False


class Plugin:
    settingsFilePath = os.path.join(decky_plugin.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

    def __init__(self):
        self.chrome = ChromeController()
        self.ducker_proc = None
        self.ducker_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ducker.py")
        self.duck_config = os.path.join(self.chrome.player_dir, "duck-config.json")

    def _write_duck_config(self, data=None):
        """Write the ducker daemon's live config from plugin settings."""
        if data is None:
            data = self._read_settings()
        cfg = {
            "enabled": bool(data.get("duckEnabled", False)),
            "depth": float(data.get("duckDepth", 0.0)),
            "releaseMs": float(data.get("duckRelease", 2500)),
            "attackMs": float(data.get("duckAttack", 45)),
            "threshold": 0.05,
            "loudRef": 0.10,
        }
        try:
            os.makedirs(self.chrome.player_dir, exist_ok=True)
            with open(self.duck_config, "w") as f:
                json.dump(cfg, f)
        except Exception as e:
            decky.logger.error(f"[DeckyAM] duck config write failed: {e}")

    def _ducker_running(self):
        return self.ducker_proc is not None and self.ducker_proc.poll() is None

    def _start_ducker(self):
        self._write_duck_config()
        if self._ducker_running():
            return
        if not os.path.exists(self.ducker_script):
            decky.logger.error(f"[DeckyAM] ducker script missing: {self.ducker_script}")
            return
        try:
            # Kill any stray instance, then launch detached with the audio env.
            subprocess.run("pkill -9 -f apple-music-plugin/ducker.py", shell=True,
                           env=self.chrome.env, timeout=5)
        except Exception:
            pass
        try:
            cmd = f'/usr/bin/setsid /usr/bin/python3 "{self.ducker_script}" "{self.duck_config}"'
            self.ducker_proc = subprocess.Popen(
                cmd, shell=True, start_new_session=True, env=self.chrome.env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            decky.logger.info("[DeckyAM] ducker started")
        except Exception as e:
            decky.logger.error(f"[DeckyAM] ducker start failed: {e}")

    def _stop_ducker(self):
        try:
            subprocess.run("pkill -9 -f apple-music-plugin/ducker.py", shell=True,
                           env=self.chrome.env, timeout=5)
        except Exception:
            pass
        self.ducker_proc = None

    async def set_duck(self, *args):
        """Enable/disable and configure the game auto-duck feature."""
        try:
            payload = args[0] if args else {}
            if isinstance(payload, list):
                payload = payload[0]
            data = self._read_settings()
            if "enabled" in payload:
                data["duckEnabled"] = bool(payload["enabled"])
            if "depth" in payload:
                data["duckDepth"] = float(payload["depth"])
            if "release" in payload:
                data["duckRelease"] = float(payload["release"])
            if "attack" in payload:
                data["duckAttack"] = float(payload["attack"])
            with open(self.settingsFilePath, "w") as f:
                json.dump(data, f)
            self._write_duck_config(data)
            if data.get("duckEnabled"):
                self._start_ducker()
            else:
                self._stop_ducker()
            return {"success": True, "enabled": bool(data.get("duckEnabled"))}
        except Exception as e:
            decky.logger.error(f"[DeckyAM] set_duck error: {e}")
            return {"success": False, "error": str(e)}

    async def set_autoplay(self, *args):
        """Enable/disable MusicKit autoplay (queueing similar songs after an
        album/playlist ends). Persists to settings + player config and applies
        live to the running player so it takes effect without a restart."""
        try:
            enabled = args[0] if args else False
            if isinstance(enabled, list):
                enabled = enabled[0] if enabled else False
            enabled = bool(enabled)
            data = self._read_settings()
            data["autoplay"] = enabled
            with open(self.settingsFilePath, "w") as f:
                json.dump(data, f)
            try:
                self.chrome._write_player_config()
            except Exception:
                pass
            try:
                await self.chrome._cdp_eval(
                    "(() => { try { MusicKit.getInstance().autoplayEnabled = "
                    + json.dumps(enabled)
                    + "; return true; } catch (e) { return false; } })()"
                )
            except Exception:
                pass
            return {"success": True, "enabled": enabled}
        except Exception as e:
            decky.logger.error(f"[DeckyAM] set_autoplay error: {e}")
            return {"success": False, "error": str(e)}

    def _read_settings(self):
        try:
            decky.logger.info(f"[DeckyAM] Reading settings from: {self.settingsFilePath}")
            if os.path.exists(self.settingsFilePath):
                with open(self.settingsFilePath, 'r') as f:
                    return json.load(f)
        except Exception as e:
            decky.logger.error(f"[DeckyAM] Error reading settings: {e}")
        return {}

    async def get_settings(self):
        data = self._read_settings()
        return {
            "developerToken": str(data.get("developerToken", "")),
            "storefront": str(data.get("storefront", DEFAULT_STOREFRONT)),
            "musicUserToken": str(data.get("musicUserToken", "")),
            "trackToasts": bool(data.get("trackToasts", True)),
            "autoplay": bool(data.get("autoplay", False)),
            "musicTrimDb": float(data.get("musicTrimDb", -8.0)),
            "duckEnabled": bool(data.get("duckEnabled", False)),
            "duckDepth": float(data.get("duckDepth", 0.0)),
            "duckRelease": float(data.get("duckRelease", 2500)),
            "duckAttack": float(data.get("duckAttack", 45))
        }

    async def save_settings(self, *args, **kwargs):
        try:
            data = self._read_settings()
            if len(args) == 1 and isinstance(args[0], dict):
                payload = args[0]
            else:
                payload = kwargs
            data["developerToken"] = str(payload.get("developerToken", data.get("developerToken", "")))
            data["storefront"] = str(payload.get("storefront", DEFAULT_STOREFRONT)) or DEFAULT_STOREFRONT
            data["musicUserToken"] = str(payload.get("musicUserToken", ""))
            data["trackToasts"] = bool(payload.get("trackToasts", data.get("trackToasts", True)))
            data["autoplay"] = bool(payload.get("autoplay", data.get("autoplay", False)))
            data["musicTrimDb"] = float(payload.get("musicTrimDb", data.get("musicTrimDb", -8.0)))
            data["duckEnabled"] = bool(payload.get("duckEnabled", data.get("duckEnabled", False)))
            data["duckDepth"] = float(payload.get("duckDepth", data.get("duckDepth", 0.0)))
            data["duckRelease"] = float(payload.get("duckRelease", data.get("duckRelease", 2500)))
            data["duckAttack"] = float(payload.get("duckAttack", data.get("duckAttack", 45)))

            with open(self.settingsFilePath, 'w') as f:
                json.dump(data, f)
        except Exception as e:
            decky.logger.error(f"[DeckyAM] save_settings error: {e}")

    async def open_in_chrome(self, *args):
        """Open a URL in the user's Chrome browser."""
        try:
            url = args[0] if args else ""
            if isinstance(url, list):
                url = url[0]
            if isinstance(url, dict):
                url = url.get("url", "")

            decky.logger.info(f"[DeckyAM] open_in_chrome: {url}")
            if not url:
                return {"success": False, "error": "No URL provided"}

            success = await self.chrome.navigate_and_play(url)
            if success:
                return {"success": True}
            else:
                return {"success": False, "error": "Failed to open URL"}
        except Exception as e:
            decky.logger.error(f"[DeckyAM] open_in_chrome error: {e}")
            return {"success": False, "error": str(e)}

    async def play_on_backend(self, *args):
        """Play an item on the bundled player via MusicKit setQueue (Widevine)."""
        decky.logger.info(f"[DeckyAM] play_on_backend args: {args}")
        try:
            payload = args[0][0] if isinstance(args[0], list) else args[0]
            track_id = payload.get("track_id")
            item_type = payload.get("type", "songs")
        except:
            return {"success": False, "error": "Invalid arguments"}

        if not track_id:
            return {"success": False, "error": "No track_id provided"}

        # Play through MusicKit on the player (full-length, DRM-decrypted) rather
        # than navigating a browser to an apple.com URL.
        result = await self.chrome.cdp_play_media(item_type, track_id)
        if isinstance(result, dict) and result.get("success"):
            return {"success": True}
        return {
            "success": False,
            "error": (result or {}).get("error", "Playback failed") if isinstance(result, dict) else "Playback failed",
        }

    async def play_media(self, *args):
        """Play any media type directly via MusicKit's setQueue on Chrome."""
        try:
            payload = args[0] if args else {}
            if isinstance(payload, list):
                payload = payload[0]
            media_type = payload.get("type", "songs")
            media_id = payload.get("id", "")
            if not media_id:
                return {"success": False, "error": "No media ID"}
            return await self.chrome.cdp_play_media(media_type, media_id)
        except Exception as e:
            decky.logger.error(f"[DeckyAM] play_media error: {e}")
            return {"success": False, "error": str(e)}

    async def am_api(self, *args):
        """Frontend browsing proxy: run a MusicKit API call on the player."""
        try:
            payload = args[0] if args else {}
            if isinstance(payload, list):
                payload = payload[0]
            path = payload.get("path")
            if not path:
                return {"ok": False, "error": "no path"}
            params = payload.get("params") or {}
            options = payload.get("options") or {}
            res = await self.chrome.cdp_api(path, params, options)
            return res or {"ok": False, "error": "no response from player"}
        except Exception as e:
            decky.logger.error(f"[DeckyAM] am_api error: {e}")
            return {"ok": False, "error": str(e)}

    async def get_dev_token(self):
        """Return Apple's harvested web-player developer token from the player, so
        the frontend can configure MusicKit without shipping a token of our own.
        Ensures the player is up (harvest completes before its CDP target
        appears), then reads it from the live config."""
        try:
            await self.chrome._ensure_cdp_connection()
        except Exception:
            pass
        try:
            cfg = self.chrome._player_http("/config") or {}
            tok = cfg.get("developerToken") or ""
            if len(tok) > 50:
                return {"token": tok}
        except Exception:
            pass
        # Fallbacks: live MusicKit instance, then the on-disk harvest cache.
        try:
            tok = await self.chrome._cdp_eval(
                "(() => { try { return MusicKit.getInstance().developerToken || ''; } catch (e) { return ''; } })()"
            )
            if isinstance(tok, str) and len(tok) > 50:
                return {"token": tok}
        except Exception:
            pass
        try:
            with open("/home/deck/.config/deckyam-player/harvested-tokens.json") as f:
                cache = json.load(f)
            if cache.get("dev"):
                return {"token": cache["dev"]}
        except Exception:
            pass
        return {"token": ""}

    async def am_signout(self):
        """Sign out: clear the player's Apple session and the stored user token."""
        self.chrome._player_http("/signout")
        try:
            data = self._read_settings()
            data["musicUserToken"] = ""
            with open(self.settingsFilePath, "w") as f:
                json.dump(data, f)
        except Exception as e:
            decky.logger.warning(f"[DeckyAM] am_signout settings clear failed: {e}")
        return {"success": True}

    async def am_status(self):
        """Report whether the player is signed in; persist a freshly captured
        user token to settings so the frontend picks it up."""
        r = self.chrome._player_http("/status") or {}
        signed_in = bool(r.get("signedIn"))
        if signed_in:
            try:
                mut = await self.chrome._cdp_eval(
                    "(() => { try { return MusicKit.getInstance().musicUserToken || ''; } catch(e) { return ''; } })()"
                )
                if mut:
                    data = self._read_settings()
                    if data.get("musicUserToken") != mut:
                        data["musicUserToken"] = mut
                        with open(self.settingsFilePath, "w") as f:
                            json.dump(data, f)
            except Exception as e:
                decky.logger.warning(f"[DeckyAM] am_status token persist failed: {e}")
        return {"signedIn": signed_in, "hasDevToken": bool(r.get("hasDevToken"))}

    @staticmethod
    def _clean_err(text):
        """Trim Apple's error text to its first line (drops the trailing
        'Forgot password?...opens in a new window' cruft)."""
        if not text:
            return "sign-in failed"
        first = str(text).strip().split("\n")[0].strip()
        return first or "sign-in failed"

    @staticmethod
    def _has_submit_button(probe):
        labels = " ".join(probe.get("buttons") or []).lower()
        return any(w in labels for w in ("continue", "sign in", "next"))

    @staticmethod
    def _has_trust_button(probe):
        labels = " ".join(probe.get("buttons") or []).lower()
        return "trust" in labels or "not now" in labels

    def _player_signed_in(self):
        """Ground-truth sign-in check via the player's /status endpoint."""
        st = self.chrome._player_http("/status") or {}
        return bool(st.get("signedIn"))

    async def _wait_login(self, cond, timeout=25.0, interval=0.7):
        """Poll the player's login probe until cond(probe) is truthy or timeout.
        Returns (probe, matched). Bails early on a captured token or auth error."""
        deadline = asyncio.get_event_loop().time() + timeout
        last = {}
        while asyncio.get_event_loop().time() < deadline:
            probe = self.chrome._login_drive("probe")
            last = probe or {}
            if last.get("mut"):
                return last, True
            if cond(last):
                return last, True
            await asyncio.sleep(interval)
        return last, False

    async def am_login(self, *args):
        """Sign in with email+password typed in the QAM. Opens a hidden login
        window, drives MusicKit.authorize()'s form, and reports the next step
        ('signedin', '2fa', or 'error'). Brittle by nature — Apple's login is a
        multi-step nested-iframe React app — so every step reports a rich probe."""
        try:
            payload = args[0] if args else {}
            if isinstance(payload, list):
                payload = payload[0] if payload else {}
            email = (payload.get("email") or "").strip()
            password = payload.get("password") or ""
            if not email or not password:
                return {"step": "error", "error": "email and password required"}

            await self.chrome._ensure_cdp_connection()
            # Open (or reuse) the hidden, plugin-driven sign-in window.
            self.chrome._player_http("/signin?hidden=1")

            # Wait for MusicKit to load, then kick off authorize(). Give slow /
            # flaky connections plenty of time, and reload the window once if the
            # page seems stalled (MusicKit still absent well into the wait).
            started = None
            loop = asyncio.get_event_loop()
            begin = loop.time()
            deadline = begin + 45
            reloaded = False
            while loop.time() < deadline:
                started = self.chrome._login_drive("start")
                if started.get("ready"):
                    break
                if not reloaded and (loop.time() - begin) > 18:
                    # The initial page load may have stalled — recreate the
                    # sign-in window fresh (re-loads music.apple.com). Uses the
                    # page server so it works on any installed player build.
                    self.chrome._player_http("/signin?hidden=1")
                    reloaded = True
                await asyncio.sleep(0.7)
            if not (started and started.get("ready")):
                return {"step": "error",
                        "error": "Couldn't reach Apple's sign-in. Check the Deck's internet connection and try again.",
                        "detail": started}
            if started.get("authorized"):
                return await self._finish_login()

            # Email step — the appleauth widget's account-name field.
            probe, ok = await self._wait_login(lambda p: p.get("emailField"), timeout=25)
            if probe.get("mut"):
                return await self._finish_login()
            if not ok:
                return {"step": "error", "error": "email field never appeared", "probe": probe}
            fill = self.chrome._login_drive("email", email)
            if not fill.get("ok"):
                return {"step": "error", "error": "could not fill email", "detail": fill, "probe": probe}

            # Apple's current web form shows email + password together, so fill the
            # password without submitting first when it's already present. Only if
            # it's a two-step layout do we Continue and wait for it to appear.
            probe = self.chrome._login_drive("probe")
            if not probe.get("passwordField"):
                self.chrome._login_drive("submit")
                probe, ok = await self._wait_login(
                    lambda p: p.get("passwordField") or p.get("error"), timeout=25)
                if probe.get("mut"):
                    return await self._finish_login()
                if probe.get("error"):
                    return {"step": "error", "error": probe.get("error"), "probe": probe}
                if not ok or not probe.get("passwordField"):
                    return {"step": "error", "error": "password field never appeared", "probe": probe}
            fill = self.chrome._login_drive("password", password)
            if not fill.get("ok"):
                return {"step": "error", "error": "could not fill password", "detail": fill, "probe": probe}

            # Apple's widget advances through several buttons within one page
            # (e.g. Continue -> "Continue with Password" chooser -> Sign In), and
            # the password field can reappear empty on the chooser. Refill it
            # whenever present, then click, settle, and repeat until resolved.
            for _ in range(4):
                probe = self.chrome._login_drive("probe")
                if probe.get("passwordField"):
                    self.chrome._login_drive("password", password)
                self.chrome._login_drive("submit")
                await asyncio.sleep(2.5)
                if self._player_signed_in():
                    return await self._finish_login()
                probe = self.chrome._login_drive("probe")
                if probe.get("mut") or probe.get("authorized"):
                    return await self._finish_login()
                if probe.get("codeField"):
                    return {"step": "2fa", "codeInputCount": probe.get("codeInputCount"), "probe": probe}
                if probe.get("error"):
                    return {"step": "error", "error": self._clean_err(probe.get("error")), "probe": probe}
                if not (self._has_submit_button(probe) or self._has_trust_button(probe)):
                    break  # form is submitting / navigating — poll for resolution

            # Final resolution wait (redirect back + token capture can take time).
            probe, ok = await self._wait_login(
                lambda p: p.get("mut") or p.get("codeField") or p.get("authorized") or p.get("error"),
                timeout=30)
            if probe.get("mut") or probe.get("authorized") or self._player_signed_in():
                return await self._finish_login()
            if probe.get("codeField"):
                return {"step": "2fa", "codeInputCount": probe.get("codeInputCount"), "probe": probe}
            if probe.get("error"):
                return {"step": "error", "error": self._clean_err(probe.get("error")), "probe": probe}
            return {"step": "error", "error": "login did not resolve", "probe": probe}
        except Exception as e:
            decky.logger.error(f"[DeckyAM] am_login error: {e}")
            return {"step": "error", "error": str(e)}

    async def am_submit_2fa(self, *args):
        """Submit the 6-digit two-factor code and finish sign-in."""
        try:
            payload = args[0] if args else {}
            if isinstance(payload, list):
                payload = payload[0] if payload else {}
            code = "".join(ch for ch in str(payload.get("code") or "") if ch.isdigit())
            if len(code) < 4:
                return {"step": "error", "error": "enter the verification code"}
            fill = self.chrome._login_drive("code", code)
            if not fill.get("ok"):
                return {"step": "error", "error": "could not enter code", "detail": fill}
            # The 6-box code auto-submits on the last digit; do NOT click a button
            # right away (that resubmits a consumed code). Apple then shows a
            # "Trust this browser?" interstitial that must be clicked through
            # before authorize() completes and the player captures the token.
            deadline = asyncio.get_event_loop().time() + 45
            last = {}
            while asyncio.get_event_loop().time() < deadline:
                # Ground truth: the player's capture loop grabs the token (from
                # MusicKit or the authorize-callback URL) and may close the window.
                if self._player_signed_in():
                    return await self._finish_login()
                last = self.chrome._login_drive("probe") or {}
                if last.get("mut") or last.get("authorized"):
                    return await self._finish_login()
                # A genuine "incorrect code" only counts while the code field is up.
                if last.get("error") and last.get("codeField"):
                    return {"step": "error", "error": self._clean_err(last.get("error"))}
                # Click through the Trust / continue interstitial when it appears.
                if self._has_submit_button(last) or self._has_trust_button(last):
                    self.chrome._login_drive("submit")
                await asyncio.sleep(1.3)
            return {"step": "error", "error": "code not accepted", "probe": last}
        except Exception as e:
            decky.logger.error(f"[DeckyAM] am_submit_2fa error: {e}")
            return {"step": "error", "error": str(e)}

    async def _finish_login(self):
        """Persist the freshly captured user token to settings (the player has
        already applied it live + cached it) and report success."""
        try:
            await self.am_status()
        except Exception as e:
            decky.logger.warning(f"[DeckyAM] _finish_login persist failed: {e}")
        return {"step": "signedin"}

    async def mpris_play(self):
        return {"success": await self.chrome.cdp_play()}

    async def mpris_pause(self):
        return {"success": await self.chrome.cdp_pause()}

    async def mpris_play_pause(self):
        return {"success": await self.chrome.cdp_play_pause()}

    async def mpris_next(self):
        return {"success": await self.chrome.cdp_next()}

    async def mpris_previous(self):
        return {"success": await self.chrome.cdp_previous()}

    async def mpris_seek(self, *args):
        try:
            offset = args[0] if args else 0
            if isinstance(offset, list):
                offset = offset[0]
            # Convert microseconds from frontend to seconds for MusicKit
            return {"success": await self.chrome.cdp_seek(int(offset) / 1_000_000)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def mpris_get_status(self):
        st = await self.chrome.cdp_get_status()
        # The player's MusicKit volume has the trim folded in; divide it back out
        # so the slider reflects the user's chosen level, not the trimmed value.
        try:
            factor = self._music_trim_factor()
            if isinstance(st, dict) and factor > 0 and isinstance(st.get("volume"), (int, float)):
                st["volume"] = max(0.0, min(1.0, st["volume"] / factor))
        except Exception:
            pass
        return st

    async def set_shuffle(self, *args):
        try:
            on = args[0] if args else False
            if isinstance(on, list):
                on = on[0]
            return {"success": await self.chrome.cdp_set_shuffle(bool(on))}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def set_repeat(self, *args):
        try:
            mode = args[0] if args else 0
            if isinstance(mode, list):
                mode = mode[0]
            return {"success": await self.chrome.cdp_set_repeat(int(mode))}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def _music_trim_factor(self):
        """Linear gain for the configured music-level trim (dB → factor).
        Defaults to -8 dB so music sits closer to game loudness."""
        try:
            db = float(self._read_settings().get("musicTrimDb", -8.0))
        except Exception:
            db = -8.0
        db = max(-24.0, min(0.0, db))
        return 10.0 ** (db / 20.0)

    async def set_volume(self, *args):
        try:
            vol = args[0] if args else 1.0
            if isinstance(vol, list):
                vol = vol[0]
            vol = max(0.0, min(1.0, float(vol)))
            # Fold the music-level trim into MusicKit's volume so it stacks under
            # the slider (and the ducker, which scales the PipeWire node on top).
            trimmed = max(0.0, min(1.0, vol * self._music_trim_factor()))
            result = await self.chrome.cdp_set_volume(trimmed)
            return {"success": result is not None and result is not False, "volume": vol}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def set_music_trim(self, *args):
        """Set the music-level trim (dB, ≤ 0) and re-apply it live using the
        current slider volume so it takes effect without restarting playback."""
        try:
            payload = args[0] if args else {}
            if isinstance(payload, list):
                payload = payload[0] if payload else {}
            db = max(-24.0, min(0.0, float(payload.get("db", -8.0))))
            data = self._read_settings()
            data["musicTrimDb"] = db
            with open(self.settingsFilePath, "w") as f:
                json.dump(data, f)
            try:
                self.chrome._write_player_config()
            except Exception:
                pass
            vol = payload.get("volume", None)
            if vol is not None:
                v = max(0.0, min(1.0, float(vol)))
                trimmed = max(0.0, min(1.0, v * (10.0 ** (db / 20.0))))
                await self.chrome.cdp_set_volume(trimmed)
            return {"success": True, "db": db}
        except Exception as e:
            decky.logger.error(f"[DeckyAM] set_music_trim error: {e}")
            return {"success": False, "error": str(e)}

    async def get_queue(self):
        return await self.chrome.cdp_get_queue()

    async def play_track_at(self, *args):
        try:
            index = args[0] if args else 0
            if isinstance(index, list):
                index = index[0]
            return {"success": await self.chrome.cdp_play_track_at(int(index))}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def mpris_list_players(self):
        return {"players": []}

    async def mpris_set_player(self, *args):
        return {"success": True}

    async def stop_backend(self):
        return {"success": True}

    async def prewarm(self):
        """Cold-start the player daemon so it's ready before the first play."""
        try:
            ws = await self.chrome._ensure_cdp_connection()
            return {"success": bool(ws)}
        except Exception as e:
            decky.logger.error(f"[DeckyAM] prewarm error: {e}")
            return {"success": False, "error": str(e)}

    # ---- Electron player install (first-run download) -----------------------

    def _player_payload_dir(self):
        """Directory the Electron player payload lives in (data_dir/player)."""
        return os.path.join(self.chrome.player_dir, "player")

    def _player_binary_exists(self):
        b = self.chrome.player_bin
        return os.path.isfile(b) and os.access(b, os.X_OK)

    def _installed_player_version(self):
        try:
            with open(os.path.join(self._player_payload_dir(), ".deckyam-version")) as f:
                return f.read().strip()
        except Exception:
            return ""

    def _get_install_state(self):
        st = getattr(self, "_install_state", None)
        if st is None:
            st = {"state": "idle", "pct": 0, "message": ""}
            self._install_state = st
        return st

    async def player_installed(self):
        """Whether the Electron player payload is installed and runnable."""
        return {
            "installed": self._player_binary_exists(),
            "version": self._installed_player_version(),
            "latest": PLAYER_VERSION,
        }

    async def install_status(self):
        return self._get_install_state()

    async def install_player(self, *args):
        """Kick off the player download+install in the background. The frontend
        polls install_status() for progress."""
        st = self._get_install_state()
        if st.get("state") in ("downloading", "extracting"):
            return {"success": True, "already": True}
        self._install_state = {"state": "downloading", "pct": 0, "message": "Starting…"}
        asyncio.create_task(self._do_install())
        return {"success": True}

    async def _do_install(self):
        try:
            await asyncio.to_thread(self._install_blocking)
            self._install_state = {"state": "done", "pct": 100, "message": "Player installed"}
            # Launch the freshly-installed player so it's ready immediately.
            try:
                await self.chrome._ensure_cdp_connection()
            except Exception:
                pass
        except Exception as e:
            decky.logger.error(f"[DeckyAM] install_player failed: {e}")
            self._install_state = {"state": "error", "pct": 0, "message": str(e)}

    def _download_ssl_context(self):
        """SSL context for the player download. Decky's bundled Python often
        can't locate the system CA store ('unable to get local issuer
        certificate'), so load SteamOS's CA bundle explicitly. Falls back to an
        unverified context — safe here because the download is pinned by
        PLAYER_SHA256, so a tampered/MITM'd file is rejected regardless of TLS."""
        import ssl
        ctx = ssl.create_default_context()
        try:
            has_ca = ctx.cert_store_stats().get("x509_ca", 0) > 0
        except Exception:
            has_ca = False
        if not has_ca:
            for ca in ("/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem",
                       "/etc/pki/tls/certs/ca-bundle.crt"):
                if os.path.exists(ca):
                    try:
                        ctx.load_verify_locations(ca)
                        has_ca = True
                        break
                    except Exception:
                        pass
        if not has_ca:
            ctx = ssl._create_unverified_context()
        return ctx

    def _open_download(self, req, timeout=60):
        import urllib.request, ssl
        try:
            return urllib.request.urlopen(req, timeout=timeout, context=self._download_ssl_context())
        except ssl.SSLError:
            # Verification still failed in this runtime — proceed unverified;
            # the pinned sha256 below is what actually guarantees integrity.
            return urllib.request.urlopen(req, timeout=timeout,
                                          context=ssl._create_unverified_context())

    def _install_blocking(self):
        """Download the player tarball, verify it, and extract it. Runs in a
        worker thread; updates self._install_state as it goes."""
        import urllib.request, tarfile, hashlib, shutil
        if not PLAYER_DOWNLOAD_URL or "<OWNER>" in PLAYER_DOWNLOAD_URL:
            raise RuntimeError("Player download URL is not configured yet")
        if not PLAYER_SHA256:
            raise RuntimeError("No PLAYER_SHA256 pin — refusing to install unverified")
        data_dir = self.chrome.player_dir
        os.makedirs(data_dir, exist_ok=True)
        tmp = os.path.join(data_dir, ".player-download.tar.gz")

        # Download with progress + running checksum.
        req = urllib.request.Request(PLAYER_DOWNLOAD_URL, headers={"User-Agent": "DeckyAM"})
        sha = hashlib.sha256()
        with self._open_download(req, timeout=60) as r:
            total = int(r.headers.get("Content-Length", 0) or 0)
            got = 0
            with open(tmp, "wb") as f:
                while True:
                    chunk = r.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
                    sha.update(chunk)
                    got += len(chunk)
                    pct = int(got * 100 / total) if total else 0
                    mb = got // (1024 * 1024)
                    tail = f" / {total // (1024 * 1024)} MB" if total else ""
                    self._install_state = {"state": "downloading", "pct": pct,
                                           "message": f"Downloading… {mb} MB{tail}"}

        if PLAYER_SHA256 and sha.hexdigest() != PLAYER_SHA256:
            try:
                os.remove(tmp)
            except Exception:
                pass
            raise RuntimeError("Download checksum mismatch — aborting install")

        # Stop any running player, then replace the payload.
        self._install_state = {"state": "extracting", "pct": 100, "message": "Installing…"}
        try:
            subprocess.run("pkill -9 -f 'player/deckyam-player'", shell=True, timeout=5)
        except Exception:
            pass
        try:
            for lock in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
                lp = os.path.join("/home/deck/.config/deckyam-player", lock)
                if os.path.exists(lp):
                    os.remove(lp)
        except Exception:
            pass
        payload = self._player_payload_dir()
        if os.path.isdir(payload):
            shutil.rmtree(payload, ignore_errors=True)

        # The tarball has a top-level player/ dir, so extract into data_dir.
        with tarfile.open(tmp, "r:gz") as t:
            try:
                t.extractall(data_dir, filter="data")  # py3.12+ safe extraction
            except TypeError:
                t.extractall(data_dir)

        for exe in ("deckyam-player", "chrome_crashpad_handler"):
            p = os.path.join(payload, exe)
            if os.path.isfile(p):
                try:
                    os.chmod(p, 0o755)
                except Exception:
                    pass
        try:
            with open(os.path.join(payload, ".deckyam-version"), "w") as f:
                f.write(PLAYER_VERSION)
        except Exception:
            pass
        try:
            os.remove(tmp)
        except Exception:
            pass

    async def _main(self):
        decky.logger.info("[DeckyAM] Plugin loaded (Widevine player mode)")
        # Warm up the player daemon in the background so plugin load isn't
        # blocked (and Decky doesn't retry-load); it runs in the persistent
        # plugin_loader context so it survives the QAM/game lifecycle.
        asyncio.create_task(self._prewarm_bg())
        # Resume auto-duck if the user had it enabled.
        try:
            if self._read_settings().get("duckEnabled"):
                self._start_ducker()
        except Exception as e:
            decky.logger.warning(f"[DeckyAM] ducker resume failed: {e}")

    async def _prewarm_bg(self):
        try:
            await self.chrome._ensure_cdp_connection()
        except Exception as e:
            decky.logger.warning(f"[DeckyAM] prewarm on load failed: {e}")

    async def _unload(self):
        decky.logger.info("[DeckyAM] Plugin unloaded")
        self._stop_ducker()
