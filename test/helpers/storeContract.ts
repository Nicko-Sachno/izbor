import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { suite, test, type TestContext } from "node:test";
import type { ObservationSource, ObservedSource } from "../../src/terminal/model.js";
import { SESSION } from "../support.js";

type StoreUnderTest<S> = { source: S; id: string };

type Build<S> = (t: TestContext) => StoreUnderTest<S> | Promise<StoreUnderTest<S>>;

const NEVER_OBSERVED = "00000000-0000-4000-8000-000000000000";

const ids = (source: ObservedSource) => source.getSnapshot().observations.map(({ id }) => id);

export function storeContract(name: string, build: Build<ObservationSource>) {
    contract(name, build, (start) => {
        test("with no request waiting, answer and prompt resolve with one sentence for the field's line, news or a refusal, and never reject", async (t) => {
            const { source, id } = await start(t);
            source.observe(id);
            const at = "2026-10-09T12:00:01.000Z";
            const answers = [
                await source.answer(id, { at, answer: "yes" }),
                await source.prompt(id, "run the tests again"),
            ];
            for (const answer of answers) {
                assert.ok(!("sent" in answer), `nothing waits for an answer: ${JSON.stringify(answer)}`);
                const sentence = "refused" in answer ? answer.refused : answer.news;
                assert.ok(sentence.endsWith("."), `one sentence: ${JSON.stringify(answer)}`);
            }
        });
        test("answer and prompt reject with AbortError after disposal", async (t) => {
            const { source, id } = await start(t);
            source.dispose();
            await assert.rejects(source.answer(id, { at: "2026-10-09T12:00:01.000Z", answer: "yes" }), {
                name: "AbortError",
            });
            await assert.rejects(source.prompt(id, "run the tests again"), { name: "AbortError" });
        });
    });
}

export function observedStoreContract(name: string, build: Build<ObservedSource>) {
    contract(name, build, () => {});
}

function contract<S extends ObservedSource>(
    name: string,
    build: Build<S>,
    sends: (start: (t: TestContext) => Promise<StoreUnderTest<S>>) => void,
) {
    suite(`${name} keeps the store's rules`, () => {
        async function start(t: TestContext) {
            const store = await build(t);
            t.after(() => store.source.dispose());
            return store;
        }

        test("getSnapshot gives the same object while nothing changes", async (t) => {
            const { source, id } = await start(t);
            const first = source.getSnapshot();
            assert.equal(source.getSnapshot(), first);
            source.observe(id);
            const second = source.getSnapshot();
            assert.notEqual(second, first);
            assert.equal(source.getSnapshot(), second);
        });

        test("observe puts the row in the snapshot before it returns, and onChange fires inside it", async (t) => {
            const { source, id } = await start(t);
            const seen: string[][] = [];
            source.onChange(() => seen.push(ids(source)));
            assert.equal(source.observe(id), "added");
            assert.deepEqual(ids(source), [id]);
            assert.deepEqual(seen[0], [id], "the callback inside observe already reads the row");
        });

        test("observe twice on one id gives one row", async (t) => {
            const { source, id } = await start(t);
            assert.equal(source.observe(id), "added");
            assert.equal(source.observe(id), "already");
            assert.deepEqual(ids(source), [id]);
        });

        test("leave removes the row before it returns, and onChange fires inside it", async (t) => {
            const { source, id } = await start(t);
            source.observe(id);
            const seen: string[][] = [];
            source.onChange(() => seen.push(ids(source)));
            source.leave(id);
            assert.deepEqual(ids(source), []);
            assert.deepEqual(seen[0], []);
        });

        test("onChange's answer ends the callbacks", async (t) => {
            const { source, id } = await start(t);
            let fired = 0;
            const off = source.onChange(() => fired++);
            off();
            source.observe(id);
            source.leave(id);
            assert.equal(fired, 0);
        });

        test("refreshSessions resolves while the source is active", async (t) => {
            const { source, id } = await start(t);
            source.observe(id);
            await source.refreshSessions();
        });

        test("refreshSessions rejects with AbortError after disposal", async (t) => {
            const { source } = await start(t);
            source.dispose();
            await assert.rejects(source.refreshSessions(), { name: "AbortError" });
        });

        sends(start);

        test("after dispose, nothing fires and observe adds no row", async (t) => {
            const { source, id } = await start(t);
            source.observe(id);
            let fired = 0;
            source.onChange(() => fired++);
            source.dispose();
            assert.doesNotThrow(() => source.observe(NEVER_OBSERVED));
            assert.doesNotThrow(() => source.leave(id));
            assert.ok(!ids(source).includes(NEVER_OBSERVED));
            await delay(20);
            assert.equal(fired, 0);
        });
    });
}

export const rowOf = (source: ObservedSource, id = SESSION) =>
    source.getSnapshot().observations.find((row) => row.id === id);
