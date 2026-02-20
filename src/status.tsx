import { Detail, Icon, Color, ActionPanel, Action } from "@raycast/api";
import { useEffect, useState } from "react";
import { getSystemInfo } from "./utils";

interface SystemStatus {
    memoryUsedGB: number;
    memoryTotalGB: number;
    memoryPercent: number;
    diskUsedGB: number;
    diskTotalGB: number;
    diskPercent: number;
    diskFreeGB: number;
    uptimeDays: number;
}

export default function StatusCommand() {
    const [status, setStatus] = useState<SystemStatus | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        loadStatus();
    }, []);

    async function loadStatus() {
        setIsLoading(true);
        try {
            const info = await getSystemInfo();
            setStatus(info);
        } catch {
            // fallback to empty
        } finally {
            setIsLoading(false);
        }
    }

    const markdown = status ? buildStatusMarkdown(status) : "Loading...";

    return (
        <Detail
            isLoading={isLoading}
            navigationTitle="Mole Status"
            markdown={markdown}
            metadata={
                status ? (
                    <Detail.Metadata>
                        <Detail.Metadata.Label title="Memory Used" text={`${status.memoryUsedGB} / ${status.memoryTotalGB} GB`} />
                        <Detail.Metadata.TagList title="Memory">
                            <Detail.Metadata.TagList.Item
                                text={`${status.memoryPercent}%`}
                                color={getPercentColor(status.memoryPercent)}
                            />
                        </Detail.Metadata.TagList>
                        <Detail.Metadata.Separator />
                        <Detail.Metadata.Label title="Disk Used" text={`${status.diskUsedGB} / ${status.diskTotalGB} GB`} />
                        <Detail.Metadata.Label title="Disk Free" text={`${status.diskFreeGB} GB`} />
                        <Detail.Metadata.TagList title="Disk">
                            <Detail.Metadata.TagList.Item
                                text={`${status.diskPercent}%`}
                                color={getPercentColor(status.diskPercent)}
                            />
                        </Detail.Metadata.TagList>
                        <Detail.Metadata.Separator />
                        <Detail.Metadata.Label title="Uptime" text={`${status.uptimeDays} days`} />
                    </Detail.Metadata>
                ) : null
            }
            actions={
                <ActionPanel>
                    <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={loadStatus} />
                </ActionPanel>
            }
        />
    );
}

function buildStatusMarkdown(s: SystemStatus): string {
    const memBar = buildProgressBar(s.memoryPercent);
    const diskBar = buildProgressBar(s.diskPercent);

    return `# 🐹 Mole System Status

## ⚙️ Memory
\`\`\`
${memBar}  ${s.memoryPercent}%
Used: ${s.memoryUsedGB} GB / ${s.memoryTotalGB} GB
\`\`\`

## 💾 Disk
\`\`\`
${diskBar}  ${s.diskPercent}%
Used: ${s.diskUsedGB} GB / ${s.diskTotalGB} GB
Free: ${s.diskFreeGB} GB
\`\`\`

## ⏱️ Uptime
\`\`\`
${s.uptimeDays} days
\`\`\`
`;
}

function buildProgressBar(percent: number): string {
    const totalBlocks = 20;
    const filled = Math.round((percent / 100) * totalBlocks);
    const empty = totalBlocks - filled;
    return "█".repeat(filled) + "░".repeat(empty);
}

function getPercentColor(percent: number): Color {
    if (percent >= 90) return Color.Red;
    if (percent >= 70) return Color.Orange;
    if (percent >= 50) return Color.Yellow;
    return Color.Green;
}
