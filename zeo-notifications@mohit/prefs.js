import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
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

        const heightRow = new Adw.SpinRow({
            title: 'Banner Min Height (px)',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 500, step_increment: 10 })
        });
        settings.bind('banner-height', heightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        genGroup.add(heightRow);

        const posModel = Gtk.StringList.new([
            'Top Right',
            'Top Left',
            'Bottom Right',
            'Bottom Left',
            'Top Center'
        ]);
        const posRow = new Adw.ComboRow({
            title: 'Position',
            model: posModel
        });
        settings.bind('position', posRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        genGroup.add(posRow);

        const animRow = new Adw.SpinRow({
            title: 'Animation Duration (ms)',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 2000, step_increment: 50 })
        });
        settings.bind('anim-duration', animRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        genGroup.add(animRow);

        const opacityRow = new Adw.SpinRow({
            title: 'Background Opacity',
            adjustment: new Gtk.Adjustment({ lower: 0.0, upper: 1.0, step_increment: 0.05 }),
            digits: 2
        });
        settings.bind('bg-opacity', opacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        genGroup.add(opacityRow);

        const testGroup = new Adw.PreferencesGroup({ title: 'Testing' });
        page.add(testGroup);

        const testRow = new Adw.ActionRow({
            title: 'Test Notification',
            subtitle: 'Send a dummy notification to preview your settings'
        });
        
        const testBtn = new Gtk.Button({
            label: 'Test',
            valign: Gtk.Align.CENTER,
            has_frame: true
        });
        
        testBtn.connect('clicked', () => {
            GLib.spawn_command_line_async("notify-send 'Test Notification' 'This is how your notifications look!'");
        });
        
        testRow.add_suffix(testBtn);
        testRow.activatable_widget = testBtn;
        testGroup.add(testRow);
    }
}
