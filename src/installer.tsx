import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState, useMemo } from "react";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { formatBytesShort, confirmAndExecute, trashPaths } from "./utils";

const execAsync = promisify(exec);

interface InstallerItem {
    name: string;
    path: string;
    sizeBytes?: number;
    isLoadingSize?: boolean;
}

export default function InstallerCommand() {
    const [items, setItems] = useState<InstallerItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        async function scan() {
            setIsLoading(true);
            try {
                const found = await discoverInstallers();
                setItems(found);
                calculateSizes(found);
            } catch (err) {
                showToast({ style: Toast.Style.Failure, title: "Failed to scan installers", message: String(err) });
            } finally {
                setIsLoading(false);
            }
        }
        scan();
    }, []);

    async function calculateSizes(initialItems: InstallerItem[]) {
        await Promise.all(
            initialItems.map(async (item) => {
                try {
                    const stats = fs.statSync(item.path);
                    if (stats.isDirectory()) {
                        const { stdout } = await execAsync(`du -sk "${item.path}"`);
                        const sizeKb = parseInt(stdout.split("\t")[0], 10);
                        if (!isNaN(sizeKb)) {
                            setItems((prev) =>
                                prev.map((p) => (p.path === item.path ? { ...p, sizeBytes: sizeKb * 1024, isLoadingSize: false } : p))
                            );
                        }
                    } else {
                        setItems((prev) =>
                            prev.map((p) => (p.path === item.path ? { ...p, sizeBytes: stats.size, isLoadingSize: false } : p))
                        );
                    }
                } catch {
                    setItems((prev) => prev.map((p) => (p.path === item.path ? { ...p, isLoadingSize: false } : p)));
                }
            })
        );
    }

    async function trashInstaller(item: InstallerItem) {
        await confirmAndExecute({
            title: `移除 ${item.name}？`,
            message: "此操作將會把安裝檔移至垃圾桶。",
            primaryAction: "移除",
            onConfirm: async () => {
                await showToast({ style: Toast.Style.Animated, title: `Removing ${item.name}...` });
                try {
                    await trashPaths([item.path]);
                    setItems((prev) => prev.filter((p) => p.path !== item.path));
                    await showToast({ style: Toast.Style.Success, title: `Removed ${item.name}` });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    await showToast({ style: Toast.Style.Failure, title: "Failed to remove", message });
                }
            },
        });
    }

    async function removeAll() {
        const totalSize = items.reduce((acc, curr) => acc + (curr.sizeBytes || 0), 0);
        const hasPending = items.some((i) => i.isLoadingSize);
        const sizeStr = hasPending ? "計算中..." : formatBytesShort(totalSize);

        await confirmAndExecute({
            title: "清理所有安裝檔？",
            message: `即將清理約 ${sizeStr} 的 DMG、PKG 與系統安裝檔。`,
            primaryAction: "全部清理",
            onConfirm: async () => {
                await showToast({ style: Toast.Style.Animated, title: "Removing all installers..." });
                try {
                    const paths = items.map((i) => i.path);
                    if (paths.length > 0) {
                        await trashPaths(paths);
                        setItems([]);
                        await showToast({ style: Toast.Style.Success, title: "All installers removed!" });
                    }
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    await showToast({ style: Toast.Style.Failure, title: "Failed to remove all", message });
                }
            },
        });
    }

    const sortedItems = useMemo(() => {
        return [...items].sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
    }, [items]);

    const totalSize = items.reduce((acc, curr) => acc + (curr.sizeBytes || 0), 0);

    return (
        <List isLoading={isLoading} searchBarPlaceholder="Search dmg, pkg, installers...">
            {!isLoading && items.length > 0 && (
                <List.Item
                    icon={{ source: Icon.Stars, tintColor: Color.Orange }}
                    title="Clean All Installers"
                    subtitle={`Free up ~${formatBytesShort(totalSize)}`}
                    actions={
                        <ActionPanel>
                            <Action title="Clean All" icon={Icon.Trash} style={Action.Style.Destructive} onAction={removeAll} />
                        </ActionPanel>
                    }
                />
            )}

            <List.Section title={`Found ${items.length} installation files`}>
                {sortedItems.map((item) => (
                    <List.Item
                        key={item.path}
                        icon={{ fileIcon: item.path }}
                        title={item.name}
                        subtitle={path.dirname(item.path).replace(process.env.HOME || "", "~")}
                        accessories={
                            item.sizeBytes
                                ? [{ text: formatBytesShort(item.sizeBytes) }]
                                : item.isLoadingSize !== false
                                    ? [{ text: "Calculating..." }]
                                    : []
                        }
                        actions={
                            <ActionPanel>
                                <Action
                                    title="Remove File"
                                    icon={Icon.Trash}
                                    style={Action.Style.Destructive}
                                    onAction={() => trashInstaller(item)}
                                />
                                <Action.ShowInFinder title="Show in Finder" path={item.path} />
                                <Action.CopyToClipboard title="Copy Path" content={item.path} />
                            </ActionPanel>
                        }
                    />
                ))}
            </List.Section>

            {!isLoading && items.length === 0 && (
                <List.EmptyView icon={Icon.Checkmark} title="No installers found!" description="Your Downloads folder is clean." />
            )}
        </List>
    );
}

// --- Scanner Helpers ---

async function discoverInstallers(): Promise<InstallerItem[]> {
    const home = process.env.HOME || "";
    const downloadsDir = path.join(home, "Downloads");
    const desktopDir = path.join(home, "Desktop");
    const appsDir = "/Applications";

    const searchPaths = [downloadsDir, desktopDir, appsDir, home].filter(fs.existsSync);
    if (searchPaths.length === 0) return [];

    const scopeArgs = searchPaths.map((p) => `-onlyin "${p}"`).join(" ");
    // We search for DMG files, PKG files, and macOS Installers based on names or types
    const queries = [
        `kMDItemFSName == "*.dmg"c`,
        `kMDItemFSName == "*.pkg"c`,
        `kMDItemFSName == "Install macOS*.app"c`
    ];

    const filterQuery = queries.join(" || ");

    try {
        const cmd = `mdfind "(${filterQuery})" ${scopeArgs}`;
        const { stdout } = await execAsync(cmd);
        const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

        const items: InstallerItem[] = [];
        for (const p of lines) {
            if (fs.existsSync(p)) {
                // Exclude system stuff and trash just in case
                if (p.includes(".Trash") || p.includes("Library/Caches") || p.includes("/System/")) continue;

                items.push({
                    name: path.basename(p),
                    path: p,
                    isLoadingSize: true,
                });
            }
        }

        // Fallback: manually scan Downloads just in case spotlight index is slow/borked for recent downloads
        if (fs.existsSync(downloadsDir)) {
            const ents = fs.readdirSync(downloadsDir, { withFileTypes: true });
            for (const ent of ents) {
                const l = ent.name.toLowerCase();
                if (l.endsWith(".dmg") || l.endsWith(".pkg")) {
                    const fullPath = path.join(downloadsDir, ent.name);
                    if (!items.find(i => i.path === fullPath)) {
                        items.push({
                            name: ent.name,
                            path: fullPath,
                            isLoadingSize: true,
                        });
                    }
                }
            }
        }

        return items;
    } catch {
        return [];
    }
}
