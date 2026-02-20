import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState, useMemo } from "react";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { formatBytesShort, confirmAndExecute, trashPaths } from "./utils";

const execAsync = promisify(exec);

interface PurgeItem {
  name: string;
  path: string;
  project: string;
  sizeBytes?: number;
  isLoadingSize?: boolean;
}

export default function PurgeCommand() {
  const [items, setItems] = useState<PurgeItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function scan() {
      setIsLoading(true);
      try {
        const found = await discoverPurgeTargets();
        setItems(found);
        calculateSizes(found);
      } catch (err) {
        showToast({ style: Toast.Style.Failure, title: "Failed to scan projects", message: String(err) });
      } finally {
        setIsLoading(false);
      }
    }
    scan();
  }, []);

  async function calculateSizes(initialItems: PurgeItem[]) {
    // Process in batches so we don't spawn 1000 'du' processes
    const batchSize = 10;
    for (let i = 0; i < initialItems.length; i += batchSize) {
      const batch = initialItems.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (item) => {
          try {
            const { stdout } = await execAsync(`du -sk "${item.path}"`);
            const sizeKb = parseInt(stdout.split("\t")[0], 10);
            if (!isNaN(sizeKb)) {
              setItems((prev) =>
                prev.map((p) => (p.path === item.path ? { ...p, sizeBytes: sizeKb * 1024, isLoadingSize: false } : p)),
              );
            }
          } catch {
            setItems((prev) => prev.map((p) => (p.path === item.path ? { ...p, isLoadingSize: false } : p)));
          }
        }),
      );
    }
  }

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
    const totalSize = items.reduce((acc, curr) => acc + (curr.sizeBytes || 0), 0);
    const hasPending = items.some((i) => i.isLoadingSize);
    const sizeStr = hasPending ? "計算中..." : formatBytesShort(totalSize);

    await confirmAndExecute({
      title: "清理所有專案快取？",
      message: `即將清理約 ${sizeStr} 的專案建置檔與相依套件。此操作會將所有列出的資料夾移至垃圾桶。`,
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
      // Sort by size descending, then by project name
      const sizeA = a.sizeBytes || 0;
      const sizeB = b.sizeBytes || 0;
      if (sizeA !== sizeB) return sizeB - sizeA;
      return a.project.localeCompare(b.project);
    });
  }, [items]);

  const totalSize = items.reduce((acc, curr) => acc + (curr.sizeBytes || 0), 0);

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

      <List.Section title={`Found ${items.length} build directories`}>
        {sortedItems.map((item) => (
          <List.Item
            key={item.path}
            icon={{ source: Icon.Box, tintColor: Color.Blue }}
            title={item.project}
            subtitle={item.name}
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

      {!isLoading && items.length === 0 && (
        <List.EmptyView icon={Icon.Checkmark} title="No project caches found!" description="Your projects are clean." />
      )}
    </List>
  );
}

// --- Scanner Helpers ---

async function discoverPurgeTargets(): Promise<PurgeItem[]> {
  const home = process.env.HOME || "";
  const searchPaths = ["www", "dev", "Projects", "GitHub", "Code", "Workspace", "Repos", "Development"]
    .map((d) => path.join(home, d))
    .filter((p) => fs.existsSync(p));

  if (searchPaths.length === 0) return [];

  const targets = ["node_modules", "target", "build", "dist", "vendor", "DerivedData", ".next", ".nuxt"];
  const filterQuery = targets.map((t) => `kMDItemFSName == "${t}"`).join(" || ");
  const scopeArgs = searchPaths.map((p) => `-onlyin "${p}"`).join(" ");

  try {
    const cmd = `mdfind "(${filterQuery}) && (kMDItemContentType == 'public.folder')" ${scopeArgs}`;
    const { stdout } = await execAsync(cmd);
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const items: PurgeItem[] = [];
    for (const p of lines) {
      if (fs.existsSync(p)) {
        // Exclude nested node_modules (e.g. node_modules/library/node_modules)
        if (p.includes("node_modules/") && path.basename(p) === "node_modules") continue;

        // Exclude trash and library internal
        if (p.includes(".Trash") || p.includes("Library/Caches")) continue;

        const parent = path.dirname(p);
        items.push({
          name: path.basename(p),
          path: p,
          project: path.basename(parent),
          isLoadingSize: true,
        });
      }
    }
    return items;
  } catch {
    return [];
  }
}
