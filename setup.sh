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

# 3. Setup Shell & Panel Themes (Dark and Light)
echo "[3/4] Linking GNOME Shell themes (Zeo-Dark & Zeo-Light)..."
mkdir -p "$HOME/.local/share/themes/Zeo-Dark/gnome-shell"
mkdir -p "$HOME/.local/share/themes/Zeo-Light/gnome-shell"
ln -sfn "$DIR/zeo-panel-theme/gnome-shell-dark.css" "$HOME/.local/share/themes/Zeo-Dark/gnome-shell/gnome-shell.css"
ln -sfn "$DIR/zeo-panel-theme/gnome-shell-light.css" "$HOME/.local/share/themes/Zeo-Light/gnome-shell/gnome-shell.css"

# Setup Nautilus / GTK 4 File Manager Theme & Shell Theme
mkdir -p "$HOME/.config/gtk-4.0"
printf '@import url("%s/zeo-file-manager-theme/gtk.css");\n' "$DIR" > "$HOME/.config/gtk-4.0/gtk.css"

if which gsettings >/dev/null 2>&1; then
    CURRENT_SCHEME=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || echo "'default'")
    if [ "$CURRENT_SCHEME" = "'prefer-light'" ] || [ "$CURRENT_SCHEME" = "'default'" ]; then
        gsettings set org.gnome.shell.extensions.user-theme name "Zeo-Light" 2>/dev/null || true
    else
        gsettings set org.gnome.shell.extensions.user-theme name "Zeo-Dark" 2>/dev/null || true
    fi
fi

# 4. Setup Theme Synchronizer Service & Autostart
echo "[4/5] Setting up real-time Theme Synchronizer daemon..."
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/zeo-theme-sync.service" << EOF
[Unit]
Description=Zeo Theme Synchronizer (Python & TypeScript)
After=gnome-session.target

[Service]
Type=simple
ExecStart=$DIR/zeo-theme-sync/sync.sh
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/zeo-theme-sync.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Zeo Theme Synchronizer
Exec=$DIR/zeo-theme-sync/sync.sh
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF

if which systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable --now zeo-theme-sync.service 2>/dev/null || true
fi

# 5. Enable the extensions
echo "[5/5] Enabling extensions..."
gnome-extensions enable zeo-widgets@mohitjoer
gnome-extensions enable zeo-notifications@mohitjoer
gnome-extensions enable zeo-blutooth-device@mohitjoer

echo "=== Setup Complete! ==="
echo "Note: If you are on Wayland and installing these for the very first time, you may need to log out and log back in."

