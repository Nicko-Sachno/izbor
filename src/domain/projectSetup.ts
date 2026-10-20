export type HooksRequest = { change: "add" | "remove"; folder: string; port: number };

export type SettingsChange<Done extends string> =
    | { done: Done; checkout: string; file: string }
    | { refused: "no folder"; folder: string }
    | { refused: "no access"; folder: string; why: string }
    | { refused: "home folder" }
    | { refused: "link"; checkout: string; file: string; link: string }
    | { refused: "settings" | "write"; checkout: string; file: string; why: string };

export type HooksChange = SettingsChange<"added" | "already" | "removed" | "none">;

export type HooksWriter = (request: HooksRequest) => HooksChange;

type ActingDone = "added" | "updated" | "already" | "removed" | "none";

export type ActingChange = SettingsChange<ActingDone> | { refused: "plugin"; checkout: string; why: string };

export type ActingWriter = (request: HooksRequest) => Promise<ActingChange>;

export type ProjectSetup = {
    changeHooks: HooksWriter;
    changeActing: ActingWriter;
    isActing(checkout: string, port: number): boolean;
};
