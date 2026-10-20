import { test } from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../src/core/scheduler.js";
import { fakeClock, hook, msg, RECEIVED_AT, setup, until } from "./support.js";

test("concurrent hooks for one session never write a message twice", async () => {
    const transcript = [msg("user", "first")];
    const { handle, readRecords } = await setup(transcript);

    await Promise.all([handle(hook("SessionStart")), handle(hook("UserPromptSubmit")), handle(hook("PostToolUse"))]);
    transcript.push(msg("assistant", [{ type: "text", text: "second" }]));
    await Promise.all([handle(hook("PostToolUse")), handle(hook("Stop"))]);

    assert.deepEqual(
        (await readRecords()).map((r) => r.id),
        transcript.map((m) => m.uuid),
    );
});

test("a burst of hooks within 300 ms causes a single read", async () => {
    const clock = fakeClock();
    const { handle, reads, readRecords } = await setup([msg("user", "first")], { wait: clock.wait });

    const done = Array.from({ length: 5 }, () => handle(hook("PostToolUse")));
    await clock.advance(299);
    assert.equal(reads.count, 0);

    await clock.advance(1);
    await Promise.all(done);
    assert.equal(reads.count, 1);
    assert.equal((await readRecords()).length, 1);
});

test("Stop shows the finished reply in the brief at once, and leaves the session file to the Agent SDK", async () => {
    const clock = fakeClock();
    const { handle, brief, readRecords } = await setup([msg("user", "first")], { wait: clock.wait });

    const done = handle(hook("Stop", { last_assistant_message: "All done.\nBye" }));
    assert.deepEqual(brief().latestActivity, {
        what: "reply finished: All done. …",
        at: RECEIVED_AT.toISOString(),
        replyFinished: true,
    });

    await clock.advance(300);
    await done;
    assert.deepEqual(
        (await readRecords()).map((r) => r.blocks[0].text),
        ["first"],
    );
});

for (const hookName of ["Stop", "SessionEnd"]) {
    test(`${hookName} triggers delayed syncs after ~1 s and ~3 s, so a late-written final reply still reaches the file`, async () => {
        const clock = fakeClock();
        const transcript = [msg("user", "first")];
        const { handle, reads, readRecords } = await setup(transcript, { wait: clock.wait });
        const fileHas =
            (...texts: string[]) =>
            async () =>
                JSON.stringify((await readRecords()).map((r) => r.blocks[0].text)) === JSON.stringify(texts);

        const firstRead = handle(hook(hookName));
        await clock.advance(300);
        await firstRead;
        transcript.push(msg("assistant", [{ type: "text", text: "late reply" }]));

        await clock.advance(1000);
        await until(fileHas("first", "late reply"));

        transcript.push(msg("assistant", [{ type: "text", text: "even later" }]));
        await clock.advance(2000);
        await until(fileHas("first", "late reply", "even later"));
        assert.equal(reads.count, 3);
    });
}

test("a burst of event hooks writes one event record each but still causes a single read", async () => {
    const clock = fakeClock();
    const { handle, reads, readRecords } = await setup([msg("user", "first")], { wait: clock.wait });

    const done = ["Bash", "Write", "Edit"].map((name) =>
        handle(hook("PermissionRequest", { tool_name: name, tool_input: {} })),
    );
    await clock.advance(300);
    await Promise.all(done);

    assert.deepEqual(
        (await readRecords()).map((r) => r.name ?? r.kind),
        ["message", "Bash", "Write", "Edit"],
    );
    assert.equal(reads.count, 2);
});

test("after its stop the scheduler starts no work that still waited on a timer, however long the clock runs", async () => {
    const clock = fakeClock();
    const scheduler = createScheduler({ wait: clock.wait, onError: (err) => assert.fail(String(err)) });
    let runs = 0;
    const work = async () => void runs++;
    void scheduler.coalesce(work);
    scheduler.coalesceAfter(1000, work);
    scheduler.coalesceAfter(3000, work);

    assert.equal(clock.dueWithin(3000), true);
    await scheduler.stop();
    assert.equal(clock.dueWithin(3000), false);
    await clock.advance(10_000);

    assert.equal(runs, 0);
});
