#!/usr/bin/env python3
"""
Zeo Theme Synchronizer (Python Implementation)
Monitors org.gnome.desktop.interface color-scheme via Gio.Settings
and automatically synchronizes org.gnome.shell.extensions.user-theme name.
"""

import sys
import signal
import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib


def sync_theme(desktop_settings, user_theme_settings):
    try:
        scheme = desktop_settings.get_string("color-scheme")
        target_theme = "Zeo-Dark" if scheme == "prefer-dark" else "Zeo-Light"
        current_theme = user_theme_settings.get_string("name")

        if current_theme != target_theme:
            user_theme_settings.set_string("name", target_theme)
            print(f"[zeo-theme-sync:py] Switched user-theme to {target_theme} (color-scheme: {scheme})", flush=True)
    except Exception as e:
        print(f"[zeo-theme-sync:py] Error during sync: {e}", file=sys.stderr, flush=True)


def on_color_scheme_changed(settings, key, user_theme_settings):
    sync_theme(settings, user_theme_settings)


def main():
    try:
        desktop_settings = Gio.Settings(schema_id="org.gnome.desktop.interface")
        user_theme_settings = Gio.Settings(schema_id="org.gnome.shell.extensions.user-theme")
    except Exception as e:
        print(f"[zeo-theme-sync:py] Required GSettings schema not found: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

    # Initial sync on startup
    sync_theme(desktop_settings, user_theme_settings)

    # Connect change listener
    desktop_settings.connect("changed::color-scheme", on_color_scheme_changed, user_theme_settings)

    loop = GLib.MainLoop()

    # Handle graceful exit
    def handle_sig(sig, frame):
        loop.quit()

    signal.signal(signal.SIGINT, handle_sig)
    signal.signal(signal.SIGTERM, handle_sig)

    print("[zeo-theme-sync:py] Active and monitoring desktop color-scheme.", flush=True)
    loop.run()


if __name__ == "__main__":
    main()
