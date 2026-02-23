import { ActionPanel, Action, Icon, List, showToast, Toast, Detail, useNavigation } from "@raycast/api";
import { useEffect, useState, useMemo } from "react";
import path from "path";
import { execMo, confirmAndExecute, trashPaths, stripAnsi, formatBytesShort } from "./utils";

export interface LeftoverFile {
  path: string;
  sizeDisplay: string;
}

interface InstalledApp {
  name: string;
  path: string;
  bundleId?: string;
  sizeBytes?: number;
  lastUsedDisplay?: string;
  leftoversDisplay?: string;
  leftoverFiles: LeftoverFile[];
  mtimeMs?: number; // Used for "time" sorting if needed, but we'll adapt to parsed data
}

function parseSizeString(sizeStr: string): number {
  if (!sizeStr || sizeStr === "N/A") return 0;
  const match = sizeStr.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return 0;

  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const k = 1024;
  switch (unit) {
    case "B": return val;
    case "KB": return val * k;
    case "MB": return val * k * k;
    case "GB": return val * k * k * k;
    case "TB": return val * k * k * k * k;
    default: return val;
  }
}

function parseDryRunDetailsOutput(output: string): InstalledApp[] {
  const lines = output.split(/[\r\n]+/);
  const found: InstalledApp[] = [];
  let currentApp: InstalledApp | null = null;

  for (let line of lines) {
    const cleanLine = stripAnsi(line).trimEnd(); // remove ansi, keep indent for checking if needed

    if (cleanLine.trim().startsWith("→")) {
      const parts = cleanLine.split("|").map(p => p.trim());
      if (parts.length < 4) continue;

      const nameSizeStr = parts[0];
      const nameSizeMatch = nameSizeStr.match(/^→\s*(.+?)\s+([\d.]+(?:B|KB|MB|GB|TB|N\/A))$/i);
      if (!nameSizeMatch) continue;

      const [, name, sizeStr] = nameSizeMatch;
      const bundleId = parts[1];
      const fullPath = parts[2];

      const lastUsedStr = parts.find(p => p.startsWith("Last:"))?.replace(/^Last:\s*/i, "");
      const leftoversStr = parts.find(p => p.startsWith("Leftovers:"))?.replace(/^Leftovers:\s*/i, "");

      currentApp = {
        name: name.trim(),
        path: fullPath.trim(),
        bundleId: bundleId && bundleId !== "N/A" ? bundleId : undefined,
        sizeBytes: parseSizeString(sizeStr),
        lastUsedDisplay: lastUsedStr,
        leftoversDisplay: leftoversStr,
        leftoverFiles: []
      };
      found.push(currentApp);
      continue;
    }

    if (currentApp && cleanLine.match(/^\s*[├└]─/)) {
      const leftoverMatch = cleanLine.match(/^\s*[├└]─\s*(.+?)\s+([\d.]+(?:B|KB|MB|GB|TB|N\/A))$/i);
      if (leftoverMatch) {
        currentApp.leftoverFiles.push({
          path: leftoverMatch[1].trim(),
          sizeDisplay: leftoverMatch[2].trim()
        });
      }
    }
  }

  return found;
}

function AppDetail({ app, onUninstall }: { app: InstalledApp; onUninstall: () => Promise<void> }) {
  const { pop } = useNavigation();

  const resolvePath = (p: string) => p.replace(/^~(?=$|\/|\\)/, process.env.HOME || "");

  const appActions = (
    <ActionPanel>
      <Action
        title="Uninstall App"
        icon={Icon.Trash}
        style={Action.Style.Destructive}
        onAction={async () => {
          await onUninstall();
          pop();
        }}
      />
      <Action.ShowInFinder title="Show in Finder" path={app.path} />
    </ActionPanel>
  );

  return (
    <List navigationTitle={app.name}>
      <List.Section title="App Information">
        <List.Item
          title="App Path"
          subtitle={app.path}
          icon={Icon.Finder}
          actions={appActions}
        />
        <List.Item
          title="Bundle ID"
          subtitle={app.bundleId || "N/A"}
          icon={Icon.Box}
          actions={appActions}
        />
        <List.Item
          title="Size"
          subtitle={formatBytesShort(app.sizeBytes || 0)}
          icon={Icon.HardDrive}
          actions={appActions}
        />
        {app.lastUsedDisplay && app.lastUsedDisplay !== "N/A" && (
          <List.Item
            title="Last Used"
            subtitle={app.lastUsedDisplay}
            icon={Icon.Calendar}
            actions={appActions}
          />
        )}
      </List.Section>

      {app.leftoverFiles && app.leftoverFiles.length > 0 && (
        <List.Section title={`Leftovers (${app.leftoversDisplay})`}>
          {app.leftoverFiles.map((f, index) => {
            const absPath = resolvePath(f.path);
            return (
              <List.Item
                key={index}
                title={f.path}
                icon={Icon.Document}
                accessories={[{ text: f.sizeDisplay }]}
                actions={
                  <ActionPanel>
                    <Action.ShowInFinder title="Show in Finder" path={absPath} />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}
    </List>
  );
}

export default function UninstallCommand() {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [sorting, setSorting] = useState<"name" | "size" | "time">("name");

  async function fetchApps() {
    setIsLoading(true);
    try {
      const output = await execMo(["uninstall", "--dry-run", "--details"]);
      const foundApps = parseDryRunDetailsOutput(output);
      setApps(foundApps);
    } catch (err) {
      showToast({ style: Toast.Style.Failure, title: "Failed to scan apps", message: String(err) });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    fetchApps();
  }, []);

  async function uninstallApp(app: InstalledApp) {
    const isConfirmed = await confirmAndExecute({
      title: `移除 ${app.name}？`,
      message: `這將會把應用程式本體${app.bundleId ? "與其相關的快取與設定檔" : ""}移至垃圾桶。`,
      primaryAction: `移除 ${app.name}`,
      onConfirm: async () => {
        await showToast({ style: Toast.Style.Animated, title: `Uninstalling ${app.name}...` });
        try {
          const pathsToTrash = [app.path];

          // Use parsed leftover files directly if requested
          // Since Mole output uses ~/, we'll resolve it before trashing
          const home = process.env.HOME || "";
          if (app.leftoverFiles && app.leftoverFiles.length > 0) {
            for (const leftover of app.leftoverFiles) {
              const absPath = leftover.path.replace(/^~(?=$|\/|\\)/, home);
              pathsToTrash.push(absPath);
            }
          } else if (app.bundleId) {
            // Fallback if no specific leftovers were parsed
            const fs = require("fs");
            const leftovers = [
              path.join(home, "Library/Application Support", app.bundleId),
              path.join(home, "Library/Caches", app.bundleId),
              path.join(home, "Library/Preferences", `${app.bundleId}.plist`),
              path.join(home, "Library/Saved Application State", `${app.bundleId}.savedState`),
              path.join(home, "Library/Containers", app.bundleId),
              path.join(home, "Library/HTTPStorages", app.bundleId),
              path.join(home, "Library/Logs", app.bundleId),
            ];
            for (const l of leftovers) {
              if (fs.existsSync(l)) pathsToTrash.push(l);
            }
          }

          await trashPaths(pathsToTrash);
          await showToast({ style: Toast.Style.Success, title: `${app.name} uninstalled` });

          await fetchApps();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await showToast({ style: Toast.Style.Failure, title: "Failed to uninstall", message });
        }
      },
    });
    return isConfirmed !== false;
  }

  const sortedApps = useMemo(() => {
    return [...apps].sort((a, b) => {
      if (sorting === "size") {
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
      } else if (sorting === "time") {
        return a.name.localeCompare(b.name);
      } else {
        return a.name.localeCompare(b.name);
      }
    });
  }, [apps, sorting]);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search applications to uninstall..."
      searchBarAccessory={
        <List.Dropdown
          tooltip="Sort Applications"
          value={sorting}
          onChange={(newValue) => setSorting(newValue as "name" | "size" | "time")}
        >
          <List.Dropdown.Item title="Sort by Name (A-Z)" value="name" />
          <List.Dropdown.Item title="Sort by Size" value="size" />
          <List.Dropdown.Item title="Sort by Add Time" value="time" />
        </List.Dropdown>
      }
    >
      <List.Section title={`Installed Applications (${sortedApps.length})`}>
        {sortedApps.map((app) => (
          <List.Item
            key={app.path}
            icon={{ fileIcon: app.path }}
            title={app.name}
            subtitle={app.bundleId}
            accessories={[
              // Time was removed to reduce noise as requested
              // Show leftovers if available
              ...(app.leftoversDisplay ? [{ text: `Leftovers: ${app.leftoversDisplay}`, icon: Icon.Important }] : []),
              // Show size
              ...(app.sizeBytes ? [{ text: formatBytesShort(app.sizeBytes) }] : [])
            ]}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Show Details"
                  icon={Icon.Sidebar}
                  target={<AppDetail app={app} onUninstall={async () => { await uninstallApp(app); }} />}
                />
                <Action
                  title="Uninstall App"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() => uninstallApp(app)}
                />
                <Action.ShowInFinder title="Show in Finder" path={app.path} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
