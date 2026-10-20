import type { EventBase, EventRecord } from "../../../domain/records.js";
import type { HookEventName, HookPayload } from "./payload.js";

const EVENT_NAMES: Partial<Record<HookEventName, EventRecord["event"]>> = {
    PermissionRequest: "permission_request",
    PermissionDenied: "permission_denied",
    Notification: "notification",
};

export function toEventRecord(hook: HookPayload, sessionId: string, receivedAt: Date): EventRecord | null {
    const name = hook.hook_event_name as HookEventName;
    const event = Object.hasOwn(EVENT_NAMES, name) ? EVENT_NAMES[name] : undefined;
    if (!event) {
        return null;
    }

    const base: EventBase = {
        kind: "event",
        sessionId,
        agentId: hook.agent_id ?? null,
        timestamp: receivedAt.toISOString(),
    };

    switch (event) {
        case "notification":
            return { ...base, event, notificationType: hook.notification_type, message: hook.message };
        case "permission_request":
        case "permission_denied":
            return { ...base, event, toolCallId: hook.tool_use_id, name: hook.tool_name, rawInput: hook.tool_input };
        default:
            return event satisfies never;
    }
}
