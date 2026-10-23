import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createMouseParser, type MouseEvent } from "../src/terminal/mouse.js";

const click = "\u001b[<0;12;7M";

test("mouse reports yield one left click and vertical wheel steps in zero-based cells", () => {
    const parser = createMouseParser();
    assert.deepEqual(parser.push(`${click}\u001b[<0;12;7m\u001b[<64;1;1M\u001b[<65;80;24M`), [
        { type: "click", x: 11, y: 6 },
        { type: "scroll", x: 0, y: 0, delta: -1 },
        { type: "scroll", x: 79, y: 23, delta: 1 },
    ]);
});

test("a report survives every chunk boundary alongside ordinary keyboard text", () => {
    for (let split = 0; split <= click.length; split++) {
        const parser = createMouseParser();
        const events = [...parser.push(`observe ${click.slice(0, split)}`), ...parser.push(`${click.slice(split)}abc`)];
        assert.deepEqual(events, [{ type: "click", x: 11, y: 6 }], `split at ${split}`);
    }
    const parser = createMouseParser();
    assert.deepEqual(
        [...Buffer.from(click)].flatMap((byte) => parser.push(Buffer.from([byte]))),
        [{ type: "click", x: 11, y: 6 }],
    );
});

test("right/middle clicks, motion, horizontal wheels, releases, and selection modifiers do not activate targets", () => {
    const parser = createMouseParser();
    for (const button of [1, 2, 3, 4, 8, 16, 32, 35, 66, 67, 68, 72, 80, 128]) {
        assert.deepEqual(parser.push(`\u001b[<${button};4;5M`), [], `button ${button}`);
    }
    assert.deepEqual(parser.push("\u001b[<0;4;5m\u001b[<64;4;5m"), []);
});

test("mouse-looking text in bracketed paste never navigates, even when every byte arrives separately", () => {
    const input = `\u001b[200~observe ${click}\u001b[<65;4;5M\u001b\u001b[201~${click}`;
    for (let split = 0; split <= input.length; split++) {
        const parser = createMouseParser();
        assert.deepEqual(
            [...parser.push(input.slice(0, split)), ...parser.push(input.slice(split))],
            [{ type: "click", x: 11, y: 6 }],
        );
    }
    const parser = createMouseParser();
    assert.deepEqual(
        [...input].flatMap((character) => parser.push(character)),
        [{ type: "click", x: 11, y: 6 }],
    );
});

test("large and malformed input is discarded with recovery at the next valid report", () => {
    const parser = createMouseParser();
    for (const invalid of [
        "\u001b[<0;0;1M",
        "\u001b[<0;1;0M",
        "\u001b[<0;-1;2M",
        "\u001b[<0;1.5;2M",
        "\u001b[<0;65536;2M",
        "\u001b[<0;2;99999999999999999999999M",
        "\u001b[<0;;2M",
        "\u001b[<0;1;2;3M",
        "\u001b[<0;1;2\u0000M",
        `\u001b[<${"1".repeat(100_000)}M`,
        `\u001b[<${"1".repeat(100_000)}`,
    ]) {
        assert.deepEqual(parser.push(invalid), []);
        assert.deepEqual(parser.push(click), [{ type: "click", x: 11, y: 6 }]);
    }
    assert.deepEqual(parser.push(`\u001b[200~${click}${"x".repeat(1_000_000)}`), []);
    assert.deepEqual(parser.push(`\u001b[201~${click}`), [{ type: "click", x: 11, y: 6 }]);
});

test("a passive data listener sees reports without consuming the stream reader's keyboard bytes", async () => {
    const stdin = new PassThrough();
    const parser = createMouseParser();
    const events: MouseEvent[] = [];
    const received: string[] = [];
    stdin.on("readable", () => {
        let chunk: Buffer | null;
        while ((chunk = stdin.read() as Buffer | null) !== null) received.push(chunk.toString("utf8"));
    });
    stdin.on("data", (chunk: Buffer) => events.push(...parser.push(chunk)));
    const input = `observe abcd${click}\u001b[D\u007f`;
    stdin.end(input);
    await new Promise<void>((resolve) => stdin.on("end", resolve));
    assert.equal(received.join(""), input);
    assert.deepEqual(events, [{ type: "click", x: 11, y: 6 }]);
});
