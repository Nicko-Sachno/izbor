import { afterSend, editField, modeOn, NO_REPLY, sendRefusal } from "./field.js";
import type { EditKey } from "./line-editor.js";
import type { FieldAnswer, FieldMessage, Observation, ObservationSource, TerminalView } from "./model.js";
import { afterDrop, NO_PROMPT_REPLY, saying, SENDING, unsaid, withoutMessage } from "./reply.js";

const droppedIn = (row: Observation) => row.prompt?.state === "dropped";

export function createSubmission(
    source: ObservationSource,
    view: TerminalView,
    changed: () => void,
    shownNow: () => Observation | undefined,
) {
    let sending = false;
    let disposed = false;
    let revision = 0;
    const dropped = new Set<string>();

    function feedback(text: string, error: boolean) {
        view.feedback = text;
        view.feedbackIsError = error;
    }

    function hearDropped() {
        if (disposed) return;
        for (const row of view.sessions) {
            if (!row.prompt || !droppedIn(row) || dropped.has(row.prompt.id)) continue;
            dropped.add(row.prompt.id);
            const next = afterDrop(view.field, row, shownNow()?.id === row.id);
            if (next.text !== view.field.text) revision++;
            view.field = next;
        }
    }

    const stopListening = source.onChange(hearDropped);

    async function send(shown: Observation | undefined) {
        if (disposed) return;
        feedback("", false);
        const { text, fixed } = view.field;
        if (!shown || !fixed || !text.trim() || sending) return;
        const submittedRevision = revision;
        const refused = sendRefusal(view.field, shown, view.izbor.state, view.list);
        const reply = fixed.mode === "reply";
        sending = true;
        let answer: FieldAnswer;
        let pending: FieldMessage | undefined;
        try {
            if (refused !== undefined) answer = { refused };
            else if (reply) {
                pending = { text: SENDING, error: false, session: shown.id };
                view.field = saying(view.field, pending);
                changed();
                answer = await source.prompt(shown.id, text);
            } else answer = await source.answer(shown.id, { at: fixed.at ?? "", answer: text });
        } catch {
            answer = { refused: reply ? NO_PROMPT_REPLY : NO_REPLY };
        } finally {
            sending = false;
        }
        if (disposed) return;
        if (pending) view.field = withoutMessage(view.field, pending);
        hearDropped();
        const lost = reply && "sent" in answer && view.sessions.some((row) => row.id === shown.id && droppedIn(row));
        const sameDraft = submittedRevision === revision && view.field.fixed === fixed;
        if (!lost) view.field = afterSend(view.field, answer, shown.id, sameDraft);
        changed();
    }

    return {
        send,
        edit(text: string | undefined, key: EditKey, shown: Observation | undefined, columns?: number) {
            if (disposed) return;
            feedback("", false);
            const next = editField(view.field, modeOn(shown), text, key, shown, columns);
            if (next.text !== view.field.text) revision++;
            view.field = next;
        },
        message(text: string, error = false) {
            if (disposed) return;
            feedback(text, error);
            view.field = unsaid(view.field);
        },
        dispose() {
            disposed = true;
            stopListening();
            dropped.clear();
        },
    };
}
