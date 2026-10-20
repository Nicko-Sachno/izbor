import { request } from "node:http";

const CONNECT_LIMIT_MS = 1_000;

const [url, limitSeconds, mode] = process.argv.slice(2);
const print = mode === "print";

const giveUp = () => process.exit(0);

process.on("uncaughtException", giveUp);
process.stdout.on("error", giveUp);
setTimeout(giveUp, Number(limitSeconds) * 1000).unref();

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("error", giveUp);
process.stdin.on("end", () => post(Buffer.concat(chunks)));

function post(body) {
    const sent = request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": body.length },
    });
    const connecting = setTimeout(() => sent.destroy(), CONNECT_LIMIT_MS);
    sent.on("socket", (socket) => socket.once("connect", () => clearTimeout(connecting)));
    sent.on("error", giveUp);
    sent.on("response", (response) => {
        clearTimeout(connecting);
        const ok = response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300;
        if (!print || !ok) return void response.resume().on("end", giveUp);
        const answer = [];
        response.on("data", (chunk) => answer.push(chunk));
        response.on("error", giveUp);
        response.on("end", () => process.stdout.write(Buffer.concat(answer)));
    });
    sent.end(body);
}
