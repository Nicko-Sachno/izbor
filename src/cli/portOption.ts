import { IZBOR_PORT, isPort } from "../config.js";

export function portOption(
    cliPort: string | undefined,
    envPort: string | undefined,
): { port: number } | { error: string } {
    const { source, text } = selectPortInput(cliPort, envPort);
    const port = Number(text);

    return isPort(port) ? { port } : { error: `${source} must be a port from 1 to 65535, not "${text}".` };
}

function selectPortInput(cliPort: string | undefined, envPort: string | undefined): PortInput {
    switch (true) {
        case cliPort !== undefined:
            return { source: "--port", text: cliPort };
        case envPort !== undefined && envPort !== "":
            return { source: "IZBOR_PORT", text: envPort };
        default:
            return { source: "default", text: String(IZBOR_PORT) };
    }
}

type PortInput = { source: "--port" | "IZBOR_PORT" | "default"; text: string };
