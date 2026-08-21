import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { State, Urgency } from 'resource:///org/gnome/shell/ui/messageTray.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

export default class ZeoNotificationsExtension extends Extension {
    enable() {
        if (!Main.messageTray) return;
        
        this._settings = this.getSettings();
        this._desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        const ext = this;

        const updateAlignment = () => {
            const pos = ext._settings.get_int('position');
            let hAlign = Clutter.ActorAlign.END;
            let vAlign = Clutter.ActorAlign.START;
            if (pos === 0) { hAlign = Clutter.ActorAlign.END; vAlign = Clutter.ActorAlign.START; }
            else if (pos === 1) { hAlign = Clutter.ActorAlign.START; vAlign = Clutter.ActorAlign.START; }
            else if (pos === 2) { hAlign = Clutter.ActorAlign.END; vAlign = Clutter.ActorAlign.END; }
            else if (pos === 3) { hAlign = Clutter.ActorAlign.START; vAlign = Clutter.ActorAlign.END; }
            else if (pos === 4) { hAlign = Clutter.ActorAlign.CENTER; vAlign = Clutter.ActorAlign.START; }
            
            Main.messageTray.bannerAlignment = hAlign;
            if (Main.messageTray._bannerBin) {
                Main.messageTray._bannerBin.set_y_align(vAlign);
            }
        };

        this._origBannerAlignment = Main.messageTray.bannerAlignment;
        if (Main.messageTray._bannerBin) {
            this._origYAlign = Main.messageTray._bannerBin.y_align;
        }

        updateAlignment();
        this._settingsChangedId = this._settings.connect('changed::position', updateAlignment);

        // 2. Custom Slide-in / Fade-in Animation via _updateShowingNotification
        this._origUpdateShowingNotification = Main.messageTray._updateShowingNotification;
        Main.messageTray._updateShowingNotification = function() {
            this._notification.acknowledged = true;
            this._notification.playSound();

            if (this._notification.urgency === Urgency.CRITICAL ||
                this._notification.source.policy.forceExpanded)
                this._expandBanner(true);

            this._notificationState = State.SHOWING;
            this._bannerBin.remove_all_transitions();
            
            // Set initial state for our slide-in (down to up)
            this._bannerBin.y = 0;
            this._bannerBin.translation_x = 0;
            this._bannerBin.translation_y = 50;
            this._bannerBin.opacity = 0;
            
            // Apply styling
            const bgOpacity = ext._settings.get_double('bg-opacity');
            const bWidth = ext._settings.get_int('banner-width');
            const bHeight = ext._settings.get_int('banner-height');
            
            this._bannerBin.style = ''; // Clear bin style to prevent black corners
            if (this._banner) {
                const scheme = ext._desktopSettings?.get_string('color-scheme') || '';
                const isLight = (scheme === 'prefer-light' || scheme === 'default');
                if (isLight) {
                    this._banner.add_style_class_name('light-theme');
                    this._banner.remove_style_class_name('dark-theme');
                } else {
                    this._banner.add_style_class_name('dark-theme');
                    this._banner.remove_style_class_name('light-theme');
                }
                const bgRgba = isLight ? `rgba(250, 250, 252, ${bgOpacity})` : `rgba(32, 32, 36, ${bgOpacity})`;
                const borderRgba = isLight ? `rgba(0, 0, 0, 0.1)` : `rgba(255, 255, 255, 0.12)`;
                let s = `background-color: ${bgRgba} !important; border: 1px solid ${borderRgba} !important; `;
                s += `width: ${bWidth}px !important; min-width: ${bWidth}px !important; max-width: ${bWidth}px !important; `;
                if (bHeight > 0) s += `min-height: ${bHeight}px !important; `;
                this._banner.style = s;
            }

            this._bannerBin.ease({
                translation_y: 0,
                opacity: 255,
                duration: ext._settings.get_int('anim-duration'),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._notificationState = State.SHOWN;
                    this._showNotificationCompleted();
                    this._updateState();
                }
            });
        };

        // 3. Custom Slide-out / Fade-out Animation via _hideNotification
        this._origHideNotification = Main.messageTray._hideNotification;
        Main.messageTray._hideNotification = function(animate) {
            this._notificationFocusGrabber.ungrabFocus();
            if (this._banner)
                this._banner.disconnectObject(this);

            this._resetNotificationLeftTimeout();
            this._bannerBin.remove_all_transitions();

            const duration = animate ? ext._settings.get_int('anim-duration') : 0;
            this._notificationState = State.HIDING;
            
            const pos = ext._settings.get_int('position');
            const hideY = (pos === 2 || pos === 3) ? 50 : -50;

            this._bannerBin.ease({
                translation_y: hideY,
                opacity: 0,
                duration,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => {
                    this._notificationState = State.HIDDEN;
                    this._hideNotificationCompleted();
                    this._updateState();
                }
            });
        };
    }

    disable() {
        if (Main.messageTray) {
            if (this._origBannerAlignment !== undefined) {
                Main.messageTray.bannerAlignment = this._origBannerAlignment;
                this._origBannerAlignment = undefined;
            }
            if (Main.messageTray._bannerBin && this._origYAlign !== undefined) {
                Main.messageTray._bannerBin.set_y_align(this._origYAlign);
                this._origYAlign = undefined;
            }
            if (this._origUpdateShowingNotification) {
                Main.messageTray._updateShowingNotification = this._origUpdateShowingNotification;
                this._origUpdateShowingNotification = undefined;
            }
            if (this._origHideNotification) {
                Main.messageTray._hideNotification = this._origHideNotification;
                this._origHideNotification = undefined;
            }
        }
        
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._settings = null;
        this._desktopSettings = null;
    }
}
