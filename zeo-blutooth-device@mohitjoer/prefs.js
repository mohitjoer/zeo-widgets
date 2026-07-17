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

export default class ZeoBluetoothDevicePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        window.add(page);
        const settings = this.getSettings();

        // General Group
        const genGroup = new Adw.PreferencesGroup({ title: 'General' });
        page.add(genGroup);

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


    }
}
