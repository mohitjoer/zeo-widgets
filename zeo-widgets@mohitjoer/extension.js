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

function _execCommandAsync(argv) {
    return new Promise((resolve) => {
        try {
            let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    let [success, stdout] = p.communicate_utf8_finish(res);
                    if (success && p.get_successful()) {
                        let out = stdout ? stdout.trim() : '';
                        if (out.includes('Failed to initialize NVML') || out.includes('NVML library version')) {
                            resolve(null);
                        } else {
                            resolve(stdout || null);
                        }
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        } catch (e) {
            resolve(null);
        }
    });
}

function _readFileAsync(path) {
    return new Promise((resolve) => {
        let file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (obj, res) => {
            try {
                let [success, contents] = obj.load_contents_finish(res);
                if (success) {
                    resolve(new TextDecoder().decode(contents));
                } else {
                    resolve(null);
                }
            } catch (e) {
                resolve(null);
            }
        });
    });
}

/**
 * Build a map of GPU PCI slots → friendly names from `lspci -vmm`.
 * Returns e.g. { '0000:00:02.0': 'Iris Xe Graphics', '0000:01:00.0': 'GeForce RTX 5070 Ti' }
 */
async function _getLspciGpuNames() {
    const names = {};
    let txt = await _execCommandAsync(['lspci', '-vmm']);
    if (!txt) return names;
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
            let slot = slotMatch[1].trim();
            let normSlot = slot.replace(/^0000:/, '');
            let name = deviceMatch[1].trim();
            // Strip the chip-code prefix like "GA107M [GeForce RTX 3050 Mobile]"
            // → keep just the bracketed name if present
            let bracketMatch = name.match(/\[(.+)\]/);
            if (bracketMatch)
                name = bracketMatch[1];
            names[slot] = name;
            names[normSlot] = name;
            names[`0000:${normSlot}`] = name;
        }
    }
    return names;
}

/**
 * Scan /sys/class/drm/card* to discover GPUs.
 * Returns an array of { vendor, cardIndex, name, pciSlot, type } objects
 * where type is 'intel', 'amd', or 'nvidia'.
 */
async function _detectGpus() {
    const lspciNames = await _getLspciGpuNames();
    const gpus = [];

    for (let i = 0; i < 10; i++) {
        let vendorPath = `/sys/class/drm/card${i}/device/vendor`;
        if (!GLib.file_test(vendorPath, GLib.FileTest.EXISTS))
            continue;

        let rawVendor = await _readFileAsync(vendorPath);
        if (!rawVendor) continue;
        let vendor = rawVendor.trim();

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
        let ueventPath = `/sys/class/drm/card${i}/device/uevent`;
        if (GLib.file_test(ueventPath, GLib.FileTest.EXISTS)) {
            let uevent = await _readFileAsync(ueventPath);
            if (uevent) {
                let slotMatch = uevent.match(/PCI_SLOT_NAME=(.+)/);
                if (slotMatch)
                    pciSlot = slotMatch[1].trim();
            }
        }

        // Get a friendly name, in priority order:
        // 1. lspci name (most descriptive)
        // 2. nvidia-smi name (for NVIDIA only)
        // 3. Vendor fallback
        let name = '';
        if (pciSlot && lspciNames[pciSlot]) {
            name = lspciNames[pciSlot];
        } else if (type === 'nvidia') {
            let nName = await _execCommandAsync(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader,nounits']);
            if (nName) {
                nName = nName.trim();
                if (nName) {
                    // Clean up "NVIDIA GeForce RTX 3050 Laptop GPU" → "RTX 3050"
                    name = nName.replace(/^NVIDIA\s+/i, '')
                                .replace(/^GeForce\s+/i, '')
                                .replace(/\s+(Laptop|Mobile)\s+GPU$/i, '');
                }
            }
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
        if (this._drawingArea) {
            if (this._signalTracker) {
                this._drawingArea.disconnectObject(this._signalTracker);
                this._signalTracker = null;
            }
            this._drawingArea.destroy();
            this._drawingArea = null;
        }

        if (this._pctLabel) {
            this._pctLabel.destroy();
            this._pctLabel = null;
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

/* ── GPU data reader helpers ─────────────────────────────────── */

/**
 * Read Intel iGPU usage via i915/xe sysfs frequency files.
 * @param {number} cardIndex - card index in /sys/class/drm/
 */
async function _readIntelGpu(cardIndex) {
    try {
        let actPath = `/sys/class/drm/card${cardIndex}/gt/gt0/rps_act_freq_mhz`;
        let maxPath = `/sys/class/drm/card${cardIndex}/gt/gt0/rps_max_freq_mhz`;
        if (!GLib.file_test(actPath, GLib.FileTest.EXISTS) ||
            !GLib.file_test(maxPath, GLib.FileTest.EXISTS))
            return [0, '—'];
        let r1 = await _readFileAsync(actPath);
        let r2 = await _readFileAsync(maxPath);
        if (!r1 || !r2) return [0, '—'];
        let act = parseInt(r1);
        let max = parseInt(r2);
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
async function _readAmdGpu(cardIndex) {
    try {
        // Method 1: direct utilisation percentage (amdgpu exposes this)
        let busyPath = `/sys/class/drm/card${cardIndex}/device/gpu_busy_percent`;
        if (GLib.file_test(busyPath, GLib.FileTest.EXISTS)) {
            let raw = await _readFileAsync(busyPath);
            if (raw) {
                let pct = parseInt(raw) || 0;

                // Also try to get current frequency for the detail string
                let detail = 'Usage';
                let freqPath = `/sys/class/drm/card${cardIndex}/device/pp_dpm_sclk`;
                if (GLib.file_test(freqPath, GLib.FileTest.EXISTS)) {
                    let txt = await _readFileAsync(freqPath);
                    if (txt) {
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
            let txt = await _readFileAsync(freqPath);
            if (txt) {
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
async function _readNvidiaGpu() {
    try {
        let txt = await _execCommandAsync(['nvidia-smi', '-q', '-d', 'MEMORY']);
        if (!txt) return [0, 'N/A'];
        if (txt.includes('Failed to initialize NVML') || txt.includes('NVML')) return [0, 'N/A'];

        // Parse FB Memory Total and Used (actual VRAM consumption)
        let fbTotalMatch = txt.match(/FB Memory Usage[\s\S]*?Total\s*:\s*(\d+)\s*MiB/);
        let fbUsedMatch = txt.match(/FB Memory Usage[\s\S]*?Used\s*:\s*(\d+)\s*MiB/);
        let fbTotal = fbTotalMatch ? parseInt(fbTotalMatch[1]) : 0;
        let fbUsed = fbUsedMatch ? parseInt(fbUsedMatch[1]) : 0;

        if (fbTotal === 0) return [0, 'N/A'];

        // Get GPU utilization separately
        let utilTxt = await _execCommandAsync(['nvidia-smi', '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']);
        let util = 0;
        if (utilTxt) util = parseInt(utilTxt.trim()) || 0;

        let totalGB = (fbTotal / 1024).toFixed(2);
        let usedDisplay = fbUsed < 1024
            ? `${fbUsed} MB`
            : `${(fbUsed / 1024).toFixed(2)} GB`;
        return [util, `${usedDisplay} / ${totalGB} GB`];
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
        this._gpus = [];
        this._gpuCells = [];
        this._row = new St.BoxLayout({
            style_class: 'zeo-ring-row',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._cpuCell    = new RingCell('CPU',      getColorPal(this._settings.get_string('cpu-color')));
        this._memCell    = new RingCell('Memory',   getColorPal(this._settings.get_string('mem-color')));
        this._diskCell   = new RingCell('Disk',     getColorPal(this._settings.get_string('disk-color')));

        this._row.add_child(this._cpuCell.actor);
        this._row.add_child(this._memCell.actor);
        this._row.add_child(this._diskCell.actor);

        this.add_child(this._row);

        // ── Start async init ───────────────────────────────────────
        this._initGpus().catch(console.error);

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
                if (this._cpuCell && this._cpuCell._drawingArea) this._cpuCell._drawingArea.queue_repaint();
                if (this._memCell && this._memCell._drawingArea) this._memCell._drawingArea.queue_repaint();
                if (this._diskCell && this._diskCell._drawingArea) this._diskCell._drawingArea.queue_repaint();
                for (let cell of this._gpuCells) {
                    if (cell && cell._drawingArea) cell._drawingArea.queue_repaint();
                }
            }
        }, this);
    }

    async _initGpus() {
        this._gpus = await _detectGpus();
        let iGpuCount = 0;
        let dGpuCount = 0;
        for (let gpu of this._gpus) {
            let colorKey;
            if (gpu.type === 'nvidia') {
                colorKey = 'dgpu-color';
                dGpuCount++;
            } else {
                colorKey = 'igpu-color';
                iGpuCount++;
            }

            let label = _shortGpuName(gpu.name);
            let cell = new RingCell(label, getColorPal(this._settings.get_string(colorKey)));
            cell._gpuInfo = gpu;
            cell._colorKey = colorKey;
            this._gpuCells.push(cell);
            if (this._row) {
                this._row.add_child(cell.actor);
            }
        }

        await this._refresh();
        this._setupTimer();
    }
    
    _setupTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        const interval = this._settings.get_int('update-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._refresh().catch(console.error);
                return GLib.SOURCE_CONTINUE;
            });
    }

    /* ── Data readers ──────────────────────────────────────────── */

    async _readCpu() {
        try {
            let txt = await _readFileAsync('/proc/stat');
            if (!txt) return [0, '—'];
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

    async _readMemory() {
        try {
            let txt = await _readFileAsync('/proc/meminfo');
            if (!txt) return [0, '—'];
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

    async _readDisk() {
        try {
            let txt = await _execCommandAsync(['df', '--output=used,size,pcent', '/']);
            if (!txt) return [0, '—'];
            txt = txt.trim();
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

    async _readGpu(gpu) {
        switch (gpu.type) {
            case 'intel':
                return await _readIntelGpu(gpu.cardIndex);
            case 'amd':
                return await _readAmdGpu(gpu.cardIndex);
            case 'nvidia':
                return await _readNvidiaGpu();
            default:
                return [0, '—'];
        }
    }

    async _refresh() {
        if (!this._cpuCell || !this._memCell || !this._diskCell) return;

        let [cpuP,  cpuD]  = await this._readCpu();
        let [memP,  memD]  = await this._readMemory();
        let [dskP,  dskD]  = await this._readDisk();

        if (this._cpuCell) this._cpuCell.update(cpuP,    cpuD);
        if (this._memCell) this._memCell.update(memP,    memD);
        if (this._diskCell) this._diskCell.update(dskP,   dskD);

        // Update all detected GPU cells
        for (let cell of this._gpuCells) {
            let [pct, detail] = await this._readGpu(cell._gpuInfo);
            if (cell) cell.update(pct, detail);
        }
    }

    destroy() {
        this._settings?.disconnectObject(this);
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }

        if (this._cpuCell) {
            this._cpuCell.destroy();
            this._cpuCell = null;
        }
        if (this._memCell) {
            this._memCell.destroy();
            this._memCell = null;
        }
        if (this._diskCell) {
            this._diskCell.destroy();
            this._diskCell = null;
        }
        for (let cell of this._gpuCells) {
            if (cell) cell.destroy();
        }
        this._gpuCells = [];
        
        if (this._row) {
            this._row.destroy();
            this._row = null;
        }

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
