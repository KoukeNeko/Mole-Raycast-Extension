import { execMo, stripAnsi } from "../src/utils";

export interface OptimizeOption {
    category: string;
    descriptions: string[];
}

export async function parseOptimizeDryRun(): Promise<OptimizeOption[]> {
    const output = await execMo(["optimize", "--dry-run"]);
    const lines = output.split("\n");
    const options: OptimizeOption[] = [];
    let current: OptimizeOption | null = null;

    for (const rawLine of lines) {
        const line = stripAnsi(rawLine).trim();
        if (!line) continue;

        if (line.startsWith("➤")) {
            if (current) options.push(current);
            current = {
                category: line.replace(/^➤\s*/, ""),
                descriptions: [],
            };
        } else if (line.startsWith("→") && current) {
            current.descriptions.push(line.replace(/^→\s*/, ""));
        } else if (line.startsWith("!") && current) {
            current.descriptions.push(line);
        }
    }

    if (current) options.push(current);

    return options;
}

if (require.main === module) {
    parseOptimizeDryRun().then(console.log).catch(console.error);
}
