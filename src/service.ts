import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHttpServer, type HttpServerDeps } from "./adapters/http/server.js";
import { sendKeyFile, writeUserFiles } from "./adapters/files/userFiles.js";
import { newSendKey } from "./adapters/http/sendKey.js";
import type { Log, Now, IzborRoutes, Platform, Providers, Wait } from "./core/ports.js";
import type { Summarize } from "./domain/summary.js";
import { codeOf, messageOf } from "./domain/text.js";
import { LOOPBACK, type IzborInfo, izborUrl } from "./domain/wire.js";
import { createIzbor, type Izbor } from "./izbor.js";

const CONNECTIONS_WAIT_MS = 1000;

const wait: Wait = (ms, signal) => sleep(ms, undefined, { signal }).catch(() => {});

const now: Now = () => new Date();

export type Seams = {
    providers: Providers;
    platform: Platform;
    log: Log;
    summarize: Summarize;
};

export type ServiceOptions = {
    port: number;
    dataDir: string;
    userDir: string;
} & Seams;

const logBug = (log: Log, what: string) => (error: unknown) => log("error", `${what}: ${messageOf(error)}`);

export type Service = { url: string; info: IzborInfo; stop(): Promise<void>; stopRequested: Promise<void> };

export async function stopIzbor(server: Server, izbor: Izbor): Promise<void> {
    izbor.tracker.close();
    izbor.letGo();
    const cut = setTimeout(() => server.closeAllConnections(), CONNECTIONS_WAIT_MS);
    await new Promise((closed) => server.close(closed));
    clearTimeout(cut);
    await izbor.stop();
}

export function izborInfo(port: number, dataDir: string, sendKeyPath: string): IzborInfo {
    return {
        service: "izbor",
        pid: process.pid,
        port,
        dataDir,
        startedAt: new Date().toISOString(),
        sendKeyPath,
    };
}

type IzborServerOptions = Omit<HttpServerDeps, "izbor"> & {
    log: Log;
};

export function createIzborServer(izbor: IzborRoutes, { log, ...deps }: IzborServerOptions) {
    return createHttpServer({
        izbor: {
            ...izbor,
            handleHook: (hook) => izbor.handleHook(hook).catch(logBug(log, "a hook was not handled")),
            handleRejected: (body) =>
                izbor.handleRejected(body).catch(logBug(log, "a rejected payload was not handled")),
        },
        ...deps,
    });
}

export async function startService({
    port,
    dataDir,
    userDir,
    providers,
    platform,
    log,
    summarize,
}: ServiceOptions): Promise<Service> {
    const provider = Object.values(providers)[0]!;
    let info!: IzborInfo;
    const sendKey = newSendKey();
    const izbor = createIzbor({
        readThreads: provider.readThreads,
        queryStatus: provider.queryStatus,
        summarize,
        sessionsDir: join(dataDir, "sessions"),
        log,
        isActing: (cwd) => provider.isActing(cwd, info.port),
        wait,
        now,
    });

    let requestStop!: () => void;
    const stopRequested = new Promise<void>((resolve) => (requestStop = resolve));
    const server = createIzborServer(izbor, {
        info: () => info,
        sendKey,
        readHook: provider.readHook,
        answerHook: provider.answerHook,
        onBug: logBug(log, "a route failed"),
        requestStop,
        log,
    });
    const lock = await platform.lockDataFolder(dataDir);
    try {
        await new Promise<void>((resolve, reject) => {
            const cannotListen = (err: unknown) =>
                reject(new Error(`izbor cannot listen on port ${port}: ${messageOf(err)}${reserved(err)}`));
            server.once("error", cannotListen);
            server.listen(port, LOOPBACK, () => {
                server.off("error", cannotListen);
                server.on("error", (err) => log("error", err.message));
                const listening = (server.address() as AddressInfo).port;
                info = izborInfo(listening, dataDir, sendKeyFile(userDir, listening));
                try {
                    writeUserFiles(platform, userDir, { key: sendKey, port: listening });
                } catch (err) {
                    log("warning", `cannot write the send key and the port file: ${messageOf(err)}`);
                }
                resolve();
            });
        });
    } catch (err) {
        await lock.release();
        throw err;
    }
    await lock
        .writeHolder(info.port)
        .catch((err: unknown) => log("warning", `cannot write the lock holder: ${messageOf(err)}`));

    let stopped: Promise<void> | undefined;
    const stop = () => (stopped ??= stopIzbor(server, izbor).finally(() => lock.release()));

    return { url: izborUrl(info.port), info, stop, stopRequested };
}

const reserved = (err: unknown) =>
    codeOf(err) === "EACCES"
        ? ". The system may reserve this port: try izbor --port 5000 (on Windows, netsh int ipv4 show excludedportrange protocol=tcp lists reserved ports)."
        : "";
