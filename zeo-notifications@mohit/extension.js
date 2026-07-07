import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { State, Urgency } from 'resource:///org/gnome/shell/ui/messageTray.js';
import Clutter from 'gi://Clutter';

export default class ZeoNotificationsExtension extends Extension {
    enable() {
        if (!Main.messageTray) return;

        // 1. Move banner to the Top-Right
        this._origBannerAlignment = Main.messageTray.bannerAlignment;
        Main.messageTray.bannerAlignment = Clutter.ActorAlign.END; // Right align
        
        if (Main.messageTray._bannerBin) {
            this._origYAlign = Main.messageTray._bannerBin.y_align;
            Main.messageTray._bannerBin.set_y_align(Clutter.ActorAlign.START); // Top
        }

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

            this._bannerBin.ease({
                translation_y: 0,
                opacity: 255,
                duration: 350,
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

            const duration = animate ? 300 : 0;
            this._notificationState = State.HIDING;

            this._bannerBin.ease({
                translation_y: -50,
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
        if (!Main.messageTray) return;

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
}
