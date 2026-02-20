import { closeMainWindow, Detail } from "@raycast/api";
import { useEffect } from "react";
import { exec } from "child_process";
import { getMoPath } from "./utils";

let hasLaunched = false;

export default function StatusCommand() {
  useEffect(() => {
    if (hasLaunched) return;
    hasLaunched = true;

    async function launchTerminal() {
      try {
        const moPath = await getMoPath();

        // Instead of fighting AppleScript which inconsistently opens duplicate windows,
        // we create a temporary executable .command file and let macOS handle the
        // terminal launch cleanly. This guarantees exactly one window.
        const COMMAND_FILE = "/tmp/mole_status.command";
        const scriptContent = `#!/bin/bash
clear
"${moPath}" status
`;

        exec(`echo '${scriptContent}' > ${COMMAND_FILE} && chmod +x ${COMMAND_FILE} && open ${COMMAND_FILE}`);
      } catch (err) {
        console.error("Failed to launch terminal:", err);
      } finally {
        await closeMainWindow();
      }
    }

    launchTerminal();
  }, []);

  return <Detail markdown="Launching Terminal..." isLoading={true} />;
}
