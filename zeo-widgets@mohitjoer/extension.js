import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

/* ── Utility: Async File & Command Execution ──────────────────────── */

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

function _execCommandAsync(argv) {
    return new Promise((resolve) => {
        try {
            let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    let [success, stdout] = p.communicate_utf8_finish(res);
                    if (success && p.get_successful()) {
                        resolve(stdout ? stdout.trim() : '');
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

async function _getLspciGpuNames() {
    const names = {};
    let txt = await _execCommandAsync(['lspci', '-vmm']);
    if (!txt) return names;
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

function formatBytes(bytes, decimals = 1) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const val = (bytes / Math.pow(k, i)).toFixed(decimals);
    return `${val} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'K/s', 'M/s', 'G/s'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytesPerSec) / Math.log(k)));
    const val = (bytesPerSec / Math.pow(k, i)).toFixed(i > 1 ? 1 : 0);
    return `${val} ${sizes[i]}`;
}

/* ── Hardware & Metric Readers ─────────────────────────────────────── */

class SystemMetricsCollector {
    constructor() {
        this.prevCpuTotal = 0;
        this.prevCpuIdle = 0;
        this.prevCoreStats = [];
        this.prevDiskStats = null;
        this.prevNetStats = null;
        this.prevNetTime = 0;
        this.prevDiskTime = 0;

        this.gpus = [];
        this._initGpuDetection();
    }

    async _initGpuDetection() {
        try {
            const lspciNames = await _getLspciGpuNames();
            const detected = [];

            // Check sysfs DRM cards
            for (let i = 0; i < 6; i++) {
                let vendorPath = `/sys/class/drm/card${i}/device/vendor`;
                if (GLib.file_test(vendorPath, GLib.FileTest.EXISTS)) {
                    let raw = await _readFileAsync(vendorPath);
                    if (raw) {
                        let vendor = raw.trim();
                        let type = null;
                        if (vendor === '0x8086') type = 'intel';
                        else if (vendor === '0x1002') type = 'amd';
                        else if (vendor === '0x10de') type = 'nvidia';

                        if (type) {
                            let pciSlot = '';
                            let ueventPath = `/sys/class/drm/card${i}/device/uevent`;
                            if (GLib.file_test(ueventPath, GLib.FileTest.EXISTS)) {
                                let uevent = await _readFileAsync(ueventPath);
                                let slotMatch = uevent ? uevent.match(/PCI_SLOT_NAME=(.+)/) : null;
                                if (slotMatch) pciSlot = slotMatch[1].trim();
                            }

                            let name = '';
                            if (pciSlot && lspciNames[pciSlot]) {
                                name = lspciNames[pciSlot];
                            } else if (type === 'intel') {
                                name = 'Iris Xe';
                            } else if (type === 'nvidia') {
                                name = 'NVIDIA GPU';
                            } else if (type === 'amd') {
                                name = 'AMD Radeon';
                            }
                            name = name.replace(/\s+Graphics$/i, '').replace(/^GeForce\s+/i, '').replace(/^NVIDIA\s+/i, '');

                            detected.push({
                                type,
                                name,
                                cardIndex: i,
                                pciSlot
                            });
                        }
                    }
                }
            }

            // Check for NVIDIA via nvidia-smi
            const nName = await _execCommandAsync(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader,nounits']);
            if (nName && !nName.includes('Failed to initialize NVML')) {
                const cleanName = nName.split('\n')[0].replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '').replace(/\s+(Laptop|Mobile)\s+GPU$/i, '').trim();
                const existingNv = detected.find(g => g.type === 'nvidia');
                if (existingNv) {
                    existingNv.name = cleanName;
                } else {
                    detected.push({
                        type: 'nvidia',
                        name: cleanName,
                        cardIndex: 0
                    });
                }
            }

            this.gpus = detected;
        } catch (e) {
            this.gpus = [];
        }
    }

    async readCpu() {
        try {
            const txt = await _readFileAsync('/proc/stat');
            if (!txt) return { totalUsage: 0, cores: [], loadAvg: '0.00, 0.00, 0.00', freqMhz: 0 };

            const lines = txt.split('\n');
            const cores = [];
            let totalUsage = 0;

            // Overall CPU
            const mainLine = lines[0].trim().split(/\s+/);
            if (mainLine[0] === 'cpu') {
                const user = parseInt(mainLine[1]) || 0;
                const nice = parseInt(mainLine[2]) || 0;
                const system = parseInt(mainLine[3]) || 0;
                const idle = parseInt(mainLine[4]) || 0;
                const iowait = parseInt(mainLine[5]) || 0;
                const irq = parseInt(mainLine[6]) || 0;
                const softirq = parseInt(mainLine[7]) || 0;
                const steal = parseInt(mainLine[8]) || 0;

                const idleTime = idle + iowait;
                const nonIdle = user + nice + system + irq + softirq + steal;
                const total = idleTime + nonIdle;

                if (this.prevCpuTotal > 0) {
                    const totalDelta = total - this.prevCpuTotal;
                    const idleDelta = idleTime - this.prevCpuIdle;
                    if (totalDelta > 0) {
                        totalUsage = Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
                    }
                }
                this.prevCpuTotal = total;
                this.prevCpuIdle = idleTime;
            }

            // Per-core stats
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim().split(/\s+/);
                if (!line[0].startsWith('cpu') || line[0] === 'cpu') break;
                const coreIndex = parseInt(line[0].replace('cpu', '')) || 0;
                const user = parseInt(line[1]) || 0;
                const nice = parseInt(line[2]) || 0;
                const system = parseInt(line[3]) || 0;
                const idle = parseInt(line[4]) || 0;
                const iowait = parseInt(line[5]) || 0;
                const irq = parseInt(line[6]) || 0;
                const softirq = parseInt(line[7]) || 0;
                const steal = parseInt(line[8]) || 0;

                const idleTime = idle + iowait;
                const total = idleTime + (user + nice + system + irq + softirq + steal);
                let coreUsage = 0;

                if (this.prevCoreStats[coreIndex]) {
                    const prev = this.prevCoreStats[coreIndex];
                    const tDelta = total - prev.total;
                    const iDelta = idleTime - prev.idle;
                    if (tDelta > 0) {
                        coreUsage = Math.min(100, Math.max(0, ((tDelta - iDelta) / tDelta) * 100));
                    }
                }
                this.prevCoreStats[coreIndex] = { total, idle: idleTime };
                cores.push({ coreIndex, usage: coreUsage });
            }

            // Load average
            let loadAvg = '';
            const loadTxt = await _readFileAsync('/proc/loadavg');
            if (loadTxt) {
                const p = loadTxt.trim().split(/\s+/);
                loadAvg = `${p[0]}, ${p[1]}, ${p[2]}`;
            }

            // CPU Frequency (from scaling_cur_freq or cpuinfo)
            let freqMhz = 0;
            const freqTxt = await _readFileAsync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq');
            if (freqTxt) {
                freqMhz = Math.round(parseInt(freqTxt.trim()) / 1000);
            }

            return { totalUsage, cores, loadAvg, freqMhz };
        } catch (e) {
            return { totalUsage: 0, cores: [], loadAvg: '—', freqMhz: 0 };
        }
    }

    async readMemory() {
        try {
            const txt = await _readFileAsync('/proc/meminfo');
            if (!txt) return { usagePct: 0, usedBytes: 0, totalBytes: 0, availBytes: 0, cachedBytes: 0, swapUsagePct: 0, swapUsedBytes: 0, swapTotalBytes: 0 };

            const memTotal = parseInt(txt.match(/MemTotal:\s+(\d+)/)?.[1] || '0') * 1024;
            const memFree = parseInt(txt.match(/MemFree:\s+(\d+)/)?.[1] || '0') * 1024;
            const memAvail = parseInt(txt.match(/MemAvailable:\s+(\d+)/)?.[1] || '0') * 1024;
            const buffers = parseInt(txt.match(/Buffers:\s+(\d+)/)?.[1] || '0') * 1024;
            const cached = parseInt(txt.match(/Cached:\s+(\d+)/)?.[1] || '0') * 1024;
            const swapTotal = parseInt(txt.match(/SwapTotal:\s+(\d+)/)?.[1] || '0') * 1024;
            const swapFree = parseInt(txt.match(/SwapFree:\s+(\d+)/)?.[1] || '0') * 1024;

            const usedBytes = Math.max(0, memTotal - memAvail);
            const usagePct = memTotal > 0 ? (usedBytes / memTotal) * 100 : 0;

            const swapUsedBytes = Math.max(0, swapTotal - swapFree);
            const swapUsagePct = swapTotal > 0 ? (swapUsedBytes / swapTotal) * 100 : 0;

            return {
                usagePct,
                usedBytes,
                totalBytes: memTotal,
                availBytes: memAvail,
                cachedBytes: cached + buffers,
                swapUsagePct,
                swapUsedBytes,
                swapTotalBytes: swapTotal
            };
        } catch (e) {
            return { usagePct: 0, usedBytes: 0, totalBytes: 0, availBytes: 0, cachedBytes: 0, swapUsagePct: 0, swapUsedBytes: 0, swapTotalBytes: 0 };
        }
    }

    async readAllGpus() {
        if (!this.gpus || this.gpus.length === 0) return [];
        const list = [];
        for (const gpu of this.gpus) {
            try {
                if (gpu.type === 'nvidia') {
                    const utilTxt = await _execCommandAsync(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.current.graphics', '--format=csv,noheader,nounits']);
                    if (utilTxt && !utilTxt.includes('Failed')) {
                        const [util, memUsed, memTotal, temp, clock] = utilTxt.trim().split(',').map(s => s.trim());
                        const uVal = parseInt(util) || 0;
                        const usedMB = parseInt(memUsed) || 0;
                        const totMB = parseInt(memTotal) || 0;
                        let detail = `${usedMB} / ${totMB} MB`;
                        if (totMB >= 4096 && usedMB >= 1024) {
                            detail = `${(usedMB / 1024).toFixed(1)} / ${(totMB / 1024).toFixed(1)} GB`;
                        }
                        list.push({
                            name: gpu.name || 'RTX 3050',
                            type: 'nvidia',
                            usagePct: uVal,
                            vramUsedBytes: usedMB * 1048576,
                            vramTotalBytes: totMB * 1048576,
                            temp: parseInt(temp) || 0,
                            clockMhz: parseInt(clock) || 0,
                            detail
                        });
                    }
                } else if (gpu.type === 'intel') {
                    let actPath = `/sys/class/drm/card${gpu.cardIndex}/gt/gt0/rps_act_freq_mhz`;
                    let maxPath = `/sys/class/drm/card${gpu.cardIndex}/gt/gt0/rps_max_freq_mhz`;
                    let act = 0, max = 0, usagePct = 0;
                    if (GLib.file_test(actPath, GLib.FileTest.EXISTS) && GLib.file_test(maxPath, GLib.FileTest.EXISTS)) {
                        let r1 = await _readFileAsync(actPath);
                        let r2 = await _readFileAsync(maxPath);
                        if (r1 && r2) {
                            act = parseInt(r1.trim()) || 0;
                            max = parseInt(r2.trim()) || 0;
                            usagePct = max > 0 ? (act / max) * 100 : 0;
                        }
                    }
                    list.push({
                        name: gpu.name || 'Iris Xe',
                        type: 'intel',
                        usagePct,
                        vramUsedBytes: 0,
                        vramTotalBytes: 0,
                        temp: 0,
                        clockMhz: act,
                        detail: max > 0 ? `${act} / ${max} MHz` : 'Usage'
                    });
                } else if (gpu.type === 'amd') {
                    const busyPath = `/sys/class/drm/card${gpu.cardIndex}/device/gpu_busy_percent`;
                    let usagePct = 0;
                    if (GLib.file_test(busyPath, GLib.FileTest.EXISTS)) {
                        let raw = await _readFileAsync(busyPath);
                        if (raw) usagePct = parseInt(raw.trim()) || 0;
                    }
                    list.push({
                        name: gpu.name || 'AMD Radeon',
                        type: 'amd',
                        usagePct,
                        vramUsedBytes: 0,
                        vramTotalBytes: 0,
                        temp: 0,
                        clockMhz: 0,
                        detail: 'Usage'
                    });
                }
            } catch (e) {}
        }
        return list;
    }

    async readGpu() {
        const all = await this.readAllGpus();
        if (!all || all.length === 0) return null;
        const activeNv = all.find(g => g.type === 'nvidia');
        if (activeNv && (activeNv.usagePct > 0 || all.length === 1)) return activeNv;
        return all[0];
    }

    async readDisks() {
        try {
            const disks = [];
            let primaryUsagePct = 0;
            let primaryUsed = 0;
            let primaryTotal = 0;

            const dfTxt = await _execCommandAsync(['df', '-kP']);
            if (dfTxt) {
                const lines = dfTxt.split('\n');
                for (let i = 1; i < lines.length; i++) {
                    const parts = lines[i].trim().split(/\s+/);
                    if (parts.length >= 6) {
                        const filesystem = parts[0];
                        const totalBytes = (parseInt(parts[1]) || 0) * 1024;
                        const usedBytes = (parseInt(parts[2]) || 0) * 1024;
                        const availBytes = (parseInt(parts[3]) || 0) * 1024;
                        const pctStr = parts[4].replace('%', '');
                        const usagePct = parseInt(pctStr) || 0;
                        const mount = parts[5];

                        // Filter virtual / snap mounts
                        if (mount.startsWith('/snap') || mount.startsWith('/sys') || mount.startsWith('/dev') || mount.startsWith('/run'))
                            continue;

                        disks.push({
                            mount,
                            filesystem,
                            usedBytes,
                            totalBytes,
                            availBytes,
                            usagePct
                        });

                        if (mount === '/') {
                            primaryUsagePct = usagePct;
                            primaryUsed = usedBytes;
                            primaryTotal = totalBytes;
                        }
                    }
                }
            }

            // Read Disk I/O rate from /proc/diskstats
            let readSpeed = 0;
            let writeSpeed = 0;
            const now = GLib.get_monotonic_time();
            const statTxt = await _readFileAsync('/proc/diskstats');
            if (statTxt) {
                let totalReadSectors = 0;
                let totalWriteSectors = 0;
                const lines = statTxt.split('\n');
                for (const line of lines) {
                    const p = line.trim().split(/\s+/);
                    if (p.length >= 14) {
                        const dev = p[2];
                        if (dev.startsWith('sd') || dev.startsWith('nvme') || dev.startsWith('vd')) {
                            // Sectors read is field 5 (index 5 in 0-indexed split without leading space)
                            totalReadSectors += parseInt(p[5]) || 0;
                            totalWriteSectors += parseInt(p[9]) || 0;
                        }
                    }
                }

                if (this.prevDiskStats && this.prevDiskTime > 0) {
                    const timeDelta = (now - this.prevDiskTime) / 1000000; // seconds
                    if (timeDelta > 0) {
                        const readBytes = (totalReadSectors - this.prevDiskStats.readSectors) * 512;
                        const writeBytes = (totalWriteSectors - this.prevDiskStats.writeSectors) * 512;
                        readSpeed = Math.max(0, readBytes / timeDelta);
                        writeSpeed = Math.max(0, writeBytes / timeDelta);
                    }
                }
                this.prevDiskStats = { readSectors: totalReadSectors, writeSectors: totalWriteSectors };
                this.prevDiskTime = now;
            }

            return { primaryUsagePct, primaryUsed, primaryTotal, disks, readSpeed, writeSpeed };
        } catch (e) {
            return { primaryUsagePct: 0, primaryUsed: 0, primaryTotal: 0, disks: [], readSpeed: 0, writeSpeed: 0 };
        }
    }

    async readNetwork() {
        try {
            const now = GLib.get_monotonic_time();
            const txt = await _readFileAsync('/proc/net/dev');
            if (!txt) return { rxSpeed: 0, txSpeed: 0, totalRx: 0, totalTx: 0, interfaces: [] };

            let totalRxBytes = 0;
            let totalTxBytes = 0;
            const interfaces = [];

            const lines = txt.split('\n');
            for (let i = 2; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                const colon = line.indexOf(':');
                if (colon === -1) continue;

                const iface = line.substring(0, colon).trim();
                if (iface === 'lo') continue; // skip loopback

                const parts = line.substring(colon + 1).trim().split(/\s+/);
                const rxBytes = parseInt(parts[0]) || 0;
                const txBytes = parseInt(parts[8]) || 0;

                totalRxBytes += rxBytes;
                totalTxBytes += txBytes;

                interfaces.push({ iface, rxBytes, txBytes });
            }

            let rxSpeed = 0;
            let txSpeed = 0;

            if (this.prevNetStats && this.prevNetTime > 0) {
                const timeDelta = (now - this.prevNetTime) / 1000000;
                if (timeDelta > 0) {
                    rxSpeed = Math.max(0, (totalRxBytes - this.prevNetStats.rxBytes) / timeDelta);
                    txSpeed = Math.max(0, (totalTxBytes - this.prevNetStats.txBytes) / timeDelta);
                }
            }
            this.prevNetStats = { rxBytes: totalRxBytes, txBytes: totalTxBytes };
            this.prevNetTime = now;

            return { rxSpeed, txSpeed, totalRx: totalRxBytes, totalTx: totalTxBytes, interfaces };
        } catch (e) {
            return { rxSpeed: 0, txSpeed: 0, totalRx: 0, totalTx: 0, interfaces: [] };
        }
    }

    async readSensors(tempUnit = 'celsius') {
        try {
            let primaryTemp = 0;
            const sensorList = [];

            // Scan /sys/class/hwmon
            for (let i = 0; i < 10; i++) {
                let namePath = `/sys/class/hwmon/hwmon${i}/name`;
                if (GLib.file_test(namePath, GLib.FileTest.EXISTS)) {
                    let chipName = (await _readFileAsync(namePath))?.trim() || `Sensor ${i}`;

                    // Check temp inputs
                    for (let t = 1; t <= 10; t++) {
                        let inputPath = `/sys/class/hwmon/hwmon${i}/temp${t}_input`;
                        let labelPath = `/sys/class/hwmon/hwmon${i}/temp${t}_label`;
                        if (GLib.file_test(inputPath, GLib.FileTest.EXISTS)) {
                            let rawVal = await _readFileAsync(inputPath);
                            let rawLabel = GLib.file_test(labelPath, GLib.FileTest.EXISTS) ? await _readFileAsync(labelPath) : null;
                            if (rawVal) {
                                let cVal = parseInt(rawVal.trim()) / 1000;
                                let label = rawLabel?.trim() || `${chipName} Temp ${t}`;
                                let displayVal = tempUnit === 'fahrenheit' ? Math.round((cVal * 9/5) + 32) : Math.round(cVal);

                                sensorList.push({ label, tempC: cVal, displayVal, unit: tempUnit === 'fahrenheit' ? '°F' : '°C' });

                                if (!primaryTemp || label.toLowerCase().includes('package') || label.toLowerCase().includes('tctl') || label.toLowerCase().includes('core')) {
                                    primaryTemp = displayVal;
                                }
                            }
                        }
                    }
                }
            }

            // Fallback to /sys/class/thermal
            if (sensorList.length === 0) {
                let thPath = '/sys/class/thermal/thermal_zone0/temp';
                if (GLib.file_test(thPath, GLib.FileTest.EXISTS)) {
                    let raw = await _readFileAsync(thPath);
                    if (raw) {
                        let cVal = parseInt(raw.trim()) / 1000;
                        let displayVal = tempUnit === 'fahrenheit' ? Math.round((cVal * 9/5) + 32) : Math.round(cVal);
                        sensorList.push({ label: 'CPU Package', tempC: cVal, displayVal, unit: tempUnit === 'fahrenheit' ? '°F' : '°C' });
                        primaryTemp = displayVal;
                    }
                }
            }

            return { primaryTemp, sensorList, unit: tempUnit === 'fahrenheit' ? '°F' : '°C' };
        } catch (e) {
            return { primaryTemp: 0, sensorList: [], unit: '°C' };
        }
    }

    async readTopProcesses() {
        try {
            // Get top CPU processes
            const cpuTxt = await _execCommandAsync(['ps', '-eo', 'pid,pcpu,pmem,comm', '--sort=-pcpu', '--no-headers']);
            const topCpu = [];
            if (cpuTxt) {
                const lines = cpuTxt.split('\n').slice(0, 5);
                for (const line of lines) {
                    const p = line.trim().split(/\s+/);
                    if (p.length >= 4) {
                        topCpu.push({ pid: p[0], cpu: parseFloat(p[1]) || 0, mem: parseFloat(p[2]) || 0, name: p.slice(3).join(' ') });
                    }
                }
            }

            // Get top Memory processes
            const memTxt = await _execCommandAsync(['ps', '-eo', 'pid,pmem,rss,comm', '--sort=-pmem', '--no-headers']);
            const topMem = [];
            if (memTxt) {
                const lines = memTxt.split('\n').slice(0, 5);
                for (const line of lines) {
                    const p = line.trim().split(/\s+/);
                    if (p.length >= 4) {
                        const rssKb = parseInt(p[2]) || 0;
                        topMem.push({ pid: p[0], mem: parseFloat(p[1]) || 0, rssStr: formatBytes(rssKb * 1024), name: p.slice(3).join(' ') });
                    }
                }
            }

            return { topCpu, topMem };
        } catch (e) {
            return { topCpu: [], topMem: [] };
        }
    }

    async readSystemInfo() {
        try {
            let uptimeStr = '—';
            const upTxt = await _readFileAsync('/proc/uptime');
            if (upTxt) {
                const secs = parseInt(upTxt.trim().split(/\s+/)[0]) || 0;
                const hours = Math.floor(secs / 3600);
                const mins = Math.floor((secs % 3600) / 60);
                uptimeStr = `${hours}h ${mins}m`;
            }

            let osName = 'Linux';
            const osTxt = await _readFileAsync('/etc/os-release');
            if (osTxt) {
                const match = osTxt.match(/PRETTY_NAME="?([^"\n]+)"?/);
                if (match) osName = match[1];
            }

            const hostname = GLib.get_host_name() || 'localhost';

            return { uptimeStr, osName, hostname };
        } catch (e) {
            return { uptimeStr: '—', osName: 'Linux', hostname: 'localhost' };
        }
    }
}

/* ── UI Components: Indicator Item & Progress Bars ────────────────── */

class IndicatorItem {
    constructor(iconParam, defaultLabel, isSublabel = false, extraClass = '') {
        this.actor = new St.BoxLayout({
            style_class: `zeo-indicator-item ${extraClass}`.trim(),
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (iconParam) {
            const iconProps = { style_class: 'zeo-indicator-icon' };
            if (typeof iconParam === 'string') {
                iconProps.icon_name = iconParam;
            } else if (iconParam instanceof Gio.Icon) {
                iconProps.gicon = iconParam;
            }
            this.icon = new St.Icon(iconProps);
            this.actor.add_child(this.icon);
        }

        this.label = new St.Label({
            text: defaultLabel,
            style_class: isSublabel ? 'zeo-indicator-sublabel' : 'zeo-indicator-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this.label);
    }

    setText(text) {
        this.label.set_text(text);
    }

    setIconVisible(visible) {
        if (this.icon) this.icon.visible = visible;
    }

    destroy() {
        this.actor.destroy();
    }
}

/* ── Ring chart constants ────────────────────────────────────────── */
const RING_SIZE   = 80;    // canvas px
const RING_RADIUS = 28;    // centre-of-stroke radius
const RING_STROKE = 6;     // stroke width

function hexToRGB(str) {
    if (!str) return [1, 1, 1];
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
    return { from: c, to: [Math.max(0, c[0] - 0.2), Math.max(0, c[1] - 0.2), Math.max(0, c[2] - 0.2)] };
}

/* ── Cairo ring painter ──────────────────────────────────────────── */
function _paintRing(cr, width, height, pct, pal, isLight = false) {
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
    if (isLight) {
        cr.setSourceRGBA(0, 0, 0, 0.08);
    } else {
        cr.setSourceRGBA(1, 1, 1, 0.08);
    }
    cr.arc(cx, cy, RING_RADIUS, 0, 2 * Math.PI);
    cr.stroke();

    if (frac <= 0)
        return;

    // Foreground arc with diagonal gradient
    const startAngle = -Math.PI / 2;                       // 12-o'clock
    const endAngle   = startAngle + Math.max(frac * 2 * Math.PI, 0.06);

    const grad = new Cairo.LinearGradient(
        cx - RING_RADIUS, cy - RING_RADIUS,
        cx + RING_RADIUS, cy + RING_RADIUS
    );
    grad.addColorStopRGBA(0, pal.from[0], pal.from[1], pal.from[2], 1);
    grad.addColorStopRGBA(1, pal.to[0],   pal.to[1],   pal.to[2],   1);

    // Soft outer glow
    cr.setSourceRGBA(pal.from[0], pal.from[1], pal.from[2], 0.12);
    cr.setLineWidth(RING_STROKE + 10);
    cr.setLineCap(Cairo.LineCap.ROUND);
    if (frac >= 0.99)
        cr.arc(cx, cy, RING_RADIUS, 0, 2 * Math.PI);
    else
        cr.arc(cx, cy, RING_RADIUS, startAngle, endAngle);
    cr.stroke();

    // Foreground arc
    cr.setSource(grad);
    cr.setLineWidth(RING_STROKE);
    cr.setLineCap(Cairo.LineCap.ROUND);
    if (frac >= 0.99)
        cr.arc(cx, cy, RING_RADIUS, 0, 2 * Math.PI);
    else
        cr.arc(cx, cy, RING_RADIUS, startAngle, endAngle);
    cr.stroke();
}

class RingCell {
    constructor(label, palette) {
        this._pct = 0;
        this._pal = palette;
        this._isLight = false;

        // St.DrawingArea for Cairo ring drawing
        this._drawingArea = new St.DrawingArea({
            width: RING_SIZE,
            height: RING_SIZE,
        });
        this._signalTracker = {};
        this._drawingArea.connectObject('repaint', (area) => {
            let cr = area.get_context();
            let [w, h] = area.get_surface_size();
            _paintRing(cr, w, h, this._pct, this._pal, this._isLight);
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
            width: RING_SIZE,
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

        // Detail line (e.g. "3.8 / 15.2 GB")
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

    setTheme(isLight) {
        this._isLight = isLight;
        if (this._drawingArea) {
            this._drawingArea.queue_repaint();
        }
    }

    update(pct, detail) {
        this._pct = pct;
        this._pctLabel.set_text(`${Math.round(pct)}%`);
        if (detail !== undefined && detail !== null) {
            this._detailLabel.set_text(detail);
        }
        if (this._drawingArea) {
            this._drawingArea.queue_repaint();
        }
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

function createProgressBar(percent = 0, isAlt = false) {
    const track = new St.BoxLayout({
        style_class: 'zeo-progress-track',
        x_expand: true,
    });
    const fill = new St.Widget({
        style_class: isAlt ? 'zeo-progress-fill-alt' : 'zeo-progress-fill',
        width: 0,
    });
    track.add_child(fill);

    let currentPct = Math.min(100, Math.max(0, Number(percent) || 0));

    const applyWidth = () => {
        const totalW = track.get_width();
        if (totalW > 0) {
            const w = Math.round((totalW * currentPct) / 100);
            fill.set_width(Math.max(0, Math.min(totalW, w)));
        }
    };

    track.connect('notify::allocation', () => {
        applyWidth();
    });

    track.updatePercent = (pct) => {
        currentPct = Math.min(100, Math.max(0, Number(pct) || 0));
        applyWidth();
    };

    track.updatePercent(percent);

    return track;
}

/* ── Desktop Card Widget (5 Circular Gauges) ───────────────────────── */

class ZeoDesktopWidget {
    constructor(settings, extPath) {
        this._settings = settings;
        this._extPath = extPath;
        this._gpuCells = [];
        this._isLight = false;

        this.actor = new St.BoxLayout({
            style_class: 'zeo-sysmon-card',
            vertical: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._row = new St.BoxLayout({
            style_class: 'zeo-ring-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._row);

        const cpuCol = this._settings.get_string('cpu-color') || '#ff3340';
        const memCol = this._settings.get_string('mem-color') || '#00d3ff';
        const diskCol = this._settings.get_string('disk-color') || '#ff9400';

        this._cpuCell = new RingCell('CPU', getColorPal(cpuCol));
        this._memCell = new RingCell('Memory', getColorPal(memCol));
        this._diskCell = new RingCell('Disk', getColorPal(diskCol));

        this._row.add_child(this._cpuCell.actor);
        this._row.add_child(this._memCell.actor);
        this._row.add_child(this._diskCell.actor);

        this._initDragging();
    }

    _initGpuCells(gpus) {
        for (const cell of this._gpuCells) {
            this._row.remove_child(cell.actor);
            cell.destroy();
        }
        this._gpuCells = [];

        for (const gpu of gpus) {
            let colorKey = gpu.type === 'intel' ? 'igpu-color' : 'dgpu-color';
            let defaultHex = gpu.type === 'intel' ? '#00d3ff' : '#b051de';
            let hex = this._settings.get_string(colorKey) || defaultHex;
            let cell = new RingCell(gpu.name, getColorPal(hex));
            cell._gpuId = gpu.name;
            cell._gpuType = gpu.type;
            cell.setTheme(this._isLight);
            this._gpuCells.push(cell);
            this._row.add_child(cell.actor);
        }
    }

    _initDragging() {
        let isDragging = false;
        let startX = 0, startY = 0;
        let actorStartX = 0, actorStartY = 0;

        this.actor.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 1) {
                isDragging = true;
                const [x, y] = event.get_coords();
                startX = x;
                startY = y;
                actorStartX = this.actor.get_x();
                actorStartY = this.actor.get_y();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.actor.connect('motion-event', (actor, event) => {
            if (isDragging) {
                const [x, y] = event.get_coords();
                const primary = Main.layoutManager.primaryMonitor;
                const newX = Math.max(primary.x, Math.min(primary.x + primary.width - 200, actorStartX + (x - startX)));
                const newY = Math.max(primary.y + 35, Math.min(primary.y + primary.height - 100, actorStartY + (y - startY)));
                this.actor.set_position(newX, newY);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.actor.connect('button-release-event', (actor, event) => {
            if (isDragging) {
                isDragging = false;
                const finalX = Math.round(this.actor.get_x());
                const finalY = Math.round(this.actor.get_y());
                this._settings.set_int('desktop-widget-x', finalX);
                this._settings.set_int('desktop-widget-y', finalY);
                this._settings.set_int('pos-x', finalX);
                this._settings.set_int('pos-y', finalY);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    update(cpuData, memData, allGpus, diskData, netData, sensorData, sysInfo) {
        // CPU
        if (this._cpuCell) {
            this._cpuCell.update(cpuData.totalUsage, 'Usage');
        }

        // Memory
        if (this._memCell) {
            const usedGB = memData.usedBytes / 1073741824;
            const totGB = memData.totalBytes / 1073741824;
            this._memCell.update(memData.usagePct, `${usedGB.toFixed(1)} / ${totGB.toFixed(1)} GB`);
        }

        // Disk
        if (this._diskCell) {
            const uGB = diskData.primaryUsed / 1073741824;
            const tGB = diskData.primaryTotal / 1073741824;
            this._diskCell.update(diskData.primaryUsagePct, `${Math.round(uGB)} / ${Math.round(tGB)} GB`);
        }

        // GPUs
        if (allGpus && allGpus.length > 0) {
            if (this._gpuCells.length !== allGpus.length) {
                this._initGpuCells(allGpus);
            }
            for (let i = 0; i < allGpus.length; i++) {
                const gData = allGpus[i];
                if (this._gpuCells[i]) {
                    this._gpuCells[i].update(gData.usagePct, gData.detail);
                }
            }
        }
    }

    setTheme(isLight) {
        this._isLight = isLight;
        if (isLight) {
            this.actor.add_style_class_name('light-theme');
        } else {
            this.actor.remove_style_class_name('light-theme');
        }
        if (this._cpuCell) this._cpuCell.setTheme(isLight);
        if (this._memCell) this._memCell.setTheme(isLight);
        if (this._diskCell) this._diskCell.setTheme(isLight);
        for (let cell of this._gpuCells) {
            if (cell) cell.setTheme(isLight);
        }
    }

    destroy() {
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
        this.actor.destroy();
    }
}

/* ── Panel Indicator Button ────────────────────────────────────────── */

const ZeoMonitorIndicator = GObject.registerClass(
class ZeoMonitorIndicator extends PanelMenu.Button {
    _init(settings, openPreferences, extPath = '') {
        super._init(0.5, 'Zeo Monitor', false);

        this._settings = settings;
        this._openPreferences = openPreferences;
        this._extPath = extPath;
        this._desktopWidget = null;
        this._collector = new SystemMetricsCollector();

        this._activeTab = 'overview'; // 'overview', 'cpu', 'memory', 'storage', 'network', 'sensors'

        // ── Build Panel Indicators Container ─────────────────────────
        this._panelBox = new St.BoxLayout({
            style_class: 'zeo-panel-box',
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        // Resolve custom CPU, Memory, GPU, and Temperature symbolic icons
        let cpuIcon = 'utilities-system-monitor-symbolic';
        let memIcon = 'media-flash-symbolic';
        let gpuIcon = 'video-display-symbolic';
        let tempIcon = 'temperature-symbolic';
        if (extPath) {
            const cpuPath = `${extPath}/icons/cpu-symbolic.svg`;
            if (GLib.file_test(cpuPath, GLib.FileTest.EXISTS)) {
                cpuIcon = Gio.FileIcon.new(Gio.File.new_for_path(cpuPath));
            }
            const memPath = `${extPath}/icons/memory-symbolic.svg`;
            if (GLib.file_test(memPath, GLib.FileTest.EXISTS)) {
                memIcon = Gio.FileIcon.new(Gio.File.new_for_path(memPath));
            }
            const gpuPath = `${extPath}/icons/gpu-symbolic.svg`;
            if (GLib.file_test(gpuPath, GLib.FileTest.EXISTS)) {
                gpuIcon = Gio.FileIcon.new(Gio.File.new_for_path(gpuPath));
            }
            const tempPath = `${extPath}/icons/temp-symbolic.svg`;
            if (GLib.file_test(tempPath, GLib.FileTest.EXISTS)) {
                tempIcon = Gio.FileIcon.new(Gio.File.new_for_path(tempPath));
            }
        }

        // Indicator items with dedicated stable width classes
        this._cpuInd = new IndicatorItem(cpuIcon, '0%', false, 'zeo-ind-percent');
        this._memInd = new IndicatorItem(memIcon, '0%', false, 'zeo-ind-percent');
        this._gpuInd = new IndicatorItem(gpuIcon, '0%', false, 'zeo-ind-percent');
        this._diskInd = new IndicatorItem('drive-harddisk-symbolic', '0%', false, 'zeo-ind-percent');
        this._netInd = new IndicatorItem(null, '↓ 0 B/s ↑ 0 B/s', false, 'zeo-ind-net');
        this._tempInd = new IndicatorItem(tempIcon, '0°C', false, 'zeo-ind-temp');

        this._panelBox.add_child(this._cpuInd.actor);
        this._panelBox.add_child(this._memInd.actor);
        this._panelBox.add_child(this._gpuInd.actor);
        this._panelBox.add_child(this._diskInd.actor);
        this._panelBox.add_child(this._netInd.actor);
        this._panelBox.add_child(this._tempInd.actor);

        // ── Build Popup Menu ─────────────────────────────────────────
        this._buildMenu();

        // ── Settings sync ────────────────────────────────────────────
        this._syncIndicatorVisibility();
        this._settings.connectObject('changed', (s, key) => {
            if (key.startsWith('show-') || key === 'compact-mode' || key === 'show-icons') {
                this._syncIndicatorVisibility();
            } else if (key === 'update-interval') {
                this._setupTimer();
            }
        }, this);

        // Menu open/close hooks for detailed vs top bar only polling
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._refreshAll().catch(console.error);
            }
        });

        // ── Start Polling Timer ──────────────────────────────────────
        this._refreshAll().catch(console.error);
        this._setupTimer();
    }

    _syncIndicatorVisibility() {
        const showCpu = this._settings.get_boolean('show-cpu');
        const showMem = this._settings.get_boolean('show-memory');
        const showGpu = this._settings.get_boolean('show-gpu');
        const showDisk = this._settings.get_boolean('show-disk');
        const showNet = this._settings.get_boolean('show-network');
        const showSensors = this._settings.get_boolean('show-sensors');
        const showIcons = this._settings.get_boolean('show-icons');

        this._cpuInd.actor.visible = showCpu;
        this._memInd.actor.visible = showMem;
        this._gpuInd.actor.visible = showGpu;
        this._diskInd.actor.visible = showDisk;
        this._netInd.actor.visible = showNet;
        this._tempInd.actor.visible = showSensors;

        this._cpuInd.setIconVisible(showIcons);
        this._memInd.setIconVisible(showIcons);
        this._gpuInd.setIconVisible(showIcons);
        this._diskInd.setIconVisible(showIcons);
        this._netInd.setIconVisible(showIcons);
        this._tempInd.setIconVisible(showIcons);
    }

    _setupTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        const interval = Math.max(1, this._settings.get_int('update-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refreshAll().catch(console.error);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('zeo-monitor-menu');

        // 1. Header Area
        const headerBox = new St.BoxLayout({
            style_class: 'zeo-menu-header',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const titleBox = new St.BoxLayout({ vertical: true, x_expand: true });
        this._headerTitle = new St.Label({ text: 'Zeo Monitor', style_class: 'zeo-menu-title' });
        this._headerSub = new St.Label({ text: 'Loading system...', style_class: 'zeo-menu-subtitle' });
        titleBox.add_child(this._headerTitle);
        titleBox.add_child(this._headerSub);
        headerBox.add_child(titleBox);

        this._uptimeBadge = new St.Label({ text: 'Up —', style_class: 'zeo-badge' });
        headerBox.add_child(this._uptimeBadge);

        this.menu.box.add_child(headerBox);

        // 2. Navigation Tab Bar
        const tabBar = new St.BoxLayout({ style_class: 'zeo-tab-bar' });
        const tabs = [
            { id: 'overview', label: 'Overview' },
            { id: 'cpu', label: 'CPU' },
            { id: 'memory', label: 'Memory' },
            { id: 'storage', label: 'Storage' },
            { id: 'network', label: 'Network' },
            { id: 'sensors', label: 'Sensors' },
        ];

        this._tabButtons = {};
        for (const t of tabs) {
            const btn = new St.Button({
                label: t.label,
                style_class: `zeo-tab-btn ${t.id === this._activeTab ? 'active' : ''}`,
                reactive: true,
            });
            btn.connect('clicked', () => {
                this._switchTab(t.id);
            });
            this._tabButtons[t.id] = btn;
            tabBar.add_child(btn);
        }
        this.menu.box.add_child(tabBar);

        // 3. Tab Content Containers
        this._contentStack = new St.BoxLayout({ vertical: true, x_expand: true });
        this.menu.box.add_child(this._contentStack);

        this._buildOverviewTab();
        this._buildCpuTab();
        this._buildMemoryTab();
        this._buildStorageTab();
        this._buildNetworkTab();
        this._buildSensorsTab();

        this._switchTab('overview');

        // 4. Footer Actions
        const footerBox = new St.BoxLayout({
            style_class: 'zeo-menu-footer',
            vertical: false,
            x_expand: true,
        });

        const sysMonBtn = new St.Button({
            label: 'System Monitor',
            style_class: 'zeo-footer-btn',
            x_expand: true,
            reactive: true,
        });
        sysMonBtn.connect('clicked', () => {
            this.menu.close();
            try {
                Gio.AppInfo.launch_default_for_uri_async('app://org.gnome.SystemMonitor.desktop', null, null, (app, res) => {
                    if (!res) {
                        _execCommandAsync(['gnome-system-monitor']);
                    }
                });
            } catch (e) {
                _execCommandAsync(['gnome-system-monitor']);
            }
        });
        footerBox.add_child(sysMonBtn);

        const prefsBtn = new St.Button({
            label: 'Preferences',
            style_class: 'zeo-footer-btn',
            x_expand: true,
            reactive: true,
        });
        prefsBtn.connect('clicked', () => {
            this.menu.close();
            if (this._openPreferences) this._openPreferences();
        });
        footerBox.add_child(prefsBtn);

        this.menu.box.add_child(footerBox);
    }

    _switchTab(tabId) {
        this._activeTab = tabId;
        for (const [id, btn] of Object.entries(this._tabButtons)) {
            if (id === tabId) btn.add_style_class_name('active');
            else btn.remove_style_class_name('active');
        }

        this._tabOverview.visible = (tabId === 'overview');
        this._tabCpu.visible = (tabId === 'cpu');
        this._tabMemory.visible = (tabId === 'memory');
        this._tabStorage.visible = (tabId === 'storage');
        this._tabNetwork.visible = (tabId === 'network');
        this._tabSensors.visible = (tabId === 'sensors');

        this._refreshAll().catch(console.error);
    }

    /* ── Overview Tab View ─────────────────────────────────────────── */
    _buildOverviewTab() {
        this._tabOverview = new St.BoxLayout({ vertical: true, x_expand: true });

        // CPU Summary Card
        this._ovCpuCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        const cpuHead = new St.BoxLayout({ x_expand: true });
        cpuHead.add_child(new St.Label({ text: 'CPU Usage', style_class: 'zeo-card-title', x_expand: true }));
        this._ovCpuVal = new St.Label({ text: '0%', style_class: 'zeo-card-value' });
        cpuHead.add_child(this._ovCpuVal);
        this._ovCpuCard.add_child(cpuHead);
        this._ovCpuBar = createProgressBar(0);
        this._ovCpuCard.add_child(this._ovCpuBar);
        this._ovCpuSub = new St.Label({ text: 'Load: — | Freq: —', style_class: 'zeo-card-subtext' });
        this._ovCpuCard.add_child(this._ovCpuSub);
        this._tabOverview.add_child(this._ovCpuCard);

        // Memory Summary Card
        this._ovMemCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        const memHead = new St.BoxLayout({ x_expand: true });
        memHead.add_child(new St.Label({ text: 'Memory & Swap', style_class: 'zeo-card-title', x_expand: true }));
        this._ovMemVal = new St.Label({ text: '0%', style_class: 'zeo-card-value' });
        memHead.add_child(this._ovMemVal);
        this._ovMemCard.add_child(memHead);
        this._ovMemBar = createProgressBar(0);
        this._ovMemCard.add_child(this._ovMemBar);
        this._ovMemSub = new St.Label({ text: 'Used: 0 GB / 0 GB', style_class: 'zeo-card-subtext' });
        this._ovMemCard.add_child(this._ovMemSub);
        this._tabOverview.add_child(this._ovMemCard);

        // Network & Storage Row Card
        const splitRow = new St.BoxLayout({ style_class: 'zeo-split-row', x_expand: true });

        this._ovDiskCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true, x_expand: true });
        this._ovDiskCard.add_child(new St.Label({ text: 'Storage (Root)', style_class: 'zeo-card-title' }));
        this._ovDiskVal = new St.Label({ text: '0%', style_class: 'zeo-card-value' });
        this._ovDiskCard.add_child(this._ovDiskVal);
        this._ovDiskBar = createProgressBar(0);
        this._ovDiskCard.add_child(this._ovDiskBar);
        this._ovDiskSub = new St.Label({ text: '0 GB / 0 GB', style_class: 'zeo-card-subtext' });
        this._ovDiskCard.add_child(this._ovDiskSub);
        splitRow.add_child(this._ovDiskCard);

        this._ovNetCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true, x_expand: true });
        this._ovNetCard.add_child(new St.Label({ text: 'Network Bandwidth', style_class: 'zeo-card-title' }));
        this._ovNetDown = new St.Label({ text: '↓ 0 B/s', style_class: 'zeo-card-value' });
        this._ovNetUp = new St.Label({ text: '↑ 0 B/s', style_class: 'zeo-card-subtext' });
        this._ovNetCard.add_child(this._ovNetDown);
        this._ovNetCard.add_child(this._ovNetUp);
        splitRow.add_child(this._ovNetCard);

        this._tabOverview.add_child(splitRow);

        this._contentStack.add_child(this._tabOverview);
    }

    /* ── CPU Tab View ──────────────────────────────────────────────── */
    _buildCpuTab() {
        this._tabCpu = new St.BoxLayout({ vertical: true, x_expand: true });

        // Overall CPU Card
        const cpuCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        const cpuHead = new St.BoxLayout({ x_expand: true });
        cpuHead.add_child(new St.Label({ text: 'Total CPU Utilization', style_class: 'zeo-card-title', x_expand: true }));
        this._cpuTabVal = new St.Label({ text: '0%', style_class: 'zeo-card-value' });
        cpuHead.add_child(this._cpuTabVal);
        cpuCard.add_child(cpuHead);

        this._cpuTabBar = createProgressBar(0);
        cpuCard.add_child(this._cpuTabBar);

        this._cpuTabInfo = new St.Label({ text: 'Load: — | Frequency: —', style_class: 'zeo-card-subtext' });
        cpuCard.add_child(this._cpuTabInfo);

        // Core Grid
        this._cpuCoreContainer = new St.BoxLayout({ style_class: 'zeo-core-grid', vertical: true });
        cpuCard.add_child(this._cpuCoreContainer);

        this._tabCpu.add_child(cpuCard);

        // Top CPU Processes Card
        const procCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        procCard.add_child(new St.Label({ text: 'Top Processes by CPU', style_class: 'zeo-card-title' }));

        const tableHead = new St.BoxLayout({ style_class: 'zeo-table-header' });
        tableHead.add_child(new St.Label({ text: 'PID', style_class: 'zeo-pid-col' }));
        tableHead.add_child(new St.Label({ text: 'PROCESS', style_class: 'zeo-name-col', x_expand: true }));
        tableHead.add_child(new St.Label({ text: 'CPU %', style_class: 'zeo-val-col' }));
        procCard.add_child(tableHead);

        this._cpuProcTable = new St.BoxLayout({ style_class: 'zeo-table', vertical: true });
        procCard.add_child(this._cpuProcTable);

        this._tabCpu.add_child(procCard);
        this._contentStack.add_child(this._tabCpu);
    }

    /* ── Memory Tab View ───────────────────────────────────────────── */
    _buildMemoryTab() {
        this._tabMemory = new St.BoxLayout({ vertical: true, x_expand: true });

        // RAM Card
        const ramCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        const ramHead = new St.BoxLayout({ x_expand: true });
        ramHead.add_child(new St.Label({ text: 'Physical Memory (RAM)', style_class: 'zeo-card-title', x_expand: true }));
        this._ramVal = new St.Label({ text: '0%', style_class: 'zeo-card-value' });
        ramHead.add_child(this._ramVal);
        ramCard.add_child(ramHead);

        this._ramBar = createProgressBar(0);
        ramCard.add_child(this._ramBar);

        this._ramDetails = new St.Label({ text: 'Used: 0 GB | Available: 0 GB | Total: 0 GB', style_class: 'zeo-card-subtext' });
        ramCard.add_child(this._ramDetails);

        this._tabMemory.add_child(ramCard);

        // Swap Card
        const swapCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        const swapHead = new St.BoxLayout({ x_expand: true });
        swapHead.add_child(new St.Label({ text: 'Swap Memory', style_class: 'zeo-card-title', x_expand: true }));
        this._swapVal = new St.Label({ text: '0%', style_class: 'zeo-card-value' });
        swapHead.add_child(this._swapVal);
        swapCard.add_child(swapHead);

        this._swapBar = createProgressBar(0);
        swapCard.add_child(this._swapBar);

        this._swapDetails = new St.Label({ text: 'Used: 0 GB | Total: 0 GB', style_class: 'zeo-card-subtext' });
        swapCard.add_child(this._swapDetails);

        this._tabMemory.add_child(swapCard);

        // Top Memory Processes
        const memProcCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        memProcCard.add_child(new St.Label({ text: 'Top Processes by Memory', style_class: 'zeo-card-title' }));

        const tableHead = new St.BoxLayout({ style_class: 'zeo-table-header' });
        tableHead.add_child(new St.Label({ text: 'PID', style_class: 'zeo-pid-col' }));
        tableHead.add_child(new St.Label({ text: 'PROCESS', style_class: 'zeo-name-col', x_expand: true }));
        tableHead.add_child(new St.Label({ text: 'RAM', style_class: 'zeo-val-col' }));
        memProcCard.add_child(tableHead);

        this._memProcTable = new St.BoxLayout({ style_class: 'zeo-table', vertical: true });
        memProcCard.add_child(this._memProcTable);

        this._tabMemory.add_child(memProcCard);
        this._contentStack.add_child(this._tabMemory);
    }

    /* ── Storage Tab View ──────────────────────────────────────────── */
    _buildStorageTab() {
        this._tabStorage = new St.BoxLayout({ vertical: true, x_expand: true });

        // Disk IO Card
        const ioCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        ioCard.add_child(new St.Label({ text: 'Storage Activity (Disk I/O)', style_class: 'zeo-card-title' }));
        this._diskIoRead = new St.Label({ text: 'Read Rate: 0 B/s', style_class: 'zeo-card-subtext' });
        this._diskIoWrite = new St.Label({ text: 'Write Rate: 0 B/s', style_class: 'zeo-card-subtext' });
        ioCard.add_child(this._diskIoRead);
        ioCard.add_child(this._diskIoWrite);
        this._tabStorage.add_child(ioCard);

        // Partitions Card
        const partCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        partCard.add_child(new St.Label({ text: 'Filesystem Partitions', style_class: 'zeo-card-title' }));

        this._partitionList = new St.BoxLayout({ style_class: 'zeo-partition-list', vertical: true });
        partCard.add_child(this._partitionList);

        this._tabStorage.add_child(partCard);
        this._contentStack.add_child(this._tabStorage);
    }

    /* ── Network Tab View ──────────────────────────────────────────── */
    _buildNetworkTab() {
        this._tabNetwork = new St.BoxLayout({ vertical: true, x_expand: true });

        // Network Bandwidth Card
        const netCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        netCard.add_child(new St.Label({ text: 'Real-time Throughput', style_class: 'zeo-card-title' }));

        this._netLiveDown = new St.Label({ text: 'Download Rate: 0 B/s', style_class: 'zeo-card-value' });
        this._netLiveUp = new St.Label({ text: 'Upload Rate: 0 B/s', style_class: 'zeo-card-subtext' });
        netCard.add_child(this._netLiveDown);
        netCard.add_child(this._netLiveUp);

        this._netSessionTotal = new St.Label({ text: 'Session Total: ↓ 0 B | ↑ 0 B', style_class: 'zeo-card-subtext zeo-mt-4' });
        netCard.add_child(this._netSessionTotal);

        this._tabNetwork.add_child(netCard);

        // Network Interfaces Card
        const ifaceCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        ifaceCard.add_child(new St.Label({ text: 'Active Interfaces', style_class: 'zeo-card-title' }));

        this._ifaceList = new St.BoxLayout({ style_class: 'zeo-iface-list', vertical: true });
        ifaceCard.add_child(this._ifaceList);

        this._tabNetwork.add_child(ifaceCard);
        this._contentStack.add_child(this._tabNetwork);
    }

    /* ── Sensors Tab View ──────────────────────────────────────────── */
    _buildSensorsTab() {
        this._tabSensors = new St.BoxLayout({ vertical: true, x_expand: true });

        const sensCard = new St.BoxLayout({ style_class: 'zeo-card', vertical: true });
        sensCard.add_child(new St.Label({ text: 'Hardware Temperatures & Sensors', style_class: 'zeo-card-title' }));

        this._sensorsList = new St.BoxLayout({ style_class: 'zeo-sensors-list', vertical: true });
        sensCard.add_child(this._sensorsList);

        this._tabSensors.add_child(sensCard);
        this._contentStack.add_child(this._tabSensors);
    }

    /* ── Refresh Loop ──────────────────────────────────────────────── */
    async _refreshAll() {
        const tempUnit = this._settings.get_string('temp-unit');

        // Query metrics
        const [cpuData, memData, allGpus, diskData, netData, sensorData, sysInfo] = await Promise.all([
            this._collector.readCpu(),
            this._collector.readMemory(),
            this._collector.readAllGpus(),
            this._collector.readDisks(),
            this._collector.readNetwork(),
            this._collector.readSensors(tempUnit),
            this._collector.readSystemInfo(),
        ]);

        const gpuData = (allGpus && allGpus.length > 0)
            ? (allGpus.find(g => g.type === 'nvidia' && g.usagePct > 0) || allGpus[0])
            : null;

        // 1. Update Top Bar Indicators
        this._cpuInd.setText(`${Math.round(cpuData.totalUsage)}%`);
        this._memInd.setText(`${Math.round(memData.usagePct)}%`);
        
        if (gpuData) {
            const showIcons = this._settings.get_boolean('show-icons');
            this._gpuInd.setText(showIcons ? `${Math.round(gpuData.usagePct)}%` : `GPU ${Math.round(gpuData.usagePct)}%`);
            this._gpuInd.actor.visible = this._settings.get_boolean('show-gpu');
        } else {
            this._gpuInd.actor.visible = false;
        }

        this._diskInd.setText(`${Math.round(diskData.primaryUsagePct)}%`);
        this._netInd.setText(`↓ ${formatSpeed(netData.rxSpeed)} ↑ ${formatSpeed(netData.txSpeed)}`);
        this._tempInd.setText(`${sensorData.primaryTemp || '—'}${sensorData.unit}`);

        // Update Desktop Card Widget
        if (this._desktopWidget) {
            this._desktopWidget.update(cpuData, memData, allGpus, diskData, netData, sensorData, sysInfo);
        }

        // 2. Update Header Info
        this._headerTitle.set_text(`${sysInfo.hostname}`);
        this._headerSub.set_text(`${sysInfo.osName}`);
        this._uptimeBadge.set_text(`Up ${sysInfo.uptimeStr}`);

        // 3. Update active tab details if menu is open
        if (this.menu.isOpen) {
            // Overview tab
            this._ovCpuVal.set_text(`${Math.round(cpuData.totalUsage)}%`);
            this._ovCpuBar.updatePercent(cpuData.totalUsage);
            this._ovCpuSub.set_text(`Load: ${cpuData.loadAvg} | Freq: ${cpuData.freqMhz} MHz`);

            this._ovMemVal.set_text(`${Math.round(memData.usagePct)}%`);
            this._ovMemBar.updatePercent(memData.usagePct);
            this._ovMemSub.set_text(`RAM: ${formatBytes(memData.usedBytes)} / ${formatBytes(memData.totalBytes)}`);

            this._ovDiskVal.set_text(`${Math.round(diskData.primaryUsagePct)}%`);
            this._ovDiskBar.updatePercent(diskData.primaryUsagePct);
            this._ovDiskSub.set_text(`${formatBytes(diskData.primaryUsed)} / ${formatBytes(diskData.primaryTotal)}`);

            this._ovNetDown.set_text(`Download: ${formatSpeed(netData.rxSpeed)}`);
            this._ovNetUp.set_text(`Upload: ${formatSpeed(netData.txSpeed)}`);

            // Tab-specific details
            if (this._activeTab === 'cpu') {
                this._cpuTabVal.set_text(`${Math.round(cpuData.totalUsage)}%`);
                this._cpuTabBar.updatePercent(cpuData.totalUsage);
                this._cpuTabInfo.set_text(`Load: ${cpuData.loadAvg} | Freq: ${cpuData.freqMhz} MHz`);

                // Cores
                this._cpuCoreContainer.destroy_all_children();
                let curRow = null;
                for (let i = 0; i < cpuData.cores.length; i++) {
                    if (i % 2 === 0) {
                        curRow = new St.BoxLayout({ style_class: 'zeo-core-row' });
                        this._cpuCoreContainer.add_child(curRow);
                    }
                    const core = cpuData.cores[i];
                    const coreBox = new St.BoxLayout({ style_class: 'zeo-core-item', x_expand: true });
                    coreBox.add_child(new St.Label({ text: `Core ${core.coreIndex}`, style_class: 'zeo-core-label', x_expand: true }));
                    coreBox.add_child(new St.Label({ text: `${Math.round(core.usage)}%`, style_class: 'zeo-core-val' }));
                    if (curRow) curRow.add_child(coreBox);
                }

                // Processes
                const { topCpu } = await this._collector.readTopProcesses();
                this._cpuProcTable.destroy_all_children();
                for (const p of topCpu) {
                    const row = new St.BoxLayout({ style_class: 'zeo-table-row' });
                    row.add_child(new St.Label({ text: p.pid, style_class: 'zeo-pid-col' }));
                    row.add_child(new St.Label({ text: p.name, style_class: 'zeo-name-col', x_expand: true }));
                    row.add_child(new St.Label({ text: `${p.cpu.toFixed(1)}%`, style_class: 'zeo-val-col' }));
                    this._cpuProcTable.add_child(row);
                }
            } else if (this._activeTab === 'memory') {
                this._ramVal.set_text(`${Math.round(memData.usagePct)}%`);
                this._ramBar.updatePercent(memData.usagePct);
                this._ramDetails.set_text(`Used: ${formatBytes(memData.usedBytes)} | Free/Avail: ${formatBytes(memData.availBytes)} | Total: ${formatBytes(memData.totalBytes)}`);

                this._swapVal.set_text(`${Math.round(memData.swapUsagePct)}%`);
                this._swapBar.updatePercent(memData.swapUsagePct);
                this._swapDetails.set_text(`Used: ${formatBytes(memData.swapUsedBytes)} | Total: ${formatBytes(memData.swapTotalBytes)}`);

                const { topMem } = await this._collector.readTopProcesses();
                this._memProcTable.destroy_all_children();
                for (const p of topMem) {
                    const row = new St.BoxLayout({ style_class: 'zeo-table-row' });
                    row.add_child(new St.Label({ text: p.pid, style_class: 'zeo-pid-col' }));
                    row.add_child(new St.Label({ text: p.name, style_class: 'zeo-name-col', x_expand: true }));
                    row.add_child(new St.Label({ text: p.rssStr, style_class: 'zeo-val-col' }));
                    this._memProcTable.add_child(row);
                }
            } else if (this._activeTab === 'storage') {
                this._diskIoRead.set_text(`Read Speed: ${formatSpeed(diskData.readSpeed)}`);
                this._diskIoWrite.set_text(`Write Speed: ${formatSpeed(diskData.writeSpeed)}`);

                this._partitionList.destroy_all_children();
                for (const d of diskData.disks) {
                    const row = new St.BoxLayout({ style_class: 'zeo-core-item', vertical: true });
                    const topRow = new St.BoxLayout({ x_expand: true });
                    topRow.add_child(new St.Label({ text: `${d.mount} (${d.filesystem})`, style_class: 'zeo-core-label', x_expand: true }));
                    topRow.add_child(new St.Label({ text: `${formatBytes(d.usedBytes)} / ${formatBytes(d.totalBytes)} (${d.usagePct}%)`, style_class: 'zeo-core-val' }));
                    row.add_child(topRow);
                    const bar = createProgressBar(d.usagePct);
                    row.add_child(bar);
                    this._partitionList.add_child(row);
                }
            } else if (this._activeTab === 'network') {
                this._netLiveDown.set_text(`Download Speed: ${formatSpeed(netData.rxSpeed)}`);
                this._netLiveUp.set_text(`Upload Speed: ${formatSpeed(netData.txSpeed)}`);
                this._netSessionTotal.set_text(`Session Data: ↓ ${formatBytes(netData.totalRx)} | ↑ ${formatBytes(netData.totalTx)}`);

                this._ifaceList.destroy_all_children();
                for (const iface of netData.interfaces) {
                    const row = new St.BoxLayout({ style_class: 'zeo-core-item' });
                    row.add_child(new St.Label({ text: iface.iface, style_class: 'zeo-core-label', x_expand: true }));
                    row.add_child(new St.Label({ text: `↓ ${formatBytes(iface.rxBytes)} | ↑ ${formatBytes(iface.txBytes)}`, style_class: 'zeo-core-val' }));
                    this._ifaceList.add_child(row);
                }
            } else if (this._activeTab === 'sensors') {
                this._sensorsList.destroy_all_children();
                for (const s of sensorData.sensorList) {
                    const row = new St.BoxLayout({ style_class: 'zeo-core-item' });
                    row.add_child(new St.Label({ text: s.label, style_class: 'zeo-core-label', x_expand: true }));
                    row.add_child(new St.Label({ text: `${s.displayVal} ${s.unit}`, style_class: 'zeo-core-val' }));
                    this._sensorsList.add_child(row);
                }
            }
        }
    }

    setTheme(isLight) {
        if (isLight) {
            this.add_style_class_name('light-theme');
            this.menu.box.add_style_class_name('light-theme');
        } else {
            this.remove_style_class_name('light-theme');
            this.menu.box.remove_style_class_name('light-theme');
        }
    }

    setDesktopWidget(desktopWidget) {
        this._desktopWidget = desktopWidget;
    }

    destroy() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        this._desktopWidget = null;
        this._settings?.disconnectObject(this);
        super.destroy();
    }
});

/* ── Extension Entry Point ─────────────────────────────────────────── */

export default class ZeoWidgetsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

        this._setupDesktopWidget();
        this._setupIndicator();

        // Listen for panel position preference changes
        this._settings.connectObject('changed::panel-position', () => {
            this._setupIndicator();
        }, this);

        // Listen for desktop widget preference changes
        this._settings.connectObject('changed::show-desktop-widget', () => {
            this._setupDesktopWidget();
            this._indicator?.setDesktopWidget(this._desktopWidget);
        }, this);

        this._settings.connectObject('changed::desktop-widget-x', () => {
            this._positionDesktopWidget();
        }, this);

        // Auto sync theme mode
        const updateThemeMode = () => {
            const scheme = this._desktopSettings.get_string('color-scheme');
            const isLight = (scheme === 'prefer-light' || scheme === 'default');
            this._indicator?.setTheme(isLight);
            this._desktopWidget?.setTheme(isLight);
        };
        updateThemeMode();
        this._desktopSettingsId = this._desktopSettings.connect('changed::color-scheme', updateThemeMode);
    }

    _setupDesktopWidget() {
        if (this._desktopWidget) {
            this._desktopWidget.destroy();
            this._desktopWidget = null;
        }

        const show = this._settings.get_boolean('show-desktop-widget');
        if (!show) return;

        this._desktopWidget = new ZeoDesktopWidget(this._settings, this.path);

        // Calculate initial position on primary monitor
        this._positionDesktopWidget();

        // Add to desktop layer
        if (Main.layoutManager._backgroundGroup) {
            Main.layoutManager._backgroundGroup.add_child(this._desktopWidget.actor);
        } else {
            Main.uiGroup.insert_child_below(this._desktopWidget.actor, global.window_group);
        }

        // Apply current theme
        const scheme = this._desktopSettings?.get_string('color-scheme');
        const isLight = (scheme === 'prefer-light' || scheme === 'default');
        this._desktopWidget.setTheme(isLight);
    }

    _positionDesktopWidget() {
        if (!this._desktopWidget) return;
        const primary = Main.layoutManager.primaryMonitor;
        let x = this._settings.get_int('desktop-widget-x');
        let y = this._settings.get_int('desktop-widget-y');
        if (x <= 0 && y <= 0) {
            x = this._settings.get_int('pos-x');
            y = this._settings.get_int('pos-y');
        }

        if (x <= 0 || x > primary.width - 100) {
            x = primary.x + 40;
        }
        if (y <= 0 || y > primary.height - 100) {
            y = primary.y + 70;
        }
        this._desktopWidget.actor.set_position(x, y);
    }

    _setupIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        const pos = this._settings.get_string('panel-position') || 'right';
        const boxIndex = this._settings.get_int('panel-box-index') || 0;

        this._indicator = new ZeoMonitorIndicator(this._settings, () => this.openPreferences(), this.path);
        this._indicator.setDesktopWidget(this._desktopWidget);
        Main.panel.addToStatusArea('zeo-monitor', this._indicator, boxIndex, pos);
    }

    disable() {
        if (this._desktopSettings && this._desktopSettingsId) {
            this._desktopSettings.disconnect(this._desktopSettingsId);
            this._desktopSettingsId = null;
        }
        this._desktopSettings = null;

        this._settings?.disconnectObject(this);
        this._settings = null;

        if (this._desktopWidget) {
            this._desktopWidget.destroy();
            this._desktopWidget = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
