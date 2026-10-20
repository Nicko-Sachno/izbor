import type { TestContext } from "node:test";
import { createTerminalController } from "../../src/terminal/controller.js";
import { createSampleSource, SAMPLE_IDS } from "./sampleSessions.js";

export function sampleWindow(
    t: TestContext,
    { columns, rows, initialIds = SAMPLE_IDS }: { columns: number; rows: number; initialIds?: readonly string[] },
) {
    const source = createSampleSource({ scenario: "overview", animate: false });
    const app = createTerminalController(source, {
        initialIds,
        columns,
        rows,
        hooks: { port: source.setup.port, write: source.setup.hooks },
        plugin: { port: source.setup.port, change: source.setup.plugin },
        changed() {},
    });
    t.after(() => app.dispose());
    return { source, app };
}
