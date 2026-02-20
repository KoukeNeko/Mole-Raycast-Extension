import { ActionPanel, Action, Icon, List, Color } from "@raycast/api";
import { useEffect, useState, useCallback } from "react";
import { scanDirectory, DirEntry, formatBytes, confirmAndExecute, trashPaths } from "./utils";
import path from "path";

export default function AnalyzeCommand() {
    const home = process.env.HOME || "/";
    return <DirectoryView dirPath={home} />;
}

function DirectoryView({ dirPath }: { dirPath: string }) {
    const [entries, setEntries] = useState<DirEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [totalSize, setTotalSize] = useState(0);

    const loadDirectory = useCallback(async () => {
        setIsLoading(true);
        const scanned = await scanDirectory(dirPath);
        setEntries(scanned);
        setTotalSize(scanned.reduce((sum, e) => sum + e.size, 0));
        setIsLoading(false);
    }, [dirPath]);

    useEffect(() => {
        loadDirectory();
    }, [loadDirectory]);

    const displayPath = dirPath.replace(process.env.HOME || "", "~");

    return (
        <List
            isLoading={isLoading}
            searchBarPlaceholder="Search files and folders..."
            navigationTitle={`Analyze ${displayPath}`}
        >
            <List.Section title={`${displayPath}  |  Total: ${formatBytes(totalSize)}`}>
                {entries.map((entry, index) => {
                    const percent = totalSize > 0 ? Math.round((entry.size / totalSize) * 100) : 0;
                    const barWidth = Math.max(1, Math.round(percent / 5));
                    const bar = "█".repeat(barWidth) + "░".repeat(20 - barWidth);

                    return (
                        <List.Item
                            key={`${entry.path}-${index}`}
                            icon={{
                                source: entry.isDir ? Icon.Folder : Icon.Document,
                                tintColor: entry.isDir ? Color.Blue : Color.SecondaryText,
                            }}
                            title={entry.name}
                            subtitle={`${bar}  ${percent}%`}
                            accessories={[{ text: formatBytes(entry.size), icon: Icon.HardDrive }]}
                            actions={
                                <ActionPanel>
                                    {entry.isDir && (
                                        <Action.Push
                                            title="進入資料夾"
                                            icon={Icon.ArrowRight}
                                            target={<DirectoryView dirPath={entry.path} />}
                                        />
                                    )}
                                    <Action.ShowInFinder path={entry.path} shortcut={{ modifiers: ["cmd"], key: "f" }} />
                                    <Action.Open title="打開" target={entry.path} shortcut={{ modifiers: ["cmd"], key: "o" }} />
                                    <Action
                                        title="刪除 (移至垃圾桶)"
                                        icon={Icon.Trash}
                                        style={Action.Style.Destructive}
                                        shortcut={{ modifiers: ["ctrl"], key: "x" }}
                                        onAction={async () => {
                                            await confirmAndExecute({
                                                title: `確認刪除 ${entry.name}？`,
                                                message: `將 ${entry.name} (${formatBytes(entry.size)}) 移至垃圾桶。`,
                                                primaryAction: "移至垃圾桶",
                                                onConfirm: async () => {
                                                    await trashPaths([entry.path]);
                                                    await loadDirectory();
                                                },
                                            });
                                        }}
                                    />
                                    <Action title="重新掃描" icon={Icon.ArrowClockwise} onAction={loadDirectory} />
                                    <Action.CopyToClipboard
                                        title="複製路徑"
                                        content={entry.path}
                                        shortcut={{ modifiers: ["cmd"], key: "c" }}
                                    />
                                </ActionPanel>
                            }
                        />
                    );
                })}
            </List.Section>
        </List>
    );
}
