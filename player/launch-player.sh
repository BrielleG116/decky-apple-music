#!/bin/bash
# Launches the DeckyAM player daemon detached from the calling session so it
# survives SSH/Decky invocation ending. The --no-sandbox --no-zygote flags are
# essential on SteamOS (see main.js for the full explanation) — without them the
# Widevine CDM cannot decrypt and playback fails with "decrypt error 3".
PLAYER_DIR=/home/deck/homebrew/data/apple-music-plugin
CONFIG="$PLAYER_DIR/player-config.json"

pkill -9 -f 'player/deckyam-player' 2>/dev/null
sleep 1

export DISPLAY=:0
export XAUTHORITY=/home/deck/.Xauthority
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
export XDG_RUNTIME_DIR=/run/user/1000

cd /home/deck
setsid "$PLAYER_DIR/player/deckyam-player" \
  --config="$CONFIG" \
  --no-sandbox --no-zygote \
  </dev/null >"$PLAYER_DIR/player-stdout.log" 2>&1 &
disown
echo "launched deckyam-player pid $!"
