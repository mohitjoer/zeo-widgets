import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

/* ── Ring chart constants ────────────────────────────────────── */
const RING_SIZE   = 80;    // canvas px
const RING_RADIUS = 28;    // centre-of-stroke radius
const RING_STROKE = 6;     // stroke width

function hexToRGB(str) {
    let rgbMatch = str.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
        return [
            parseInt(rgbMatch[1], 10) / 255.0,
            parseInt(rgbMatch[2], 10) / 255.0,
            parseInt(rgbMatch[3], 10) / 255.0,
        ];
    }
    if (str.startsWith('#')) {
        let r = parseInt(str.slice(1, 3), 16) / 255.0;
        let g = parseInt(str.slice(3, 5), 16) / 255.0;
        let b = parseInt(str.slice(5, 7), 16) / 255.0;
        return [r || 0, g || 0, b || 0];
    }
    return [1, 1, 1];
}
function getColorPal(hex) {
    let c = hexToRGB(hex);
    return { from: c, to: [Math.max(0, c[0]-0.2), Math.max(0, c[1]-0.2), Math.max(0, c[2]-0.2)] };
}

/* ── Cairo ring painter ──────────────────────────────────────── */
function _paintRing(cr, width, height, pct, pal, isLight = false) {
    const size = Math.min(width, height);
    const cx = width / 2;
    const cy = height / 2;
    const frac = Math.min(Math.max(pct, 0), 100) / 100;

    cr.setOperator(Cairo.Operator.CLEAR);
    cr.paint();
    cr.setOperator(Cairo.Operator.OVER);

    cr.setLineWidth(RING_STROKE);
    cr.setLineCap(Cairo.LineCap.ROUND);
    if (isLight) {
        cr.setSourceRGBA(0, 0, 0, 0.08);
    } else {
        cr.setSourceRGBA(1, 1, 1, 0.07);
    }
    cr.arc(cx, cy, RING_RADIUS, 0, 2 * Math.PI);
    cr.stroke();

    if (frac <= 0) return;

    const startAngle = -Math.PI / 2;
    const endAngle   = startAngle + frac * 2 * Math.PI;

    const grad = new Cairo.LinearGradient(
        cx - RING_RADIUS, cy - RING_RADIUS,
        cx + RING_RADIUS, cy + RING_RADIUS);
    grad.addColorStopRGBA(0, pal.from[0], pal.from[1], pal.from[2], 1);
    grad.addColorStopRGBA(1, pal.to[0],   pal.to[1],   pal.to[2],   1);

    cr.setSource(grad);
    cr.setLineWidth(RING_STROKE);
    cr.setLineCap(Cairo.LineCap.ROUND);

    if (frac >= 0.99)
        cr.arc(cx, cy, RING_RADIUS, 0, 2 * Math.PI);
    else
        cr.arc(cx, cy, RING_RADIUS, startAngle, endAngle);
    cr.stroke();

    cr.setSourceRGBA(pal.from[0], pal.from[1], pal.from[2], 0.10);
    cr.setLineWidth(RING_STROKE + 12);
    cr.setLineCap(Cairo.LineCap.ROUND);

    if (frac >= 0.99)
        cr.arc(cx, cy, RING_RADIUS, 0, 2 * Math.PI);
    else
        cr.arc(cx, cy, RING_RADIUS, startAngle, endAngle);
    cr.stroke();
}

/* ── Non-draggable base widget ─────────────────────────────────── */
class BaseWidget extends St.BoxLayout {
    static { GObject.registerClass(this); }
    constructor(params) {
        super({ reactive: false, ...params });
    }
}

/* ── Single ring cell ────────────────────────────────────────── */
class RingCell {
    constructor(label, palette, iconName) {
        this._pct = 0;
        this._pal = palette;
        this._isLight = false;
        this._drawingArea = new St.DrawingArea({ width: RING_SIZE, height: RING_SIZE });
        this._signalTracker = {};
        this._drawingArea.connectObject('repaint', (area) => {
            let cr = area.get_context();
            let [w, h] = area.get_surface_size();
            _paintRing(cr, w, h, this._pct, this._pal, this._isLight);
            cr.$dispose();
        }, this._signalTracker);

        let actualIcon = iconName || 'bluetooth-active';
        if (!actualIcon.endsWith('-symbolic')) actualIcon += '-symbolic';

        this._icon = new St.Icon({
            icon_name: actualIcon,
            icon_size: 24,
            style_class: 'zeo-ring-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width:  RING_SIZE,
            height: RING_SIZE,
        });
        stack.add_child(this._drawingArea);
        stack.add_child(this._icon);

        this._nameLabel = new St.Label({
            text: label,
            style_class: 'zeo-ring-name',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._detailLabel = new St.Label({
            text: '—',
            style_class: 'zeo-ring-detail',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this.actor = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'zeo-ring-cell',
        });
        this.actor.add_child(stack);
        this.actor.add_child(this._nameLabel);
        this.actor.add_child(this._detailLabel);
    }

    setTheme(isLight) {
        this._isLight = isLight;
        if (this._drawingArea) {
            this._drawingArea.queue_repaint();
        }
    }

    update(pct, detail, pal) {
        this._pct = pct;
        if (pal) this._pal = pal;
        this._detailLabel.set_text(detail);
        this._drawingArea.queue_repaint();
    }

    destroy() {
        if (this._drawingArea) {
            if (this._signalTracker) {
                this._drawingArea.disconnectObject(this._signalTracker);
                this._signalTracker = null;
            }
            this._drawingArea.destroy();
            this._drawingArea = null;
        }
        
        if (this._icon) {
            this._icon.destroy();
            this._icon = null;
        }
        
        if (this._nameLabel) {
            this._nameLabel.destroy();
            this._nameLabel = null;
        }
        
        if (this._detailLabel) {
            this._detailLabel.destroy();
            this._detailLabel = null;
        }
        
        if (this.actor) {
            this.actor.destroy();
            this.actor = null;
        }
    }
}

/* ── UPower DBus ─────────────────────────────────────────────── */
const UPowerIface = `<node>
  <interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices">
      <arg direction="out" type="ao" name="devices"/>
    </method>
  </interface>
</node>`;
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerIface);

const DeviceIface = `<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Type" type="u" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="Model" type="s" access="read"/>
    <property name="NativePath" type="s" access="read"/>
  </interface>
</node>`;
const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(DeviceIface);

const BluezDeviceIface = `<node>
  <interface name="org.bluez.Device1">
    <property name="Icon" type="s" access="read"/>
  </interface>
</node>`;
const BluezDeviceProxy = Gio.DBusProxy.makeProxyWrapper(BluezDeviceIface);

/* ── Bluetooth Monitor Widget ────────────────────────────────── */
class BluetoothWidget extends BaseWidget {
    static { GObject.registerClass(this); }
    constructor(settings) {
        super({
            vertical: true,
            style_class: 'zeo-sysmon-card',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._settings = settings;

        this._row = new St.BoxLayout({
            style_class: 'zeo-ring-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._row);

        this._noDeviceLabel = new St.Label({
            text: 'No Bluetooth Devices',
            style_class: 'zeo-no-device-text',
            visible: true
        });
        this.add_child(this._noDeviceLabel);

        this._ringCells = {};
        this._upower = new UPowerProxy(Gio.DBus.system, 'org.freedesktop.UPower', '/org/freedesktop/UPower');

        this._updateLoopId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
        
        this.set_position(this._settings.get_int('pos-x'), this._settings.get_int('pos-y'));
        
        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'pos-x' || key === 'pos-y') {
                this.set_position(this._settings.get_int('pos-x'), this._settings.get_int('pos-y'));
            }
        });

        this._update();
    }

    _update() {
        if (!this._upower) return;
        this._upower.EnumerateDevicesRemote((result, error) => {
            if (error || !this._upower) return;
            const devices = result[0];
            const currentDevices = {};

            for (let i = 0; i < devices.length; i++) {
                const path = devices[i];
                const dev = new DeviceProxy(Gio.DBus.system, 'org.freedesktop.UPower', path);
                // Check if bluetooth
                if (dev.NativePath && dev.NativePath.includes('/org/bluez/')) {
                    let iconName = 'bluetooth-active';
                    try {
                        const bluezDev = new BluezDeviceProxy(Gio.DBus.system, 'org.bluez', dev.NativePath);
                        if (bluezDev.Icon) {
                            iconName = bluezDev.Icon;
                        }
                    } catch(e) {}
                    
                    const m = (dev.Model || '').toLowerCase();
                    if (iconName === 'bluetooth-active' || iconName === 'audio-card') {
                        if (m.includes('bud') || m.includes('airpod') || m.includes('ear') || m.includes('head')) {
                            iconName = 'audio-headphones';
                        } else if (m.includes('phone') || m.includes('iphone')) {
                            iconName = 'phone';
                        }
                    }

                    currentDevices[path] = {
                        model: dev.Model || 'Unknown',
                        percentage: dev.Percentage,
                        state: dev.State, // 1 = charging, 2 = discharging, etc.
                        iconName: iconName
                    };
                }
            }

            let hasDevices = false;

            // Add or update cells
            const entries = Object.entries(currentDevices);
            for (let i = 0; i < entries.length; i++) {
                const [path, info] = entries[i];
                hasDevices = true;
                
                let hexColor = '#e74c3c'; // red
                if (info.percentage > 80) {
                    hexColor = '#2ecc71'; // green
                } else if (info.percentage > 30) {
                    hexColor = '#3498db'; // blue
                }
                const pal = getColorPal(hexColor);

                if (!this._ringCells[path]) {
                    const shortName = info.model.length > 12 ? info.model.substring(0, 10) + '…' : info.model;
                    const cell = new RingCell(shortName, pal, info.iconName);
                    this._ringCells[path] = cell;
                    this._row.add_child(cell.actor);
                }
                
                let stateStr = 'Battery';
                if (info.state === 1) stateStr = 'Charging';
                else if (info.state === 4) stateStr = 'Fully Charged';
                
                this._ringCells[path].update(info.percentage, stateStr, pal);
            }

            // Remove old cells
            const keys = Object.keys(this._ringCells);
            for (let i = 0; i < keys.length; i++) {
                const path = keys[i];
                if (!currentDevices[path]) {
                    this._ringCells[path].destroy();
                    delete this._ringCells[path];
                }
            }

            this._noDeviceLabel.visible = false;
            this._row.visible = hasDevices;
            this.visible = hasDevices;
        });
    }

    setTheme(isLight) {
        this._isLight = isLight;
        if (isLight) {
            this.add_style_class_name('light-theme');
        } else {
            this.remove_style_class_name('light-theme');
        }
        const cells = Object.values(this._ringCells);
        for (let cell of cells) {
            if (cell) cell.setTheme(isLight);
        }
    }

    destroy() {
        if (this._updateLoopId) {
            GLib.Source.remove(this._updateLoopId);
            this._updateLoopId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        const cells = Object.values(this._ringCells);
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            if (cell) cell.destroy();
        }
        this._ringCells = {};
        this._upower = null;
        
        if (this._noDeviceLabel) {
            this._noDeviceLabel.destroy();
            this._noDeviceLabel = null;
        }
        
        if (this._row) {
            this._row.destroy();
            this._row = null;
        }
        
        this.disconnectObject(this);
        super.destroy();
    }
}

/* ── Extension Lifecycle ─────────────────────────────────────── */
export default class ZeoBluetoothDeviceExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._widget = new BluetoothWidget(this._settings);
        Main.layoutManager._backgroundGroup.add_child(this._widget);

        this._desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        const updateThemeMode = () => {
            const scheme = this._desktopSettings.get_string('color-scheme');
            const isLight = (scheme === 'prefer-light' || scheme === 'default');
            this._widget?.setTheme(isLight);
        };
        updateThemeMode();
        this._desktopSettingsId = this._desktopSettings.connect('changed::color-scheme', updateThemeMode);
    }

    disable() {
        if (this._desktopSettings && this._desktopSettingsId) {
            this._desktopSettings.disconnect(this._desktopSettingsId);
            this._desktopSettingsId = null;
        }
        this._desktopSettings = null;

        if (this._widget) {
            Main.layoutManager._backgroundGroup.remove_child(this._widget);
            this._widget.destroy();
            this._widget = null;
        }
        this._settings = null;
    }
}
