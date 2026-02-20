import { ActionPanel, Action, Form, showToast, Toast, Icon } from "@raycast/api";
import { useEffect, useState } from "react";
import fs from "fs";
import path from "path";

const MOLE_DIR = path.join(process.env.HOME || "", ".config/mole");
const WHITELIST_PATH = path.join(MOLE_DIR, "whitelist");
const PURGE_PATHS_PATH = path.join(MOLE_DIR, "purge_paths");

export default function SettingsCommand() {
    const [whitelist, setWhitelist] = useState<string>("");
    const [purgePaths, setPurgePaths] = useState<string>("");
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        async function loadConfigs() {
            setIsLoading(true);
            try {
                if (!fs.existsSync(MOLE_DIR)) {
                    fs.mkdirSync(MOLE_DIR, { recursive: true });
                }

                if (fs.existsSync(WHITELIST_PATH)) {
                    setWhitelist(fs.readFileSync(WHITELIST_PATH, "utf8"));
                }

                if (fs.existsSync(PURGE_PATHS_PATH)) {
                    setPurgePaths(fs.readFileSync(PURGE_PATHS_PATH, "utf8"));
                }
            } catch (err) {
                showToast({ style: Toast.Style.Failure, title: "Failed to load configs" });
            } finally {
                setIsLoading(false);
            }
        }
        loadConfigs();
    }, []);

    async function handleSubmit(values: { whitelist: string; purgePaths: string }) {
        await showToast({ style: Toast.Style.Animated, title: "Saving Configuration..." });
        try {
            if (!fs.existsSync(MOLE_DIR)) {
                fs.mkdirSync(MOLE_DIR, { recursive: true });
            }

            fs.writeFileSync(WHITELIST_PATH, values.whitelist.trim() + "\n", "utf8");
            fs.writeFileSync(PURGE_PATHS_PATH, values.purgePaths.trim() + "\n", "utf8");

            await showToast({ style: Toast.Style.Success, title: "Settings Saved" });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await showToast({ style: Toast.Style.Failure, title: "Failed to save", message });
        }
    }

    return (
        <Form
            isLoading={isLoading}
            actions={
                <ActionPanel>
                    <Action.SubmitForm title="Save Settings" icon={Icon.SaveDocument} onSubmit={handleSubmit} />
                </ActionPanel>
            }
        >
            <Form.Description
                title="Mole Configuration"
                text="Manage your custom paths and protected items directly to the Mole configuration files."
            />

            <Form.TextArea
                id="purgePaths"
                title="Custom Purge Paths"
                placeholder="~/Documents/GitHub\n~/Projects\n/Volumes/Work"
                info="Directories to scan for node_modules, target, dist, etc."
                value={purgePaths}
                onChange={setPurgePaths}
                enableMarkdown={false}
            />
            <Form.Description text="One absolute path per line. Mole will recursively scan these in addition to the defaults." />

            <Form.Separator />

            <Form.TextArea
                id="whitelist"
                title="Protection Whitelist"
                placeholder="*docker*\n*steam*\n/Applications/ImportantApp.app"
                info="Items to protect during Clean and Optimize."
                value={whitelist}
                onChange={setWhitelist}
                enableMarkdown={false}
            />
            <Form.Description text="One pattern per line. Use wildcards (*) for flexible matching." />
        </Form>
    );
}
