import { getSessionInfo, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";

/** What a session's transcript says it is about: Claude's title for it and its first prompt, each when it has one. */
export type SessionTitle = { title?: string; firstPrompt?: string };

/** Reads one session's title from its transcript, found in any project folder. A session with no transcript yet has
 *  an empty title. Rejects when the transcript cannot be read. */
export type TitleReader = (sessionId: string) => Promise<SessionTitle>;

type InfoReader = (sessionId: string) => Promise<SDKSessionInfo | undefined>;

export function createTitleReader(readInfo: InfoReader): TitleReader {
    return async (sessionId) => {
        const info = await readInfo(sessionId);
        const title = info?.customTitle?.trim();
        const firstPrompt = info?.firstPrompt?.trim();
        return {
            ...(title && { title }),
            // A slash command such as /clear says nothing about what the session is for.
            ...(firstPrompt && !firstPrompt.startsWith("/") && { firstPrompt }),
        };
    };
}

export const readSessionTitle: TitleReader = createTitleReader((sessionId) => getSessionInfo(sessionId));
