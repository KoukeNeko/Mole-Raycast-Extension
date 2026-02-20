import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState, useMemo } from "react";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { execMo, formatBytesShort, confirmAndExecute, trashPaths } from "./utils";

const execAsync = promisify(exec);

interface InstalledApp {
  name: string;
  path: string;
  bundleId?: string;
  sizeBytes?: number;
  isLoadingSize?: boolean;
  mtimeMs?: number;
}

export default function UninstallCommand() {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [sorting, setSorting] = useState<"name" | "size" | "time">("name");

  async function fetchApps() {
    setIsLoading(true);
    try {
      const foundApps = await scanApps();
      setApps(foundApps);
      calculateSizes(foundApps);
    } catch (err) {
      showToast({ style: Toast.Style.Failure, title: "Failed to scan apps", message: String(err) });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    fetchApps();
  }, []);

  async function calculateSizes(initialApps: InstalledApp[]) {
    for (const app of initialApps) {
      execAsync(`du -sk "${app.path}"`)
        .then(({ stdout }) => {
          const sizeKb = parseInt(stdout.split("\t")[0], 10);
          if (!isNaN(sizeKb)) {
            setApps((prev) =>
              prev.map((p) => (p.path === app.path ? { ...p, sizeBytes: sizeKb * 1024, isLoadingSize: false } : p)),
            );
          }
        })
        .catch(() => {
          setApps((prev) => prev.map((p) => (p.path === app.path ? { ...p, isLoadingSize: false } : p)));
        });
    }
  }

  async function uninstallApp(app: InstalledApp) {
    await confirmAndExecute({
      title: `移除 ${app.name}？`,
      message: `這將會把應用程式本體${app.bundleId ? "與其相關的快取與設定檔" : ""}移至垃圾桶。`,
      primaryAction: `移除 ${app.name}`,
      onConfirm: async () => {
        await showToast({ style: Toast.Style.Animated, title: `Uninstalling ${app.name}...` });
        try {
          const pathsToTrash = [app.path];

          if (app.bundleId) {
            const home = process.env.HOME || "";
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

          // Refresh the list from the filesystem instead of just filtering state
          await fetchApps();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await showToast({ style: Toast.Style.Failure, title: "Failed to uninstall", message });
        }
      },
    });
  }

  const sortedApps = useMemo(() => {
    return [...apps].sort((a, b) => {
      if (sorting === "size") {
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
      } else if (sorting === "time") {
        return (b.mtimeMs || 0) - (a.mtimeMs || 0);
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
            accessories={
              app.sizeBytes
                ? [{ text: formatBytesShort(app.sizeBytes) }]
                : app.isLoadingSize !== false
                  ? [{ text: "Calculating..." }]
                  : []
            }
            actions={
              <ActionPanel>
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

// --- Scanner Helpers ---
async function scanApps(): Promise<InstalledApp[]> {
  const apps: InstalledApp[] = [];
  const searchDirs = ["/Applications", "/System/Applications", path.join(process.env.HOME || "", "Applications")];

  // Exclude system protected apps
  const protectedApps = [
    "Safari.app",
    "Mail.app",
    "Messages.app",
    "FaceTime.app",
    "Maps.app",
    "Photos.app",
    "Calendar.app",
    "Contacts.app",
    "Reminders.app",
    "Notes.app",
    "Music.app",
    "Podcasts.app",
    "TV.app",
    "Books.app",
    "News.app",
    "Stocks.app",
    "Weather.app",
    "VoiceMemos.app",
    "Calculator.app",
    "Dictionary.app",
    "Chess.app",
    "Stickies.app",
    "Font Book.app",
    "Image Capture.app",
    "Preview.app",
    "QuickTime Player.app",
    "TextEdit.app",
    "Time Machine.app",
    "Automator.app",
    "Mission Control.app",
    "System Preferences.app",
    "System Settings.app",
    "App Store.app",
    "Launchpad.app",
    "Dashboard.app",
    "Siri.app",
    "FindMy.app",
    "Shortcuts.app",
    "Home.app",
    "Freeform.app",
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.endsWith(".app")) {
          // Skip core apps
          if (protectedApps.includes(entry.name)) continue;

          const appPath = path.join(dir, entry.name);
          const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
          let bundleId = undefined;

          if (fs.existsSync(infoPlistPath)) {
            try {
              const { stdout } = await execAsync(`defaults read "${infoPlistPath}" CFBundleIdentifier`);
              bundleId = stdout.trim();
            } catch {
              // Ignore Plist errors
            }
          }

          apps.push({
            name: entry.name.replace(".app", ""),
            path: appPath,
            bundleId,
            isLoadingSize: true,
            mtimeMs: fs.statSync(appPath).mtimeMs,
          });
        }
      }
    } catch (e) {
      console.error(`Failed to scan ${dir}:`, e);
    }
  }

  // Setapp
  const setappDir = path.join(process.env.HOME || "", "Library/Application Support/Setapp/Applications");
  if (fs.existsSync(setappDir)) {
    try {
      const entries = fs.readdirSync(setappDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.endsWith(".app")) {
          const appPath = path.join(setappDir, entry.name);
          apps.push({
            name: entry.name.replace(".app", ""),
            path: appPath,
            isLoadingSize: true,
            mtimeMs: fs.statSync(appPath).mtimeMs,
          });
        }
      }
    } catch { }
  }

  return apps;
}
