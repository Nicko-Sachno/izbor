import assert from "node:assert/strict";
import { type IncomingMessage, request } from "node:http";

export const FORBIDDEN_HOST = {
    error: "forbidden",
    message: "Izbor answers only requests addressed to 127.0.0.1 or localhost",
};

export const FORBIDDEN_SITE = {
    error: "forbidden",
    message: "Izbor refuses requests a browser sends for another website",
};

export async function assertJson(response: Response, status: number, body: unknown, message?: string) {
    assert.equal(response.status, status, message);
    assert.equal(response.headers.get("content-type"), "application/json", message);
    assert.deepEqual(await response.json(), body, message);
}

function toResponse(res: IncomingMessage) {
    return new Promise<Response>((resolve) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(name, value);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(new Response(body, { status: res.statusCode, headers })));
    });
}

// A POST whose body arrives in two writes 50 ms apart; `between` runs before the second.
export function postInTwoPieces(
    url: string,
    first: Buffer | string,
    second: Buffer | string,
    between = () => {},
    headers: Record<string, string> = {},
) {
    return new Promise<Response>((resolve, reject) => {
        const req = request(url, { method: "POST", headers }, (res) => resolve(toResponse(res)));
        req.on("error", reject);
        req.write(first);
        setTimeout(() => {
            between();
            req.end(second);
        }, 50);
    });
}

export function withHost(base: string, method: string, path: string, host: string, body?: string) {
    return new Promise<Response>((resolve, reject) => {
        const req = request(`${base}${path}`, { method, headers: { host } }, (res) => resolve(toResponse(res)));
        req.on("error", reject);
        req.end(body);
    });
}
