import { ActionPanel, Action, Icon, List, Color } from "@raycast/api";
import { useEffect, useState, useCallback } from "react";
import { scanDirectory, DirEntry, formatBytes, confirmAndExecute, trashPaths } from "./utils";

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
      <List.Section title={`${displayPath}`} subtitle={`Total: ${formatBytes(totalSize)}`}>
        {entries.map((entry, index) => {
          const percent = totalSize > 0 ? (entry.size / totalSize) * 100 : 0;
          const percentDisplay = percent >= 1 ? `${Math.round(percent)}%` : "<1%";

          return (
            <List.Item
              key={`${entry.path}-${index}`}
              icon={getEntryIcon(entry)}
              title={entry.name}
              subtitle={entry.isDir ? undefined : entry.path.split("/").slice(-2, -1)[0]}
              accessories={[
                {
                  tag: { value: percentDisplay, color: getPercentColor(percent) },
                },
                {
                  text: formatBytes(entry.size),
                },
              ]}
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
                    title="移至垃圾桶"
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

function getEntryIcon(entry: DirEntry): { source: Icon; tintColor: Color } {
  if (entry.isDir) {
    return { source: Icon.Folder, tintColor: Color.Blue };
  }

  const ext = entry.name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "zip":
    case "tar":
    case "gz":
    case "7z":
    case "rar":
      return { source: Icon.FolderBox, tintColor: Color.Orange };
    case "dmg":
    case "iso":
    case "pkg":
      return { source: Icon.Box, tintColor: Color.Purple };
    case "mp4":
    case "mov":
    case "avi":
    case "mkv":
      return { source: Icon.Video, tintColor: Color.Red };
    case "mp3":
    case "wav":
    case "flac":
    case "aac":
      return { source: Icon.Music, tintColor: Color.Magenta };
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "svg":
    case "webp":
      return { source: Icon.Image, tintColor: Color.Green };
    case "pdf":
      return { source: Icon.Document, tintColor: Color.Red };
    default:
      return { source: Icon.Document, tintColor: Color.SecondaryText };
  }
}

function getPercentColor(percent: number): Color {
  if (percent >= 50) return Color.Red;
  if (percent >= 25) return Color.Orange;
  if (percent >= 10) return Color.Yellow;
  if (percent >= 5) return Color.Blue;
  return Color.SecondaryText;
}
