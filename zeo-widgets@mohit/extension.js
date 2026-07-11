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

/* ── GPU vendor IDs ──────────────────────────────────────────── */
const VENDOR_INTEL  = '0x8086';
const VENDOR_AMD    = '0x1002';
const VENDOR_NVIDIA = '0x10de';

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

/* ── GPU auto-detection ──────────────────────────────────────── */

/**
 * Build a map of GPU PCI slots → friendly names from `lspci -vmm`.
 * Returns e.g. { '0000:00:02.0': 'Iris Xe Graphics', '0000:01:00.0': 'GeForce RTX 5070 Ti' }
 */
function _getLspciGpuNames() {
    const names = {};
    try {
        let [ok, out] = GLib.spawn_command_line_sync('lspci -vmm');
        if (!ok) return names;
        let txt = new TextDecoder().decode(out);
        // Split into blocks separated by blank lines
        let blocks = txt.split(/\n\n+/);
        for (let block of blocks) {
            if (!block.includes('VGA compatible controller') &&
                !block.includes('3D controller') &&
                !block.includes('Display controller'))
                continue;
            let slotMatch = block.match(/^Slot:\s*(.+)$/m);
            let deviceMatch = block.match(/^Device:\s*(.+)$/m);
            if (slotMatch && deviceMatch) {
                let name = deviceMatch[1].trim();
                // Strip the chip-code prefix like "GA107M [GeForce RTX 3050 Mobile]"
                // → keep just the bracketed name if present
                let bracketMatch = name.match(/\[(.+)\]/);
                if (bracketMatch)
                    name = bracketMatch[1];
                names[slotMatch[1].trim()] = name;
            }
        }
    } catch (e) {
        // lspci not available — will fall back to vendor names
    }
    return names;
}

/**
 * Scan /sys/class/drm/card* to discover GPUs.
 * Returns an array of { vendor, cardIndex, name, pciSlot, type } objects
 * where type is 'intel', 'amd', or 'nvidia'.
 */
function _detectGpus() {
    const lspciNames = _getLspciGpuNames();
    const gpus = [];

    for (let i = 0; i < 10; i++) {
        let vendorPath = `/sys/class/drm/card${i}/device/vendor`;
        if (!GLib.file_test(vendorPath, GLib.FileTest.EXISTS))
            continue;

        let [ok, raw] = GLib.file_get_contents(vendorPath);
        if (!ok) continue;
        let vendor = new TextDecoder().decode(raw).trim();

        let type;
        if (vendor === VENDOR_INTEL)
            type = 'intel';
        else if (vendor === VENDOR_AMD)
            type = 'amd';
        else if (vendor === VENDOR_NVIDIA)
            type = 'nvidia';
        else
            continue; // skip unknown vendors

        // Try to get the PCI slot to match with lspci names
        let pciSlot = '';
        try {
            let ueventPath = `/sys/class/drm/card${i}/device/uevent`;
            if (GLib.file_test(ueventPath, GLib.FileTest.EXISTS)) {
                let [uOk, uRaw] = GLib.file_get_contents(ueventPath);
                if (uOk) {
                    let uevent = new TextDecoder().decode(uRaw);
                    let slotMatch = uevent.match(/PCI_SLOT_NAME=(.+)/);
                    if (slotMatch)
                        pciSlot = slotMatch[1].trim();
                }
            }
        } catch (e) { /* ignore */ }

        // Get a friendly name, in priority order:
        // 1. lspci name (most descriptive)
        // 2. nvidia-smi name (for NVIDIA only)
        // 3. Vendor fallback
        let name = '';
        if (pciSlot && lspciNames[pciSlot]) {
            name = lspciNames[pciSlot];
        } else if (type === 'nvidia') {
            try {
                let [nOk, nOut] = GLib.spawn_command_line_sync(
                    'nvidia-smi --query-gpu=name --format=csv,noheader,nounits');
                if (nOk) {
                    let nName = new TextDecoder().decode(nOut).trim();
                    if (nName) {
                        // Clean up "NVIDIA GeForce RTX 3050 Laptop GPU" → "RTX 3050"
                        name = nName.replace(/^NVIDIA\s+/i, '')
                                    .replace(/^GeForce\s+/i, '')
                                    .replace(/\s+(Laptop|Mobile)\s+GPU$/i, '');
                    }
                }
            } catch (e) { /* ignore */ }
        }

        // Vendor fallback names
        if (!name) {
            if (type === 'intel') name = 'Intel GPU';
            else if (type === 'amd') name = 'AMD GPU';
            else if (type === 'nvidia') name = 'NVIDIA GPU';
        } else {
            // Clean up common lspci prefixes for shorter ring labels
            // e.g. "Iris Xe Graphics" → "Iris Xe", "Radeon 780M" stays
            name = name.replace(/\s+Graphics$/i, '');
            // "GeForce RTX 5070 Ti" → "RTX 5070 Ti"
            name = name.replace(/^GeForce\s+/i, '');
        }

        gpus.push({ vendor, cardIndex: i, name, pciSlot, type });
    }

    return gpus;
}

/**
 * Shorten a GPU name for the ring label (max ~12 chars ideally).
 * Full name is used in the detail label / tooltip.
 */
function _shortGpuName(name) {
    // Already short enough
    if (name.length <= 14) return name;
    // Try abbreviating
    return name;
}

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

        this.connectObject(
            'button-press-event',   this._onPress.bind(this),
            'motion-event',         this._onMotion.bind(this),
            'button-release-event', this._onRelease.bind(this),
            this);
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
        if (this._settings) {
            this._settings.set_int('pos-x', this.x);
            this._settings.set_int('pos-y', this.y);
        }
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
        // Use a sentinel object as the tracking target for connectObject
        this._signalTracker = {};
        this._drawingArea.connectObject('repaint', (area) => {
            let cr = area.get_context();
            let [w, h] = area.get_surface_size();
            _paintRing(cr, w, h, this._pct, this._pal);
            cr.$dispose();
        }, this._signalTracker);

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
        if (this._drawingArea && this._signalTracker) {
            this._drawingArea.disconnectObject(this._signalTracker);
            this._signalTracker = null;
        }
        this._drawingArea = null;
    }
}

/* ── GPU data reader helpers ─────────────────────────────────── */

/**
 * Read Intel iGPU usage via i915/xe sysfs frequency files.
 * @param {number} cardIndex - card index in /sys/class/drm/
 */
function _readIntelGpu(cardIndex) {
    try {
        let actPath = `/sys/class/drm/card${cardIndex}/gt/gt0/rps_act_freq_mhz`;
        let maxPath = `/sys/class/drm/card${cardIndex}/gt/gt0/rps_max_freq_mhz`;
        if (!GLib.file_test(actPath, GLib.FileTest.EXISTS) ||
            !GLib.file_test(maxPath, GLib.FileTest.EXISTS))
            return [0, '—'];
        let [ok1, r1] = GLib.file_get_contents(actPath);
        let [ok2, r2] = GLib.file_get_contents(maxPath);
        if (!ok1 || !ok2) return [0, '—'];
        let act = parseInt(new TextDecoder().decode(r1));
        let max = parseInt(new TextDecoder().decode(r2));
        let pct = max > 0 ? (act / max) * 100 : 0;
        return [pct, `${act} / ${max} MHz`];
    } catch (e) {
        return [0, 'Error'];
    }
}

/**
 * Read AMD iGPU/dGPU usage via amdgpu sysfs.
 * Tries gpu_busy_percent first, falls back to frequency ratio.
 * @param {number} cardIndex - card index in /sys/class/drm/
 */
function _readAmdGpu(cardIndex) {
    try {
        // Method 1: direct utilisation percentage (amdgpu exposes this)
        let busyPath = `/sys/class/drm/card${cardIndex}/device/gpu_busy_percent`;
        if (GLib.file_test(busyPath, GLib.FileTest.EXISTS)) {
            let [ok, raw] = GLib.file_get_contents(busyPath);
            if (ok) {
                let pct = parseInt(new TextDecoder().decode(raw)) || 0;

                // Also try to get current frequency for the detail string
                let detail = 'Usage';
                let freqPath = `/sys/class/drm/card${cardIndex}/device/pp_dpm_sclk`;
                if (GLib.file_test(freqPath, GLib.FileTest.EXISTS)) {
                    let [fOk, fRaw] = GLib.file_get_contents(freqPath);
                    if (fOk) {
                        let txt = new TextDecoder().decode(fRaw);
                        // Find the active frequency line (marked with *)
                        let activeMatch = txt.match(/(\d+)\s*Mhz\s*\*/i);
                        if (activeMatch)
                            detail = `${activeMatch[1]} MHz`;
                    }
                }
                return [pct, detail];
            }
        }

        // Method 2: frequency ratio from pp_dpm_sclk
        let freqPath = `/sys/class/drm/card${cardIndex}/device/pp_dpm_sclk`;
        if (GLib.file_test(freqPath, GLib.FileTest.EXISTS)) {
            let [ok, raw] = GLib.file_get_contents(freqPath);
            if (ok) {
                let txt = new TextDecoder().decode(raw);
                let lines = txt.trim().split('\n');
                // Find active line (ends with *)
                let activeMatch = txt.match(/(\d+)\s*Mhz\s*\*/i);
                // Find max frequency (last line)
                let lastLine = lines[lines.length - 1];
                let maxMatch = lastLine.match(/(\d+)\s*Mhz/i);
                if (activeMatch && maxMatch) {
                    let act = parseInt(activeMatch[1]);
                    let max = parseInt(maxMatch[1]);
                    let pct = max > 0 ? (act / max) * 100 : 0;
                    return [pct, `${act} / ${max} MHz`];
                }
            }
        }

        return [0, '—'];
    } catch (e) {
        return [0, 'Error'];
    }
}

/**
 * Read NVIDIA GPU usage via nvidia-smi.
 */
function _readNvidiaGpu() {
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

/* ── System Monitor Widget ───────────────────────────────────── */
class SystemMonitorWidget extends BaseWidget {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            vertical: true,
            style_class: 'zeo-sysmon-card',
            x_align: Clutter.ActorAlign.CENTER,
        });
        
        this._settings = settings;

        // ── Auto-detect GPUs ────────────────────────────────────────
        this._gpus = _detectGpus();
        this._gpuCells = [];

        // ── Ring row ────────────────────────────────────────────
        let row = new St.BoxLayout({
            style_class: 'zeo-ring-row',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._cpuCell    = new RingCell('CPU',      getColorPal(this._settings.get_string('cpu-color')));
        this._memCell    = new RingCell('Memory',   getColorPal(this._settings.get_string('mem-color')));
        this._diskCell   = new RingCell('Disk',     getColorPal(this._settings.get_string('disk-color')));

        row.add_child(this._cpuCell.actor);
        row.add_child(this._memCell.actor);
        row.add_child(this._diskCell.actor);

        // Add GPU rings dynamically based on detected hardware
        // Use igpu-color for the first iGPU (Intel/AMD), dgpu-color for the first dGPU (NVIDIA/AMD discrete)
        let iGpuCount = 0;
        let dGpuCount = 0;
        for (let gpu of this._gpus) {
            let colorKey;
            // Intel and AMD integrated GPUs get igpu-color, NVIDIA gets dgpu-color
            // If there are multiple GPUs of same category, extra ones use the same color
            if (gpu.type === 'nvidia') {
                colorKey = 'dgpu-color';
                dGpuCount++;
            } else {
                // Intel or AMD — typically integrated
                colorKey = 'igpu-color';
                iGpuCount++;
            }

            let label = _shortGpuName(gpu.name);
            let cell = new RingCell(label, getColorPal(this._settings.get_string(colorKey)));
            cell._gpuInfo = gpu;
            cell._colorKey = colorKey;
            this._gpuCells.push(cell);
            row.add_child(cell.actor);
        }

        this.add_child(row);

        // ── Start updates ───────────────────────────────────────
        this._refresh();
        this._setupTimer();
        
        this._settings.connectObject('changed', (settings, key) => {
            if (key === 'update-interval') {
                this._setupTimer();
            } else if (key === 'cpu-color') {
                this._cpuCell._pal = getColorPal(settings.get_string(key));
            } else if (key === 'mem-color') {
                this._memCell._pal = getColorPal(settings.get_string(key));
            } else if (key === 'disk-color') {
                this._diskCell._pal = getColorPal(settings.get_string(key));
            } else if (key === 'igpu-color' || key === 'dgpu-color') {
                // Update all GPU cells that use this color key
                for (let cell of this._gpuCells) {
                    if (cell._colorKey === key)
                        cell._pal = getColorPal(settings.get_string(key));
                }
            }
            if (key && key.endsWith('-color')) {
                this._cpuCell._drawingArea.queue_repaint();
                this._memCell._drawingArea.queue_repaint();
                this._diskCell._drawingArea.queue_repaint();
                for (let cell of this._gpuCells) {
                    cell._drawingArea.queue_repaint();
                }
            }
        }, this);
    }
    
    _setupTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        const interval = this._settings.get_int('update-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
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

    _readGpu(gpu) {
        switch (gpu.type) {
            case 'intel':
                return _readIntelGpu(gpu.cardIndex);
            case 'amd':
                return _readAmdGpu(gpu.cardIndex);
            case 'nvidia':
                return _readNvidiaGpu();
            default:
                return [0, '—'];
        }
    }

    _refresh() {
        let [cpuP,  cpuD]  = this._readCpu();
        let [memP,  memD]  = this._readMemory();
        let [dskP,  dskD]  = this._readDisk();

        this._cpuCell.update(cpuP,    cpuD);
        this._memCell.update(memP,    memD);
        this._diskCell.update(dskP,   dskD);

        // Update all detected GPU cells
        for (let cell of this._gpuCells) {
            let [pct, detail] = this._readGpu(cell._gpuInfo);
            cell.update(pct, detail);
        }
    }

    destroy() {
        this._settings?.disconnectObject(this);
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }

        this._cpuCell?.destroy();
        this._memCell?.destroy();
        this._diskCell?.destroy();
        for (let cell of this._gpuCells)
            cell?.destroy();
        this._gpuCells = [];

        super.destroy();
    }
}

/* ── Extension entry point ───────────────────────────────────── */
export default class ZeoWidgetsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._widget = new SystemMonitorWidget(this._settings);

        // Place on the desktop layer (below windows, above wallpaper)
        Main.layoutManager._backgroundGroup.add_child(this._widget);

        const updatePos = () => {
            this._widget.set_position(
                this._settings.get_int('pos-x'),
                this._settings.get_int('pos-y')
            );
        };
        
        // Initial position
        updatePos();
        
        this._settings.connectObject('changed', (settings, key) => {
            if (key === 'pos-x' || key === 'pos-y') {
                updatePos();
            }
        }, this);
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._settings = null;
        
        if (this._widget) {
            Main.layoutManager._backgroundGroup.remove_child(this._widget);
            this._widget.destroy();
            this._widget = null;
        }
    }
}
