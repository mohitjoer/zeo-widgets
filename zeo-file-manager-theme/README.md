# Zeo File Manager Theme

A macOS-inspired dark theme for Nautilus on GTK 4: compact toolbar controls, a graphite sidebar, blue Finder-like selection states, and softly rounded file tiles.

## Install

Import the theme from your user GTK 4 configuration, then restart Nautilus:

```bash
mkdir -p ~/.config/gtk-4.0
printf '\n@import url("/home/mohit/code/zeo-widgets/zeo-file-manager-theme/gtk.css");\n' >> ~/.config/gtk-4.0/gtk.css
nautilus -q
```

The theme only changes GTK 4 applications that load your user `gtk.css`; it does not install or enable a GNOME Shell extension. Adjust the absolute path if you move this repository.
