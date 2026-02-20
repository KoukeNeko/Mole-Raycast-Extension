import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState } from "react";
import { execCommand, getMoPath, formatBytesShort } from "./utils";

interface HealthData {
    memory_used_gb: number;
    memory_total_gb: number;
    disk_used_gb: number;
    disk_total_gb: number;
    disk_used_percent: number;
    uptime_days: number;
}

export default function StatusCommand() {
    const [data, setData] = useState<HealthData | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        fetchHealthData();
    }, []);

    async function fetchHealthData() {
        setIsLoading(true);
        try {
            const moPath = await getMoPath();
            const moleDir = moPath.replace("/bin/mo", "");
            const scriptPath = `${moleDir}/lib/check/health_json.sh`;

            const { stdout } = await execCommand("bash", ["-c", `source "${scriptPath}" && generate_health_json`]);
            const parsed = JSON.parse(stdout);
            setData(parsed);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            showToast({ style: Toast.Style.Failure, title: "Failed to fetch status", message });
        } finally {
            setIsLoading(false);
        }
    }

    const memoryColor = data && (data.memory_used_gb / data.memory_total_gb) > 0.8 ? Color.Red : Color.Green;
    const diskColor = data && data.disk_used_percent > 85 ? Color.Red : Color.Blue;

    return (
        <List isLoading={isLoading} searchBarPlaceholder="System metrics...">
            {data ? (
                <List.Section title="System Resources">
                    <List.Item
                        icon={{ source: Icon.MemoryChip, tintColor: memoryColor }}
                        title="Memory Usage"
                        subtitle={`${data.memory_used_gb} GB / ${data.memory_total_gb} GB used`}
                        accessories={[{ text: `${((data.memory_used_gb / data.memory_total_gb) * 100).toFixed(1)}%` }]}
                        actions={<ActionPanel><Action title="Refresh" icon={Icon.ArrowClockwise} onAction={fetchHealthData} /></ActionPanel>}
                    />
                    <List.Item
                        icon={{ source: Icon.HardDrive, tintColor: diskColor }}
                        title="Disk Usage"
                        subtitle={`${data.disk_used_gb} GB / ${data.disk_total_gb} GB used`}
                        accessories={[{ text: `${data.disk_used_percent}%` }]}
                        actions={<ActionPanel><Action title="Refresh" icon={Icon.ArrowClockwise} onAction={fetchHealthData} /></ActionPanel>}
                    />
                    <List.Item
                        icon={{ source: Icon.Clock, tintColor: Color.Orange }}
                        title="System Uptime"
                        subtitle={data.uptime_days === 0 ? "Just restarted" : `${data.uptime_days} days`}
                        actions={<ActionPanel><Action title="Refresh" icon={Icon.ArrowClockwise} onAction={fetchHealthData} /></ActionPanel>}
                    />
                </List.Section>
            ) : (
                !isLoading && <List.EmptyView icon={Icon.Warning} title="Failed to load status" />
            )}
        </List>
    );
}
