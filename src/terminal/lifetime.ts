export async function duringLifetime<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let aborted = () => {};
    const cancellation = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
    });
    try {
        const value = await Promise.race([work(), cancellation]);
        signal.throwIfAborted();
        return value;
    } finally {
        signal.removeEventListener("abort", aborted);
    }
}
