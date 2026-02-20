import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState } from "react";
import { execMo, stripAnsi, confirmAndExecute } from "./utils";

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

    useEffect(() => {
        runDryRun();
    }, []);

    async function runDryRun() {
        setIsLoading(true);
        setError(null);
        try {
            const output = await execMo(["clean", "--dry-run"]);
            const { categories: parsed, summary: parsedSummary } = parseMoCleanOutput(output);
            setCategories(parsed);
            setSummary(parsedSummary);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            await showToast({ style: Toast.Style.Failure, title: "掃描失敗", message });
        } finally {
            setIsLoading(false);
        }
    }

    async function executeClean() {
        // Compute total from parsed categories as fallback
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
                    message: `已釋放 ${summary?.totalSize || ""}`,
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
                                                title="執行全部清理"
                                                icon={Icon.Trash}
                                                style={Action.Style.Destructive}
                                                onAction={executeClean}
                                            />
                                            <Action title="重新掃描" icon={Icon.ArrowClockwise} onAction={runDryRun} />
                                        </ActionPanel>
                                    }
                                />
                            ))}
                        </List.Section>
                    ))}

                    {emptyCategories.length > 0 && (
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

// --- Parser ---
// Actual mo clean --dry-run output format:
//   ➤ Category name
//     → Item description, 5.50GB dry
//     → Item · would clean
//     ✓ Nothing to clean
//   ...
//   Potential space: 10.83GB | Items: 941 | Categories: 27

function parseMoCleanOutput(output: string): {
    categories: CleanCategory[];
    summary: CleanSummary | null;
} {
    const categories: CleanCategory[] = [];
    let currentCategory: CleanCategory | null = null;
    let summary: CleanSummary | null = null;

    for (const line of output.split("\n")) {
        const stripped = stripAnsi(line).trim();
        if (!stripped) continue;

        // Summary line: "Potential space: 10.83GB | Items: 941 | Categories: 27"
        const summaryMatch = stripped.match(/Potential space:\s*([\d.]+\s*\w+)\s*\|\s*Items:\s*(\d+)\s*\|\s*Categories:\s*(\d+)/);
        if (summaryMatch) {
            summary = {
                totalSize: summaryMatch[1],
                totalItems: summaryMatch[2],
                totalCategories: summaryMatch[3],
            };
            continue;
        }

        // Section header: ➤ Category name
        if (stripped.startsWith("➤")) {
            if (currentCategory) categories.push(currentCategory);
            currentCategory = {
                name: stripped.replace(/^➤\s*/, "").trim(),
                items: [],
                totalSize: "",
            };
            continue;
        }

        if (!currentCategory) continue;

        // Item: → description, SIZE dry
        const dryMatch = stripped.match(/^→\s*(.+?),\s*([\d.]+\s*\w+)\s*dry$/);
        if (dryMatch) {
            currentCategory.items.push({ description: dryMatch[1], size: dryMatch[2] });
            continue;
        }

        // Item: → description · would clean/empty
        const wouldMatch = stripped.match(/^→\s*(.+?)\s*·\s*would\s+(.+)/);
        if (wouldMatch) {
            currentCategory.items.push({ description: `${wouldMatch[1]} (would ${wouldMatch[2]})`, size: "" });
            continue;
        }

        // Item: → description (no size)
        const simpleMatch = stripped.match(/^→\s*(.+)/);
        if (simpleMatch && !simpleMatch[1].startsWith("/")) {
            currentCategory.items.push({ description: simpleMatch[1], size: "" });
            continue;
        }

        // Nothing to clean — mark category as clean (keep it, no items)
        // ✓ Nothing to clean — handled by empty items array
    }

    if (currentCategory) categories.push(currentCategory);

    // Calculate total size per category
    for (const cat of categories) {
        const sizes = cat.items.map((i) => parseSizeToBytes(i.size)).filter((s) => s > 0);
        if (sizes.length > 0) {
            const total = sizes.reduce((a, b) => a + b, 0);
            cat.totalSize = formatBytesShort(total);
        }
    }

    return { categories, summary };
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
    const gb = bytes / (1024 ** 3);
    if (gb >= 2) return Color.Red;
    if (gb >= 0.5) return Color.Orange;
    if (gb >= 0.1) return Color.Yellow;
    if (bytes > 0) return Color.Green;
    return Color.SecondaryText;
}
