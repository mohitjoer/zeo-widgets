import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function rgbaToHex(rgba) {
    let r = Math.round(rgba.red * 255).toString(16).padStart(2, '0');
    let g = Math.round(rgba.green * 255).toString(16).padStart(2, '0');
    let b = Math.round(rgba.blue * 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
}

export default class ZeoWidgetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        window.add(page);
        const settings = this.getSettings();

        // General Group
        const genGroup = new Adw.PreferencesGroup({ title: 'General' });
        page.add(genGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Update Interval (seconds)',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 60, step_increment: 1 })
        });
        settings.bind('update-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        genGroup.add(intervalRow);

        const xRow = new Adw.SpinRow({
            title: 'X Position',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 9999, step_increment: 10 })
        });
        settings.bind('pos-x', xRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        genGroup.add(xRow);

        const yRow = new Adw.SpinRow({
            title: 'Y Position',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 9999, step_increment: 10 })
        });
        settings.bind('pos-y', yRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        genGroup.add(yRow);

        // Colors Group
        const colorGroup = new Adw.PreferencesGroup({ title: 'Ring Colors' });
        page.add(colorGroup);

        const rings = ['cpu', 'mem', 'disk', 'intel', 'nvidia'];
        const labels = ['CPU', 'Memory', 'Disk', 'Intel GPU', 'NVIDIA GPU'];

        for (let i = 0; i < rings.length; i++) {
            const key = `${rings[i]}-color`;
            const row = new Adw.ActionRow({ title: labels[i] + ' Color' });
            
            let colorBtn;
            if (Gtk.ColorDialogButton) {
                const colorDialog = new Gtk.ColorDialog();
                colorBtn = new Gtk.ColorDialogButton({
                    dialog: colorDialog,
                    valign: Gtk.Align.CENTER
                });
                const rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string(key));
                colorBtn.rgba = rgba;
                colorBtn.connect('notify::rgba', () => {
                    settings.set_string(key, rgbaToHex(colorBtn.rgba));
                });
            } else {
                colorBtn = new Gtk.ColorButton();
                colorBtn.valign = Gtk.Align.CENTER;
                const rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string(key));
                colorBtn.set_rgba(rgba);
                colorBtn.connect('color-set', () => {
                    settings.set_string(key, rgbaToHex(colorBtn.get_rgba()));
                });
            }
            
            row.add_suffix(colorBtn);
            colorGroup.add(row);
        }
    }
}
