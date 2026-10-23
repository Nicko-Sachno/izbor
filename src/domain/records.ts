import type { SubagentCounts } from "./response.js";

export type Block =
    /** `interrupt` marks the line the agent writes when the user interrupts the reply: while the model wrote, or at a
     *  tool call it ran or the user refused. */
    | { type: "text"; text: string; interrupt?: "reply" | "tool use" }
    | { type: "thinking"; text: string }
    | {
          type: "toolCall";
          toolCallId: string;
          name: string;
          rawInput: unknown;
          kind: ToolKind;
          title: string;
          /** The call's name as the agent shows it, such as `Update` for an edit or `server · tool` for an MCP tool. */
          display: string;
          /** The call's whole main argument, such as its command or its path; "" when it has none. */
          argument: string;
          /** The input's own description of the call, when it has one. */
          description?: string;
          /** Present on a call that starts a subagent, with the subagent's type when the call names one. */
          subagent?: { agentType?: string };
      }
    | {
          type: "toolResult";
          toolCallId: string;
          status: "completed" | "failed";
          rawOutput: unknown;
          /** The output's first line that holds text; of a failure, its first error line. */
          firstLine?: string;
          /** A failed command's exit code. */
          exitCode?: number;
          /** A subagent's tool uses and time, when its result gives them. */
          counts?: SubagentCounts;
          /** The call left its work running in the background, as a command or a subagent sent there does: its result
           *  says only that. */
          background?: true;
      }
    /** What the agent was told while it worked, such as a background task that finished. */
    | { type: "notice"; text: string }
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
    /** Written by the agent's program in the model's place, so its text gives no text item: `error` says in its
     *  text why the reply failed, such as an API error; `no reply` stands in where no reply was asked for. */
    synthetic?: "error" | "no reply";
    /** The model ended its turn with this message. */
    endedTurn?: true;
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
