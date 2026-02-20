import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState } from "react";
import { execMo, parseDryRunOutput, CleanCategory, confirmAndExecute } from "./utils";

export default function CleanCommand() {
    const [categories, setCategories] = useState<CleanCategory[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [totalSize, setTotalSize] = useState("");

    useEffect(() => {
        runDryRun();
    }, []);

    async function runDryRun() {
        setIsLoading(true);
        setError(null);
        try {
            const output = await execMo(["clean", "--dry-run"]);
            const parsed = parseDryRunOutput(output);
            setCategories(parsed);

            // Extract total from summary line
            const totalMatch = output.match(/Space freed:\s*([\d.]+\s*\w+)/i);
            if (totalMatch) {
                setTotalSize(totalMatch[1]);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            await showToast({ style: Toast.Style.Failure, title: "掃描失敗", message });
        } finally {
            setIsLoading(false);
        }
    }

    async function executeClean() {
        await confirmAndExecute({
            title: "確認清理？",
            message: `將清理約 ${totalSize || "未知大小"} 的快取、日誌和暫存檔案。此操作無法復原。`,
            primaryAction: "執行清理",
            onConfirm: async () => {
                await execMo(["clean"]);
                await showToast({ style: Toast.Style.Success, title: "清理完成！", message: `已釋放 ${totalSize}` });
                await runDryRun(); // Refresh
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

    return (
        <List
            isLoading={isLoading}
            searchBarPlaceholder="Search cleanup categories..."
            navigationTitle="Mole Clean"
        >
            {categories.length === 0 && !isLoading ? (
                <List.EmptyView icon={Icon.Checkmark} title="系統已經很乾淨！" description="沒有可清理的項目" />
            ) : (
                <>
                    {categories.map((category, index) => (
                        <List.Item
                            key={`${category.name}-${index}`}
                            icon={{ source: getCategoryIcon(category.name), tintColor: getCategoryColor(category.size) }}
                            title={category.name}
                            subtitle={category.items.length > 0 ? `${category.items.length} items` : undefined}
                            accessories={[{ text: category.size || "0 B", icon: Icon.HardDrive }]}
                            actions={
                                <ActionPanel>
                                    <Action
                                        title="執行全部清理"
                                        icon={Icon.Trash}
                                        style={Action.Style.Destructive}
                                        onAction={executeClean}
                                    />
                                    <Action title="重新掃描" icon={Icon.ArrowClockwise} onAction={runDryRun} />
                                    {category.items.length > 0 && (
                                        <Action.CopyToClipboard
                                            title="複製清單"
                                            content={category.items.join("\n")}
                                            shortcut={{ modifiers: ["cmd"], key: "c" }}
                                        />
                                    )}
                                </ActionPanel>
                            }
                        />
                    ))}
                    {totalSize && (
                        <List.Item
                            icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
                            title={`Total: ${totalSize}`}
                            subtitle="可釋放空間"
                        />
                    )}
                </>
            )}
        </List>
    );
}

function getCategoryIcon(name: string): Icon {
    const lower = name.toLowerCase();
    if (lower.includes("browser")) return Icon.Globe;
    if (lower.includes("developer") || lower.includes("dev")) return Icon.Code;
    if (lower.includes("system")) return Icon.ComputerChip;
    if (lower.includes("cache")) return Icon.MemoryChip;
    if (lower.includes("log")) return Icon.Document;
    if (lower.includes("trash")) return Icon.Trash;
    if (lower.includes("app")) return Icon.AppWindowGrid3x3;
    return Icon.Folder;
}

function getCategoryColor(size: string): Color {
    if (!size) return Color.SecondaryText;
    const match = size.match(/([\d.]+)\s*(\w+)/);
    if (!match) return Color.SecondaryText;

    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();

    if (unit === "GB" && value >= 1) return Color.Red;
    if (unit === "GB" || (unit === "MB" && value >= 500)) return Color.Orange;
    if (unit === "MB" && value >= 100) return Color.Yellow;
    return Color.Green;
}
