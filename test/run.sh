#!/bin/sh
cd "$(dirname "$0")/.." && rm -rf /tmp/swamp-ud && SWAMP_MOCK=1 SWAMP_SHOT=/tmp/claude-0/-home-claude/638fd26b-e807-5631-be6d-a28076f0abf9/scratchpad/shot TZ=Europe/Stockholm xvfb-run -a -s "-screen 0 1600x1000x24" npx electron --no-sandbox --user-data-dir=/tmp/swamp-ud . 2>&1 | grep -v -E "dbus|Fontconfig|gpu|GLES|viz" | head -40
