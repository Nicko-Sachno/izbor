export function userDirOf(env) {
    if (env.IZBOR_USER_DIR) return env.IZBOR_USER_DIR;
    if (env.LOCALAPPDATA) return `${env.LOCALAPPDATA}/izbor`;
    return `${env.HOME ?? env.USERPROFILE}/.config/izbor`;
}

const PAUSE_MS = 2000;

async function findIzbor($) {
    try {
        const dir = userDirOf({
            IZBOR_USER_DIR: await $.env.get("IZBOR_USER_DIR"),
            LOCALAPPDATA: await $.env.get("LOCALAPPDATA"),
            HOME: await $.env.get("HOME"),
            USERPROFILE: await $.env.get("USERPROFILE"),
        });
        const port = (await $.fs.read(`${dir}/port`)).trim();
        const key = (await $.fs.read(`${dir}/send-key-${port}`)).trim();
        if (/^\d+$/.test(port) && key !== "") return { port, key };
    } catch {}
    return undefined;
}

function ask($, izbor, path, init = {}) {
    return $.http.fetch(`http://127.0.0.1:${izbor.port}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${izbor.key}` },
    });
}

async function submit($, izbor, { promptId, text }) {
    let report;
    try {
        const result = await $.prompt.submit({ text, asUser: true });
        report = result.drop === undefined ? { state: "delivered" } : { state: "dropped", reason: String(result.drop) };
    } catch (error) {
        report = { state: "dropped", reason: error instanceof Error ? error.message : String(error) };
    }
    try {
        await ask($, izbor, `/prompts/${promptId}/${report.state}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(report.state === "dropped" ? { reason: report.reason } : {}),
        });
    } catch {}
}

async function poll($, izbor) {
    izbor ??= await findIzbor($);
    if (!izbor) return later($, undefined, PAUSE_MS);
    const sessionId = await $.session.id();
    let response;
    try {
        response = await ask($, izbor, `/sessions/${sessionId}/prompts/next`);
    } catch {
        return later($, undefined, PAUSE_MS);
    }
    if (response.status === 200) {
        let prompt;
        try {
            prompt = JSON.parse(response.text);
        } catch {
            return later($, undefined, PAUSE_MS);
        }
        void submit($, izbor, prompt);
        return later($, izbor, 0);
    }
    if (response.status === 204) return later($, izbor, 0);
    return later($, undefined, PAUSE_MS);
}

function later($, izbor, ms) {
    $.clock.after(ms, () => void poll($, izbor));
}

export function register(on) {
    on("session.start", ($, e, next) => {
        later($, undefined, 0);
        return next(e);
    });
}
