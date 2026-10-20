export const COLLECT_LIMIT_MS = 5000;

export const POLL_LIMIT_MS = 25_000;

export const REPORT_LIMIT_MS = 60 * 60 * 1000;

export const IZBOR_PLUGIN = "izbor";

export type IzborPrompt = { promptId: string; sessionId: string; text: string };

export type PromptState = "delivered" | "dropped";

export const NO_PLUGIN = "Type /reload-plugins in this session once to send messages from here.";

export const REQUEST_PENDING = "Answer the request first.";

export const PROMPT_PENDING = "A prompt for this session waits already.";

export const notActing = (folder: string) => `To answer from here, run add plugin ${folder}.`;

const EMPTY_PROMPT = "The prompt is empty.";

const SLASH_COMMAND = "Run slash commands in the session.";

export function badPromptText(text: string): string | undefined {
    const typed = text.trim();
    if (typed === "") return EMPTY_PROMPT;
    if (typed.startsWith("/")) return SLASH_COMMAND;
    return undefined;
}

export const BAD_PROMPT_BODY = 'Izbor could not read this as a prompt: send {"text"}';
