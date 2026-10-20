import type { IzborClient } from "../../adapters/izbor/client.js";
import { type NotAnswerable } from "../../domain/answer.js";
import type { ErrorCode } from "../../domain/wire.js";
import { NO_REPLY, NOTHING_SENT } from "../field.js";
import { createListeners } from "../listeners.js";
import { duringLifetime } from "../lifetime.js";
import {
    unseenWait,
    type FieldAnswer,
    type Observation,
    type ObservationSource,
    type ObservedSource,
    type SentAnswer,
    type Snapshot,
} from "../model.js";
import { NO_PLUGIN_HERE, NO_PROMPT_REPLY } from "../reply.js";
import type { Wait } from "./observation.js";
import type { SentPrompts } from "./prompts.js";

export const STILL_WAITS_MS = 5_000;

export const REASON_HOLDS_MS = 400;

const MOMENTARY: ReadonlySet<true | NotAnswerable | undefined> = new Set(["not running when it asked", "expired"]);

type Reason = { at: string | undefined; reason: NotAnswerable; held: boolean };

const REFUSED: Partial<Record<ErrorCode, string>> = {
    not_acting: NO_PLUGIN_HERE,
    not_watched: NOTHING_SENT.notWatching,
    unauthorized: "Izbor refused this window's send key: nothing was sent.",
};

const sentence = (message: string) => (/[.!?]$/.test(message) ? message : `${message}.`);

type Reply = Awaited<ReturnType<IzborClient["sendAnswer"] | IzborClient["sendPrompt"]>>;

function heard(reply: Reply, word: "sent" | "collected", noReply: string): { said: string } | { refused: string } {
    if (typeof reply !== "object" || reply === null) return { refused: noReply };
    if ("away" in reply) return { refused: reply.away === "not answering" ? noReply : NOTHING_SENT[reply.away] };
    if ("refused" in reply) return { refused: (reply.error && REFUSED[reply.error]) ?? sentence(reply.message) };
    const said = (reply as Record<string, unknown>)[word];
    return typeof said === "string" ? { said } : { refused: noReply };
}

function waitsLive({ connection, brief }: Observation, at: string): boolean {
    const needsYou = brief?.needsYou;
    return connection.state === "live" && needsYou?.state === "request" && needsYou.at === at;
}

function reasonHolder(wait: Wait, signal: AbortSignal, changed: () => void): (row: Observation) => Observation {
    const reasons = new Map<string, Reason>();
    return (row) => {
        const { brief } = row;
        const asked = brief?.needsYou.state === "request" ? brief.needsYou : unseenWait(brief);
        if (!brief || !asked || brief.answerable === true || !MOMENTARY.has(brief.answerable)) {
            reasons.delete(row.id);
            return row;
        }
        const { at } = asked;
        const reason = brief.answerable as NotAnswerable;
        let seen = reasons.get(row.id);
        if (!seen || seen.at !== at || seen.reason !== reason) {
            const first: Reason = { at, reason, held: false };
            reasons.set(row.id, (seen = first));
            void wait(REASON_HOLDS_MS, signal).then(() => {
                if (signal.aborted || reasons.get(row.id) !== first) return;
                first.held = true;
                changed();
            });
        }
        if (seen.held) return row;
        const { answerable: _momentary, ...unsaid } = brief;
        return { ...row, brief: "waitingFor" in asked ? { ...unsaid, needsYou: { state: "unknown" } } : unsaid };
    };
}

async function sendKey(
    keyPath: string | undefined,
    readKey: (path: string, signal: AbortSignal) => Promise<string>,
    what: "answers" | "prompts",
    signal: AbortSignal,
): Promise<{ key: string } | { refused: string }> {
    signal.throwIfAborted();
    if (keyPath === undefined) return { refused: `This Izbor is older than the app: it takes no ${what}.` };
    try {
        const key = await readKey(keyPath, signal);
        signal.throwIfAborted();
        return { key: key.trim() };
    } catch {
        signal.throwIfAborted();
        return { refused: "Izbor's send key could not be read: nothing was sent." };
    }
}

export function answering(
    source: ObservedSource,
    {
        client,
        keyPath,
        readKey,
        wait,
        now,
        prompts,
    }: {
        client: Pick<IzborClient, "sendAnswer" | "sendPrompt">;
        keyPath: string | undefined;
        readKey: (path: string, signal: AbortSignal) => Promise<string>;
        wait: Wait;
        now: () => Date;
        prompts: SentPrompts;
    },
): ObservationSource {
    const sent = new Map<string, SentAnswer>();
    const due = new WeakSet<SentAnswer>();
    const listeners = createListeners();
    const atDispose = new AbortController();
    let disposed = false;
    const said = reasonHolder(wait, atDispose.signal, () => refresh());
    let snapshot = shown(source.getSnapshot());

    function sentTo(row: Observation): SentAnswer | undefined {
        const mine = sent.get(row.id);
        if (mine && due.has(mine) && waitsLive(row, mine.at)) sent.set(row.id, { ...mine, stillWaits: true });
        return sent.get(row.id);
    }

    function steady(row: Observation): Observation {
        const mine = sentTo(row);
        return said(prompts.shown(mine ? { ...row, sent: mine } : row));
    }

    function shown(inner: Snapshot): Snapshot {
        return { ...inner, observations: inner.observations.map(steady) };
    }

    function refresh() {
        if (disposed) return;
        snapshot = shown(source.getSnapshot());
        listeners.emit();
    }

    async function send(id: string, { at, answer }: { at: string; answer: string }): Promise<FieldAnswer> {
        const read = await sendKey(keyPath, readKey, "answers", atDispose.signal);
        atDispose.signal.throwIfAborted();
        if ("refused" in read) return read;
        const answered = heard(
            await client.sendAnswer(id, { at, answer }, read.key, atDispose.signal),
            "sent",
            NO_REPLY,
        );
        atDispose.signal.throwIfAborted();
        if ("refused" in answered) return answered;
        const text = answered.said === "yes" || answered.said === "no" ? answered.said : answer.trim();
        const mine: SentAnswer = { at, text, sentAt: now().toISOString() };
        sent.set(id, mine);
        refresh();
        void wait(STILL_WAITS_MS, atDispose.signal).then(() => {
            if (disposed) return;
            due.add(mine);
            refresh();
        });
        return { sent: text };
    }

    async function post(id: string, text: string): Promise<FieldAnswer> {
        const read = await sendKey(keyPath, readKey, "prompts", atDispose.signal);
        atDispose.signal.throwIfAborted();
        if ("refused" in read) return read;
        const collected = heard(
            await client.sendPrompt(id, { text }, read.key, atDispose.signal),
            "collected",
            NO_PROMPT_REPLY,
        );
        atDispose.signal.throwIfAborted();
        if ("refused" in collected) return collected;
        const row = source.getSnapshot().observations.find((observed) => observed.id === id);
        if (row) prompts.collected(row, collected.said, text, now().toISOString());
        refresh();
        return { sent: text };
    }

    const stopListening = source.onChange(refresh);
    const stopPrompts = prompts.onChange(refresh);

    return {
        ...source,
        getSnapshot: () => snapshot,
        onChange: listeners.on,
        leave(id) {
            sent.delete(id.toLowerCase());
            prompts.forget(id.toLowerCase());
            source.leave(id);
        },
        answer: (id, answer) => duringLifetime(atDispose.signal, () => send(id.toLowerCase(), answer)),
        prompt: (id, text) => duringLifetime(atDispose.signal, () => post(id.toLowerCase(), text)),
        dispose() {
            if (disposed) return;
            disposed = true;
            atDispose.abort();
            listeners.close();
            stopListening();
            stopPrompts();
            prompts.dispose();
            sent.clear();
            source.dispose();
        },
    };
}
