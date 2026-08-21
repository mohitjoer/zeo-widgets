#!/bin/bash

# Get the absolute path of the directory containing this script
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"

echo "=== Zeo Extensions Setup ==="

# 1. Compile schemas
echo "[1/3] Compiling GSettings schemas..."
glib-compile-schemas "$DIR/zeo-widgets@mohitjoer/schemas/"
glib-compile-schemas "$DIR/zeo-notifications@mohitjoer/schemas/"
glib-compile-schemas "$DIR/zeo-blutooth-device@mohitjoer/schemas/"

# 2. Symlink to GNOME Shell extensions directory
echo "[2/3] Linking extensions to $EXT_DIR..."
mkdir -p "$EXT_DIR"

# Use symbolic links so changes in the repo are instantly reflected in GNOME
ln -sfn "$DIR/zeo-widgets@mohitjoer" "$EXT_DIR/zeo-widgets@mohitjoer"
ln -sfn "$DIR/zeo-notifications@mohitjoer" "$EXT_DIR/zeo-notifications@mohitjoer"
ln -sfn "$DIR/zeo-blutooth-device@mohitjoer" "$EXT_DIR/zeo-blutooth-device@mohitjoer"

# 3. Enable the extensions
echo "[3/3] Enabling extensions..."
gnome-extensions enable zeo-widgets@mohitjoer
gnome-extensions enable zeo-notifications@mohitjoer
gnome-extensions enable zeo-blutooth-device@mohitjoer

echo "=== Setup Complete! ==="
echo "Note: If you are on Wayland and installing these for the very first time, you may need to log out and log back in."
