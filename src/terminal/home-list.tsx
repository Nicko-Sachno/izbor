import type { Ref } from "react";
import { Box, type DOMElement } from "ink";
import stringWidth from "string-width";
import { BADGE, Badge, Copy, Mark, Spans, type Span } from "./copy.js";
import { projectFocus } from "./focus.js";
import { waitStart, type Observation, type RunningSession } from "./model.js";
import { projectAct, type Project } from "./projects.js";
import { blinkShown, clip, sessionName, singleLine, STATUS } from "./presentation.js";

function listStatus({ status }: RunningSession): string {
    if (status === undefined) return STATUS.unknown;
    return Object.hasOwn(STATUS, status) ? STATUS[status as keyof typeof STATUS] : status;
}

const CUES = { "add hooks": "Add hooks ›", "add plugin": "Add plugin · answer from Izbor ›" } as const;

const LATE = "Briefs update late";

function ProjectLine({
    project,
    focused,
    width,
    color,
    ref,
}: {
    project: Project;
    focused: string | null;
    width: number;
    color: boolean;
    ref: Ref<DOMElement>;
}) {
    const focus = projectFocus(project.checkout);
    const act = projectAct(project);
    const tail = project.hooks ? "" : ` · ${LATE}`;
    const cue = act ? CUES[act] : "";
    const fits = (withTail: string, withCue: string) =>
        3 + stringWidth(project.name + withTail) + (withCue ? 1 + stringWidth(withCue) : 0) <= width;
    const shownTail = fits(tail, cue) ? tail : "";
    const shownCue = fits(shownTail, cue) ? cue : cue && "›";
    const textWidth = Math.max(0, width - 3 - (shownCue ? stringWidth(shownCue) + 1 : 0));
    const words: Span[] = [{ text: project.name, tone: focused === focus ? "focus" : "text", bold: true }];
    if (shownTail) words.push({ text: " · ", tone: "muted" }, { text: LATE, tone: "notice" });
    return (
        <Box ref={shownCue ? undefined : ref} width={width} flexShrink={0} paddingLeft={3}>
            <Box width={textWidth} flexShrink={0}>
                <Spans color={color} spans={words} />
            </Box>
            {shownCue ? (
                <Box ref={ref} marginLeft={1} flexShrink={0}>
                    <Copy color={color} tone="focus" underline>
                        {shownCue}
                    </Copy>
                </Box>
            ) : null}
        </Box>
    );
}

type Piece = Span | "badge";

const cellsOf = (pieces: readonly Piece[]) =>
    pieces.reduce((cells, piece) => cells + (piece === "badge" ? BADGE.length : stringWidth(piece.text)), 2);

function sessionPieces(
    session: RunningSession,
    { focused, observed, width }: { focused: boolean; observed: boolean; width: number },
): Piece[] {
    const name = sessionName(session);
    const waiting = session.status === "waiting";
    const wait = waiting ? singleLine(session.waitingFor ?? "") : "";
    const worktree = singleLine(session.worktree ?? "");
    const status: Piece[] = waiting ? ["badge"] : [{ text: singleLine(listStatus(session)), tone: "muted" }];
    const cueWord = observed ? "Open ›" : focused ? "Observe ›" : "";
    const cue: Piece[] = cueWord
        ? [
              { text: " · ", tone: "muted" },
              { text: cueWord, tone: focused ? "focus" : "muted", underline: true },
          ]
        : [];
    const line = (shownName: string, withWait: boolean, withWorktree: boolean): Piece[] => [
        { text: "   " },
        { text: shownName, tone: focused ? "focus" : "text", bold: focused },
        { text: " · ", tone: "muted" },
        ...status,
        ...(withWait && wait ? [{ text: ` ${wait}` }] : []),
        ...(withWorktree && worktree ? [{ text: ` · worktree ${worktree}`, tone: "muted" as const }] : []),
        ...cue,
    ];
    const bare = (shownName: string) => line(shownName, false, false);
    const fitting = [line(name, true, true), line(name, true, false), bare(name)].find(
        (pieces) => cellsOf(pieces) <= width,
    );
    return fitting ?? bare(clip(name, Math.max(1, width - cellsOf(bare("")))));
}

function SessionLine({
    session,
    focused,
    row,
    width,
    color,
    now,
    ref,
}: {
    session: RunningSession;
    focused: boolean;
    row: Observation | undefined;
    width: number;
    color: boolean;
    now: Date;
    ref: Ref<DOMElement>;
}) {
    const observed = row !== undefined;
    const since = waitStart(row?.brief) ?? session.waitingSince;
    const mark = session.status === "waiting" && blinkShown(since, now) ? "needsYou" : undefined;
    return (
        <Box ref={ref} width={width} flexShrink={0} paddingLeft={1}>
            <Mark glyph={mark} color={color} />
            {sessionPieces(session, { focused, observed, width }).map((piece, index) =>
                piece === "badge" ? (
                    <Badge key={index} color={color} />
                ) : (
                    <Copy key={index} color={color} tone={piece.tone} bold={piece.bold} underline={piece.underline}>
                        {piece.text}
                    </Copy>
                ),
            )}
        </Box>
    );
}

type ProjectGroupProps = {
    project: Project;
    focused: string | null;
    rows: readonly Observation[];
    width: number;
    color: boolean;
    now: Date;
    lineRef: (focus: string) => Ref<DOMElement>;
};

export function ProjectGroup({ project, focused, rows, width, color, now, lineRef }: ProjectGroupProps) {
    return (
        <Box flexDirection="column" flexShrink={0}>
            <ProjectLine
                project={project}
                focused={focused}
                width={width}
                color={color}
                ref={lineRef(projectFocus(project.checkout))}
            />
            {project.sessions.map((session) => (
                <SessionLine
                    key={session.id}
                    session={session}
                    focused={focused === session.id}
                    row={rows.find(({ id }) => id === session.id)}
                    width={width}
                    color={color}
                    now={now}
                    ref={lineRef(session.id)}
                />
            ))}
        </Box>
    );
}
