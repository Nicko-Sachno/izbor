import { spawn } from "node:child_process";

const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(2)], {
    detached: true,
    stdio: ["ignore", 2, 2],
    windowsHide: true,
});
if (child.pid === undefined) {
    child.once("error", (error) => {
        process.stderr.write(`izbor could not start Izbor: ${error.message}\n`);
        process.exitCode = 1;
    });
} else {
    child.unref();
    process.stdout.write(`${child.pid}\n`);
}
