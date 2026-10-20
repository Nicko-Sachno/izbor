export type SummaryRequest = { systemPrompt: string; input: string };

export type SummaryResult =
    { outcome: "summary"; text: string } | { outcome: "unavailable"; reason: string } | { outcome: "cancelled" };

export type Summarize = (request: SummaryRequest, signal: AbortSignal) => Promise<SummaryResult>;
