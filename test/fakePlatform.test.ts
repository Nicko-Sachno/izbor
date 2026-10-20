import { fakePlatform } from "./helpers/fakePlatform.js";
import { platformContract } from "./helpers/platformContract.js";

platformContract(
    "fake",
    () => ({
        platform: fakePlatform({
            runs: {
                prints: { outcome: "exited", code: 3, signal: null, stdout: "out", stderr: "err" },
                hangs: "hangs",
            },
        }),
        commands: {
            prints: { command: "prints", args: [] },
            missing: { command: "missing", args: [] },
            hanging: { command: "hangs", args: [] },
        },
    }),
    { realProcesses: false },
);
