type EndTurn = () => void;

export type TakeTurn = (signal: AbortSignal) => Promise<EndTurn | null>;

export type SummaryTurns = {
    take: TakeTurn;
};

export function createSummaryTurns(): SummaryTurns {
    const waiting: (() => void)[] = [];
    let taken = false;

    function passOn(): void {
        const next = waiting.shift();
        if (next) next();
        else taken = false;
    }

    const take: TakeTurn = (signal) =>
        new Promise((resolve) => {
            if (signal.aborted) return resolve(null);
            const give = () => {
                signal.removeEventListener("abort", leave);
                taken = true;
                let ended = false;
                resolve(() => {
                    if (ended) return;
                    ended = true;
                    passOn();
                });
            };
            const leave = () => {
                waiting.splice(waiting.indexOf(give), 1);
                resolve(null);
            };
            if (!taken) return give();
            waiting.push(give);
            signal.addEventListener("abort", leave, { once: true });
        });

    return { take };
}
