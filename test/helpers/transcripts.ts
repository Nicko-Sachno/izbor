import { readdirSync, readFileSync } from "node:fs";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

const TRANSCRIPT_FIXTURES = new URL("../fixtures/transcripts/", import.meta.url);

export type TranscriptRow = { type: string; origin?: object; promptSource?: string; toolDenialKind?: string };

type TranscriptFixture = {
    source: string;
    hookReply?: object;
    messages: SessionMessage[];
    rows: TranscriptRow[];
};

export const transcriptFixture = (name: string): TranscriptFixture =>
    JSON.parse(readFileSync(new URL(`${name}.json`, TRANSCRIPT_FIXTURES), "utf8")) as TranscriptFixture;

export const transcriptFixtureNames = () =>
    readdirSync(TRANSCRIPT_FIXTURES)
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.replace(/\.json$/, ""));
