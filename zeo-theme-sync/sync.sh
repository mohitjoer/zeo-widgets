#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check user preference or environment variable ZEO_SYNC_RUNTIME (python|ts|auto)
PREF="${ZEO_SYNC_RUNTIME:-auto}"

run_ts() {
    if which bun >/dev/null 2>&1; then
        exec bun "$DIR/sync.ts" "$@"
    elif [ -x "$HOME/.bun/bin/bun" ]; then
        exec "$HOME/.bun/bin/bun" "$DIR/sync.ts" "$@"
    elif which tsx >/dev/null 2>&1; then
        exec tsx "$DIR/sync.ts" "$@"
    elif which node >/dev/null 2>&1 && node --version | grep -E -q "v(2[4-9]|[3-9][0-9])"; then
        exec node "$DIR/sync.ts" "$@"
    elif [ -x "$HOME/.nvm/versions/node/v24.15.0/bin/node" ]; then
        exec "$HOME/.nvm/versions/node/v24.15.0/bin/node" "$DIR/sync.ts" "$@"
    fi
    return 1
}

run_py() {
    if which python3 >/dev/null 2>&1; then
        if python3 -c 'import gi; gi.require_version("Gio", "2.0"); from gi.repository import Gio' >/dev/null 2>&1; then
            exec python3 "$DIR/sync.py" "$@"
        fi
    fi
    return 1
}

if [ "$PREF" = "ts" ] || [ "$PREF" = "typescript" ]; then
    run_ts || run_py
elif [ "$PREF" = "py" ] || [ "$PREF" = "python" ]; then
    run_py || run_ts
else
    # Auto: try Python first, fallback to TypeScript runner
    run_py || run_ts
fi

# Fallback: if neither PyGObject nor TS runner is available, run built-in shell monitor loop
echo "[zeo-theme-sync] Running built-in shell fallback monitor..."
gsettings monitor org.gnome.desktop.interface color-scheme | while read -r line; do
    if echo "$line" | grep -q "prefer-dark"; then
        gsettings set org.gnome.shell.extensions.user-theme name "Zeo-Dark"
    else
        gsettings set org.gnome.shell.extensions.user-theme name "Zeo-Light"
    fi
done
