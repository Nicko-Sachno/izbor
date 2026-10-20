export type PluginResponse = { status: number; ok: boolean; headers: Record<string, string>; text: string };

export type PluginSubmitResult = { text: string; drop?: undefined } | { drop: string };

export type PluginEngine = {
    env: { get: (name: string) => Promise<string | undefined> };
    fs: { read: (path: string) => Promise<string> };
    http: {
        fetch: (
            url: string,
            init?: { method?: string; headers?: Record<string, string>; body?: string },
        ) => Promise<PluginResponse>;
    };
    session: { id: () => Promise<string> };
    clock: { after: (ms: number, fn: () => void) => { cancel: () => void } };
    prompt: { submit: (args: { text: string; asUser: true }) => Promise<PluginSubmitResult> };
};

export type SessionStartHook = (
    $: PluginEngine,
    e: { cwd: string },
    next: (e: { cwd: string }) => Promise<unknown>,
) => Promise<unknown>;

export type On = (event: "session.start", hook: SessionStartHook) => void;

export function userDirOf(env: Record<string, string | undefined>): string;

export function register(on: On): void;
