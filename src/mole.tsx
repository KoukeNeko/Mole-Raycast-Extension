import { ActionPanel, Action, Icon, List, showToast, Toast, Color, launchCommand, LaunchType } from "@raycast/api";
import { useEffect, useState } from "react";
import { execMo } from "./utils";

interface VersionInfo {
  version: string;
  architecture: string;
  os: string;
  sip: string;
}

export default function Command() {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchVersion() {
      try {
        const output = await execMo(["--version"]);
        const lines = output.split("\n");
        const info: VersionInfo = { version: "Unknown", architecture: "Unknown", os: "Unknown", sip: "Unknown" };

        for (const line of lines) {
          if (line.includes("Mole version")) info.version = line.replace("Mole version ", "").trim();
          if (line.includes("Architecture:")) info.architecture = line.replace("Architecture:", "").trim();
          if (line.includes("macOS:")) info.os = line.replace("macOS:", "").trim();
          if (line.includes("SIP:")) info.sip = line.replace("SIP:", "").trim();
        }

        setVersionInfo(info);
      } catch (err) {
        setVersionInfo(null);
      } finally {
        setIsLoading(false);
      }
    }
    fetchVersion();
  }, []);

  async function configureTouchID() {
    await showToast({ style: Toast.Style.Animated, title: "Configuring Touch ID..." });
    try {
      await execMo(["touchid"]);
      await showToast({ style: Toast.Style.Success, title: "Touch ID Configured" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await showToast({ style: Toast.Style.Failure, title: "Failed", message });
    }
  }

  async function updateMole() {
    await showToast({ style: Toast.Style.Animated, title: "Updating Mole..." });
    try {
      await execMo(["update"]);
      await showToast({ style: Toast.Style.Success, title: "Mole Updated" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await showToast({ style: Toast.Style.Failure, title: "Failed to Update", message });
    }
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search Mole features..." navigationTitle="Mole Dashboard">
      <List.Section title="System Care">
        <List.Item
          icon={{ source: Icon.Trash, tintColor: Color.Red }}
          title="Clean"
          subtitle="Deep cleanup and free up disk space"
          actions={<CommandAction name="clean" />}
        />
        <List.Item
          icon={{ source: Icon.Wrench, tintColor: Color.Blue }}
          title="Optimize"
          subtitle="Check and maintain system"
          actions={<CommandAction name="optimize" />}
        />
        <List.Item
          icon={{ source: Icon.Heartbeat, tintColor: Color.Green }}
          title="Status"
          subtitle="Live system health dashboard"
          actions={<CommandAction name="status" />}
        />
      </List.Section>

      <List.Section title="Disk & Apps">
        <List.Item
          icon={{ source: Icon.MagnifyingGlass, tintColor: Color.Yellow }}
          title="Analyze"
          subtitle="Visual disk explorer"
          actions={<CommandAction name="analyze" />}
        />
        <List.Item
          icon={{ source: Icon.AppWindowGrid3x3, tintColor: Color.Purple }}
          title="Uninstall"
          subtitle="Remove apps and leftovers completely"
          actions={<CommandAction name="uninstall" />}
        />
        <List.Item
          icon={{ source: Icon.Code, tintColor: Color.Orange }}
          title="Purge"
          subtitle="Clean project build artifacts"
          actions={<CommandAction name="purge" />}
        />
        <List.Item
          icon={{ source: Icon.Box, tintColor: Color.Magenta }}
          title="Installer Cleaner"
          subtitle="Find and remove installer files"
          actions={<CommandAction name="installer" />}
        />
      </List.Section>

      <List.Section title="Settings & Tools">
        <List.Item
          icon={{ source: Icon.Fingerprint, tintColor: Color.SecondaryText }}
          title="Configure Touch ID"
          subtitle="Setup Touch ID for sudo commands"
          actions={
            <ActionPanel>
              <Action title="Configure" icon={Icon.Fingerprint} onAction={configureTouchID} />
            </ActionPanel>
          }
        />
        <List.Item
          icon={{ source: Icon.Download, tintColor: Color.SecondaryText }}
          title="Update Mole"
          subtitle={versionInfo ? `Current: ${versionInfo.version}` : "Fetching version..."}
          accessories={versionInfo ? [{ text: `macOS ${versionInfo.os}` }] : []}
          actions={
            <ActionPanel>
              <Action title="Update" icon={Icon.Download} onAction={updateMole} />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}

function CommandAction({ name }: { name: string }) {
  return (
    <ActionPanel>
      <Action
        title={`Open ${name.charAt(0).toUpperCase() + name.slice(1)}`}
        icon={Icon.Window}
        onAction={() => launchCommand({ name, type: LaunchType.UserInitiated })}
      />
    </ActionPanel>
  );
}
