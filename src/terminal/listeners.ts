export type Listeners = {
    on(changed: () => void): () => void;
    emit(): void;
    close(): void;
};

export function createListeners(): Listeners {
    const callbacks = new Set<() => void>();
    let closed = false;
    return {
        on(changed) {
            if (closed) return () => {};
            const callback = () => changed();
            callbacks.add(callback);
            return () => callbacks.delete(callback);
        },
        emit() {
            for (const changed of [...callbacks]) changed();
        },
        close() {
            closed = true;
            callbacks.clear();
        },
    };
}
