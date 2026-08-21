# Zeo File Manager Theme (Dark & Light)

A macOS Finder-inspired theme for Nautilus on GTK 4: compact toolbar controls, graphite sidebar, circular traffic light buttons (Red, Yellow, Green), and softly rounded file tiles with full support for both Dark and Light modes.

## Variants

- **Dynamic Theme** (`gtk.css`): Automatically adapts between Dark and Light mode depending on system preference.
- **Dark Mode** (`gtk-dark.css`): Deep obsidian and graphite palette with translucent surfaces.
- **Light Mode** (`gtk-light.css`): Frosted silver sidebar, clean white view surfaces, and crisp dark typography.

## Install

Import the theme from your user GTK 4 configuration (automatically configured when running `./setup.sh`):

```bash
mkdir -p ~/.config/gtk-4.0
printf '\n@import url("/home/mohit/code/zeo-widgets/zeo-file-manager-theme/gtk.css");\n' >> ~/.config/gtk-4.0/gtk.css
nautilus -q
```
