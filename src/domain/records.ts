export type Block =
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "toolCall"; toolCallId: string; name: string; rawInput: unknown; kind: ToolKind; title: string }
    | { type: "toolResult"; toolCallId: string; status: "completed" | "failed"; rawOutput: unknown }
    | { type: "other"; originalType: string; raw: unknown };

export type ToolKind =
    "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

export type MessageRecord = {
    kind: "message";
    id: string;
    sessionId: string;
    agentId: string | null;
    parentToolCallId: string | null;
    timestamp: string | null;
    role: "user" | "assistant";
    origin?: { kind: string; name?: string; asUser?: boolean };
    model?: string;
    usage?: Usage;
    blocks: Block[];
};

export type EventBase = {
    kind: "event";
    sessionId: string;
    agentId: string | null;
    timestamp: string;
};

type PermissionEventRecord = EventBase & {
    event: "permission_request" | "permission_denied";
    toolCallId?: string;
    name?: string;
    rawInput?: unknown;
};

type NotificationEventRecord = EventBase & {
    event: "notification";
    notificationType?: string;
    message?: string;
};

export type EventRecord = PermissionEventRecord | NotificationEventRecord;

export type HookRecord = {
    kind: "hook";
    sessionId: string;
    timestamp: string;
    payload: unknown;
};

export type StopWhy = "no listener" | "deleted" | "izbor stopping";

export type IzborEvent =
    | { event: "started" }
    | { event: "stopped"; why: StopWhy }
    | { event: "sync_error"; error: string }
    | { event: "rejected_payload"; body: string };

export type IzborRecord = {
    kind: "izbor";
    sessionId: string;
    timestamp: string;
} & IzborEvent;

export type Status =
    | { status: "busy" | "idle" }
    | { status: "waiting"; waitingFor?: string }
    | { status: "not_listed" }
    | { status: "unknown"; error: string };

export type StatusRecord = {
    kind: "status";
    sessionId: string;
    timestamp: string;
} & Status;
