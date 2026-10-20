import { useEffect, useEffectEvent } from "react";
import { useStdin, useStdout } from "ink";

export type MouseEvent = {
    type: "click" | "scroll";
    x: number;
    y: number;
    delta?: number;
};

const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1000l\u001b[?1006l";
const PASTE_END = "\u001b[201~";
const MAX_CONTROL_LENGTH = 32;
const MAX_COORDINATE = 65_535;

export function createMouseParser() {
    let state: "ground" | "escape" | "csi" | "discard-csi" | "paste" = "ground";
    let sequence = "";
    let pasteEndLength = 0;

    function report(sequence: string): MouseEvent | undefined {
        const match = /^<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])$/.exec(sequence);
        if (!match || match[4] !== "M") return;
        const button = Number(match[1]);
        const x = Number(match[2]);
        const y = Number(match[3]);
        if (x < 1 || y < 1 || x > MAX_COORDINATE || y > MAX_COORDINATE) return;

        if (button === 0) return { type: "click", x: x - 1, y: y - 1 };
        if (button === 64 || button === 65)
            return { type: "scroll", x: x - 1, y: y - 1, delta: button === 64 ? -1 : 1 };
    }

    return {
        push(chunk: string | Buffer): MouseEvent[] {
            const events: MouseEvent[] = [];
            for (const character of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
                if (state === "paste") {
                    if (character === PASTE_END[pasteEndLength]) pasteEndLength++;
                    else pasteEndLength = character === "\u001b" ? 1 : 0;
                    if (pasteEndLength === PASTE_END.length) {
                        pasteEndLength = 0;
                        state = "ground";
                    }
                    continue;
                }
                if (character === "\u001b") {
                    state = "escape";
                    sequence = "";
                    continue;
                }
                if (state === "escape") {
                    state = character === "[" ? "csi" : "ground";
                    continue;
                }
                if (state === "ground") continue;

                const code = character.charCodeAt(0);
                if (code >= 0x40 && code <= 0x7e) {
                    if (state === "csi") {
                        sequence += character;
                        if (sequence === "200~") {
                            state = "paste";
                            sequence = "";
                            continue;
                        }
                        const event = report(sequence);
                        if (event) events.push(event);
                    }
                    state = "ground";
                    sequence = "";
                } else if (code < 0x20 || code > 0x3f) {
                    state = "ground";
                    sequence = "";
                } else if (state === "csi") {
                    sequence += character;
                    if (sequence.length > MAX_CONTROL_LENGTH) {
                        state = "discard-csi";
                        sequence = "";
                    }
                }
            }
            return events;
        },
    };
}

export function useMouse(handler: (event: MouseEvent) => void, enabled = true): void {
    const { stdin, setRawMode, isRawModeSupported } = useStdin();
    const { stdout } = useStdout();
    const onMouse = useEffectEvent(handler);

    useEffect(() => {
        if (!enabled || !isRawModeSupported || !("isTTY" in stdout) || stdout.isTTY !== true) return;
        const parser = createMouseParser();
        const onData = (chunk: string | Buffer) => {
            for (const event of parser.push(chunk)) onMouse(event);
        };
        const disable = () => {
            try {
                stdout.write(DISABLE_MOUSE);
            } catch {}
        };

        setRawMode(true);
        stdin.on("data", onData);
        process.once("exit", disable);
        stdout.write(ENABLE_MOUSE);
        return () => {
            stdin.off("data", onData);
            process.off("exit", disable);
            disable();
            setRawMode(false);
        };
    }, [enabled, isRawModeSupported, setRawMode, stdin, stdout]);
}
