import { ActionPanel, Action, Icon, List, showToast, Toast, Detail, useNavigation } from "@raycast/api";
import { useEffect, useState, useMemo } from "react";
import path from "path";
import fs from "fs";
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

function useAnimatedEllipsis() {
  const [frame, setFrame] = useState(0);
  const frames = ["...", "..", ".", ".."];

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
    }, 400); // 400ms interval for a relaxed text animation
    return () => clearInterval(timer);
  }, []);

  return frames[frame];
}

// Find leftovers for a specific app dynamically using the Mole CLI
async function scanLeftoversForApp(app: InstalledApp): Promise<{ files: LeftoverFile[]; display?: string }> {
  try {
    const output = await execMo(["uninstall", "--dry-run", "--details", "--app-path", app.path]);
    const detailedApps = parseDryRunDetailsOutput(output);
    const match = detailedApps.find(a => a.path === app.path);
    return {
      files: match?.leftoverFiles || [],
      display: match?.leftoversDisplay
    };
  } catch (e) {
    return { files: [] };
  }
}

function AppDetail({ app, onUninstall }: { app: InstalledApp; onUninstall: (leftovers?: LeftoverFile[]) => Promise<void> }) {
  const { pop } = useNavigation();
  const [leftovers, setLeftovers] = useState<LeftoverFile[]>(app.leftoverFiles || []);
  const [leftoversDisplay, setLeftoversDisplay] = useState<string | undefined>(app.leftoversDisplay);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    // Dynamically scan leftovers when opening details
    if (leftovers.length === 0 && !app.leftoversDisplay) {
      setIsScanning(true);
      scanLeftoversForApp(app).then((result) => {
        setLeftovers(result.files);
        setLeftoversDisplay(result.display);
        setIsScanning(false);
      });
    }
  }, [app]);

  const resolvePath = (p: string) => p.replace(/^~(?=$|\/|\\)/, process.env.HOME || "");

  const appActions = (
    <ActionPanel>
      <Action
        title="Uninstall App"
        icon={Icon.Trash}
        style={Action.Style.Destructive}
        onAction={async () => {
          await onUninstall(leftovers);
          pop();
        }}
      />
      <Action.ShowInFinder title="Show in Finder" path={app.path} />
    </ActionPanel>
  );

  return (
    <List navigationTitle={app.name} isLoading={isScanning}>
      <List.Section title="App Information">
        <List.Item
          title="App Name"
          subtitle={app.name}
          icon={{ fileIcon: app.path }}
          actions={appActions}
        />
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

      {leftovers.length > 0 && (
        <List.Section title={`Leftovers ${leftoversDisplay ? `(${leftoversDisplay})` : `(${leftovers.length} files)`}`}>
          {leftovers.map((f, index) => {
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
                    <Action
                      title="Uninstall App & Leftovers"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      onAction={async () => {
                        await onUninstall(leftovers);
                        pop();
                      }}
                    />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}

      {(!isScanning && leftovers.length === 0) && (
        <List.Section title="Leftovers">
          <List.Item title="No leftovers found." icon={Icon.CheckCircle} actions={appActions} />
        </List.Section>
      )}
    </List>
  );
}

// New component to encapsulate the animated icon logic and UI for each individual list item
function AppListItem({
  app,
  isScanning,
  leftoversDisplay,
  leftoverFiles,
  onUninstall
}: {
  app: InstalledApp;
  isScanning: boolean;
  leftoversDisplay?: string;
  leftoverFiles?: LeftoverFile[];
  onUninstall: (app: InstalledApp, leftovers?: LeftoverFile[]) => Promise<boolean>;
}) {
  const ellipsis = useAnimatedEllipsis();

  return (
    <List.Item
      icon={{ fileIcon: app.path }}
      title={app.name}
      subtitle={app.bundleId}
      accessories={[
        ...(isScanning ? [{ text: `${ellipsis}` }] : []),
        ...(leftoversDisplay ? [{ text: `Leftovers: ${leftoversDisplay}`, icon: Icon.Important }] : []),
        ...(app.sizeBytes ? [{ text: formatBytesShort(app.sizeBytes) }] : [])
      ]}
      actions={
        <ActionPanel>
          <Action.Push
            title="Show Details"
            icon={Icon.Sidebar}
            target={
              <AppDetail
                app={{
                  ...app,
                  leftoversDisplay: leftoversDisplay || app.leftoversDisplay,
                  leftoverFiles: leftoverFiles || app.leftoverFiles || []
                }}
                onUninstall={async (leftovers) => { await onUninstall(app, leftovers); }}
              />
            }
          />
          <Action
            title="Uninstall App"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            onAction={() => onUninstall(app)}
          />
          <Action.ShowInFinder title="Show in Finder" path={app.path} />
        </ActionPanel>
      }
    />
  );
}

export default function UninstallCommand() {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [sorting, setSorting] = useState<"name" | "size" | "time">("name");

  // Separate states for lazy-loaded data to prevent full list re-renders
  const [scanningApps, setScanningApps] = useState<Set<string>>(new Set());
  const [leftoversMap, setLeftoversMap] = useState<Record<string, LeftoverFile[]>>({});
  const [displayMap, setDisplayMap] = useState<Record<string, string>>({});

  async function fetchApps() {
    setIsLoading(true);
    try {
      // Fast initial scan
      const output = await execMo(["uninstall", "--dry-run"]);
      const foundApps = parseDryRunDetailsOutput(output);
      setApps(foundApps);

      // Populate initial maps from the fast scan (which may have empty leftovers if --details was removed)
      const initialLeftovers: Record<string, LeftoverFile[]> = {};
      const initialDisplay: Record<string, string> = {};

      for (const app of foundApps) {
        if (app.leftoverFiles && app.leftoverFiles.length > 0) {
          initialLeftovers[app.path] = app.leftoverFiles;
        }
        if (app.leftoversDisplay) {
          initialDisplay[app.path] = app.leftoversDisplay;
        }
      }
      setLeftoversMap(initialLeftovers);
      setDisplayMap(initialDisplay);

      // Start background lazy loading for each app
      const toScan = foundApps.filter(a => !initialDisplay[a.path]);

      setScanningApps(new Set(toScan.map(a => a.path)));

      // We intentionally do not await this, it runs in the background
      // Use a simple concurrency limit (e.g. 3) to prevent UI hanging
      const CONCURRENCY_LIMIT = 5;
      let i = 0;

      const workers = Array.from({ length: CONCURRENCY_LIMIT }).map(async () => {
        while (i < toScan.length) {
          const currentIndex = i++;
          const appToScan = toScan[currentIndex];

          try {
            const result = await scanLeftoversForApp(appToScan);

            // Update specific map entries without mapping over the entire apps array
            setLeftoversMap(prev => ({ ...prev, [appToScan.path]: result.files }));
            if (result.display) {
              const displayString = result.display;
              setDisplayMap(prev => ({ ...prev, [appToScan.path]: displayString }));
            }

          } finally {
            // Remove from scanning set
            setScanningApps(current => {
              const next = new Set(current);
              next.delete(appToScan.path);
              return next;
            });
          }
        }
      });
      Promise.all(workers);

    } catch (err) {
      showToast({ style: Toast.Style.Failure, title: "Failed to scan apps", message: String(err) });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    fetchApps();
  }, []);

  async function uninstallApp(app: InstalledApp, customLeftovers?: LeftoverFile[]) {
    const isConfirmed = await confirmAndExecute({
      title: `移除 ${app.name}？`,
      message: `這將會把應用程式本體${app.bundleId ? "與其相關的快取與設定檔" : ""}移至垃圾桶。`,
      primaryAction: `移除 ${app.name}`,
      onConfirm: async () => {
        await showToast({ style: Toast.Style.Animated, title: `Uninstalling ${app.name}...` });
        try {
          const pathsToTrash = [app.path];

          // Use parsed leftover files directly if requested
          // Since it uses ~/, we'll resolve it before trashing
          const home = process.env.HOME || "";

          const leftoverSource = customLeftovers || leftoversMap[app.path] || app.leftoverFiles || [];

          if (leftoverSource && leftoverSource.length > 0) {
            for (const leftover of leftoverSource) {
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
          <AppListItem
            key={app.path}
            app={app}
            isScanning={scanningApps.has(app.path)}
            leftoversDisplay={displayMap[app.path] || app.leftoversDisplay}
            leftoverFiles={leftoversMap[app.path] || app.leftoverFiles}
            onUninstall={uninstallApp}
          />
        ))}
      </List.Section>
    </List>
  );
}
