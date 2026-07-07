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
const UPDATE_SECS = 3;     // refresh interval

/* Zeo-inspired colour pairs  { from:[r,g,b], to:[r,g,b] }    */
const PALETTE = {
    cpu:    { from: [1.00, 0.20, 0.25], to: [1.00, 0.40, 0.45] },   // Red/Pink
    mem:    { from: [0.00, 0.83, 1.00], to: [0.00, 0.55, 1.00] },   // Cyan → Blue
    disk:   { from: [1.00, 0.58, 0.00], to: [1.00, 0.78, 0.00] },   // Orange → Gold
    intel:  { from: [0.20, 0.78, 0.35], to: [0.40, 0.90, 0.55] },   // Green
    nvidia: { from: [0.69, 0.32, 0.87], to: [1.00, 0.18, 0.40] },   // Purple → Pink
};

/* ── Cairo ring painter ──────────────────────────────────────── */
function _paintRing(cr, width, height, pct, pal) {
    const size = Math.min(width, height);
    const cx = width / 2;
    const cy = height / 2;
    const frac = Math.min(Math.max(pct, 0), 100) / 100;

    // Clear canvas to transparent
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.paint();
    cr.setOperator(Cairo.Operator.OVER);

    // Background track (full dim circle)
    cr.setLineWidth(RING_STROKE);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setSourceRGBA(1, 1, 1, 0.07);
    cr.arc(cx, cy, RING_RADIUS, 0, 2 * Math.PI);
    cr.stroke();

    if (frac <= 0)
        return;

    // Foreground arc with diagonal gradient
    const startAngle = -Math.PI / 2;                       // 12-o'clock
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

    // Soft outer glow
    cr.setSourceRGBA(pal.from[0], pal.from[1], pal.from[2], 0.10);
    cr.setLineWidth(RING_STROKE + 12);
    cr.setLineCap(Cairo.LineCap.ROUND);

    if (frac >= 0.99)
        cr.arc(cx, cy, RING_RADIUS, 0, 2 * Math.PI);
    else
        cr.arc(cx, cy, RING_RADIUS, startAngle, endAngle);
    cr.stroke();
}

/* ── Draggable base widget ───────────────────────────────────── */
class BaseWidget extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    constructor(params) {
        super({ reactive: true, ...params });
        this._dragging = false;

        this.connect('button-press-event',   this._onPress.bind(this));
        this.connect('motion-event',         this._onMotion.bind(this));
        this.connect('button-release-event', this._onRelease.bind(this));
    }

    _onPress(_actor, event) {
        if (event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;

        let [x, y] = event.get_coords();
        this._dragging = true;
        this._dragStartX = x;
        this._dragStartY = y;
        this._dragActorX = this.x;
        this._dragActorY = this.y;
        return Clutter.EVENT_STOP;
    }

    _onMotion(_actor, event) {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;

        let [x, y] = event.get_coords();
        this.set_position(
            this._dragActorX + x - this._dragStartX,
            this._dragActorY + y - this._dragStartY);
        return Clutter.EVENT_STOP;
    }

    _onRelease(_actor, event) {
        if (event.get_button() !== 1 || !this._dragging)
            return Clutter.EVENT_PROPAGATE;

        this._dragging = false;
        return Clutter.EVENT_STOP;
    }
}

/* ── Single ring cell  (St.DrawingArea + percentage + name + detail) ── */
class RingCell {
    constructor(label, palette) {
        this._pct = 0;
        this._pal = palette;

        // St.DrawingArea for Cairo ring drawing
        this._drawingArea = new St.DrawingArea({
            width: RING_SIZE,
            height: RING_SIZE,
        });
        this._repaintId = this._drawingArea.connect('repaint', (area) => {
            let cr = area.get_context();
            let [w, h] = area.get_surface_size();
            _paintRing(cr, w, h, this._pct, this._pal);
            cr.$dispose();
        });

        // Percentage label (overlaid at ring centre)
        this._pctLabel = new St.Label({
            text: '0%',
            style_class: 'zeo-ring-pct',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Stack ring + label via BinLayout
        let stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width:  RING_SIZE,
            height: RING_SIZE,
        });
        stack.add_child(this._drawingArea);
        stack.add_child(this._pctLabel);

        // Metric name
        this._nameLabel = new St.Label({
            text: label,
            style_class: 'zeo-ring-name',
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Detail line (e.g. "9.6 / 15.2 GB")
        this._detailLabel = new St.Label({
            text: '—',
            style_class: 'zeo-ring-detail',
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Outer cell container
        this.actor = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'zeo-ring-cell',
        });
        this.actor.add_child(stack);
        this.actor.add_child(this._nameLabel);
        this.actor.add_child(this._detailLabel);
    }

    update(pct, detail) {
        this._pct = pct;
        this._pctLabel.set_text(`${Math.round(pct)}%`);
        this._detailLabel.set_text(detail);
        this._drawingArea.queue_repaint();
    }

    destroy() {
        if (this._repaintId && this._drawingArea) {
            this._drawingArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
        this._drawingArea = null;
    }
}

/* ── System Monitor Widget ───────────────────────────────────── */
class SystemMonitorWidget extends BaseWidget {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super({
            vertical: true,
            style_class: 'zeo-sysmon-card',
            x_align: Clutter.ActorAlign.CENTER,
        });

        // ── Ring row ────────────────────────────────────────────
        let row = new St.BoxLayout({
            style_class: 'zeo-ring-row',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._cpuCell    = new RingCell('CPU',      PALETTE.cpu);
        this._memCell    = new RingCell('Memory',   PALETTE.mem);
        this._diskCell   = new RingCell('Disk',     PALETTE.disk);
        this._intelCell  = new RingCell('Iris Xe',  PALETTE.intel);
        this._nvidiaCell = new RingCell('RTX 3050', PALETTE.nvidia);

        row.add_child(this._cpuCell.actor);
        row.add_child(this._memCell.actor);
        row.add_child(this._diskCell.actor);
        row.add_child(this._intelCell.actor);
        row.add_child(this._nvidiaCell.actor);
        this.add_child(row);

        // ── Start updates ───────────────────────────────────────
        this._refresh();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, UPDATE_SECS, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    /* ── Data readers ──────────────────────────────────────────── */

    _readCpu() {
        try {
            let [ok, raw] = GLib.file_get_contents('/proc/stat');
            if (!ok) return [0, '—'];
            let txt = new TextDecoder().decode(raw);
            let lines = txt.split('\n');
            let cpuLine = lines[0].trim().split(/\s+/);
            if (cpuLine[0] !== 'cpu') return [0, '—'];

            let user = parseInt(cpuLine[1]) || 0;
            let nice = parseInt(cpuLine[2]) || 0;
            let system = parseInt(cpuLine[3]) || 0;
            let idle = parseInt(cpuLine[4]) || 0;
            let iowait = parseInt(cpuLine[5]) || 0;
            let irq = parseInt(cpuLine[6]) || 0;
            let softirq = parseInt(cpuLine[7]) || 0;
            let steal = parseInt(cpuLine[8]) || 0;

            let idleTime = idle + iowait;
            let nonIdleTime = user + nice + system + irq + softirq + steal;
            let totalTime = idleTime + nonIdleTime;

            if (!this._prevCpu) {
                this._prevCpu = { idle: idleTime, total: totalTime };
                return [0, 'Reading...'];
            }

            let totalDelta = totalTime - this._prevCpu.total;
            let idleDelta = idleTime - this._prevCpu.idle;

            this._prevCpu = { idle: idleTime, total: totalTime };

            let pct = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;
            return [pct, 'Usage'];
        } catch (e) {
            return [0, 'Error'];
        }
    }

    _readMemory() {
        try {
            let [ok, raw] = GLib.file_get_contents('/proc/meminfo');
            if (!ok) return [0, '—'];
            let txt  = new TextDecoder().decode(raw);
            let tot  = parseInt(txt.match(/MemTotal:\s+(\d+)/)?.[1] ?? '0');
            let avl  = parseInt(txt.match(/MemAvailable:\s+(\d+)/)?.[1] ?? '0');
            let usedGB = (tot - avl) / 1048576;
            let totGB  = tot / 1048576;
            let pct = totGB > 0 ? (usedGB / totGB) * 100 : 0;
            return [pct, `${usedGB.toFixed(1)} / ${totGB.toFixed(1)} GB`];
        } catch (e) {
            return [0, 'Error'];
        }
    }

    _readDisk() {
        try {
            let [ok, out] = GLib.spawn_command_line_sync('df --output=used,size,pcent / ');
            if (!ok) return [0, '—'];
            let txt   = new TextDecoder().decode(out).trim();
            let lines = txt.split('\n');
            if (lines.length < 2) return [0, '—'];
            let parts = lines[1].trim().split(/\s+/);
            let usedKB = parseInt(parts[0]) || 0;
            let totKB  = parseInt(parts[1]) || 0;
            let pct    = parseInt(parts[2]) || 0;
            let uGB = usedKB / 1048576;
            let tGB = totKB  / 1048576;
            return [pct, `${Math.round(uGB)} / ${Math.round(tGB)} GB`];
        } catch (e) {
            return [0, 'Error'];
        }
    }

    _readIntelGpu() {
        try {
            let actFile, maxFile;
            for (let i = 0; i < 5; i++) {
                let actPath = `/sys/class/drm/card${i}/gt/gt0/rps_act_freq_mhz`;
                let maxPath = `/sys/class/drm/card${i}/gt/gt0/rps_max_freq_mhz`;
                if (GLib.file_test(actPath, GLib.FileTest.EXISTS) && GLib.file_test(maxPath, GLib.FileTest.EXISTS)) {
                    actFile = actPath;
                    maxFile = maxPath;
                    break;
                }
            }
            if (!actFile) return [0, '—'];
            let [ok1, r1] = GLib.file_get_contents(actFile);
            let [ok2, r2] = GLib.file_get_contents(maxFile);
            if (!ok1 || !ok2) return [0, '—'];
            let act = parseInt(new TextDecoder().decode(r1));
            let max = parseInt(new TextDecoder().decode(r2));
            let pct = max > 0 ? (act / max) * 100 : 0;
            return [pct, `${act} / ${max} MHz`];
        } catch (e) {
            return [0, 'Error'];
        }
    }

    _readNvidiaGpu() {
        try {
            let [ok, out, , status] = GLib.spawn_command_line_sync(
                'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits');
            if (!ok) return [0, '—'];
            let txt   = new TextDecoder().decode(out).trim();
            let parts = txt.split(',').map(s => s.trim());
            let util  = parseInt(parts[0]) || 0;
            let mUsed = parseInt(parts[1]) || 0;
            let mTot  = parseInt(parts[2]) || 0;
            return [util, `${mUsed} / ${mTot} MB`];
        } catch (e) {
            return [0, 'N/A'];
        }
    }

    _refresh() {
        let [cpuP,  cpuD]  = this._readCpu();
        let [memP,  memD]  = this._readMemory();
        let [dskP,  dskD]  = this._readDisk();
        let [intP,  intD]  = this._readIntelGpu();
        let [nvP,   nvD]   = this._readNvidiaGpu();

        this._cpuCell.update(cpuP,    cpuD);
        this._memCell.update(memP,    memD);
        this._diskCell.update(dskP,   dskD);
        this._intelCell.update(intP,  intD);
        this._nvidiaCell.update(nvP,   nvD);
    }

    destroy() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }

        this._cpuCell?.destroy();
        this._memCell?.destroy();
        this._diskCell?.destroy();
        this._intelCell?.destroy();
        this._nvidiaCell?.destroy();

        super.destroy();
    }
}

/* ── Extension entry point ───────────────────────────────────── */
export default class ZeoWidgetsExtension extends Extension {
    enable() {
        this._widget = new SystemMonitorWidget();

        // Place on the desktop layer (below windows, above wallpaper)
        Main.layoutManager._backgroundGroup.add_child(this._widget);

        // Position near top-left of primary monitor
        let mon = Main.layoutManager.primaryMonitor;
        const pad = 40;
        this._widget.set_position(
            mon.x + pad,
            mon.y + pad + 30);
    }

    disable() {
        if (this._widget) {
            Main.layoutManager._backgroundGroup.remove_child(this._widget);
            this._widget.destroy();
            this._widget = null;
        }
    }
}
