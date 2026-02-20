import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);

export interface InstalledApp {
    name: string;
    path: string;
    bundleId?: string;
}

export async function scanApps(): Promise<InstalledApp[]> {
    const apps: InstalledApp[] = [];
    const searchDirs = ["/Applications", "/System/Applications", path.join(process.env.HOME || "", "Applications")];

    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.endsWith(".app")) {
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
                    });
                }
            }
        } catch (e) {
            console.error(`Failed to scan ${dir}:`, e);
        }
    }

    // Add Setapp directory specifically if it exists
    const setappDir = path.join(process.env.HOME || "", "Library/Application Support/Setapp/Applications");
    if (fs.existsSync(setappDir)) {
        try {
            const entries = fs.readdirSync(setappDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.endsWith(".app")) {
                    apps.push({
                        name: entry.name.replace(".app", ""),
                        path: path.join(setappDir, entry.name),
                    });
                }
            }
        } catch { }
    }

    return apps;
}

async function run() {
    console.log("Scanning apps...");
    const start = Date.now();
    const apps = await scanApps();
    console.log(`Found ${apps.length} apps in ${Date.now() - start}ms`);
    console.log("Sample:", apps.slice(0, 5));
}

if (require.main === module) {
    run();
}
