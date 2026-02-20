import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState } from "react";
import { execMo, stripAnsi, confirmAndExecute } from "./utils";

interface OptimizeItem {
    name: string;
    description: string;
    status: "pending" | "done" | "skipped";
    detail: string;
}

export default function OptimizeCommand() {
    const [items, setItems] = useState<OptimizeItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [systemInfo, setSystemInfo] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        loadOptimizePreview();
    }, []);

    async function loadOptimizePreview() {
        setIsLoading(true);
        setError(null);
        try {
            const output = await execMo(["optimize", "--dry-run"]);
            const parsed = parseOptimizeOutput(output);
            setItems(parsed.items);
            setSystemInfo(parsed.systemInfo);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            await showToast({ style: Toast.Style.Failure, title: "無法取得優化資訊", message });
        } finally {
            setIsLoading(false);
        }
    }

    async function executeOptimize() {
        await confirmAndExecute({
            title: "執行系統優化？",
            message: `將執行 ${items.length} 項系統優化操作，包括清理快取、重建資料庫等。可能需要管理員權限。`,
            primaryAction: "執行優化",
            onConfirm: async () => {
                await execMo(["optimize"]);
                await showToast({ style: Toast.Style.Success, title: "優化完成！" });
                await loadOptimizePreview();
            },
        });
    }

    if (error) {
        return (
            <List>
                <List.EmptyView
                    icon={Icon.ExclamationMark}
                    title="無法載入"
                    description={error}
                    actions={
                        <ActionPanel>
                            <Action title="重試" icon={Icon.ArrowClockwise} onAction={loadOptimizePreview} />
                        </ActionPanel>
                    }
                />
            </List>
        );
    }

    return (
        <List isLoading={isLoading} searchBarPlaceholder="Search optimizations..." navigationTitle="Mole Optimize">
            {systemInfo && (
                <List.Section title="System">
                    <List.Item
                        icon={{ source: Icon.ComputerChip, tintColor: Color.Blue }}
                        title={systemInfo}
                        accessories={[{ text: "Current Status" }]}
                    />
                </List.Section>
            )}
            <List.Section title={`Optimizations (${items.length})`}>
                {items.map((item, index) => (
                    <List.Item
                        key={`${item.name}-${index}`}
                        icon={{ source: getItemIcon(item), tintColor: getItemColor(item) }}
                        title={item.name}
                        subtitle={item.description}
                        accessories={[{ text: item.status === "done" ? "✓" : "○" }]}
                        actions={
                            <ActionPanel>
                                <Action
                                    title="執行全部優化"
                                    icon={Icon.Bolt}
                                    style={Action.Style.Destructive}
                                    onAction={executeOptimize}
                                />
                                <Action title="重新載入" icon={Icon.ArrowClockwise} onAction={loadOptimizePreview} />
                            </ActionPanel>
                        }
                    />
                ))}
            </List.Section>
        </List>
    );
}

function getItemIcon(item: OptimizeItem): Icon {
    switch (item.status) {
        case "done":
            return Icon.Checkmark;
        case "skipped":
            return Icon.MinusCircle;
        default:
            return Icon.Circle;
    }
}

function getItemColor(item: OptimizeItem): Color {
    switch (item.status) {
        case "done":
            return Color.Green;
        case "skipped":
            return Color.SecondaryText;
        default:
            return Color.Yellow;
    }
}

function parseOptimizeOutput(output: string): { items: OptimizeItem[]; systemInfo: string } {
    const items: OptimizeItem[] = [];
    let systemInfo = "";

    for (const line of output.split("\n")) {
        const stripped = stripAnsi(line).trim();
        if (!stripped) continue;

        // System info line
        if (stripped.includes("System") && stripped.includes("GB") && stripped.includes("Disk")) {
            systemInfo = stripped.replace(/^[^\w]*/, "");
            continue;
        }

        // Optimization items: ▶ Name or → Name
        if (stripped.startsWith("▶") || stripped.startsWith("→") || stripped.startsWith("⚡")) {
            const name = stripped.replace(/^[▶→⚡]\s*/, "").trim();
            if (name && !name.includes("DRY RUN") && !name.includes("Optimize")) {
                items.push({ name, description: "", status: "pending", detail: "" });
            }
            continue;
        }

        // Success items: ✓ description
        const successMatch = stripped.match(/^[✓]\s*(.+)/);
        if (successMatch) {
            items.push({ name: successMatch[1], description: "", status: "done", detail: "" });
            continue;
        }

        // Detail for last item
        if (items.length > 0 && stripped.startsWith("-")) {
            items[items.length - 1].description = stripped.replace(/^-\s*/, "");
        }
    }

    return { items, systemInfo };
}
