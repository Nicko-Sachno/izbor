import { isObject, readJson } from "../../../domain/text.js";
import { isSessionId } from "../../../domain/wire.js";

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export type HookPayload = {
    session_id: string;
    hook_event_name: string;
    cwd?: string;
    agent_id?: string;
    agent_type?: string;
    prompt?: string;
    last_assistant_message?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_use_id?: string;
    tool_response?: unknown;
    background_tasks?: { description?: string }[];
    error?: string;
    /** StopFailure's: more about its `error` category. Unchecked by the reader, so read with `typeof`. */
    error_details?: unknown;
    /** PostToolUseFailure's: true when the tool stopped by an abort, as on Esc. A Bash command stopped by Esc fails with
     *  a shell error instead: it carries false, and its `error` holds the interrupt line after `Exit code N`.
     *  Unchecked by the reader, so read as `=== true`. */
    is_interrupt?: unknown;
    source?: string;
    reason?: string;
    notification_type?: string;
    message?: string;
};

export const HOOK_EVENT_NAMES = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "StopFailure",
    "SessionEnd",
    "PermissionRequest",
    "PermissionDenied",
    "Notification",
] as const;

const TEXT_FIELDS = [
    "hook_event_name",
    "cwd",
    "agent_id",
    "agent_type",
    "prompt",
    "last_assistant_message",
    "tool_name",
    "tool_use_id",
    "source",
    "reason",
    "notification_type",
    "message",
] as const satisfies readonly (keyof HookPayload)[];

export function readHookPayload(body: string): HookPayload | undefined {
    const fields = readJson(body);
    if (!isObject(fields)) {
        return undefined;
    }
    if (!isSessionId(fields.session_id)) {
        return undefined;
    }

    for (const name of TEXT_FIELDS) {
        if (fields[name] !== undefined && typeof fields[name] !== "string") {
            return undefined;
        }
    }

    return fields as HookPayload;
}
