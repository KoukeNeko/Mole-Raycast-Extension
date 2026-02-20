import { ActionPanel, Action, Icon, List, showToast, Toast, Color } from "@raycast/api";
import { useEffect, useState } from "react";
import { execMo, stripAnsi, confirmAndExecute } from "./utils";

interface OptimizeOption {
  category: string;
  descriptions: string[];
}

export default function OptimizeCommand() {
  const [options, setOptions] = useState<OptimizeOption[]>([]);
  const [systemInfo, setSystemInfo] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchDryRun();
  }, []);

  async function fetchDryRun() {
    setIsLoading(true);
    try {
      const output = await execMo(["optimize", "--dry-run"]);
      const lines = output.split("\n");
      const parsedOptions: OptimizeOption[] = [];
      let current: OptimizeOption | null = null;
      let sysInfo = null;

      for (const rawLine of lines) {
        const line = stripAnsi(rawLine).trim();
        if (!line) continue;

        if (line.startsWith("⚙ System")) {
          sysInfo = line.replace(/^⚙\s*/, "");
        } else if (line.startsWith("➤")) {
          if (current) parsedOptions.push(current);
          current = {
            category: line.replace(/^➤\s*/, ""),
            descriptions: [],
          };
        } else if (line.startsWith("→") && current) {
          current.descriptions.push(line.replace(/^→\s*/, ""));
        } else if (line.startsWith("!") && current) {
          current.descriptions.push("⚠️ " + line.replace(/^!\s*/, ""));
        }
      }

      if (current) parsedOptions.push(current);

      setOptions(parsedOptions);
      if (sysInfo) setSystemInfo(sysInfo);
    } catch (err) {
      showToast({ style: Toast.Style.Failure, title: "Failed to load optimize plan", message: String(err) });
    } finally {
      setIsLoading(false);
    }
  }

  async function runOptimization() {
    await confirmAndExecute({
      title: "執行系統最佳化？",
      message: "Mole 將會清理 DNS 快取、重建 Spotlight 索引、修復權限等。有些操作可能需要輸入密碼。",
      primaryAction: "執行最佳化",
      onConfirm: async () => {
        await showToast({ style: Toast.Style.Animated, title: "Optimizing system..." });
        try {
          await execMo(["optimize"]);
          await showToast({ style: Toast.Style.Success, title: "System optimized successfully!" });
          await fetchDryRun();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await showToast({ style: Toast.Style.Failure, title: "Optimization failed", message });
        }
      },
    });
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search optimization categories...">
      {systemInfo && (
        <List.Section title="System Information">
          <List.Item
            icon={{ source: Icon.ComputerChip, tintColor: Color.Blue }}
            title={systemInfo}
            actions={
              <ActionPanel>
                <Action title="Run Optimization" icon={Icon.Wrench} onAction={runOptimization} />
                <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={fetchDryRun} />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {options.length > 0 && (
        <List.Section title="Optimization Plan">
          {options.map((opt) => (
            <List.Item
              key={opt.category}
              icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
              title={opt.category}
              subtitle={opt.descriptions.join(" · ")}
              actions={
                <ActionPanel>
                  <Action title="Run Full Optimization" icon={Icon.Wrench} onAction={runOptimization} />
                  <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={fetchDryRun} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {!isLoading && options.length === 0 && (
        <List.EmptyView icon={Icon.Checkmark} title="System is optimal" description="No actions needed." />
      )}
    </List>
  );
}
