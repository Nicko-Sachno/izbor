import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { answerHook } from "../../src/adapters/agents/claude/provider.js";
import { answerHookAt } from "../../src/adapters/agents/claude/setup/answerHook.js";
import { sendKeyFile, writeUserFiles } from "../../src/adapters/files/userFiles.js";
import { newSendKey } from "../../src/adapters/http/sendKey.js";
import { izborUserDir } from "../../src/config.js";
import type { IzborInfo } from "../../src/domain/wire.js";
import { createIzborServer, izborInfo, stopIzbor } from "../../src/service.js";
import { setupIzbor } from "../support.js";
import { homeEnv } from "./fakeCommand.js";
import { hostPlatform } from "./fakePlatform.js";
import { recordingLog } from "./recordingLog.js";
import type { LiveOptions } from "../../src/terminal/main.js";

type ReceivedRequest = { method: string; path: string };

export async function startIzborServer(
    t: TestContext,
    {
        port: listenOn = 0,
        home: givenHome,
        ...options
    }: Parameters<typeof setupIzbor>[0] & { port?: number; home?: string } = {},
) {
    let info: IzborInfo | undefined;
    const izbor = await setupIzbor({ isActing: (cwd) => answerHookAt(cwd, info!.port, hostPlatform()), ...options });
    const requests: ReceivedRequest[] = [];
    const bugs: unknown[] = [];
    const sendKey = newSendKey();
    const home = givenHome ?? (await mkdtemp(join(tmpdir(), "izbor-home-")));
    if (!givenHome) t.after(() => rm(home, { recursive: true, force: true }));
    const userDir = izborUserDir(homeEnv(home), home);
    const wiringLog = recordingLog();
    const server = createIzborServer(
        {
            ...izbor,
            handleHook: izbor.hooks.handle,
            holdAnswer: izbor.hooks.hold,
        },
        {
            info: () => info!,
            sendKey,
            readHook: izbor.hooks.read,
            answerHook,
            onBug: (error) => bugs.push(error),
            requestStop: () => {},
            log: wiringLog.log,
        },
    );
    server.prependListener("request", ({ method = "", url = "" }) => requests.push({ method, path: url }));
    let stopped: Promise<void> | undefined;
    const stop = () => (stopped ??= stopIzbor(server, izbor));
    t.after(async () => {
        if (stopped) return stopped;
        izbor.tracker.close();
        server.closeAllConnections();
        await new Promise((closed) => server.close(closed));
        await izbor.stop();
    });
    t.after(() => {
        if (wiringLog.entries.length === 0) return;
        const texts = wiringLog.entries.map((entry) => entry.text).join("; ");
        throw new Error(`the Izbor server's wiring logged: ${texts}`);
    });
    server.listen(listenOn, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    info = izborInfo(port, izbor.dir, sendKeyFile(userDir, port));
    writeUserFiles(hostPlatform(), userDir, { key: sendKey, port });
    return { base: `http://127.0.0.1:${port}`, port, info, izbor, requests, bugs, server, home, userDir, stop };
}

// The live store's host options: no send key to read, and this process's environment.
export const hostLive = (): Pick<LiveOptions, "readKey" | "env"> => ({
    readKey: () => Promise.reject(new Error("no reader for the send key")),
    env: process.env,
});
