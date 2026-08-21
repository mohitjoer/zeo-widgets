# Zeo Panel & Shell Themes (Dark & Light)

macOS-inspired clean themes for GNOME Shell (45+ / 46+ / 50+) featuring a clean monochrome top bar, minimalist workspace pill & dots, polished typography, and Control Center styling for menus and quick toggles.

## Variants

- **Zeo-Dark** (`gnome-shell-dark.css`): Deep obsidian translucent panel (`rgba(12, 12, 14, 0.88)`), white active workspace capsule, pure white slider tracks, and dark glass popovers.
- **Zeo-Light** (`gnome-shell-light.css`): Frosted silver translucent panel (`rgba(246, 246, 248, 0.88)`), jet-black active workspace capsule, dark slider tracks, and light glass popovers.

## Installation

Install using `./setup.sh` from the repository root, or manually link:

```bash
# Zeo-Dark
mkdir -p ~/.local/share/themes/Zeo-Dark/gnome-shell
ln -sfn /home/mohit/code/zeo-widgets/zeo-panel-theme/gnome-shell-dark.css ~/.local/share/themes/Zeo-Dark/gnome-shell/gnome-shell.css

# Zeo-Light
mkdir -p ~/.local/share/themes/Zeo-Light/gnome-shell
ln -sfn /home/mohit/code/zeo-widgets/zeo-panel-theme/gnome-shell-light.css ~/.local/share/themes/Zeo-Light/gnome-shell/gnome-shell.css

# Activate via gsettings (or GNOME Tweaks)
gsettings set org.gnome.shell.extensions.user-theme name 'Zeo-Dark'
# or
gsettings set org.gnome.shell.extensions.user-theme name 'Zeo-Light'
```
