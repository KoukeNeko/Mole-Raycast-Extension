import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState } from "react";
import { scanApplications, AppEntry, formatBytes, confirmAndExecute, execMo } from "./utils";

export default function UninstallCommand() {
    const [apps, setApps] = useState<AppEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        loadApps();
    }, []);

    async function loadApps() {
        setIsLoading(true);
        try {
            const scanned = await scanApplications();
            setApps(scanned);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await showToast({ style: Toast.Style.Failure, title: "掃描失敗", message });
        } finally {
            setIsLoading(false);
        }
    }

    async function uninstallApp(app: AppEntry) {
        await confirmAndExecute({
            title: `確認解除安裝 ${app.name}？`,
            message: `將移除 ${app.name} (${formatBytes(app.size)}) 及其相關檔案（快取、設定等）。此操作無法復原。`,
            primaryAction: "解除安裝",
            onConfirm: async () => {
                const toast = await showToast({ style: Toast.Style.Animated, title: `正在解除安裝 ${app.name}...` });
                try {
                    // Try using Mole's uninstaller for thorough removal
                    await execMo(["uninstall", "--batch", app.path]);
                    toast.style = Toast.Style.Success;
                    toast.title = `已解除安裝 ${app.name}`;
                } catch {
                    // Fallback: move to trash
                    const { trash } = await import("@raycast/api");
                    await trash(app.path);
                    toast.style = Toast.Style.Success;
                    toast.title = `已將 ${app.name} 移至垃圾桶`;
                    toast.message = "提示：部分殘留檔案可能需要手動清理";
                }
                await loadApps(); // Refresh list
            },
        });
    }

    return (
        <List isLoading={isLoading} searchBarPlaceholder="Search applications..." navigationTitle="Mole Uninstall">
            {apps.length === 0 && !isLoading ? (
                <List.EmptyView icon={Icon.Checkmark} title="沒有找到應用程式" />
            ) : (
                apps.map((app) => (
                    <List.Item
                        key={app.path}
                        icon={{ fileIcon: app.path }}
                        title={app.name}
                        subtitle={app.bundleId !== "unknown" ? app.bundleId : undefined}
                        accessories={[
                            {
                                text: formatBytes(app.size),
                                icon: { source: Icon.HardDrive, tintColor: getSizeColor(app.size) },
                            },
                        ]}
                        actions={
                            <ActionPanel>
                                <Action
                                    title="解除安裝"
                                    icon={Icon.Trash}
                                    style={Action.Style.Destructive}
                                    onAction={() => uninstallApp(app)}
                                />
                                <Action.ShowInFinder path={app.path} shortcut={{ modifiers: ["cmd"], key: "f" }} />
                                <Action.CopyToClipboard
                                    title="複製路徑"
                                    content={app.path}
                                    shortcut={{ modifiers: ["cmd"], key: "c" }}
                                />
                                <Action title="重新掃描" icon={Icon.ArrowClockwise} onAction={loadApps} />
                            </ActionPanel>
                        }
                    />
                ))
            )}
        </List>
    );
}

function getSizeColor(sizeBytes: number): Color {
    const gb = sizeBytes / (1024 * 1024 * 1024);
    if (gb >= 2) return Color.Red;
    if (gb >= 0.5) return Color.Orange;
    if (gb >= 0.1) return Color.Yellow;
    return Color.SecondaryText;
}
