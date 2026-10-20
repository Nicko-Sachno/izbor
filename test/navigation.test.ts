import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalController } from "../src/terminal/controller.js";
import { DETAIL_FOCUS } from "../src/terminal/focus.js";
import { createFakeStore } from "./helpers/fakeStore.js";
import { NO_WRITES } from "./helpers/projectWriters.js";

function controller() {
    return createTerminalController(createFakeStore(), {
        ...NO_WRITES,
        initialIds: ["first", "second"],
        columns: 80,
        rows: 30,
        changed() {},
    });
}

test("a retained terminal view follows navigation across help, resize, and removal", (t) => {
    const app = controller();
    t.after(() => app.dispose());
    const view = app.view;
    app.scrollBy(4, 20);
    app.openSession("second");
    app.scrollBy(3, 20);
    app.toggleHelp();
    app.resize(160, 30);
    app.back();

    assert.equal(view.screen, "sessions");
    assert.equal(view.selected, "second");
    assert.equal(view.focused, DETAIL_FOCUS);
    assert.equal(view.expanded, null);
    assert.equal(view.help, false);
    assert.equal(view.wide, true);
    assert.equal(view.scroll, 4);
    assert.equal(view.detailScroll, 3);

    app.stopObserving("second");
    assert.equal(view.selected, "first");
    assert.equal(view.focused, null);
    assert.equal(view.detailScroll, 0);
    app.showScreen("home");
    assert.equal(view.screen, "home");
    app.showScreen("sessions");
    assert.equal(view.scroll, 4);
});
