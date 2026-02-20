import { ActionPanel, Action, Icon, List, Color, showToast, Toast } from "@raycast/api";
import { useEffect, useState, useRef, useCallback } from "react";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";

const execAsync = promisify(exec);
const REFRESH_MS = 2_000;

// Raycast sandbox PATH only includes /usr/bin and /bin.
// Many macOS system tools live in /usr/sbin and /sbin.
const SHELL_PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", process.env.PATH]
  .filter(Boolean)
  .join(":");
const SHELL_ENV = { ...process.env, LANG: "en_US.UTF-8", PATH: SHELL_PATH };

// ── Shell helper ──────────────────────────────────────────────────────────────

async function sh(cmd: string, timeoutMs = 10_000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { timeout: timeoutMs, env: SHELL_ENV });
    return stdout.trim();
  } catch {
    return "";
  }
}

function pickIoReg(raw: string, key: string): string {
  const m = raw.match(new RegExp(`"${key}"\\s*=\\s*(\\d+)`));
  return m ? m[1] : "";
}

function pickLine(raw: string, key: string): string {
  const m = raw.match(new RegExp(`${key}:\\s*(.+)`));
  return m ? m[1].trim() : "";
}

// ── Cached static info ──────────────────────────────────────────────────────

interface HardwareInfo {
  model: string;
  chip: string;
  gpuLabel: string;
  memGb: string;
  coreLabel: string;
}

let cachedHw: HardwareInfo | null = null;
let spProfilerStarted = false;

async function getHardwareInfo(): Promise<HardwareInfo> {
  if (cachedHw) return cachedHw;

  // Fast sysctl queries (< 100ms, always works in Raycast sandbox)
  const [hwModel, cpuBrand, pCoresRaw, eCoresRaw] = await Promise.all([
    sh("sysctl -n hw.model"),
    sh("sysctl -n machdep.cpu.brand_string"),
    sh("sysctl -n hw.perflevel0.logicalcpu 2>/dev/null"),
    sh("sysctl -n hw.perflevel1.logicalcpu 2>/dev/null"),
  ]);

  // P/E core split from sysctl (Apple Silicon), fallback to total count
  const pCount = parseInt(pCoresRaw);
  const eCount = parseInt(eCoresRaw);
  const coreLabel = pCount > 0 && eCount > 0 ? `${pCount}P+${eCount}E` : `${os.cpus().length}`;

  const chip = cpuBrand || "Apple Silicon";
  const memGb = (os.totalmem() / 1024 ** 3).toFixed(1);
  const model = mapModelName(hwModel);

  cachedHw = { model, chip, gpuLabel: "", memGb, coreLabel };

  // Background: system_profiler for marketing model name + GPU core count
  // This can take 5-20s but won't block render; next refresh picks it up
  if (!spProfilerStarted) {
    spProfilerStarted = true;
    sh("system_profiler SPHardwareDataType 2>/dev/null", 30_000).then((raw) => {
      if (!raw || !cachedHw) return;
      const spModel = pickLine(raw, "Model Name");
      const gpuCores = pickLine(raw, "Total Number of Cores \\(GPU\\)");
      if (spModel || gpuCores) {
        cachedHw = {
          ...cachedHw!,
          ...(spModel ? { model: spModel } : {}),
          ...(gpuCores ? { gpuLabel: `, ${gpuCores}GPU` } : {}),
        };
      }
    });
  }

  return cachedHw;
}

function mapModelName(id: string): string {
  if (!id) return "Mac";
  if (id.startsWith("MacBookPro")) return "MacBook Pro";
  if (id.startsWith("MacBookAir")) return "MacBook Air";
  if (id.startsWith("MacBook")) return "MacBook";
  if (id.startsWith("iMacPro")) return "iMac Pro";
  if (id.startsWith("iMac")) return "iMac";
  if (id.startsWith("Macmini")) return "Mac mini";
  if (id.startsWith("MacPro")) return "Mac Pro";
  // Apple Silicon unified IDs like "Mac14,7" — need system_profiler for exact name
  return "Mac";
}

// ── Battery health (from ioreg, no system_profiler needed) ──────────────────

interface PowerHealth {
  healthPct: number;
  condition: string;
}
let cachedPower: PowerHealth | null = null;

function computePowerHealth(ioRaw: string): PowerHealth {
  if (cachedPower) return cachedPower;
  if (!ioRaw) return { healthPct: 0, condition: "" };

  const maxCap = parseInt(pickIoReg(ioRaw, "MaxCapacity")) || 0;
  let healthPct = 0;
  if (maxCap > 0 && maxCap <= 100) {
    // Modern macOS: MaxCapacity is already a percentage
    healthPct = maxCap;
  } else if (maxCap > 100) {
    // Older macOS: MaxCapacity is in mAh, compute ratio
    const designCap = parseInt(pickIoReg(ioRaw, "DesignCapacity")) || 0;
    if (designCap > 0) healthPct = Math.min(100, Math.round((maxCap / designCap) * 100));
  }
  const condition = healthPct > 80 ? "Normal" : healthPct > 0 ? "Service" : "";
  const result = { healthPct, condition };
  if (healthPct > 0) cachedPower = result; // Only cache successful reads
  return result;
}

// ── Network delta tracking ──────────────────────────────────────────────────

let prevNet: { inBytes: number; outBytes: number; time: number } | null = null;

function parseEn0Bytes(raw: string): { inBytes: number; outBytes: number } {
  for (const line of raw.split("\n")) {
    if (!line.match(/^en0\s/) || !line.includes("Link#")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 11) {
      return { inBytes: parseInt(parts[6]) || 0, outBytes: parseInt(parts[9]) || 0 };
    }
  }
  return { inBytes: 0, outBytes: 0 };
}

// ── Data collection ──────────────────────────────────────────────────────────

async function collect() {
  const hw = await getHardwareInfo();

  const [osVer, bootRaw, uptimeRaw, dfRaw, iostatRaw, battRaw, ioRaw, topRaw, swapRaw, proxyRaw, netRaw, tunIp] =
    await Promise.all([
      sh("sw_vers -productVersion"),
      sh("sysctl -n kern.boottime"),
      sh("uptime"),
      sh("df -k 2>/dev/null"),
      sh("iostat -d -c 2 -w 1 2>/dev/null | tail -1"),
      sh("pmset -g batt 2>/dev/null"),
      sh("ioreg -rc AppleSmartBattery 2>/dev/null"),
      sh("ps -Aceo %cpu,comm -r | head -4 | tail -3"),
      sh("sysctl -n vm.swapusage 2>/dev/null"),
      sh("scutil --proxy 2>/dev/null"),
      sh("netstat -ib 2>/dev/null"),
      sh("ifconfig 2>/dev/null | awk '/^utun/{iface=1; next} iface && /inet /{print $2; exit}'"),
    ]);

  // Power health from ioreg (fast, no system_profiler)
  const pwr = computePowerHealth(ioRaw);

  // Uptime: kern.boottime primary, `uptime` command fallback
  let uptimeStr = "N/A";
  const bootMatch = bootRaw.match(/sec\s*=\s*(\d+)/);
  if (bootMatch) {
    const secs = Math.floor(Date.now() / 1000) - parseInt(bootMatch[1]);
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    uptimeStr = d > 0 ? `${d}d ${h}h` : `${h}h`;
  } else if (uptimeRaw) {
    const m = uptimeRaw.match(/up\s+(?:(\d+)\s+days?,?\s*)?(\d+):(\d+)/);
    if (m) {
      const d = parseInt(m[1]) || 0;
      const h = parseInt(m[2]) || 0;
      uptimeStr = d > 0 ? `${d}d ${h}h` : `${h}h`;
    }
  }

  // CPU
  const cpus = os.cpus();
  const loads = os.loadavg();
  const totalPct = Math.min(100, (loads[0] / cpus.length) * 100);
  const coreUsages = cpus
    .map((c, i) => {
      const t = c.times;
      const total = t.user + t.nice + t.sys + t.idle + t.irq;
      return { label: `Core ${i + 1}`, pct: Math.round(((total - t.idle) / total) * 100) };
    })
    .sort((a, b) => b.pct - a.pct);

  // Temperature (battery/SoC from ioreg, hundredths of °C)
  const tempVal = parseInt(pickIoReg(ioRaw, "Temperature")) || 0;
  const socTemp = tempVal > 0 ? tempVal / 100 : 0;
  const tempStr = socTemp > 0 ? `${socTemp.toFixed(1)}°C` : "";

  // Memory
  const memTotalGb = os.totalmem() / 1024 ** 3;
  const memUsedGb = memTotalGb - os.freemem() / 1024 ** 3;
  const memUsedPct = Math.round((memUsedGb / memTotalGb) * 100);

  // Swap
  let swapUsed = 0,
    swapTotal = 0;
  const stm = swapRaw.match(/total\s*=\s*([\d.]+)M/);
  const sum = swapRaw.match(/used\s*=\s*([\d.]+)M/);
  if (stm) swapTotal = parseFloat(stm[1]) / 1024;
  if (sum) swapUsed = parseFloat(sum[1]) / 1024;
  const swapPct = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;

  // Disk
  let diskTotalK = 0,
    diskAvailK = 0,
    extrTotalK = 0,
    extrAvailK = 0;
  for (const line of dfRaw.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 9 || !p[0].startsWith("/dev/disk")) continue;
    const totalK = parseInt(p[1]) || 0;
    const availK = parseInt(p[3]) || 0;
    const mount = p.slice(8).join(" ");
    if (mount === "/") {
      diskTotalK = totalK;
      diskAvailK = availK;
    } else if (mount.startsWith("/Volumes/") && !mount.startsWith("/Volumes/com.apple.")) {
      extrTotalK += totalK;
      extrAvailK += availK;
    }
  }
  const G = 1 / (1024 * 1024);
  const diskTotalGb = diskTotalK * G;
  const diskUsedGb = (diskTotalK - diskAvailK) * G;
  const diskPct = diskTotalK > 0 ? Math.round(((diskTotalK - diskAvailK) / diskTotalK) * 100) : 0;
  const extrTotalGb = extrTotalK * G;
  const extrUsedGb = (extrTotalK - extrAvailK) * G;
  const extrPct = extrTotalK > 0 ? Math.round(((extrTotalK - extrAvailK) / extrTotalK) * 100) : 0;

  // Disk I/O
  let readMBs = 0,
    writeMBs = 0;
  if (iostatRaw) {
    const p = iostatRaw.trim().split(/\s+/);
    if (p.length >= 3) readMBs = parseFloat(p[2]) || 0;
    if (p.length >= 6) writeMBs = parseFloat(p[5]) || 0;
  }

  // Battery
  let battLevel = -1,
    battCharging = false,
    battSource = "Battery";
  if (battRaw) {
    const lm = battRaw.match(/(\d+)%/);
    if (lm) battLevel = parseInt(lm[1]);
    if (battRaw.includes("AC Power")) {
      battCharging = true;
      battSource = "AC";
    }
  }
  const cycleCount = pickIoReg(ioRaw, "CycleCount");
  const battTemp = socTemp > 0 ? `${socTemp.toFixed(1)}°C` : "";

  // Network delta
  const cur = parseEn0Bytes(netRaw);
  const now = Date.now();
  let netDownMBs = 0,
    netUpMBs = 0;
  if (prevNet && prevNet.inBytes > 0) {
    const dt = (now - prevNet.time) / 1000;
    if (dt > 0) {
      netDownMBs = Math.max(0, (cur.inBytes - prevNet.inBytes) / (1024 * 1024) / dt);
      netUpMBs = Math.max(0, (cur.outBytes - prevNet.outBytes) / (1024 * 1024) / dt);
    }
  }
  prevNet = { ...cur, time: now };

  // Proxy / VPN
  let proxyLabel = "";
  if (
    proxyRaw.includes("SOCKSEnable : 1") ||
    proxyRaw.includes("HTTPEnable : 1") ||
    proxyRaw.includes("HTTPSEnable : 1")
  ) {
    const sm = proxyRaw.match(/(?:SOCKSProxy|HTTPProxy|HTTPSProxy)\s*:\s*(\S+)/);
    proxyLabel = sm ? `Proxy · ${sm[1]}` : "Proxy";
  }
  if (!proxyLabel && tunIp) proxyLabel = `Proxy TUN · ${tunIp}`;

  // Processes
  const procs: { name: string; pct: number }[] = [];
  for (const line of topRaw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const p = t.split(/\s+/);
    if (p.length >= 2) procs.push({ name: p.slice(1).join(" "), pct: parseFloat(p[0]) || 0 });
  }

  // Health score
  const healthScore =
    pwr.healthPct > 0 ? Math.round(pwr.healthPct * 0.5 + (100 - diskPct) * 0.3 + (100 - swapPct) * 0.2) : 0;

  return {
    model: hw.model,
    chip: hw.chip,
    gpuLabel: hw.gpuLabel,
    memGb: hw.memGb,
    osVer,
    uptimeStr,
    healthScore,
    totalPct,
    tempStr,
    loads,
    coreLabel: hw.coreLabel,
    topCores: coreUsages.slice(0, 3),
    memUsedGb,
    memTotalGb,
    memUsedPct,
    memFreePct: 100 - memUsedPct,
    refreshRate: "120Hz",
    swapUsed,
    swapTotal,
    swapPct,
    diskUsedGb,
    diskTotalGb,
    diskPct,
    extrUsedGb,
    extrTotalGb,
    extrPct,
    readMBs,
    writeMBs,
    battLevel,
    battSource,
    battCharging,
    healthPct: pwr.healthPct,
    battCondition: pwr.condition,
    cycleCount,
    battTemp,
    netDownMBs,
    netUpMBs,
    proxyLabel,
    procs,
  };
}

// ── Color helpers ────────────────────────────────────────────────────────────

function usageColor(pct: number): Color {
  if (pct >= 90) return Color.Red;
  if (pct >= 75) return Color.Orange;
  if (pct >= 50) return Color.Yellow;
  return Color.Green;
}

function healthColor(pct: number): Color {
  if (pct >= 80) return Color.Green;
  if (pct >= 50) return Color.Yellow;
  return Color.Red;
}

function batteryColor(level: number): Color {
  if (level >= 50) return Color.Green;
  if (level >= 20) return Color.Yellow;
  return Color.Red;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function StatusCommand() {
  const [data, setData] = useState<Awaited<ReturnType<typeof collect>> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isFetchingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      setData(await collect());
    } catch (err) {
      showToast({ style: Toast.Style.Failure, title: "Failed to load status", message: String(err) });
    } finally {
      setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, REFRESH_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh]);

  const d = data;
  const actions = (
    <ActionPanel>
      <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={refresh} />
    </ActionPanel>
  );

  return (
    <List isLoading={isLoading} navigationTitle="Mole Status">
      {d && (
        <>
          {/* ── System ── */}
          <List.Section title="System">
            <List.Item
              icon={Icon.Monitor}
              title={d.model}
              subtitle={`${d.chip}${d.gpuLabel}`}
              accessories={[
                ...(d.healthScore > 0
                  ? [{ tag: { value: `Health ${d.healthScore}`, color: healthColor(d.healthScore) } }]
                  : []),
                { text: `up ${d.uptimeStr}` },
              ]}
              actions={actions}
            />
            <List.Item
              icon={Icon.Info}
              title={`${d.memGb} GB RAM · ${Math.round(d.diskTotalGb)} GB Disk · ${d.refreshRate}`}
              subtitle={`macOS ${d.osVer}`}
              actions={actions}
            />
          </List.Section>

          {/* ── CPU ── */}
          <List.Section title="CPU" subtitle={d.tempStr || undefined}>
            <List.Item
              icon={{ source: Icon.ComputerChip, tintColor: usageColor(d.totalPct) }}
              title="Total"
              subtitle={d.tempStr ? `@ ${d.tempStr}` : undefined}
              accessories={[{ tag: { value: `${d.totalPct.toFixed(1)}%`, color: usageColor(d.totalPct) } }]}
              actions={actions}
            />
            {d.topCores.map((core, i) => (
              <List.Item
                key={i}
                icon={{ source: Icon.Dot, tintColor: usageColor(core.pct) }}
                title={core.label}
                accessories={[{ tag: { value: `${core.pct}%`, color: usageColor(core.pct) } }]}
                actions={actions}
              />
            ))}
            <List.Item
              icon={Icon.Gauge}
              title="Load"
              subtitle={d.loads.map((v) => v.toFixed(2)).join(" / ")}
              accessories={[{ text: d.coreLabel }]}
              actions={actions}
            />
          </List.Section>

          {/* ── Memory ── */}
          <List.Section title="Memory">
            <List.Item
              icon={{ source: Icon.MemoryStick, tintColor: usageColor(d.memUsedPct) }}
              title="Used"
              accessories={[{ tag: { value: `${d.memUsedPct}%`, color: usageColor(d.memUsedPct) } }]}
              actions={actions}
            />
            <List.Item
              icon={Icon.MemoryStick}
              title="Free"
              accessories={[{ tag: { value: `${d.memFreePct}%`, color: Color.Green } }]}
              actions={actions}
            />
            <List.Item
              icon={{ source: Icon.Switch, tintColor: usageColor(d.swapPct) }}
              title="Swap"
              subtitle={d.swapTotal > 0 ? `${d.swapUsed.toFixed(1)}G / ${d.swapTotal.toFixed(1)}G` : "0G"}
              accessories={[{ tag: { value: `${d.swapPct}%`, color: usageColor(d.swapPct) } }]}
              actions={actions}
            />
            <List.Item
              icon={Icon.MemoryStick}
              title="Total"
              accessories={[{ text: `${d.memUsedGb.toFixed(1)} GB / ${d.memTotalGb.toFixed(1)} GB` }]}
              actions={actions}
            />
            <List.Item
              icon={Icon.MemoryStick}
              title="Available"
              accessories={[{ text: `${(d.memTotalGb - d.memUsedGb).toFixed(1)} GB` }]}
              actions={actions}
            />
          </List.Section>

          {/* ── Disk ── */}
          <List.Section title="Disk">
            <List.Item
              icon={{ source: Icon.HardDrive, tintColor: usageColor(d.diskPct) }}
              title="Internal"
              subtitle={`${Math.round(d.diskUsedGb)}G / ${Math.round(d.diskTotalGb)}G`}
              accessories={[{ tag: { value: `${d.diskPct}%`, color: usageColor(d.diskPct) } }]}
              actions={actions}
            />
            {d.extrTotalGb > 0 && (
              <List.Item
                icon={{ source: Icon.HardDrive, tintColor: usageColor(d.extrPct) }}
                title="External"
                subtitle={`${Math.round(d.extrUsedGb)}G / ${Math.round(d.extrTotalGb)}G`}
                accessories={[{ tag: { value: `${d.extrPct}%`, color: usageColor(d.extrPct) } }]}
                actions={actions}
              />
            )}
            <List.Item
              icon={Icon.ArrowDown}
              title="Read"
              accessories={[{ text: `${d.readMBs.toFixed(1)} MB/s` }]}
              actions={actions}
            />
            <List.Item
              icon={Icon.ArrowUp}
              title="Write"
              accessories={[{ text: `${d.writeMBs.toFixed(1)} MB/s` }]}
              actions={actions}
            />
          </List.Section>

          {/* ── Power ── */}
          {d.battLevel >= 0 && (
            <List.Section title="Power">
              <List.Item
                icon={{
                  source: d.battCharging ? Icon.BatteryCharging : Icon.Battery,
                  tintColor: batteryColor(d.battLevel),
                }}
                title="Level"
                subtitle={d.battSource}
                accessories={[{ tag: { value: `${d.battLevel}%`, color: batteryColor(d.battLevel) } }]}
                actions={actions}
              />
              {d.healthPct > 0 && (
                <List.Item
                  icon={{ source: Icon.Heart, tintColor: healthColor(d.healthPct) }}
                  title="Health"
                  subtitle={d.battCondition || undefined}
                  accessories={[{ tag: { value: `${d.healthPct}%`, color: healthColor(d.healthPct) } }]}
                  actions={actions}
                />
              )}
              {(d.cycleCount || d.battTemp) && (
                <List.Item
                  icon={Icon.Info}
                  title={[d.cycleCount ? `${d.cycleCount} cycles` : "", d.battTemp].filter(Boolean).join(" · ")}
                  actions={actions}
                />
              )}
            </List.Section>
          )}

          {/* ── Processes ── */}
          <List.Section title="Processes">
            {d.procs.map((p, i) => (
              <List.Item
                key={i}
                icon={Icon.Terminal}
                title={p.name}
                accessories={[{ tag: { value: `${p.pct.toFixed(1)}%`, color: usageColor(p.pct) } }]}
                actions={actions}
              />
            ))}
          </List.Section>

          {/* ── Network ── */}
          <List.Section title="Network">
            <List.Item
              icon={Icon.ArrowDown}
              title="Download"
              accessories={[{ text: `${d.netDownMBs.toFixed(2)} MB/s` }]}
              actions={actions}
            />
            <List.Item
              icon={Icon.ArrowUp}
              title="Upload"
              accessories={[{ text: `${d.netUpMBs.toFixed(2)} MB/s` }]}
              actions={actions}
            />
            {d.proxyLabel && <List.Item icon={Icon.Globe} title={d.proxyLabel} actions={actions} />}
          </List.Section>
        </>
      )}
    </List>
  );
}
