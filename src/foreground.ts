import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDERS } from "./adapters/agents/registry.js";
import { createStdoutLog } from "./adapters/log/stdoutLog.js";
import { createSummarizer } from "./adapters/summarizer/summarizer.js";
import { type IzborEnv, providerContextOf, STOP_TIMEOUT_MS, tuneInCommand } from "./config.js";
import type { Platform } from "./core/ports.js";
import { curlStream } from "./domain/wire.js";
import { type Seams, type Service, startService } from "./service.js";

type ForegroundOptions = { port: number; platform: Platform } & IzborEnv;

function seamsOf({ platform, dataDir, summarizerCommand }: ForegroundOptions): Seams {
    const context = providerContextOf({ platform, home: homedir() });
    return {
        providers: Object.fromEntries(Object.entries(PROVIDERS).map(([name, create]) => [name, create(context)])),
        platform,
        log: createStdoutLog(),
        summarize: createSummarizer({
            dir: join(dataDir, "summarizer"),
            command: summarizerCommand,
            platform,
            env: process.env,
        }),
    };
}

export async function serveInForeground(options: ForegroundOptions): Promise<Service> {
    const { port, dataDir, userDir } = options;
    const seams = seamsOf(options);
    const service = await startService({ port, dataDir, userDir, ...seams });
    const { url, info } = service;
    const { log } = seams;
    log("info", `izbor watches no session yet. Tune in to one by its id:`);
    log("info", `  ${tuneInCommand(info.port)}`);
    log("info", `  every watched session at once: ${curlStream(`${url}/events`)}`);
    log("info", `  hooks: ${url}/hook`);
    log("info", `  data:  ${dataDir}`);

    let stopping = false;
    async function stop() {
        if (stopping) return;
        stopping = true;
        setTimeout(() => {
            log("error", `the stop took over ${STOP_TIMEOUT_MS} ms, exiting`);
            process.exit(1);
        }, STOP_TIMEOUT_MS).unref();
        await service.stop();
        log("info", "izbor stopped");
        process.exit(0);
    }

    service.stopRequested.then(stop);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(signal, stop);
    return service;
}
