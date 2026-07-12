#!/usr/bin/env python3
"""DeckyAM auto-duck daemon.

Continuously measures game (and other non-music) audio loudness via
PulseAudio-compat per-application monitoring (`parec --monitor-stream`), and
rides the music player's PipeWire node volume down when the game gets loud,
back up to full when it's quiet — classic sidechain ducking.

Modes / options (all re-read live from the config each tick):
  * sensitivity (0..1)  -> how easily ducking triggers (maps to threshold).
  * mutedStreams []     -> per-stream keys to ignore (the UI lets the user pick
                           which of a game's audio streams should trigger duck).
  * speechOnly (bool)   -> only duck on speech-like audio: band-pass the stream
                           to the 300-3400 Hz speech band and weight it by its
                           syllabic amplitude modulation, so steady music /
                           rumble / explosions duck far less than dialogue.

Design notes:
  * We duck at the PipeWire *node* level of the player (via `wpctl set-volume`).
    The user's in-app volume (MusicKit) is the ceiling; this only scales the
    node between `depth` and 1.0, so it never fights the volume slider.
  * "Game audio" = every sink-input except our own player and the virtual
    surround output (which carries the mixed signal — monitoring it would feed
    back).
  * Detected streams are written to duck-streams.json so the UI can list them
    and let the user toggle each one.
"""
import os
import sys
import time
import json
import math
import select
import array
import subprocess

CONFIG_PATH = sys.argv[1] if len(sys.argv) > 1 else "/home/deck/homebrew/data/apple-music-plugin/duck-config.json"
STREAMS_PATH = os.path.join(os.path.dirname(CONFIG_PATH), "duck-streams.json")

# Streams we must never treat as "game" audio.
EXCLUDE_APP_NAMES = {"deckyam-player"}
EXCLUDE_MEDIA_NAMES = {"Virtual Surround Sound output"}
PLAYER_NODE_NAMES = {"deckyam-player"}

SAMPLE_RATE = 8000          # mono, low rate — telephony rate, fine for speech
TICK = 0.04                 # 25 Hz control loop
REFRESH_EVERY = 1.0         # re-scan sink-inputs / player node this often
FULL_SCALE = 32768.0
KEY_SEP = ""


def log(*a):
    print("[ducker]", *a, flush=True)


def read_config():
    cfg = {
        "enabled": True,
        "depth": 0.0,          # music node volume when fully ducked (0..1)
        "threshold": 0.05,     # game level (0..1) below which we don't duck
        "loudRef": 0.10,       # game level mapped to full duck
        "attackMs": 45,        # how fast we duck down
        "releaseMs": 2500,     # how slow we come back
        "speechOnly": False,   # only duck on speech-like audio
        "mutedStreams": [],    # stream keys to ignore
    }
    try:
        with open(CONFIG_PATH) as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    return cfg


def stream_key(app, media):
    return (app or "?") + KEY_SEP + (media or "?")


def stream_name(app, media):
    a = app or "Unknown app"
    m = media or ""
    return f"{a} — {m}" if (m and m != a) else a


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
    """Return [(index, app, media)] for non-player game streams."""
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
            result.append((idx, app, media))

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


def write_streams(detected):
    """Publish detected streams (deduped) for the UI to list + toggle."""
    try:
        seen = {}
        for (_i, a, m) in detected:
            k = stream_key(a, m)
            seen[k] = {"key": k, "name": stream_name(a, m)}
        tmp = STREAMS_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"ts": time.time(), "streams": list(seen.values())}, f)
        os.replace(tmp, STREAMS_PATH)
    except Exception as e:
        log("write_streams error:", e)


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


def set_volume(node_id, vol):
    try:
        subprocess.run(["wpctl", "set-volume", str(node_id), f"{vol:.3f}"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
    except Exception:
        pass


def _biquad_coeffs(kind, fc, fs, q=0.707):
    """RBJ cookbook biquad coefficients, normalized (a0 = 1)."""
    w0 = 2.0 * math.pi * fc / fs
    c = math.cos(w0)
    s = math.sin(w0)
    alpha = s / (2.0 * q)
    a0 = 1.0 + alpha
    if kind == "hp":
        b0 = (1.0 + c) / 2.0; b1 = -(1.0 + c); b2 = (1.0 + c) / 2.0
    else:  # lp
        b0 = (1.0 - c) / 2.0; b1 = (1.0 - c); b2 = (1.0 - c) / 2.0
    a1 = -2.0 * c
    a2 = 1.0 - alpha
    return (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)


class SpeechAnalyzer:
    """Per-stream 300-3400 Hz band-pass (HP->LP cascade) + syllabic-modulation
    tracking, to score how speech-like a stream's audio is (0..1)."""

    def __init__(self, fs=SAMPLE_RATE):
        self.hp = _biquad_coeffs("hp", 300.0, fs)
        self.lp = _biquad_coeffs("lp", 3400.0, fs)
        self.hz1 = self.hz2 = 0.0
        self.lz1 = self.lz2 = 0.0
        self.env = []          # recent band-RMS values (~1s history)
        self.env_cap = 25

    def band_rms(self, samples):
        hb0, hb1, hb2, ha1, ha2 = self.hp
        lb0, lb1, lb2, la1, la2 = self.lp
        hz1, hz2, lz1, lz2 = self.hz1, self.hz2, self.lz1, self.lz2
        ss = 0.0
        n = 0
        for x in samples:
            yh = hb0 * x + hz1
            hz1 = hb1 * x - ha1 * yh + hz2
            hz2 = hb2 * x - ha2 * yh
            yl = lb0 * yh + lz1
            lz1 = lb1 * yh - la1 * yl + lz2
            lz2 = lb2 * yh - la2 * yl
            ss += yl * yl
            n += 1
        self.hz1, self.hz2, self.lz1, self.lz2 = hz1, hz2, lz1, lz2
        return (math.sqrt(ss / n) / FULL_SCALE) if n else 0.0

    def score(self, samples, full_rms):
        """Return (speech_level, band_rms) for this block.
        speech_level ~ how much *dialogue-like* energy is present."""
        band = self.band_rms(samples)
        self.env.append(band)
        if len(self.env) > self.env_cap:
            self.env.pop(0)
        # Ratio: fraction of energy sitting in the speech band (excludes
        # sub-bass rumble / explosions / bass-heavy music).
        ratio = band / (full_rms + 1e-6)
        ratio_gate = max(0.0, min(1.0, (ratio - 0.35) / 0.45))
        # Modulation: syllabic speech makes the band envelope fluctuate; steady
        # tones / sustained music don't. Use coefficient of variation.
        mod_gate = 0.0
        if len(self.env) >= 6:
            mean = sum(self.env) / len(self.env)
            if mean > 1e-5:
                var = sum((e - mean) ** 2 for e in self.env) / len(self.env)
                cv = math.sqrt(var) / mean
                mod_gate = max(0.0, min(1.0, (cv - 0.18) / 0.42))
        speechiness = ratio_gate * mod_gate
        return band * speechiness, band


def main():
    log("starting; config:", CONFIG_PATH)
    procs = {}              # index -> Popen
    levels = {}             # index -> latest level fed to the ducker
    analyzers = {}          # index -> SpeechAnalyzer
    keys = {}               # index -> stream key
    current = 1.0
    applied = None
    player_node = None
    last_refresh = 0.0

    while True:
        cfg = read_config()
        now = time.time()

        if not cfg.get("enabled", True):
            for p in procs.values():
                try: p.terminate()
                except Exception: pass
            procs.clear(); levels.clear(); analyzers.clear(); keys.clear()
            if player_node and applied != 1.0:
                set_volume(player_node, 1.0); applied = 1.0
            current = 1.0
            time.sleep(0.5)
            continue

        speech_only = bool(cfg.get("speechOnly", False))
        muted = set(cfg.get("mutedStreams", []) or [])

        # Periodically re-scan the player node and game sink-inputs.
        if now - last_refresh >= REFRESH_EVERY:
            last_refresh = now
            player_node = find_player_node() or player_node
            detected = find_game_sink_inputs()
            write_streams(detected)  # publish ALL detected streams for the UI
            # Only capture streams the user hasn't muted.
            wanted = {i: (a, m) for (i, a, m) in detected
                      if stream_key(a, m) not in muted}
            for i in list(procs):
                if i not in wanted or procs[i].poll() is not None:
                    try: procs[i].terminate()
                    except Exception: pass
                    procs.pop(i, None); levels.pop(i, None)
                    analyzers.pop(i, None); keys.pop(i, None)
            for i, (a, m) in wanted.items():
                if i not in procs:
                    p = start_parec(i)
                    if p:
                        procs[i] = p; levels[i] = 0.0
                        analyzers[i] = SpeechAnalyzer(); keys[i] = stream_key(a, m)

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
                    a = array.array("h")
                    a.frombytes(chunk[: (len(chunk) // 2) * 2])
                    n = len(a)
                    if n:
                        full = math.sqrt(sum(x * x for x in a) / n) / FULL_SCALE
                        if speech_only:
                            lvl, _band = analyzers[i].score(a, full)
                        else:
                            lvl = full
                        levels[i] = lvl
                    else:
                        levels[i] *= 0.5
                else:
                    levels[i] *= 0.5
        else:
            time.sleep(TICK)

        # Instantaneous game loudness = loudest active (unmuted) stream.
        game = max(levels.values()) if levels else 0.0

        # Map loudness -> target gain (1.0 = full music, depth = fully ducked).
        depth = float(cfg.get("depth", 0.0))
        thr = float(cfg.get("threshold", 0.05))
        loud = max(float(cfg.get("loudRef", 0.10)), thr + 1e-3)
        if game <= thr:
            target = 1.0
        else:
            frac = min((game - thr) / (loud - thr), 1.0)
            target = 1.0 - (1.0 - depth) * frac

        # Asymmetric smoothing: quick attack down, slow release up.
        tau_ms = float(cfg.get("attackMs", 45)) if target < current else float(cfg.get("releaseMs", 2500))
        alpha = 1.0 - math.exp(-(TICK * 1000.0) / max(tau_ms, 1.0))
        current += (target - current) * alpha
        current = max(depth, min(1.0, current))

        if player_node and (applied is None or abs(current - applied) > 0.01):
            set_volume(player_node, current)
            applied = current

        if cfg.get("verbose"):
            if now - globals().get("_last_hb", 0) >= 0.5:
                globals()["_last_hb"] = now
                log(f"streams={len(procs)} speech={speech_only} game={game:.3f} "
                    f"target={target:.2f} gain={current:.2f}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
