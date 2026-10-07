# Zeo Theme Synchronizer

Automatic, real-time background synchronizer between GNOME's desktop color scheme (`org.gnome.desktop.interface color-scheme`) and the active GNOME Shell user theme (`org.gnome.shell.extensions.user-theme name`).

Whenever you toggle **Dark Style** in GNOME Quick Settings or Settings → Appearance:
- In dark mode (`prefer-dark`): switches shell theme to `Zeo-Dark`
- In light mode (`default` / `prefer-light`): switches shell theme to `Zeo-Light`

## Architecture & Dual Runtimes

This package contains full implementations in both **TypeScript** and **Python**:

- `sync.ts` — TypeScript implementation using child process monitoring. Runs natively on Bun, Node 24+, or tsx.
- `sync.py` — Python implementation using GLib / PyGObject `Gio.Settings` event listeners.
- `sync.sh` — Universal runner that automatically selects the available runtime (Python, Bun/Node TS, or shell fallback).

## Usage

### Run automatically via setup:
```bash
./setup.sh
```

### Manual execution:
```bash
# Auto-detect best runtime:
./zeo-theme-sync/sync.sh

# Force TypeScript runtime:
ZEO_SYNC_RUNTIME=ts ./zeo-theme-sync/sync.sh
# or directly:
bun ./zeo-theme-sync/sync.ts

# Force Python runtime:
ZEO_SYNC_RUNTIME=py ./zeo-theme-sync/sync.sh
# or directly:
python3 ./zeo-theme-sync/sync.py
```
