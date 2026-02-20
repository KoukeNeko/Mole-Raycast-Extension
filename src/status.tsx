import { ActionPanel, Action, Icon, List, Color, showToast, Toast } from "@raycast/api";
import { useEffect, useState, useRef, useCallback } from "react";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";

const execAsync = promisify(exec);
const REFRESH_MS = 2_000;

// ── Shell helper ──────────────────────────────────────────────────────────────

async function sh(cmd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 10_000, env: { ...process.env, LANG: "en_US.UTF-8" } });
    return stdout.trim();
  } catch {
    return "";
  }
}

function pick(raw: string, key: string): string {
  const m = raw.match(new RegExp(`${key}:\\s*(.+)`));
  return m ? m[1].trim() : "";
}

function pickIoReg(raw: string, key: string): string {
  const m = raw.match(new RegExp(`"${key}"\\s*=\\s*(\\d+)`));
  return m ? m[1] : "";
}

// ── Cached static info ──────────────────────────────────────────────────────

interface HardwareInfo {
  model: string;
  chip: string;
  gpuLabel: string;
  memGb: string;
}
interface PowerHealthInfo {
  healthPct: number;
  battCondition: string;
}

let cachedHw: HardwareInfo | null = null;
let cachedPower: PowerHealthInfo | null = null;

async function getHardwareInfo(): Promise<HardwareInfo> {
  if (cachedHw) return cachedHw;
  const hwRaw = await sh("system_profiler SPHardwareDataType 2>/dev/null");
  let model = pick(hwRaw, "Model Name");
  let chip = pick(hwRaw, "Chip") || pick(hwRaw, "Processor Name");
  const gpuCores = pick(hwRaw, "Total Number of Cores \\(GPU\\)");
  let memStr = pick(hwRaw, "Memory");
  if (!model) {
    const hwModel = await sh("sysctl -n hw.model 2>/dev/null");
    model = hwModel.replace(/\d+,\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2") || "Mac";
  }
  if (!chip) chip = await sh("sysctl -n machdep.cpu.brand_string 2>/dev/null");
  if (!memStr) memStr = `${Math.round(os.totalmem() / 1024 ** 3)} GB`;
  const memMatch = memStr.match(/([\d.]+)/);
  const memGb = memMatch ? parseFloat(memMatch[1]).toFixed(1) : `${Math.round(os.totalmem() / 1024 ** 3)}.0`;
  cachedHw = { model: model || "Mac", chip: chip || "", gpuLabel: gpuCores ? `, ${gpuCores}GPU` : "", memGb };
  return cachedHw;
}

async function getPowerHealthInfo(): Promise<PowerHealthInfo> {
  if (cachedPower) return cachedPower;
  const pwrRaw = await sh("system_profiler SPPowerDataType 2>/dev/null");
  const maxCapRaw = pick(pwrRaw, "Maximum Capacity");
  cachedPower = { healthPct: maxCapRaw ? parseInt(maxCapRaw) : 0, battCondition: pick(pwrRaw, "Condition") || "" };
  return cachedPower;
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
  const [hw, pwr] = await Promise.all([getHardwareInfo(), getPowerHealthInfo()]);
  const [osVer, bootRaw, dfAllRaw, iostatRaw, battRaw, battIoRaw, topRaw, swapRaw, proxyRaw, netstatRaw, tunIpRaw] =
    await Promise.all([
      sh("sw_vers -productVersion"),
      sh("sysctl -n kern.boottime"),
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

  // Uptime
  let uptimeStr = "N/A";
  const bm = bootRaw.match(/sec\s*=\s*(\d+)/);
  if (bm) {
    const s = Math.floor(Date.now() / 1000) - parseInt(bm[1], 10);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    uptimeStr = d > 0 ? `${d}d ${h}h` : `${h}h`;
  }

  // CPU
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  const loads = os.loadavg();
  const totalPct = Math.min(100, (loads[0] / cpuCount) * 100);
  const coreUsages: { label: string; pct: number }[] = [];
  for (let i = 0; i < cpus.length; i++) {
    const t = cpus[i].times;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    coreUsages.push({ label: `Core ${i + 1}`, pct: Math.round(((total - t.idle) / total) * 100) });
  }
  coreUsages.sort((a, b) => b.pct - a.pct);
  const topCores = coreUsages.slice(0, 3);
  const tempRawVal = pickIoReg(battIoRaw, "Temperature");
  const socTemp = tempRawVal ? parseInt(tempRawVal) / 100 : 0;
  const tempStr = socTemp > 0 ? `${socTemp.toFixed(1)}°C` : "";
  const pCores = cpus.filter((c) => c.speed > 2000).length;
  const eCores = cpuCount - pCores;
  const coreLabel = pCores > 0 && eCores > 0 ? `${pCores}P+${eCores}E` : `${cpuCount}`;

  // Memory
  const memTotalGb = os.totalmem() / 1024 ** 3;
  const memUsedGb = memTotalGb - os.freemem() / 1024 ** 3;
  const memUsedPct = Math.round((memUsedGb / memTotalGb) * 100);

  // Swap
  let swapUsed = 0;
  let swapTotal = 0;
  const swapTotalM = swapRaw.match(/total\s*=\s*([\d.]+)M/);
  const swapUsedM = swapRaw.match(/used\s*=\s*([\d.]+)M/);
  if (swapTotalM) swapTotal = parseFloat(swapTotalM[1]) / 1024;
  if (swapUsedM) swapUsed = parseFloat(swapUsedM[1]) / 1024;
  const swapPct = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;

  // Disk
  let diskTotalK = 0;
  let diskAvailK = 0;
  let extrTotalK = 0;
  let extrAvailK = 0;
  for (const line of dfAllRaw.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9 || !parts[0].startsWith("/dev/disk")) continue;
    const totalK = parseInt(parts[1]) || 0;
    const availK = parseInt(parts[3]) || 0;
    const mount = parts.slice(8).join(" ");
    if (mount === "/") {
      diskTotalK = totalK;
      diskAvailK = availK;
    } else if (mount.startsWith("/Volumes/") && !mount.startsWith("/Volumes/com.apple.")) {
      extrTotalK += totalK;
      extrAvailK += availK;
    }
  }
  const KB_TO_GB = 1 / (1024 * 1024);
  const diskTotalGb = diskTotalK * KB_TO_GB;
  const diskUsedGb = (diskTotalK - diskAvailK) * KB_TO_GB;
  const diskPct = diskTotalK > 0 ? Math.round(((diskTotalK - diskAvailK) / diskTotalK) * 100) : 0;
  const extrTotalGb = extrTotalK * KB_TO_GB;
  const extrUsedGb = (extrTotalK - extrAvailK) * KB_TO_GB;
  const extrPct = extrTotalK > 0 ? Math.round(((extrTotalK - extrAvailK) / extrTotalK) * 100) : 0;

  // Disk I/O
  let readMBs = 0;
  let writeMBs = 0;
  if (iostatRaw) {
    const parts = iostatRaw.trim().split(/\s+/);
    if (parts.length >= 3) readMBs = parseFloat(parts[2]) || 0;
    if (parts.length >= 6) writeMBs = parseFloat(parts[5]) || 0;
  }

  // Battery
  let battLevel = -1;
  let battCharging = false;
  let battSource = "Battery";
  if (battRaw) {
    const lm = battRaw.match(/(\d+)%/);
    if (lm) battLevel = parseInt(lm[1], 10);
    if (battRaw.includes("AC Power")) {
      battCharging = true;
      battSource = "AC";
    }
  }
  const cycleCount = pickIoReg(battIoRaw, "CycleCount");
  const battTemp = socTemp > 0 ? `${socTemp.toFixed(1)}°C` : "";

  // Network
  const currentNet = parseEn0Bytes(netstatRaw);
  const now = Date.now();
  let netDownMBs = 0;
  let netUpMBs = 0;
  if (prevNet && prevNet.inBytes > 0) {
    const dtSec = (now - prevNet.time) / 1000;
    if (dtSec > 0) {
      netDownMBs = Math.max(0, (currentNet.inBytes - prevNet.inBytes) / (1024 * 1024) / dtSec);
      netUpMBs = Math.max(0, (currentNet.outBytes - prevNet.outBytes) / (1024 * 1024) / dtSec);
    }
  }
  prevNet = { ...currentNet, time: now };

  // Proxy / VPN
  let proxyLabel = "";
  if (
    proxyRaw.includes("SOCKSEnable : 1") ||
    proxyRaw.includes("HTTPEnable : 1") ||
    proxyRaw.includes("HTTPSEnable : 1")
  ) {
    const serverMatch = proxyRaw.match(/(?:SOCKSProxy|HTTPProxy|HTTPSProxy)\s*:\s*(\S+)/);
    proxyLabel = serverMatch ? `Proxy · ${serverMatch[1]}` : "Proxy";
  }
  if (!proxyLabel && tunIpRaw) proxyLabel = `Proxy TUN · ${tunIpRaw}`;

  // Processes
  const procs: { name: string; pct: number }[] = [];
  for (const line of topRaw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length >= 2) procs.push({ name: parts.slice(1).join(" "), pct: parseFloat(parts[0]) || 0 });
  }

  // Health score
  const { healthPct, battCondition } = pwr;
  const healthScore = healthPct > 0 ? Math.round(healthPct * 0.5 + (100 - diskPct) * 0.3 + (100 - swapPct) * 0.2) : 0;

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
    coreLabel,
    topCores,
    memUsedGb,
    memTotalGb,
    memUsedPct,
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
    healthPct,
    battCondition,
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
              title={`${d.memGb} GB RAM · ${Math.round(d.diskTotalGb)} GB Disk`}
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
              subtitle={`${d.memUsedGb.toFixed(1)} / ${d.memTotalGb.toFixed(1)} GB`}
              accessories={[{ tag: { value: `${d.memUsedPct}%`, color: usageColor(d.memUsedPct) } }]}
              actions={actions}
            />
            <List.Item
              icon={Icon.MemoryStick}
              title="Available"
              accessories={[{ text: `${(d.memTotalGb - d.memUsedGb).toFixed(1)} GB` }]}
              actions={actions}
            />
            {d.swapTotal > 0 && (
              <List.Item
                icon={{ source: Icon.Switch, tintColor: usageColor(d.swapPct) }}
                title="Swap"
                subtitle={`${d.swapUsed.toFixed(1)}G / ${d.swapTotal.toFixed(1)}G`}
                accessories={[{ tag: { value: `${d.swapPct}%`, color: usageColor(d.swapPct) } }]}
                actions={actions}
              />
            )}
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
