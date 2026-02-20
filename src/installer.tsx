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
  displayName?: string;
}

export default function InstallerCommand() {
  const [items, setItems] = useState<InstallerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [grouping, setGrouping] = useState<"type" | "path">("type");
  const [sorting, setSorting] = useState<"name" | "size">("name");

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
                prev.map((p) => (p.path === item.path ? { ...p, sizeBytes: sizeKb * 1024, isLoadingSize: false } : p)),
              );
            }
          } else {
            setItems((prev) =>
              prev.map((p) => (p.path === item.path ? { ...p, sizeBytes: stats.size, isLoadingSize: false } : p)),
            );
          }
        } catch {
          setItems((prev) => prev.map((p) => (p.path === item.path ? { ...p, isLoadingSize: false } : p)));
        }
      }),
    );
  }

  async function trashInstaller(item: InstallerItem) {
    await confirmAndExecute({
      title: `移除 ${item.displayName || item.name}？`,
      message: "此操作將會把安裝檔移至垃圾桶。",
      primaryAction: "移除",
      onConfirm: async () => {
        await showToast({ style: Toast.Style.Animated, title: `Removing ${item.displayName || item.name}...` });
        try {
          await trashPaths([item.path]);
          setItems((prev) => prev.filter((p) => p.path !== item.path));
          await showToast({ style: Toast.Style.Success, title: `Removed ${item.displayName || item.name}` });
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
    return [...items]
      .map((item) => {
        // Strip the 64-character Homebrew hash prefix if present
        let displayName = item.name;
        const hashMatch = displayName.match(/^[0-9a-f]{64}--(.*)/);
        if (hashMatch) {
          displayName = hashMatch[1];
        }
        return { ...item, displayName };
      })
      .sort((a, b) => {
        if (sorting === "size") {
          return (b.sizeBytes || 0) - (a.sizeBytes || 0);
        } else {
          return a.displayName.localeCompare(b.displayName);
        }
      });
  }, [items, sorting]);

  const groupedItems = useMemo(() => {
    const groups: Record<string, InstallerItem[]> = {};
    for (const item of sortedItems) {
      let groupName = "Other";

      if (grouping === "path") {
        const dirPath = path.dirname(item.path);
        const home = process.env.HOME || "";

        if (dirPath.startsWith(path.join(home, "Downloads"))) groupName = "Downloads";
        else if (dirPath.startsWith(path.join(home, "Desktop"))) groupName = "Desktop";
        else if (dirPath.startsWith(path.join(home, "Documents"))) groupName = "Documents";
        else if (dirPath.startsWith(path.join(home, "Public"))) groupName = "Public";
        else if (dirPath.startsWith(path.join(home, "Library/Downloads"))) groupName = "Library";
        else if (dirPath.startsWith("/Users/Shared")) groupName = "Shared";
        else if (dirPath.startsWith(path.join(home, "Library/Caches/Homebrew"))) groupName = "Homebrew";
        else if (dirPath.includes("CloudDocs/Downloads")) groupName = "iCloud";
        else if (dirPath.includes("com.apple.mail")) groupName = "Mail";
        else if (dirPath.includes("Telegram Desktop")) groupName = "Telegram";
        else groupName = path.basename(dirPath);
      } else {
        const ext = path.extname(item.displayName || item.name).toLowerCase();
        if (ext === ".dmg") groupName = "Disk Images (.dmg)";
        else if (ext === ".pkg" || ext === ".mpkg") groupName = "Packages (.pkg, .mpkg)";
        else if (ext === ".zip" || ext === ".xip") groupName = "Archives (.zip, .xip)";
        else if (ext === ".iso") groupName = "ISO Images (.iso)";
        else if ((item.displayName || item.name).endsWith(".app")) groupName = "macOS Installers (.app)";
        else groupName = ext ? `Files (${ext})` : "Other Files";
      }

      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(item);
    }

    const sortedGroups: Record<string, InstallerItem[]> = {};
    Object.keys(groups)
      .sort((a, b) => a.localeCompare(b))
      .forEach((key) => {
        sortedGroups[key] = groups[key];
      });

    return sortedGroups;
  }, [sortedItems, grouping]);

  const totalSize = items.reduce((acc, curr) => acc + (curr.sizeBytes || 0), 0);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search dmg, pkg, installers..."
      searchBarAccessory={
        <List.Dropdown
          tooltip="Group and Sort"
          value={`${grouping}_${sorting}`}
          onChange={(newValue) => {
            const [g, s] = newValue.split("_") as [string, string];
            setGrouping(g as "type" | "path");
            setSorting(s as "name" | "size");
          }}
        >
          <List.Dropdown.Section title="Group by File Type">
            <List.Dropdown.Item title="Sort by Name (A-Z)" value="type_name" />
            <List.Dropdown.Item title="Sort by Size" value="type_size" />
          </List.Dropdown.Section>
          <List.Dropdown.Section title="Group by Path">
            <List.Dropdown.Item title="Sort by Name (A-Z)" value="path_name" />
            <List.Dropdown.Item title="Sort by Size" value="path_size" />
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
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

      {Object.entries(groupedItems).map(([groupName, groupItems]) => (
        <List.Section key={groupName} title={`${groupName} (${groupItems.length})`}>
          {groupItems.map((item) => (
            <List.Item
              key={item.path}
              icon={{ fileIcon: item.path }}
              title={item.displayName || item.name}
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
      ))}

      {!isLoading && items.length === 0 && (
        <List.EmptyView
          icon={Icon.Checkmark}
          title="No installers found!"
          description="Your Downloads folder is clean."
        />
      )}
    </List>
  );
}

// --- Scanner Helpers ---

async function isInstallerZip(zipPath: string): Promise<boolean> {
  try {
    // Check first 50 entries for installer payloads, matching Mole CLI logic
    const { stdout } = await execAsync(`zipinfo -1 "${zipPath}" | head -n 50`, { timeout: 2000 });
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (/\.(app|pkg|dmg|xip)(\/|$)/i.test(line)) {
        return true;
      }
    }
  } catch {
    // Ignore zip parsing errors (e.g. invalid zip, permissions, tool missing)
  }
  return false;
}

async function findInstallersNative(dir: string, currentDepth: number, maxDepth: number, results: Set<string>) {
  if (currentDepth > maxDepth) return;
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of ents) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === ".Trash" || ent.name === "System" || ent.name.endsWith(".app")) continue;
        await findInstallersNative(fullPath, currentDepth + 1, maxDepth, results);
      } else if (ent.isFile()) {
        const l = ent.name.toLowerCase();
        if (
          l.endsWith(".dmg") ||
          l.endsWith(".pkg") ||
          l.endsWith(".iso") ||
          l.endsWith(".xip") ||
          l.endsWith(".mpkg")
        ) {
          results.add(fullPath);
        } else if (l.endsWith(".zip")) {
          // Verify if zip contains installer payloads
          if (await isInstallerZip(fullPath)) {
            results.add(fullPath);
          }
        }
      }
    }
  } catch {
    // ignore permission/access errors silently
  }
}

async function discoverInstallers(): Promise<InstallerItem[]> {
  const home = process.env.HOME || "";
  const downloadsDir = path.join(home, "Downloads");
  const desktopDir = path.join(home, "Desktop");
  const appsDir = "/Applications";

  const searchPaths = [
    downloadsDir,
    desktopDir,
    appsDir,
    home,
    path.join(home, "Documents"),
    path.join(home, "Public"),
    path.join(home, "Library/Downloads"),
    "/Users/Shared",
    "/Users/Shared/Downloads",
    path.join(home, "Library/Caches/Homebrew"),
    path.join(home, "Library/Mobile Documents/com~apple~CloudDocs/Downloads"),
    path.join(home, "Library/Containers/com.apple.mail/Data/Library/Mail Downloads"),
    path.join(home, "Library/Application Support/Telegram Desktop"),
    path.join(home, "Downloads/Telegram Desktop"),
  ].filter(fs.existsSync);

  if (searchPaths.length === 0) return [];

  const resultsSet = new Set<string>();

  // Mirror `mo installer` by doing a fast depth=2 search on all configured paths
  for (const p of searchPaths) {
    await findInstallersNative(p, 1, 2, resultsSet);
  }

  const items: InstallerItem[] = [];
  for (const p of resultsSet) {
    if (p.includes(".Trash") || p.includes("/System/")) continue;
    items.push({
      name: path.basename(p),
      path: p,
      isLoadingSize: true,
    });
  }

  return items;
}
