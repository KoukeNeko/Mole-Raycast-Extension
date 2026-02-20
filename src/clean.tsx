import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState, useRef, useCallback } from "react";
import { execMo, spawnMoStreaming, stripAnsi, confirmAndExecute, trashPaths } from "./utils";
import { existsSync } from "fs";

// --- Types ---

interface CleanCategory {
    name: string;
    items: CleanItem[];
    totalSize: string;
}

interface CleanItem {
    description: string;
    size: string;
}

interface CleanSummary {
    totalSize: string;
    totalItems: string;
    totalCategories: string;
}

// --- Command ---

export default function CleanCommand() {
    const [categories, setCategories] = useState<CleanCategory[]>([]);
    const [summary, setSummary] = useState<CleanSummary | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [scanStatus, setScanStatus] = useState("");

    // Use refs to accumulate state during streaming
    const categoriesRef = useRef<CleanCategory[]>([]);
    const currentCategoryRef = useRef<CleanCategory | null>(null);
    const currentScanIdRef = useRef(0);

    const runDryRun = useCallback(async () => {
        const scanId = ++currentScanIdRef.current;

        setIsLoading(true);
        setError(null);
        setCategories([]);
        setSummary(null);
        setScanStatus("正在掃描...");
        categoriesRef.current = [];
        currentCategoryRef.current = null;

        try {
            await spawnMoStreaming(["clean", "--dry-run"], (line) => {
                if (currentScanIdRef.current !== scanId) return; // Prevent concurrent streams making duplicates

                const stripped = stripAnsi(line).trim();
                if (!stripped) return;

                // Summary line
                const summaryMatch = stripped.match(
                    /Potential space:\s*([\d.]+\s*\w+)\s*\|\s*Items:\s*(\d+)\s*\|\s*Categories:\s*(\d+)/,
                );
                if (summaryMatch) {
                    setSummary({
                        totalSize: summaryMatch[1],
                        totalItems: summaryMatch[2],
                        totalCategories: summaryMatch[3],
                    });
                    return;
                }

                // Section header: ➤ Category name
                if (stripped.startsWith("➤")) {
                    // Push previous category
                    if (currentCategoryRef.current) {
                        finalizeCategorySize(currentCategoryRef.current);
                        categoriesRef.current = [...categoriesRef.current, currentCategoryRef.current];
                        setCategories([...categoriesRef.current]);
                    }
                    const name = stripped.replace(/^➤\s*/, "").trim();
                    currentCategoryRef.current = { name, items: [], totalSize: "" };
                    setScanStatus(`正在掃描 ${name}...`);
                    return;
                }

                if (!currentCategoryRef.current) return;

                // Item: → description, SIZE dry
                const dryMatch = stripped.match(/^→\s*(.+?),\s*([\d.]+\s*\w+)\s*dry$/);
                if (dryMatch) {
                    currentCategoryRef.current.items.push({ description: dryMatch[1], size: dryMatch[2] });
                    finalizeCategorySize(currentCategoryRef.current);
                    // Update immediately so user sees the item appear
                    setCategories([...categoriesRef.current, currentCategoryRef.current]);
                    return;
                }

                // Item: → description · would clean/empty
                const wouldMatch = stripped.match(/^→\s*(.+?)\s*·\s*would\s+(.+)/);
                if (wouldMatch) {
                    currentCategoryRef.current.items.push({
                        description: `${wouldMatch[1]} (would ${wouldMatch[2]})`,
                        size: "",
                    });
                    setCategories([...categoriesRef.current, currentCategoryRef.current]);
                    return;
                }

                // Item: → description (no size, not a path)
                const simpleMatch = stripped.match(/^→\s*(.+)/);
                if (simpleMatch && !simpleMatch[1].startsWith("/")) {
                    currentCategoryRef.current.items.push({ description: simpleMatch[1], size: "" });
                    setCategories([...categoriesRef.current, currentCategoryRef.current]);
                    return;
                }

                // Scanning progress: • description
                if (stripped.startsWith("•")) {
                    setScanStatus(stripped.replace(/^•\s*/, ""));
                }
            });

            if (currentScanIdRef.current !== scanId) return;

            // Push final category
            if (currentCategoryRef.current) {
                finalizeCategorySize(currentCategoryRef.current);
                categoriesRef.current = [...categoriesRef.current, currentCategoryRef.current];
                setCategories([...categoriesRef.current]);
            }
        } catch (err) {
            if (currentScanIdRef.current !== scanId) return;
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            await showToast({ style: Toast.Style.Failure, title: "掃描失敗", message });
        } finally {
            if (currentScanIdRef.current === scanId) {
                setIsLoading(false);
                setScanStatus("");
            }
        }
    }, []);

    useEffect(() => {
        runDryRun();
    }, [runDryRun]);

    async function executeClean() {
        const computedTotal = categories
            .flatMap((c) => c.items)
            .map((i) => parseSizeToBytes(i.size))
            .reduce((a, b) => a + b, 0);
        const totalDisplay = summary?.totalSize || (computedTotal > 0 ? formatBytesShort(computedTotal) : "");

        await confirmAndExecute({
            title: "確認清理？",
            message: `將清理約 ${totalDisplay} 的快取、日誌和暫存檔案。此操作無法復原。`,
            primaryAction: "執行清理",
            onConfirm: async () => {
                await execMo(["clean"]);
                await showToast({
                    style: Toast.Style.Success,
                    title: "清理完成！",
                    message: `已釋放 ${totalDisplay}`,
                });
                await runDryRun();
            },
        });
    }

    if (error) {
        return (
            <List>
                <List.EmptyView
                    icon={Icon.ExclamationMark}
                    title="無法掃描"
                    description={error}
                    actions={
                        <ActionPanel>
                            <Action title="重試" icon={Icon.ArrowClockwise} onAction={runDryRun} />
                        </ActionPanel>
                    }
                />
            </List>
        );
    }

    const nonEmptyCategories = categories.filter((c) => c.items.length > 0);
    const emptyCategories = categories.filter((c) => c.items.length === 0);

    return (
        <List isLoading={isLoading} searchBarPlaceholder="Search cleanup categories..." navigationTitle="Mole Clean">
            {categories.length === 0 && !isLoading ? (
                <List.EmptyView icon={Icon.Checkmark} title="系統已經很乾淨！" description="沒有可清理的項目" />
            ) : (
                <>
                    {/* Loading status */}
                    {isLoading && scanStatus && (
                        <List.Section title="Scanning">
                            <List.Item
                                icon={{ source: Icon.MagnifyingGlass, tintColor: Color.Blue }}
                                title={scanStatus}
                                accessories={[{ tag: { value: "掃描中", color: Color.Blue } }]}
                            />
                        </List.Section>
                    )}

                    {/* Summary */}
                    {summary && (
                        <List.Section title="Summary">
                            <List.Item
                                icon={{ source: Icon.HardDrive, tintColor: Color.Orange }}
                                title={`可釋放: ${summary.totalSize}`}
                                subtitle={`${summary.totalItems} items · ${summary.totalCategories} categories`}
                                actions={
                                    <ActionPanel>
                                        <Action
                                            title="執行全部清理"
                                            icon={Icon.Trash}
                                            style={Action.Style.Destructive}
                                            onAction={executeClean}
                                        />
                                        <Action title="重新掃描" icon={Icon.ArrowClockwise} onAction={runDryRun} />
                                    </ActionPanel>
                                }
                            />
                        </List.Section>
                    )}

                    {/* Categories with items */}
                    {nonEmptyCategories.map((category) => (
                        <List.Section key={category.name} title={category.name} subtitle={category.totalSize}>
                            {category.items.map((item, idx) => (
                                <List.Item
                                    key={`${category.name}-${idx}`}
                                    icon={{ source: getCategoryIcon(category.name), tintColor: getSizeColor(item.size) }}
                                    title={item.description}
                                    accessories={item.size ? [{ text: item.size }] : []}
                                    actions={
                                        <ActionPanel>
                                            <Action
                                                title={`清理 ${category.name}`}
                                                icon={Icon.Trash}
                                                style={Action.Style.Destructive}
                                                onAction={() => cleanCategory(category, runDryRun)}
                                            />
                                            <Action
                                                title="清理全部"
                                                icon={Icon.ExclamationMark}
                                                style={Action.Style.Destructive}
                                                shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
                                                onAction={executeClean}
                                            />
                                            <Action title="重新掃描" icon={Icon.ArrowClockwise} onAction={runDryRun} />
                                        </ActionPanel>
                                    }
                                />
                            ))}
                        </List.Section>
                    ))}

                    {/* Clean categories */}
                    {!isLoading && emptyCategories.length > 0 && (
                        <List.Section title="Already Clean">
                            {emptyCategories.map((category) => (
                                <List.Item
                                    key={category.name}
                                    icon={{ source: Icon.Checkmark, tintColor: Color.Green }}
                                    title={category.name}
                                    accessories={[{ tag: { value: "Clean", color: Color.Green } }]}
                                />
                            ))}
                        </List.Section>
                    )}
                </>
            )}
        </List>
    );
}

// --- Per-Category Clean ---

const CLEAN_LIST_PATH = `${process.env.HOME}/.config/mole/clean-list.txt`;

async function cleanCategory(category: CleanCategory, refresh: () => Promise<void>) {
    const paths = await getPathsForCategory(category.name);
    const sizeDisplay = category.totalSize || "selected items";

    await confirmAndExecute({
        title: `清理 ${category.name}？`,
        message: `將清理 ${sizeDisplay}。此操作無法復原。`,
        primaryAction: `清理 ${category.name}`,
        onConfirm: async () => {
            if (paths.length > 0) {
                const { readdirSync, statSync } = await import("fs");
                const pathModule = await import("path");
                const toTrash: string[] = [];

                for (const p of paths) {
                    try {
                        const stat = statSync(p);
                        if (stat.isDirectory()) {
                            // Trash the contents, not the directory itself
                            const items = readdirSync(p);
                            for (const item of items) {
                                toTrash.push(pathModule.join(p, item));
                            }
                        } else {
                            toTrash.push(p);
                        }
                    } catch {
                        // skip files we can't access
                    }
                }

                if (toTrash.length > 0) {
                    await trashPaths(toTrash);
                }
            }
            await showToast({ style: Toast.Style.Success, title: `已清理 ${category.name}` });
            await refresh();
        },
    });
}

async function getPathsForCategory(categoryName: string): Promise<string[]> {
    try {
        const { readFileSync } = await import("fs");
        const content = readFileSync(CLEAN_LIST_PATH, "utf-8");
        const paths: string[] = [];
        let inCategory = false;

        for (const line of content.split("\n")) {
            const trimmed = line.trim();

            if (trimmed.startsWith("===") && trimmed.endsWith("===")) {
                const name = trimmed.replace(/^=+\s*/, "").replace(/\s*=+$/, "").trim();
                inCategory = name.toLowerCase() === categoryName.toLowerCase();
                continue;
            }

            if (!inCategory) continue;
            if (!trimmed || trimmed.startsWith("#")) continue;

            const pathPart = trimmed.split("#")[0].trim();
            if (pathPart && pathPart.startsWith("/") && existsSync(pathPart)) {
                paths.push(pathPart);
            }
        }

        return paths;
    } catch {
        return [];
    }
}

// --- Helpers ---

function finalizeCategorySize(category: CleanCategory) {
    const sizes = category.items.map((i) => parseSizeToBytes(i.size)).filter((s) => s > 0);
    if (sizes.length > 0) {
        category.totalSize = formatBytesShort(sizes.reduce((a, b) => a + b, 0));
    }
}

function parseSizeToBytes(sizeStr: string): number {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.]+)\s*(\w+)/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return value * (multipliers[unit] || 1);
}

function formatBytesShort(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
}

function getCategoryIcon(name: string): Icon {
    const lower = name.toLowerCase();
    if (lower.includes("browser")) return Icon.Globe;
    if (lower.includes("developer") || lower.includes("dev")) return Icon.Code;
    if (lower.includes("system") || lower.includes("macos")) return Icon.ComputerChip;
    if (lower.includes("cache")) return Icon.MemoryChip;
    if (lower.includes("log")) return Icon.Document;
    if (lower.includes("trash")) return Icon.Trash;
    if (lower.includes("cloud")) return Icon.Cloud;
    if (lower.includes("office")) return Icon.TextDocument;
    if (lower.includes("user")) return Icon.Person;
    if (lower.includes("finder")) return Icon.Finder;
    if (lower.includes("virtual")) return Icon.Desktop;
    if (lower.includes("sandbox")) return Icon.Lock;
    if (lower.includes("xcode") || lower.includes("silicon")) return Icon.Hammer;
    if (lower.includes("large")) return Icon.MagnifyingGlass;
    if (lower.includes("ios")) return Icon.Mobile;
    if (lower.includes("time machine")) return Icon.Clock;
    if (lower.includes("uninstall") || lower.includes("app")) return Icon.AppWindowGrid3x3;
    if (lower.includes("support")) return Icon.Folder;
    return Icon.Folder;
}

function getSizeColor(size: string): Color {
    const bytes = parseSizeToBytes(size);
    const gb = bytes / 1024 ** 3;
    if (gb >= 2) return Color.Red;
    if (gb >= 0.5) return Color.Orange;
    if (gb >= 0.1) return Color.Yellow;
    if (bytes > 0) return Color.Green;
    return Color.SecondaryText;
}
