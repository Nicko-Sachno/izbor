import { chmod, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export async function writeFakeCommand(dir: string, name: string, js: string): Promise<void> {
    const command = join(dir, name);
    await writeFile(command, `#!/usr/bin/env node\n${js}\n`);
    await chmod(command, 0o755);
    await writeFile(`${command}.cmd`, `@node "%~dp0${name}" %*\r\n`);
    await writeFile(`${command}.js`, `${js}\n`);
}

export const homeEnv = (dir: string) => ({ HOME: dir, USERPROFILE: dir, LOCALAPPDATA: undefined });

const pathKey = (env: NodeJS.ProcessEnv) => Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";

export function withPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
    const key = pathKey(env);
    return { ...env, [key]: [dir, env[key]].filter(Boolean).join(delimiter) };
}

export function pathFirst(dir: string): NodeJS.ProcessEnv {
    const key = pathKey(process.env);
    return { [key]: withPath(process.env, dir)[key] };
}

export const HANGING = `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "inherit"] });
writeFileSync(join(__dirname, "pids"), \`\${process.pid} \${grandchild.pid}\\n\`);`;

export const skipOnWindows = (reason: string) => ({ skip: process.platform === "win32" && reason });
