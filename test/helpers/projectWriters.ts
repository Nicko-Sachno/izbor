import assert from "node:assert/strict";
import type { ProjectSetup } from "../../src/terminal/main.js";

// The controller's project writers from a ProjectSetup, as the terminal app wires them.
export function writersOf({ port, hooks, plugin }: ProjectSetup) {
    return { hooks: { port, write: hooks }, plugin: { port, change: plugin } };
}

// For a test that never adds hooks or the plugin: a write fails the test.
export const NO_WRITES = writersOf({
    port: 4319,
    hooks: () => assert.fail("this test adds no hooks"),
    plugin: () => assert.fail("this test adds no plugin"),
});
