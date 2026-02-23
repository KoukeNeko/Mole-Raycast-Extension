import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState, useMemo } from "react";
import path from "path";
import { execMo, confirmAndExecute, trashPaths, stripAnsi } from "./utils";

// --- Constants ---

const HOME = process.env.HOME || "";

// --- Types ---

interface PurgeItem {
  name: string;
  path: string;
  project: string;
  sizeBytes: number;
  isRecent: boolean;
}

// --- CLI Output Parsing ---

/** Parse a human-readable size string (e.g. "527.2MB", "660KB", "2.34GB") into bytes. */
function parseSizeString(sizeStr: string): number {
  const match = sizeStr.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();

  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };

  return Math.round(value * (multipliers[unit] || 1));
}

/** Expand `~` prefix to the user's home directory. */
function expandTilde(p: string): string {
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

/**
 * Parse `mo purge --dry-run` output into PurgeItem[].
 *
 * Expected line format:
 *   → ~/Documents/GitHub/project  527.2MB  |  node_modules
 *   → ~/Documents/GitHub/app  285.3MB  |  node_modules  [Recent]
 */
function parseDryRunOutput(output: string): PurgeItem[] {
  const items: PurgeItem[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();

    // Match: → <path>  <size>  |  <artifact>  [Recent]?
    const match = line.match(/^→\s+(.+?)\s+([\d.]+\s*(?:B|KB|MB|GB|TB))\s+\|\s+(\S+)(.*)$/i);
    if (!match) continue;

    const projectPath = match[1].trim();
    const sizeStr = match[2].trim();
    const artifactName = match[3].trim();
    const trailing = match[4] || "";
    const isRecent = trailing.includes("[Recent]");

    const absoluteProjectPath = expandTilde(projectPath);
    const artifactFullPath = path.join(absoluteProjectPath, artifactName);
    const projectName = path.basename(absoluteProjectPath);

    items.push({
      name: artifactName,
      path: artifactFullPath,
      project: projectName,
      sizeBytes: parseSizeString(sizeStr),
      isRecent,
    });
  }

  return items;
}

// --- Size Formatting ---

function formatBytesShort(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// --- Component ---

export default function PurgeCommand() {
  const [items, setItems] = useState<PurgeItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function scan() {
      setIsLoading(true);
      try {
        const output = await execMo(["purge", "--dry-run"]);
        console.error("================ PURGE RUN ================");
        console.error("[purge] raw output length:", output.length);
        console.error("[purge] first 300 chars:", output.substring(0, 300));
        const found = parseDryRunOutput(output);
        console.error("[purge] items found:", found.length);
        if (found.length > 0) console.error("Found:", found[0]);
        setItems(found);
      } catch (err) {
        console.error("[purge] ERROR:", err);
        showToast({ style: Toast.Style.Failure, title: "Failed to scan projects", message: String(err) });
      } finally {
        setIsLoading(false);
      }
    }
    scan();
  }, []);

  async function purgeItem(item: PurgeItem) {
    await confirmAndExecute({
      title: `清理 ${item.project} 的 ${item.name}？`,
      message: "此操作將會把這些建置檔案與相依套件移至垃圾桶，後續你需要重新安裝 (例如 npm install)。",
      primaryAction: "清理",
      onConfirm: async () => {
        await showToast({ style: Toast.Style.Animated, title: `Purging ${item.name}...` });
        try {
          await trashPaths([item.path]);
          setItems((prev) => prev.filter((p) => p.path !== item.path));
          await showToast({ style: Toast.Style.Success, title: `Purged ${item.name}` });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await showToast({ style: Toast.Style.Failure, title: "Failed to purge", message });
        }
      },
    });
  }

  async function purgeAll() {
    const totalSize = items.reduce((acc, curr) => acc + curr.sizeBytes, 0);

    await confirmAndExecute({
      title: "清理所有專案快取？",
      message: `即將清理約 ${formatBytesShort(totalSize)} 的專案建置檔與相依套件。此操作會將所有列出的資料夾移至垃圾桶。`,
      primaryAction: "全部清理",
      onConfirm: async () => {
        await showToast({ style: Toast.Style.Animated, title: "Purging all items..." });
        try {
          const paths = items.map((i) => i.path);
          if (paths.length > 0) {
            await trashPaths(paths);
            setItems([]);
            await showToast({ style: Toast.Style.Success, title: "All projects purged!" });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await showToast({ style: Toast.Style.Failure, title: "Failed to purge all", message });
        }
      },
    });
  }

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const sizeA = a.sizeBytes || 0;
      const sizeB = b.sizeBytes || 0;
      if (sizeA !== sizeB) return sizeB - sizeA;
      return a.project.localeCompare(b.project);
    });
  }, [items]);

  const totalSize = items.reduce((acc, curr) => acc + curr.sizeBytes, 0);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search project caches...">
      {!isLoading && items.length > 0 && (
        <List.Item
          icon={{ source: Icon.Stars, tintColor: Color.Orange }}
          title="Purge All Projects"
          subtitle={`Free up ~${formatBytesShort(totalSize)}`}
          actions={
            <ActionPanel>
              <Action title="Purge All" icon={Icon.Trash} style={Action.Style.Destructive} onAction={purgeAll} />
            </ActionPanel>
          }
        />
      )}

      {(() => {
        // Group items by artifact type (e.g. node_modules, build, dist)
        const groups = new Map<string, typeof sortedItems>();
        for (const item of sortedItems) {
          const list = groups.get(item.name) || [];
          list.push(item);
          groups.set(item.name, list);
        }

        return Array.from(groups.entries()).map(([artifactType, groupItems]) => (
          <List.Section key={artifactType} title={artifactType} subtitle={`${groupItems.length} items`}>
            {groupItems.map((item) => (
              <List.Item
                key={item.path}
                icon={{ source: Icon.Box, tintColor: item.isRecent ? Color.Yellow : Color.Blue }}
                title={item.project}
                subtitle={item.path.replace(HOME, "~")}
                accessories={[
                  ...(item.isRecent ? [{ tag: { value: "Recent", color: Color.Yellow } }] : []),
                  { text: formatBytesShort(item.sizeBytes) },
                ]}
                actions={
                  <ActionPanel>
                    <Action
                      title="Purge Folder"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      onAction={() => purgeItem(item)}
                    />
                    <Action.ShowInFinder title="Show in Finder" path={item.path} />
                    <Action.CopyToClipboard title="Copy Path" content={item.path} />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        ));
      })()}

      {!isLoading && items.length === 0 && (
        <List.EmptyView icon={Icon.Checkmark} title="No project caches found!" description="Your projects are clean." />
      )}
    </List>
  );
}
