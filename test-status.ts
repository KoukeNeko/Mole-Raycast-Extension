import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

async function run() {
    console.log("Starting Python PTY wrapper...");
    const cmd = `
        python3 -c '
import pty
import os
import sys

def read_and_print(fd):
    try:
        data = os.read(fd, 8192)
        sys.stdout.buffer.write(data)
        sys.stdout.flush()
    except OSError:
        pass

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLUMNS"] = "100"
    os.environ["LINES"] = "30"
    os.execv("/opt/homebrew/bin/mo", ["/opt/homebrew/bin/mo", "status"])
else:
    import time
    start = time.time()
    while time.time() - start < 1.0:
        read_and_print(fd)
    os.kill(pid, 2)
    os.close(fd)
'
    `;
    
    try {
        const { stdout } = await execAsync(cmd, { shell: "/bin/bash" });
        console.log("Output len:", stdout.length);
        console.log("Out preview:", stdout.slice(-200));
    } catch(e) {
        console.error("Error:", e);
    }
}
run();
