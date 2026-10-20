import type { IzborClient } from "../../adapters/izbor/client.js";
import type { CliArgs } from "../args.js";
import { type IzborEnv, izborAddress } from "../../config.js";
import { messageOf } from "../../domain/text.js";
import type { CommandReport } from "./report.js";

export type ServeArgs = Extract<CliArgs, { command: "serve" }>;

export async function runServe(
    { port }: ServeArgs,
    { izborEnv, client, serve }: ServeDeps,
): Promise<CommandReport<0 | 1>> {
    let env: IzborEnv;
    try {
        env = izborEnv();
    } catch (error) {
        return failedReport(error);
    }

    const izbor = await client.getIzbor();
    if ("up" in izbor) {
        if (izbor.up === "older") {
            return failedReport(
                `An older Izbor already runs on ${izborAddress(port)}. Stop it with Ctrl-C where it runs.`,
            );
        }
        return failedReport(`Izbor already runs in the background (pid ${izbor.up.pid}). Run izbor stop first.`);
    }

    try {
        await serve({ port, ...env });
    } catch (error) {
        return failedReport(error);
    }
    return { lines: [], code: 0 };
}

function failedReport(error: unknown): CommandReport<1> {
    return { lines: [messageOf(error)], code: 1 };
}

type ServeDeps = {
    izborEnv: () => IzborEnv;
    client: Pick<IzborClient, "getIzbor">;
    serve: (options: { port: number } & IzborEnv) => Promise<unknown>;
};
