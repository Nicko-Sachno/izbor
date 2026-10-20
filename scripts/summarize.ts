import { join } from "node:path";
import { selectPlatform } from "../src/adapters/platform/select.js";
import { createSummarizer } from "../src/adapters/summarizer/summarizer.js";
import { PROJECT_DIR, readDataDir } from "../src/config.js";
import { UNKNOWN_BRIEF } from "../src/domain/brief.js";
import { toSummaryRequest } from "../src/domain/explanation.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 2, 12, 0, seconds)).toISOString();

const ACTIONS = [
    "prompt submitted",
    "Claude wrote: I'll start with the failing test to see where the redirect loops.",
    "started Bash: npm test -- auth.spec.ts",
    "failed Bash: npm test -- auth.spec.ts",
    "started Read: src/auth.ts",
    "finished Read: src/auth.ts",
    "started Read: src/middleware/session.ts",
    "finished Read: src/middleware/session.ts",
    "started Grep: redirectTo",
].map((what, i) => ({ what, at: at(i) }));

const { request } = toSummaryRequest(
    {
        ...UNKNOWN_BRIEF,
        task: { text: "fix the login redirect loop", at: at(0), from: "hook" },
        status: { status: "busy" },
        latestActivity: ACTIONS.at(-1)!,
        needsYou: { state: "nothing", at: at(1) },
    },
    ACTIONS,
);

const summarize = createSummarizer({
    dir: join(readDataDir(process.env, PROJECT_DIR), "summarizer"),
    platform: selectPlatform(process.platform),
    env: process.env,
});
const cancel = new AbortController();

const stop = () => cancel.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const started = Date.now();
const result = await summarize({ ...request, input: process.argv[2] ?? request.input }, cancel.signal);
const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
if (result.outcome === "summary") console.log(`summary (${took}): ${result.text}`);
else if (result.outcome === "unavailable") console.log(`unavailable (${took}): ${result.reason}`);
else console.log(`cancelled (${took})`);
process.exit(result.outcome === "unavailable" ? 1 : 0);
