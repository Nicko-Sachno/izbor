import { REQUEST_PENDING } from "../domain/prompt.js";
import {
    listedSession,
    unseenWait,
    type FieldMessage,
    type FieldState,
    type Observation,
    type RunningSession,
    type SentPrompt,
    type SessionList,
} from "./model.js";
import { singleLine } from "./presentation.js";

export const NO_PROMPT_REPLY = "Izbor gave no reply: check the Brief before you send again.";

export const SENDING = "Sending…";

export const NO_PLUGIN_HERE = "This project has no plugin: answer in Claude Code, or add it with Add plugin › on Home.";

const OTHER_SESSION = "You typed this on another session's Brief: nothing was sent.";

export function pluginless(row: Observation, list: SessionList): RunningSession | undefined {
    const listed = listedSession(list, row.id);
    return listed && !listed.acting ? listed : undefined;
}

export function replyRefusal(session: string, row: Observation, list: SessionList): string | undefined {
    if (session !== row.id) return OTHER_SESSION;
    if (row.brief?.needsYou.state === "request" || unseenWait(row.brief)) return REQUEST_PENDING;
    return pluginless(row, list) ? NO_PLUGIN_HERE : undefined;
}

const PROMPT_LINES: Partial<Record<SentPrompt["state"], string>> = {
    sent: "Sent to this session.",
    queued: "Sent. It runs when this turn ends.",
};

export function promptLine({ prompt }: Observation): FieldMessage | null {
    const text = prompt && PROMPT_LINES[prompt.state];
    return text ? { text, error: false } : null;
}

export function saying(field: FieldState, message: FieldMessage): FieldState {
    const { message: was, behind = [], ...rest } = field;
    const others = [...behind, ...(was?.session === undefined ? [] : [was])].filter(
        (other) => other.session !== message.session,
    );
    return { ...rest, message, ...(others.length > 0 && { behind: others }) };
}

export function withoutMessage(field: FieldState, message: FieldMessage): FieldState {
    const { behind = [], ...rest } = field;
    const others = behind.filter((other) => other !== message);
    return {
        ...rest,
        message: field.message === message ? null : field.message,
        ...(others.length > 0 && { behind: others }),
    };
}

export function unsaid(field: FieldState): FieldState {
    const { behind: _behind, ...rest } = field;
    return { ...rest, message: null };
}

export function saidOn(field: FieldState, id: string): FieldMessage | undefined {
    return [field.message, ...(field.behind ?? [])].find((said) => said && (said.session ?? id) === id) ?? undefined;
}

function droppedMessage(row: Observation): FieldMessage {
    const why = singleLine(row.prompt?.reason ?? "").replace(/[.!?]$/, "");
    return { text: `That prompt did not run${why && `: ${why}`}.`, error: true, session: row.id };
}

export function droppedLine(field: FieldState, row: Observation): FieldMessage | null {
    const { prompt } = row;
    return prompt?.state === "dropped" && !field.told?.includes(prompt.id) ? droppedMessage(row) : null;
}

export function toldOf(field: FieldState, row: Observation | undefined): Pick<FieldState, "told"> {
    const id = row?.prompt?.state === "dropped" ? row.prompt.id : undefined;
    const told = id === undefined || field.told?.includes(id) ? field.told : [...(field.told ?? []), id];
    return told ? { told } : {};
}

export function afterDrop(field: FieldState, row: Observation, shown: boolean): FieldState {
    const text = row.prompt?.text ?? "";
    const said = saying(field, droppedMessage(row));
    if (field.text || !shown || row.brief?.needsYou.state === "request") return said;
    return { ...said, text, cursor: text.length, fixed: { mode: "reply", session: row.id } };
}
