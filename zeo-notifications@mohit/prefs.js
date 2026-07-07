import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ZeoNotificationsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        window.add(page);
        const settings = this.getSettings();

        const genGroup = new Adw.PreferencesGroup({ title: 'Banner Settings' });
        page.add(genGroup);

        const widthRow = new Adw.SpinRow({
            title: 'Banner Width (px)',
            adjustment: new Gtk.Adjustment({ lower: 200, upper: 800, step_increment: 10 })
        });
        settings.bind('banner-width', widthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        genGroup.add(widthRow);

        const animRow = new Adw.SpinRow({
            title: 'Animation Duration (ms)',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 2000, step_increment: 50 })
        });
        settings.bind('anim-duration', animRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        genGroup.add(animRow);
    }
}
