export const QUESTION_TOOL = "AskUserQuestion";

export function questionsOf(input: unknown): string[] {
    const questions: unknown = (input as { questions?: unknown } | null)?.questions;
    if (!Array.isArray(questions)) return [];
    return questions
        .map(
            (
                asked: {
                    question?: unknown;
                } | null,
            ) => asked?.question,
        )
        .filter((q) => typeof q === "string");
}

type Asked = { question?: unknown; options?: unknown; multiSelect?: unknown; kind?: unknown } | null;

export function choiceOf(input: unknown): { question: string; options: string[] } | undefined {
    const questions: unknown = (input as { questions?: unknown } | null)?.questions;
    if (!Array.isArray(questions) || questions.length !== 1) return undefined;
    const { question, options, multiSelect, kind } = (questions[0] as Asked) ?? {};
    if (typeof question !== "string" || !question || multiSelect === true) return undefined;
    if ((kind !== undefined && kind !== "choice") || !Array.isArray(options) || options.length === 0) return undefined;
    const labels = options.map((option: { label?: unknown } | null) => option?.label);
    const readable = (label: unknown): label is string => typeof label === "string" && label !== "";
    return labels.every(readable) ? { question, options: labels } : undefined;
}

const about = (words: string, questions: string[]) =>
    questions.length > 0 ? `${words} to: ${questions.join(" · ")}` : `${words} to a question`;

export function finishedInWords(response: unknown): string | null {
    const { answers, response: reply } = (response ?? {}) as { answers?: unknown; response?: unknown };
    if (typeof answers !== "object" || answers === null) return null;
    const questions = questionsOf(response);
    if (typeof reply === "string" && reply.trim()) return about(`the user replied "${reply.trim()}"`, questions);
    const given = Object.entries(answers).flatMap(([question, answer]) => {
        const picked = [answer].flat().filter((option) => typeof option === "string" && option !== "");
        return picked.length > 0 ? [`"${picked.join(", ")}" to: ${question}`] : [];
    });
    return given.length > 0 ? `the user answered ${given.join(" · ")}` : about("the user gave no answer", questions);
}

export const endedInWords = (rawOutput: unknown) =>
    typeof rawOutput === "string" && rawOutput ? `the question ended: ${rawOutput}` : "the question ended";

export function dismissedInWords(questions: string[], { inIzbor = false } = {}): string {
    const where = inIzbor ? " in Izbor" : "";
    return questions.length > 0
        ? `the user dismissed the question${where}: ${questions.join(" · ")}`
        : `the user dismissed a question${where}`;
}
