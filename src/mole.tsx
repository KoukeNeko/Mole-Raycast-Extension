import { ActionPanel, Action, Icon, List, Color } from "@raycast/api";

import CleanCommand from "./clean";
import OptimizeCommand from "./optimize";
import StatusCommand from "./status";
import UninstallCommand from "./uninstall";
import AnalyzeCommand from "./analyze";

interface MenuItem {
  id: string;
  icon: Icon;
  color: Color;
  title: string;
  subtitle: string;
  target: () => JSX.Element;
}

const MENU_ITEMS: MenuItem[] = [
  {
    id: "clean",
    icon: Icon.Trash,
    color: Color.Green,
    title: "Clean",
    subtitle: "Deep cleanup — free up disk space",
    target: CleanCommand,
  },
  {
    id: "uninstall",
    icon: Icon.XMarkCircle,
    color: Color.Red,
    title: "Uninstall",
    subtitle: "Remove apps and leftover files",
    target: UninstallCommand,
  },
  {
    id: "optimize",
    icon: Icon.Bolt,
    color: Color.Yellow,
    title: "Optimize",
    subtitle: "Check and maintain system health",
    target: OptimizeCommand,
  },
  {
    id: "analyze",
    icon: Icon.HardDrive,
    color: Color.Blue,
    title: "Analyze",
    subtitle: "Explore disk usage by folder",
    target: AnalyzeCommand,
  },
  {
    id: "status",
    icon: Icon.Heartbeat,
    color: Color.Purple,
    title: "Status",
    subtitle: "Live system health dashboard",
    target: StatusCommand,
  },
];

export default function Command() {
  return (
    <List searchBarPlaceholder="Search Mole commands...">
      {MENU_ITEMS.map((item) => (
        <List.Item
          key={item.id}
          icon={{ source: item.icon, tintColor: item.color }}
          title={item.title}
          subtitle={item.subtitle}
          actions={
            <ActionPanel>
              <Action.Push title={`Open ${item.title}`} icon={item.icon} target={<item.target />} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
