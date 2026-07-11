#!/usr/bin/env python3
"""DeckyAM auto-duck daemon.

Continuously measures game (and other non-music) audio loudness via
PulseAudio-compat per-application monitoring (`parec --monitor-stream`), and
rides the music player's PipeWire node volume down when the game gets loud,
back up to full when it's quiet — classic sidechain ducking.

Design notes:
  * We duck at the PipeWire *node* level of the player (via `wpctl set-volume`).
    The user's in-app volume (MusicKit) is the ceiling; this only scales the
    node between `depth` and 1.0, so it never fights the volume slider.
  * "Game audio" = every sink-input except our own player and the virtual
    surround output (which carries the mixed signal — monitoring it would feed
    back). Steam UI blips can cause a brief duck; that's acceptable/desirable.
  * Config is re-read from disk each tick so the UI can change depth/release
    live without restarting the daemon.
"""
import os
import sys
import time
import json
import math
import select
import subprocess

CONFIG_PATH = sys.argv[1] if len(sys.argv) > 1 else "/home/deck/homebrew/data/apple-music-plugin/duck-config.json"

# Streams we must never treat as "game" audio.
EXCLUDE_APP_NAMES = {"deckyam-player"}
EXCLUDE_MEDIA_NAMES = {"Virtual Surround Sound output"}
PLAYER_NODE_NAMES = {"deckyam-player"}

SAMPLE_RATE = 8000          # mono, low rate — plenty for loudness detection
TICK = 0.04                 # 25 Hz control loop
REFRESH_EVERY = 1.0         # re-scan sink-inputs / player node this often
FULL_SCALE = 32768.0


def log(*a):
    print("[ducker]", *a, flush=True)


def read_config():
    cfg = {
        "enabled": True,
        "depth": 0.0,         # music node volume when fully ducked (0..1)
        "threshold": 0.02,    # game RMS (0..1) below which we don't duck
        "loudRef": 0.07,      # game RMS mapped to full duck
        "attackMs": 45,       # how fast we duck down
        "releaseMs": 2500,    # how slow we come back
    }
    try:
        with open(CONFIG_PATH) as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    return cfg


def find_player_node():
    """Return the PipeWire node id of the music player (for volume control)."""
    try:
        out = subprocess.run(["pw-dump"], capture_output=True, text=True, timeout=4).stdout
        for n in json.loads(out):
            if not isinstance(n, dict):
                continue
            p = n.get("info", {}).get("props", {})
            if p.get("media.class") == "Stream/Output/Audio" and \
               (p.get("node.name") in PLAYER_NODE_NAMES or p.get("application.name") in PLAYER_NODE_NAMES):
                return n["id"]
    except Exception as e:
        log("find_player_node error:", e)
    return None


def find_game_sink_inputs():
    """Return list of sink-input indices whose audio should trigger ducking."""
    try:
        out = subprocess.run(["pactl", "list", "sink-inputs"], capture_output=True, text=True, timeout=4).stdout
    except Exception as e:
        log("pactl error:", e)
        return []
    result = []
    idx = None
    app = None
    media = None

    def flush():
        if idx is not None and app not in EXCLUDE_APP_NAMES and media not in EXCLUDE_MEDIA_NAMES:
            result.append(idx)

    for line in out.splitlines():
        s = line.strip()
        if s.startswith("Sink Input #"):
            flush()
            try:
                idx = int(s.split("#")[1])
            except Exception:
                idx = None
            app = None
            media = None
        elif s.startswith("application.name = "):
            app = s.split("= ", 1)[1].strip().strip('"')
        elif s.startswith("media.name = "):
            media = s.split("= ", 1)[1].strip().strip('"')
    flush()
    return result


def start_parec(index):
    try:
        return subprocess.Popen(
            ["parec", f"--monitor-stream={index}", "--format=s16le",
             "--channels=1", f"--rate={SAMPLE_RATE}"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        log("parec start error:", e)
        return None


def rms_of(buf):
    if not buf:
        return 0.0
    n = len(buf) // 2
    if n == 0:
        return 0.0
    total = 0
    # struct-free fast path: iterate int16 little-endian
    import array
    a = array.array("h")
    a.frombytes(buf[: n * 2])
    for x in a:
        total += x * x
    return math.sqrt(total / n) / FULL_SCALE


def set_volume(node_id, vol):
    try:
        subprocess.run(["wpctl", "set-volume", str(node_id), f"{vol:.3f}"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
    except Exception:
        pass


def main():
    log("starting; config:", CONFIG_PATH)
    procs = {}              # index -> Popen
    levels = {}             # index -> latest rms (decays)
    current = 1.0           # current node gain we've applied
    applied = None
    player_node = None
    last_refresh = 0.0

    while True:
        cfg = read_config()
        now = time.time()

        if not cfg.get("enabled", True):
            # Feature off: release music to full, tear down captures, idle.
            for p in procs.values():
                try: p.terminate()
                except Exception: pass
            procs.clear(); levels.clear()
            if player_node and applied != 1.0:
                set_volume(player_node, 1.0); applied = 1.0
            current = 1.0
            time.sleep(0.5)
            continue

        # Periodically re-scan the player node and game sink-inputs.
        if now - last_refresh >= REFRESH_EVERY:
            last_refresh = now
            player_node = find_player_node() or player_node
            wanted = set(find_game_sink_inputs())
            for i in list(procs):
                if i not in wanted or procs[i].poll() is not None:
                    try: procs[i].terminate()
                    except Exception: pass
                    procs.pop(i, None); levels.pop(i, None)
            for i in wanted:
                if i not in procs:
                    p = start_parec(i)
                    if p:
                        procs[i] = p; levels[i] = 0.0

        # Drain whatever audio is available from each capture (non-blocking).
        if procs:
            fds = {p.stdout.fileno(): i for i, p in procs.items() if p.stdout}
            ready, _, _ = select.select(list(fds), [], [], TICK)
            for fd in ready:
                i = fds[fd]
                try:
                    chunk = os.read(fd, 4096)
                except Exception:
                    chunk = b""
                if chunk:
                    levels[i] = rms_of(chunk)
                else:
                    levels[i] *= 0.5  # decay if stream went quiet/EOF-ish
        else:
            time.sleep(TICK)

        # Instantaneous game loudness = loudest active game stream.
        game = max(levels.values()) if levels else 0.0

        # Map loudness -> target gain (1.0 = full music, depth = fully ducked).
        depth = float(cfg.get("depth", 0.30))
        thr = float(cfg.get("threshold", 0.02))
        loud = max(float(cfg.get("loudRef", 0.20)), thr + 1e-3)
        if game <= thr:
            target = 1.0
        else:
            frac = min((game - thr) / (loud - thr), 1.0)
            target = 1.0 - (1.0 - depth) * frac

        # Asymmetric smoothing: quick attack down, slow release up.
        tau_ms = float(cfg.get("attackMs", 120)) if target < current else float(cfg.get("releaseMs", 1200))
        alpha = 1.0 - math.exp(-(TICK * 1000.0) / max(tau_ms, 1.0))
        current += (target - current) * alpha
        current = max(depth, min(1.0, current))

        # Apply if it moved enough to matter.
        if player_node and (applied is None or abs(current - applied) > 0.01):
            set_volume(player_node, current)
            applied = current

        # Optional heartbeat for tuning/observation.
        if cfg.get("verbose"):
            if now - globals().get("_last_hb", 0) >= 0.5:
                globals()["_last_hb"] = now
                log(f"streams={len(procs)} game={game:.3f} target={target:.2f} gain={current:.2f} node={player_node}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
