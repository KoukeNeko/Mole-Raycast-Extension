import { exec, execFile } from "child_process";
import { promisify } from "util";
import { showToast, Toast, confirmAlert, Alert, trash } from "@raycast/api";
import { existsSync, statSync, readdirSync } from "fs";
import path from "path";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// --- Constants ---

const MO_SEARCH_PATHS = [
    "/usr/local/bin/mo",
    "/opt/homebrew/bin/mo",
    `${process.env.HOME}/.local/bin/mo`,
    "/opt/local/bin/mo",
];

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const BYTES_PER_KB = 1024;

// --- Path Detection ---

let cachedMoPath: string | null = null;

export async function getMoPath(): Promise<string> {
    if (cachedMoPath) return cachedMoPath;

    try {
        const { stdout } = await execFileAsync("which", ["mo"]);
        const resolved = stdout.trim();
        if (resolved && existsSync(resolved)) {
            cachedMoPath = resolved;
            return resolved;
        }
    } catch {
        // which failed, try fallback paths
    }

    for (const candidate of MO_SEARCH_PATHS) {
        if (existsSync(candidate)) {
            cachedMoPath = candidate;
            return candidate;
        }
    }

    throw new Error("Mole (mo) 未安裝。請先執行 `brew install mole` 或參考 https://github.com/tw93/mole");
}

function buildShellPath(): string {
    const paths = [
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/homebrew/bin",
        `${process.env.HOME}/.local/bin`,
    ];
    return paths.join(":");
}

// --- Command Execution ---

export async function execMo(args: string[]): Promise<string> {
    const moPath = await getMoPath();
    const shellPath = buildShellPath();
    const escapedArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    // Use shell exec with stderr suppressed — Mole scripts emit non-fatal
    // warnings (e.g. unbound variable) to stderr but produce valid stdout.
    const command = `"${moPath}" ${escapedArgs} 2>/dev/null`;
    try {
        const { stdout } = await execAsync(command, {
            env: {
                ...process.env,
                PATH: shellPath,
                TERM: "dumb",
                NO_COLOR: "1",
                LC_ALL: "C",
            },
            timeout: 300_000,
            maxBuffer: 10 * 1024 * 1024,
            shell: "/bin/bash",
        });
        return stdout;
    } catch (err: unknown) {
        // exec throws when exit code != 0; try to extract stdout anyway
        const error = err as { stdout?: string; stderr?: string; message?: string };
        if (error.stdout && error.stdout.trim().length > 0) {
            return error.stdout;
        }
        const detail = error.stderr || error.message || String(err);
        throw new Error(`mo ${args.join(" ")} failed: ${detail}`);
    }
}

/**
 * Stream mo command output line-by-line for real-time progress.
 * Calls onLine for each new line, and resolves when process exits.
 */
export function spawnMoStreaming(
    args: string[],
    onLine: (line: string) => void,
): Promise<void> {
    const { spawn } = require("child_process") as typeof import("child_process");

    return new Promise(async (resolve, reject) => {
        let moPath: string;
        try {
            moPath = await getMoPath();
        } catch (err) {
            reject(err);
            return;
        }

        const shellPath = buildShellPath();
        const proc = spawn(moPath, args, {
            env: {
                ...process.env,
                PATH: shellPath,
                TERM: "dumb",
                NO_COLOR: "1",
                LC_ALL: "C",
            },
            stdio: ["ignore", "pipe", "ignore"], // ignore stdin and stderr
        });

        let buffer = "";
        proc.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // keep incomplete last line
            for (const line of lines) {
                onLine(line);
            }
        });

        proc.on("close", () => {
            if (buffer.trim()) onLine(buffer);
            resolve();
        });

        proc.on("error", (err: Error) => {
            reject(new Error(`mo ${args.join(" ")} failed: ${err.message}`));
        });

        // Timeout: 5 minutes
        setTimeout(() => {
            proc.kill();
            resolve(); // don't reject — partial results are still useful
        }, 300_000);
    });
}

export async function execCommand(command: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(command, args, {
        timeout: 30_000,
        maxBuffer: 5 * 1024 * 1024,
    });
    return stdout;
}

// --- Size Formatting ---

export function formatBytes(bytes: number): string {
    if (bytes <= 0) return "0 B";

    let unitIndex = 0;
    let size = bytes;
    while (size >= BYTES_PER_KB && unitIndex < SIZE_UNITS.length - 1) {
        size /= BYTES_PER_KB;
        unitIndex++;
    }

    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${SIZE_UNITS[unitIndex]}`;
}

export function formatBytesFromKB(kb: number): string {
    return formatBytes(kb * BYTES_PER_KB);
}

// --- Dry Run Output Parsing ---

export interface CleanCategory {
    name: string;
    size: string;
    isDryRun: boolean;
    items: string[];
}

/**
 * Parse `mo clean --dry-run` output into structured categories.
 * Output lines look like:
 *   ▶ Section Name
 *   ⊘ item description, 123.4MB dry
 *   ✓ Nothing to clean
 */
export function parseDryRunOutput(output: string): CleanCategory[] {
    const categories: CleanCategory[] = [];
    let currentCategory: CleanCategory | null = null;

    for (const line of output.split("\n")) {
        const stripped = stripAnsi(line).trim();
        if (!stripped) continue;

        // Section header: starts with ▶ or →
        if (stripped.startsWith("▶") || stripped.startsWith("→")) {
            if (currentCategory) categories.push(currentCategory);
            currentCategory = {
                name: stripped.replace(/^[▶→]\s*/, "").trim(),
                size: "",
                isDryRun: true,
                items: [],
            };
            continue;
        }

        if (!currentCategory) continue;

        // Dry run item: ⊘ description, SIZE dry
        const dryRunMatch = stripped.match(/^[⊘]\s*(.+?),\s*([\d.]+\s*\w+)\s*dry$/);
        if (dryRunMatch) {
            currentCategory.items.push(dryRunMatch[1]);
            currentCategory.size = dryRunMatch[2];
            continue;
        }

        // Success item: ✓ description, SIZE
        const successMatch = stripped.match(/^[✓]\s*(.+?),\s*([\d.]+\s*\w+)$/);
        if (successMatch) {
            currentCategory.items.push(successMatch[1]);
            currentCategory.size = successMatch[2];
            continue;
        }

        // Nothing to clean
        if (stripped.includes("Nothing to clean")) {
            currentCategory.size = "0 B";
        }
    }

    if (currentCategory) categories.push(currentCategory);
    return categories.filter((c) => c.name);
}

// --- ANSI Stripping ---

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI_REGEX, "");
}

// --- Directory Scanning ---

export interface DirEntry {
    name: string;
    path: string;
    size: number;
    isDir: boolean;
}

/**
 * Scan a directory and compute sizes using `du -sk`.
 * Returns entries sorted by size descending.
 */
export async function scanDirectory(dirPath: string): Promise<DirEntry[]> {
    const entries: DirEntry[] = [];

    let children: string[];
    try {
        children = readdirSync(dirPath);
    } catch {
        return entries;
    }

    const sizePromises = children.map(async (name) => {
        const fullPath = path.join(dirPath, name);
        try {
            const stat = statSync(fullPath);
            const isDir = stat.isDirectory();

            let sizeBytes: number;
            if (isDir) {
                try {
                    const { stdout } = await execFileAsync("du", ["-sk", fullPath], { timeout: 10_000 });
                    const kb = parseInt(stdout.split("\t")[0], 10);
                    sizeBytes = isNaN(kb) ? 0 : kb * BYTES_PER_KB;
                } catch {
                    sizeBytes = 0;
                }
            } else {
                sizeBytes = stat.size;
            }

            return { name, path: fullPath, size: sizeBytes, isDir };
        } catch {
            return null;
        }
    });

    const results = await Promise.all(sizePromises);
    for (const entry of results) {
        if (entry && entry.size > 0) {
            entries.push(entry);
        }
    }

    entries.sort((a, b) => b.size - a.size);
    return entries;
}

// --- App Scanning (for Uninstall) ---

export interface AppEntry {
    name: string;
    path: string;
    bundleId: string;
    size: number;
    icon: string;
}

const PROTECTED_BUNDLE_IDS = new Set([
    "com.apple.finder",
    "com.apple.Safari",
    "com.apple.systempreferences",
    "com.apple.AppStore",
    "com.apple.Terminal",
    "com.apple.dt.Xcode",
]);

export async function scanApplications(): Promise<AppEntry[]> {
    const appDirs = ["/Applications", path.join(process.env.HOME || "", "Applications")];
    const apps: AppEntry[] = [];

    for (const appDir of appDirs) {
        if (!existsSync(appDir)) continue;

        let items: string[];
        try {
            items = readdirSync(appDir);
        } catch {
            continue;
        }

        for (const item of items) {
            if (!item.endsWith(".app")) continue;
            const appPath = path.join(appDir, item);
            const appName = item.replace(/\.app$/, "");

            // Read bundle ID from Info.plist
            let bundleId = "unknown";
            const plistPath = path.join(appPath, "Contents", "Info.plist");
            if (existsSync(plistPath)) {
                try {
                    const { stdout } = await execFileAsync("defaults", ["read", plistPath, "CFBundleIdentifier"], {
                        timeout: 3000,
                    });
                    bundleId = stdout.trim();
                } catch {
                    // keep unknown
                }
            }

            if (PROTECTED_BUNDLE_IDS.has(bundleId)) continue;

            // Get app size
            let sizeBytes = 0;
            try {
                const { stdout } = await execFileAsync("du", ["-sk", appPath], { timeout: 10_000 });
                const kb = parseInt(stdout.split("\t")[0], 10);
                sizeBytes = isNaN(kb) ? 0 : kb * BYTES_PER_KB;
            } catch {
                // skip sizing errors
            }

            const iconPath = path.join(appPath, "Contents", "Resources", "AppIcon.icns");
            const icon = existsSync(iconPath) ? iconPath : appPath;

            apps.push({ name: appName, path: appPath, bundleId, size: sizeBytes, icon });
        }
    }

    apps.sort((a, b) => b.size - a.size);
    return apps;
}

// --- Confirmation + Execution Helpers ---

export async function confirmAndExecute(options: {
    title: string;
    message: string;
    primaryAction: string;
    onConfirm: () => Promise<void>;
}) {
    const confirmed = await confirmAlert({
        title: options.title,
        message: options.message,
        primaryAction: {
            title: options.primaryAction,
            style: Alert.ActionStyle.Destructive,
        },
    });

    if (!confirmed) return;

    const toast = await showToast({ style: Toast.Style.Animated, title: "執行中..." });
    try {
        await options.onConfirm();
        toast.style = Toast.Style.Success;
        toast.title = "完成！";
    } catch (error) {
        toast.style = Toast.Style.Failure;
        toast.title = "執行失敗";
        toast.message = error instanceof Error ? error.message : String(error);
    }
}

// --- Trash Helper ---

export async function trashPaths(paths: string[]) {
    await trash(paths);
}

// --- System Info ---

export async function getSystemInfo() {
    const [memoryInfo, diskInfo, uptimeInfo] = await Promise.all([getMemoryInfo(), getDiskInfo(), getUptimeInfo()]);
    return { ...memoryInfo, ...diskInfo, ...uptimeInfo };
}

async function getMemoryInfo() {
    const totalBytes = parseInt((await execCommand("sysctl", ["-n", "hw.memsize"])).trim(), 10);
    const totalGB = totalBytes / (1024 * 1024 * 1024);

    const vmOutput = await execCommand("vm_stat", []);
    const pageSize = 4096;

    const extractPages = (label: string): number => {
        const match = vmOutput.match(new RegExp(`${label}:\\s+(\\d+)`));
        return match ? parseInt(match[1], 10) : 0;
    };

    const activePages = extractPages("Pages active");
    const wiredPages = extractPages("Pages wired down");
    const compressedPages = extractPages("Pages occupied by compressor");

    const usedBytes = (activePages + wiredPages + compressedPages) * pageSize;
    const usedGB = usedBytes / (1024 * 1024 * 1024);

    return {
        memoryUsedGB: Math.round(usedGB * 10) / 10,
        memoryTotalGB: Math.round(totalGB * 10) / 10,
        memoryPercent: Math.round((usedGB / totalGB) * 100),
    };
}

async function getDiskInfo() {
    const home = process.env.HOME || "/";
    const output = await execCommand("df", ["-k", home]);
    const lines = output.trim().split("\n");
    if (lines.length < 2) return { diskUsedGB: 0, diskTotalGB: 0, diskPercent: 0, diskFreeGB: 0 };

    const parts = lines[1].split(/\s+/);
    const totalKB = parseInt(parts[1], 10);
    const usedKB = parseInt(parts[2], 10);
    const availKB = parseInt(parts[3], 10);

    return {
        diskUsedGB: Math.round((usedKB / (1024 * 1024)) * 10) / 10,
        diskTotalGB: Math.round((totalKB / (1024 * 1024)) * 10) / 10,
        diskPercent: Math.round((usedKB / totalKB) * 100),
        diskFreeGB: Math.round((availKB / (1024 * 1024)) * 10) / 10,
    };
}

async function getUptimeInfo() {
    try {
        const output = await execCommand("sysctl", ["-n", "kern.boottime"]);
        const match = output.match(/sec = (\d+)/);
        if (!match) return { uptimeDays: 0 };

        const bootTime = parseInt(match[1], 10);
        const uptimeSeconds = Math.floor(Date.now() / 1000) - bootTime;
        return { uptimeDays: Math.round((uptimeSeconds / 86400) * 10) / 10 };
    } catch {
        return { uptimeDays: 0 };
    }
}
