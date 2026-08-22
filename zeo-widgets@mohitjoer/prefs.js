import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ZeoWidgetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // ── 1. Top Bar Display Page ──────────────────────────────────
        const displayPage = new Adw.PreferencesPage({
            title: 'Top Bar',
            icon_name: 'view-paged-symbolic',
        });
        window.add(displayPage);

        // Visibility Group
        const visGroup = new Adw.PreferencesGroup({
            title: 'Visible Monitors',
            description: 'Choose which metrics are displayed in the GNOME top bar panel',
        });
        displayPage.add(visGroup);

        const items = [
            { key: 'show-cpu', title: 'CPU Monitor', subtitle: 'Show CPU utilization percentage' },
            { key: 'show-memory', title: 'Memory Monitor', subtitle: 'Show RAM usage percentage or used size' },
            { key: 'show-gpu', title: 'GPU Monitor', subtitle: 'Show detected GPU utilization (NVIDIA / AMD / Intel)' },
            { key: 'show-disk', title: 'Disk Monitor', subtitle: 'Show root disk storage usage percentage' },
            { key: 'show-network', title: 'Network Monitor', subtitle: 'Show real-time upload and download speeds' },
            { key: 'show-sensors', title: 'Temperature & Sensors', subtitle: 'Show package / hardware temperature' },
        ];

        for (const item of items) {
            const row = new Adw.SwitchRow({
                title: item.title,
                subtitle: item.subtitle,
            });
            settings.bind(item.key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            visGroup.add(row);
        }

        // Appearance Group
        const appGroup = new Adw.PreferencesGroup({
            title: 'Appearance & Formatting',
            description: 'Configure layout and styling in the top bar',
        });
        displayPage.add(appGroup);

        const compactRow = new Adw.SwitchRow({
            title: 'Compact Mode',
            subtitle: 'Use shorter labels to save top bar space',
        });
        settings.bind('compact-mode', compactRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appGroup.add(compactRow);

        const iconsRow = new Adw.SwitchRow({
            title: 'Show Icons',
            subtitle: 'Display symbolic icons next to metric values',
        });
        settings.bind('show-icons', iconsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appGroup.add(iconsRow);

        // ── 2. Desktop Widget Page ───────────────────────────────────
        const desktopPage = new Adw.PreferencesPage({
            title: 'Desktop',
            icon_name: 'user-desktop-symbolic',
        });
        window.add(desktopPage);

        const desktopGroup = new Adw.PreferencesGroup({
            title: 'Desktop Widget Card',
            description: 'Place a glassmorphism real-time system monitor card directly on the desktop',
        });
        desktopPage.add(desktopGroup);

        const desktopToggle = new Adw.SwitchRow({
            title: 'Enable Desktop Card',
            subtitle: 'Show real-time CPU, RAM, GPU, Disk, and Network card on your desktop',
        });
        settings.bind('show-desktop-widget', desktopToggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        desktopGroup.add(desktopToggle);

        const resetPosRow = new Adw.ActionRow({
            title: 'Reset Card Position',
            subtitle: 'Move desktop card back to the top-right default location (card is also freely draggable)',
            activatable: true,
        });
        const resetBtn = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
        });
        resetBtn.connect('clicked', () => {
            settings.set_int('desktop-widget-x', 0);
            settings.set_int('desktop-widget-y', 0);
        });
        resetPosRow.add_suffix(resetBtn);
        resetPosRow.connect('activated', () => {
            settings.set_int('desktop-widget-x', 0);
            settings.set_int('desktop-widget-y', 0);
        });
        desktopGroup.add(resetPosRow);

        // ── 3. General & Layout Page ─────────────────────────────────
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        // Panel Placement Group
        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel Position',
            description: 'Adjust where Zeo Monitor is placed in the GNOME panel',
        });
        generalPage.add(panelGroup);

        const posModel = new Gtk.StringList();
        posModel.append('Right');
        posModel.append('Center');
        posModel.append('Left');

        const posRow = new Adw.ComboRow({
            title: 'Panel Section',
            subtitle: 'Choose which section of the top bar to dock into',
            model: posModel,
        });

        const currentPos = settings.get_string('panel-position');
        if (currentPos === 'left') posRow.selected = 2;
        else if (currentPos === 'center') posRow.selected = 1;
        else posRow.selected = 0;

        posRow.connect('notify::selected', () => {
            if (posRow.selected === 2) settings.set_string('panel-position', 'left');
            else if (posRow.selected === 1) settings.set_string('panel-position', 'center');
            else settings.set_string('panel-position', 'right');
        });
        panelGroup.add(posRow);

        // Refresh Rate Group
        const perfGroup = new Adw.PreferencesGroup({
            title: 'Performance & Polling',
            description: 'Control how often metrics are sampled',
        });
        generalPage.add(perfGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Update Interval (seconds)',
            subtitle: 'Lower values update faster, higher values reduce CPU overhead',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 10, step_increment: 1 }),
        });
        settings.bind('update-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        perfGroup.add(intervalRow);

        // Hardware Units Group
        const unitGroup = new Adw.PreferencesGroup({
            title: 'Hardware Units',
            description: 'Units for temperature and disk',
        });
        generalPage.add(unitGroup);

        const tempModel = new Gtk.StringList();
        tempModel.append('Celsius (°C)');
        tempModel.append('Fahrenheit (°F)');

        const tempRow = new Adw.ComboRow({
            title: 'Temperature Unit',
            model: tempModel,
        });

        const curTempUnit = settings.get_string('temp-unit');
        tempRow.selected = curTempUnit === 'fahrenheit' ? 1 : 0;
        tempRow.connect('notify::selected', () => {
            settings.set_string('temp-unit', tempRow.selected === 1 ? 'fahrenheit' : 'celsius');
        });
        unitGroup.add(tempRow);

        // ── 3. About Page ────────────────────────────────────────────
        const aboutPage = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });
        window.add(aboutPage);

        const aboutGroup = new Adw.PreferencesGroup({
            title: 'Zeo Monitor',
            description: 'Astra-style high-performance top bar system monitor for GNOME',
        });
        aboutPage.add(aboutGroup);

        const githubRow = new Adw.ActionRow({
            title: 'GitHub Repository',
            subtitle: 'https://github.com/mohitjoer/zeo-widgets',
            activatable: true,
        });
        githubRow.connect('activated', () => {
            Gio.AppInfo.launch_default_for_uri_async('https://github.com/mohitjoer/zeo-widgets', null, null, null);
        });
        aboutGroup.add(githubRow);

        const authorRow = new Adw.ActionRow({
            title: 'Author',
            subtitle: 'Mohit Joe (mohitjoer)',
        });
        aboutGroup.add(authorRow);
    }
}
