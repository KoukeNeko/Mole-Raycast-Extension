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
}

export default function UninstallCommand() {
    const [apps, setApps] = useState<InstalledApp[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        async function fetchApps() {
            setIsLoading(true);
            try {
                const foundApps = await scanApps();
                setApps(foundApps);

                // Asynchronously fetch sizes in background so UI doesn't block parsing bundles for 100+ apps
                calculateSizes(foundApps);
            } catch (err) {
                showToast({ style: Toast.Style.Failure, title: "Failed to scan apps", message: String(err) });
            } finally {
                setIsLoading(false);
            }
        }
        fetchApps();
    }, []);

    async function calculateSizes(initialApps: InstalledApp[]) {
        // We update state individually or in batches
        for (const app of initialApps) {
            execAsync(`du -sk "${app.path}"`).then(({ stdout }) => {
                const sizeKb = parseInt(stdout.split("\t")[0], 10);
                if (!isNaN(sizeKb)) {
                    setApps((prev) =>
                        prev.map((p) => (p.path === app.path ? { ...p, sizeBytes: sizeKb * 1024, isLoadingSize: false } : p))
                    );
                }
            }).catch(() => {
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
                    // If we have bundle ID or exact name, we can ask Mole to uninstall it properly or do it via native trash + leftovers
                    // mole uninstall <bundle_id> or <name> natively supports silent mode if we script it, but mole uninstall expects interactive input usually.
                    // Fallback: Custom leftover remover since Mole CLI is interactive
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
                            path.join(home, "Library/Logs", app.bundleId)
                        ];
                        for (const l of leftovers) {
                            if (fs.existsSync(l)) pathsToTrash.push(l);
                        }
                    }

                    await trashPaths(pathsToTrash);
                    setApps((prev) => prev.filter((p) => p.path !== app.path));
                    await showToast({ style: Toast.Style.Success, title: `${app.name} uninstalled` });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    await showToast({ style: Toast.Style.Failure, title: "Failed to uninstall", message });
                }
            },
        });
    }

    // Sort apps alphabetically, but could also sort by size if they have it
    const sortedApps = useMemo(() => {
        return [...apps].sort((a, b) => a.name.localeCompare(b.name));
    }, [apps]);

    return (
        <List isLoading={isLoading} searchBarPlaceholder="Search applications to uninstall...">
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
        </List>
    );
}

// --- Scanner Helpers ---
async function scanApps(): Promise<InstalledApp[]> {
    const apps: InstalledApp[] = [];
    const searchDirs = ["/Applications", "/System/Applications", path.join(process.env.HOME || "", "Applications")];

    // Exclude system protected apps
    const protectedApps = ["Safari.app", "Mail.app", "Messages.app", "FaceTime.app", "Maps.app", "Photos.app", "Calendar.app", "Contacts.app", "Reminders.app", "Notes.app", "Music.app", "Podcasts.app", "TV.app", "Books.app", "News.app", "Stocks.app", "Weather.app", "VoiceMemos.app", "Calculator.app", "Dictionary.app", "Chess.app", "Stickies.app", "Font Book.app", "Image Capture.app", "Preview.app", "QuickTime Player.app", "TextEdit.app", "Time Machine.app", "Automator.app", "Mission Control.app", "System Preferences.app", "System Settings.app", "App Store.app", "Launchpad.app", "Dashboard.app", "Siri.app", "FindMy.app", "Shortcuts.app", "Home.app", "Freeform.app"];

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
                        isLoadingSize: true
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
                    apps.push({
                        name: entry.name.replace(".app", ""),
                        path: path.join(setappDir, entry.name),
                        isLoadingSize: true
                    });
                }
            }
        } catch { }
    }

    return apps;
}
