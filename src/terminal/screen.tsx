import { useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Box, measureElement, useCursor, type DOMElement, type CursorPosition } from "ink";
import {
    listedSessions,
    unknownLine,
    unseenWait,
    waitStart,
    type Connection,
    type HitTarget,
    type Observation,
    type IzborState,
    type Rectangle,
    type SessionList,
    type TerminalBrief,
    type TerminalSize,
    type TerminalView,
    type ViewportLayout,
} from "./model.js";
import { shortId } from "../domain/text.js";
import { projectsOf } from "./projects.js";
import {
    blinkShown,
    clip,
    commandWindow,
    fullTime,
    relativeTime,
    STATUS,
    topLine,
    wrapCut,
    wrapLines,
    wrapText,
    type Tone,
    type Words,
} from "./presentation.js";
import { Badge, Copy, feedbackText, FeedbackLine, Mark, Spans, type Glyph, type Span } from "./copy.js";
import { Help } from "./help-page.js";
import { ProjectGroup } from "./home-list.js";
import {
    acts,
    closingLines,
    fieldTitle,
    hooked,
    placeholderOn,
    shownMessage,
    shownMode,
    type BriefLine,
} from "./field.js";
import { DETAIL_FOCUS, FIELD_FOCUS, focusedCheckout, HELP_FOCUS } from "./focus.js";
import { inputLayout, terminalLayout } from "./layout.js";
import { sameScrollLayout, viewportLayout, type MeasuredTarget, type ViewportHistory } from "./viewport.js";

export function contains(rect: Rectangle, x: number, y: number): boolean {
    return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

const kept = (elements: RefObject<Map<string, DOMElement>>, key: string) => (element: DOMElement | null) => {
    if (element) elements.current.set(key, element);
    else elements.current.delete(key);
};

type ScreenProps = {
    view: Readonly<TerminalView>;
    size: TerminalSize;
    color: boolean;
    now?: Date;
    onLayout?: (layout: ViewportLayout) => void;
};

const CATCHING_UP = "Catching up…";
type ConnectionIn<State extends Connection["state"]> = Extract<Connection, { state: State }>;
const STOPPED: Record<ConnectionIn<"stopped">["why"], string> = {
    deleted: "Stopped · a client stopped Izbor's watch of this session",
    "izbor stopping": "Stopped · Izbor stopped",
};
const AWAY: Record<ConnectionIn<"izbor away">["reason"], string> = {
    "not running": "Izbor is not running",
    stopping: "Izbor is stopping",
};

function countdown(words: string, retryAt: string | undefined, now: Date): string {
    const seconds = retryAt === undefined ? 0 : Math.ceil((Date.parse(retryAt) - now.getTime()) / 1000);
    return seconds > 0 ? ` · ${words} in ${seconds} s` : "";
}

const CONNECTION_LABELS: {
    [State in Connection["state"]]: (connection: ConnectionIn<State>, now: Date) => string;
} = {
    connecting: () => CATCHING_UP,
    "catching up": () => CATCHING_UP,
    live: () => "",
    stopped: ({ why }) => STOPPED[why],
    disconnected: ({ retryAt }, now) => `Disconnected${countdown("retrying", retryAt, now)}`,
    "izbor away": ({ reason, retryAt }, now) => `${AWAY[reason]}${countdown("retrying", retryAt, now)}`,
    refused: ({ status, message }) => `Izbor refused · ${status} · ${message}`,
};

function izborDown({ state }: IzborState): boolean {
    return state === "not running" || state === "stopping" || state === "not answering";
}

function connectionNotice({ brief, connection }: Observation, now: Date): string {
    const label = (CONNECTION_LABELS[connection.state] as (connection: Connection, now: Date) => string)(
        connection,
        now,
    );
    if (!brief) return `▲ ${label || CATCHING_UP}`;
    return label && `▲ ${label} · last known Brief`;
}

const ROW_CAUSES: { [State in Connection["state"]]: (connection: ConnectionIn<State>) => string } = {
    connecting: () => CATCHING_UP,
    "catching up": () => CATCHING_UP,
    live: () => "",
    stopped: ({ why }) => (why === "deleted" ? "Stopped" : ""),
    disconnected: () => "Disconnected",
    "izbor away": () => "",
    refused: ({ status, message }) => `Izbor refused · ${status} · ${message}`,
};

function rowNotice({ brief, connection }: Observation, down: boolean): string {
    const cause = down ? "" : (ROW_CAUSES[connection.state] as (connection: Connection) => string)(connection);
    if (!brief) return `▲ ${cause || CATCHING_UP}`;
    if (connection.state === "live") return "";
    return cause ? `▲ ${cause} · last known Brief` : "▲ last known Brief";
}

function rowGlyph(brief: TerminalBrief | null, notice: string, at: Date): Glyph | undefined {
    if (brief?.status === "waiting") return blinkShown(waitStart(brief), at) ? "needsYou" : undefined;
    if (!brief || notice) return "notice";
    return brief.status === "busy" ? "working" : brief.status === "idle" ? "idle" : "unknown";
}

function clockTime(at: string): string {
    const time = new Date(at);
    return [time.getHours(), time.getMinutes(), time.getSeconds()]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
}

function gapText({ gap }: Observation): string | undefined {
    return gap && `▲ Izbor did not observe this session between ${clockTime(gap.from)} and ${clockTime(gap.to)}`;
}

function listNotice(list: SessionList): Words | undefined {
    if (list.state === "loading") return { text: "Looking for running Claude Code sessions…", tone: "muted" };
    if (list.state === "no list") return { text: `▲ No list: ${list.reason}`, tone: "notice" };
    if (!list.sessions.length) return { text: "No Claude Code session runs. Start one with claude.", tone: "muted" };
    return undefined;
}

export function explanationUnknown(reason: string | undefined): Words | undefined {
    return reason ? { text: `Explanation unknown · ${reason}`, tone: "muted" } : undefined;
}

function rowStatus(brief: TerminalBrief | null, notice: string, columns: number): Span[] {
    if (!brief) return [{ text: clip(notice, columns), tone: "notice" }];
    const word = STATUS[brief.status];
    if (!notice) return [{ text: word, tone: "muted" }];
    return [
        { text: `${word} · `, tone: "muted" },
        { text: clip(notice, columns - word.length - 3), tone: "notice" },
    ];
}

function rowNow(brief: TerminalBrief, columns: number, noticed: boolean): Words | undefined {
    if (!brief.explanation) {
        const unknown = explanationUnknown(brief.explanationUnknownReason);
        return unknown && { ...unknown, text: clip(unknown.text, columns) };
    }
    const { text, outdatedReason } = brief.explanation;
    if (!outdatedReason) return { text: wrapCut(text, columns, 3), tone: noticed ? "muted" : "reply" };
    const tail = ` · outdated: ${outdatedReason}`;
    return { text: (wrapCut(text, columns, 3, tail.length) + tail).replace("\n ·", "\n·"), tone: "muted" };
}

function rowRequest(brief: TerminalBrief | null): string {
    if (brief?.status !== "waiting" || brief.needsYou.state === "nothing") return "";
    return brief.needsYou.state === "request" ? brief.needsYou.text : unknownLine(brief.needsYou);
}

type SessionRowProps = {
    session: Observation;
    marked: boolean;
    selected: boolean;
    cueShown: boolean;
    width: number;
    color: boolean;
    at: Date;
    down: boolean;
    ref: Ref<DOMElement>;
};

function SessionRow({ session, marked, selected, cueShown, width, color, at, down, ref }: SessionRowProps) {
    const { brief } = session;
    const notice = rowNotice(session, down);
    const gap = gapText(session);
    const title = brief ? (brief.task?.text ?? "Task unknown") : shortId(session.id);
    const cue = marked && cueShown ? "Open ›" : "";
    const textWidth = width - 3;
    const nowLine = brief && rowNow(brief, textWidth, Boolean(notice));
    const request = rowRequest(brief);
    const titleWidth = Math.max(0, textWidth - (cue ? cue.length + 1 : 0));
    return (
        <Box ref={ref} width={width} flexDirection="column" flexShrink={0}>
            <Box flexShrink={0} paddingLeft={1}>
                <Mark glyph={rowGlyph(brief, notice, at)} color={color} />
                <Box width={titleWidth} flexShrink={0} marginLeft={1}>
                    <Copy color={color} tone={marked ? "focus" : brief && !brief.task ? "muted" : "text"} bold={marked}>
                        {wrapCut(`${!color && selected ? "Selected · " : ""}${title}`, titleWidth, 3)}
                    </Copy>
                </Box>
                {cue ? (
                    <Box marginLeft={1} flexShrink={0}>
                        <Copy color={color} tone="focus" underline>
                            {cue}
                        </Copy>
                    </Box>
                ) : null}
            </Box>
            <Box flexDirection="column" paddingLeft={3}>
                <Spans color={color} spans={rowStatus(brief, notice, textWidth)} />
                {nowLine && (
                    <Copy color={color} tone={nowLine.tone}>
                        {nowLine.text}
                    </Copy>
                )}
                {gap && (
                    <Copy color={color} tone="notice">
                        {wrapText(gap, textWidth)}
                    </Copy>
                )}
                {request ? (
                    <>
                        <Badge color={color} />
                        <Box paddingLeft={1}>
                            <Copy color={color} tone="needsYou" bold>
                                {clip(request, textWidth - 1)}
                            </Copy>
                        </Box>
                    </>
                ) : null}
            </Box>
        </Box>
    );
}

function SessionHeading({
    session: { id, brief },
    focused = false,
    width,
    color,
}: {
    session: Observation;
    focused?: boolean;
    width: number;
    color: boolean;
}) {
    const title = headingTitle({ id, brief }, width);
    return (
        <Spans
            color={color}
            spans={[{ text: title, tone: brief && !brief.task ? "muted" : "text", underline: focused }]}
        />
    );
}

function headingTitle({ id, brief }: Pick<Observation, "id" | "brief">, width: number): string {
    if (!brief) return shortId(id);
    return wrapCut(brief.task?.text ?? "Task unknown", width, 3).replace(/ …$/, "…");
}

function openTitle(page: Observation | undefined, side: Observation | undefined, width: number, detailWidth: number) {
    return page ? headingTitle(page, width - 12) : side ? headingTitle(side, detailWidth - 10) : "";
}

const rowsOf = (text: string) => text.split("\n").length;

function ClosingLines({ lines, color, width }: { lines: readonly BriefLine[]; color: boolean; width: number }) {
    return lines.map(({ text, tone }) => (
        <Copy key={text} color={color} tone={tone} bold={tone === "error"}>
            {wrapText(text, width)}
        </Copy>
    ));
}

const LATE_BRIEF = "Briefs update late: this project has no hooks";

type FullBriefProps = {
    session: Observation;
    color: boolean;
    now: Date;
    width: number;
    late: boolean;
    metadataExpanded: boolean;
    closing: readonly BriefLine[];
    stopRef: Ref<DOMElement>;
    taskCut: boolean;
};

function FullBrief({ session, color, now, width, late, metadataExpanded, closing, stopRef, taskCut }: FullBriefProps) {
    const { brief } = session;
    const line = (text: string, tone: Tone = "text", bold = false) => (
        <Copy color={color} tone={tone} bold={bold}>
            {wrapLines(text, width)}
        </Copy>
    );
    const field = (name: string, children: ReactNode) => (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
            <Copy color={color} tone="muted">
                {name}
            </Copy>
            {children}
        </Box>
    );
    const notice = connectionNotice(session, now);
    const gap = gapText(session);
    const unknown = explanationUnknown(brief?.explanationUnknownReason);
    const task = brief?.task?.text ?? "Unknown";
    const nowTone = notice || brief?.explanation?.outdatedReason ? "muted" : "reply";
    const latest = brief?.status === "busy" && brief.needsYou.state === "nothing" && brief.latestActivity?.text;
    const asked = brief?.needsYou.state === "request" ? brief.needsYou : undefined;
    const wait = brief?.needsYou.state === "unknown" && unseenWait(brief) ? brief.needsYou : undefined;
    const request = asked?.text ?? (wait ? unknownLine(wait) : rowRequest(brief));
    return (
        <Box width={width} flexDirection="column" flexShrink={0}>
            {notice && line(notice, "notice")}
            {brief?.statusDetail ? line(brief.statusDetail, "muted") : null}
            {late ? line(LATE_BRIEF, "notice") : null}
            {brief && (
                <>
                    {brief.explanation
                        ? field(
                              "Now",
                              <>
                                  {brief.explanation.outdatedReason &&
                                      line(`Outdated: ${brief.explanation.outdatedReason}`, "muted")}
                                  {line(brief.explanation.text, nowTone)}
                              </>,
                          )
                        : unknown && field("Now", line(unknown.text, unknown.tone))}
                    {latest ? line(`Latest: ${latest}`, "muted") : null}
                    {request && (
                        <Box flexDirection="column" marginTop={1} flexShrink={0}>
                            <Badge color={color} />
                            {line(request, "needsYou", true)}
                            {asked?.detail && asked.detail !== asked.text && line(asked.detail)}
                            <ClosingLines lines={closing} color={color} width={width} />
                        </Box>
                    )}
                    {gap && line(gap, "notice")}
                    {line(
                        `Last change ${brief.lastObserved ? relativeTime(brief.lastObserved.at, now) : "unknown"}`,
                        "muted",
                    )}
                </>
            )}
            <Box ref={stopRef} marginTop={1} width={18} flexShrink={0}>
                <Copy color={color} tone="focus" underline>
                    s · Stop observing
                </Copy>
            </Box>
            {metadataExpanded && (
                <>
                    {field("Session ID", line(session.id, "muted"))}
                    {brief && (
                        <>
                            {taskCut && field("Task", line(task, "muted"))}
                            {field(
                                "Task source",
                                line(
                                    brief.task
                                        ? `From ${brief.task.from} · ${fullTime(brief.task.at, now)}`
                                        : "Unknown",
                                    "muted",
                                ),
                            )}
                            {field(
                                "Explanation requested",
                                line(brief.explanation ? fullTime(brief.explanation.at, now) : "Unknown", "muted"),
                            )}
                            {field(
                                "Latest activity at",
                                line(
                                    brief.latestActivity ? fullTime(brief.latestActivity.at, now) : "Unknown",
                                    "muted",
                                ),
                            )}
                            {field(
                                "Last observed",
                                line(
                                    brief.lastObserved
                                        ? `${fullTime(brief.lastObserved.at, now)} · From ${brief.lastObserved.from}`
                                        : "Unknown",
                                    "muted",
                                ),
                            )}
                        </>
                    )}
                </>
            )}
        </Box>
    );
}

const SEND = "Send →";

function Divider({ color, rows }: { color: boolean; rows: number }) {
    return (
        <Box marginLeft={2} width={1} height={rows} flexShrink={0}>
            <Copy color={color} tone="border">
                {"│\n".repeat(rows - 1) + "│"}
            </Copy>
        </Box>
    );
}

function SideBrief({
    session,
    color,
    width,
    paneRows,
    rows,
    focused,
    scroll,
    paneRef,
    viewportRef,
    contentRef,
    hideRef,
    field,
    children,
}: {
    session: Observation;
    color: boolean;
    width: number;
    paneRows: number;
    rows: number;
    focused: boolean;
    scroll: number;
    paneRef: Ref<DOMElement>;
    viewportRef: Ref<DOMElement>;
    contentRef: Ref<DOMElement>;
    hideRef: Ref<DOMElement>;
    field: ReactNode;
    children: ReactNode;
}) {
    return (
        <>
            <Divider color={color} rows={paneRows} />
            <Box ref={paneRef} marginLeft={2} width={width} height={paneRows} flexDirection="column" flexShrink={0}>
                <Box flexShrink={0} justifyContent="space-between">
                    <SessionHeading session={session} focused={focused} width={width - 10} color={color} />
                    <Box ref={hideRef} marginLeft={2} width={8} height={1} flexShrink={0}>
                        <Copy color={color} tone="focus" underline>
                            Hide · h
                        </Copy>
                    </Box>
                </Box>
                <Box
                    ref={viewportRef}
                    height={rows}
                    flexDirection="column"
                    flexShrink={0}
                    overflow="hidden"
                    contentOffsetY={scroll}
                >
                    <Box ref={contentRef} width={Math.min(82, width)} flexDirection="column" flexShrink={0}>
                        {children}
                    </Box>
                </Box>
                {field}
            </Box>
        </>
    );
}

type FieldBoxProps = {
    color: boolean;
    width: number;
    tone: Tone;
    title: string;
    text: string;
    empty: boolean;
    placeholder: string;
    submitLabel: string;
    boxRef: Ref<DOMElement>;
    contentRef: Ref<DOMElement>;
    submitRef: Ref<DOMElement>;
};

function FieldBox({
    color,
    width,
    tone,
    title,
    text,
    empty,
    placeholder,
    submitLabel,
    boxRef,
    contentRef,
    submitRef,
}: FieldBoxProps) {
    const { submit, inputWidth } = inputLayout(width, submitLabel);
    return (
        <Box ref={boxRef} height={3} flexShrink={0} flexDirection="column">
            <Copy color={color} tone={tone}>
                {`┌${title}${"─".repeat(Math.max(0, width - 2 - title.length))}┐`}
            </Copy>
            <Box height={1} flexShrink={0}>
                <Copy color={color} tone={tone}>
                    │{" "}
                </Copy>
                <Copy color={color} tone="focus">
                    ›{" "}
                </Copy>
                <Box ref={contentRef} width={inputWidth} flexShrink={0} overflow="hidden">
                    <Copy color={color} tone={empty ? "muted" : "text"}>
                        {empty ? clip(placeholder, inputWidth) : text}
                    </Copy>
                </Box>
                {submit && (
                    <Box marginLeft={1} ref={submitRef} width={submitLabel.length} flexShrink={0}>
                        <Copy color={color} tone="focus" underline>
                            {submitLabel}
                        </Copy>
                    </Box>
                )}
                <Copy color={color} tone={tone}>
                    {" "}
                    │
                </Copy>
            </Box>
            <Copy color={color} tone={tone}>{`└${"─".repeat(Math.max(0, width - 2))}┘`}</Copy>
        </Box>
    );
}

function SideField({ box, line }: { box: FieldBoxProps | undefined; line: ReactNode }) {
    return (
        <Box flexDirection="column" flexShrink={0}>
            <Box minHeight={box ? 1 : 0} flexShrink={0}>
                {line}
            </Box>
            {box ? <FieldBox {...box} /> : null}
        </Box>
    );
}

const HELP_LABEL = "Help · Ctrl-G";
const CLOSE_LABEL = "Close · Ctrl-G";

function LastLine({
    color,
    width,
    label,
    helpFocused,
    helpRef,
}: {
    color: boolean;
    width: number;
    label: string;
    helpFocused: boolean;
    helpRef: Ref<DOMElement>;
}) {
    return (
        <Box width={width} height={1} flexShrink={0} justifyContent="flex-end">
            <Box ref={helpRef} width={label.length} flexShrink={0}>
                <Copy color={color} tone="focus" underline bold={helpFocused}>
                    {label}
                </Copy>
            </Box>
        </Box>
    );
}

export function TerminalScreen({ view, size, color, now = new Date(), onLayout }: ScreenProps) {
    const selectedSession = view.sessions.find(({ id }) => id === view.selected);
    const listMessage = listNotice(view.list);
    const projects = projectsOf(listedSessions(view.list), view.home);
    const home = view.screen === "home";
    const tabLabels = {
        home: home ? "Home" : "[ Home ]",
        sessions: home ? `[ Sessions · ${view.sessions.length} ]` : `Sessions · ${view.sessions.length}`,
    };
    const geometry = terminalLayout(
        size.columns,
        size.rows,
        !home && !view.briefHidden && !view.help && !!selectedSession,
    );
    const { columns, rows, inset, available, width, detailWidth, wide, small, tight } = geometry;
    const { corner, state: izbor } = topLine(view.izbor, view.oldBuild, available);
    const expanded = view.wide ? undefined : view.sessions.find(({ id }) => id === view.expanded);
    const showDetail = !home && wide && !view.help && Boolean(selectedSession);
    const markedId = !showDetail && view.sessions.some(({ id }) => id === view.focused) ? view.focused : view.selected;
    const title = openTitle(expanded, showDetail ? selectedSession : undefined, width, detailWidth);
    const fieldSession = view.help ? undefined : showDetail ? selectedSession : expanded;
    const mode =
        fieldSession && hooked(fieldSession.id, view.list) ? shownMode(view.field, fieldSession.brief) : undefined;
    const closing = fieldSession && mode ? closingLines(fieldSession, acts(fieldSession.id, view.list), now) : [];
    const fieldFocused = view.focused === FIELD_FOCUS;
    const fieldWidth = showDetail ? detailWidth : width;
    const fieldInput = commandWindow(view.field.text, view.field.cursor, inputLayout(fieldWidth, SEND).inputWidth);
    const pageField = mode !== undefined && !showDetail;
    const topGap = expanded || view.help ? 0 : 1;
    const shown = shownMessage(view, mode ? fieldSession : undefined);
    const shownWidth = showDetail ? detailWidth : width;
    const shownRows = shown ? feedbackText(shown, shownWidth).split("\n").length : 0;
    const extraRows = showDetail ? 0 : Math.max(0, shownRows - 1);
    const pageRows = (expanded && !view.help ? rowsOf(title) - 1 : 0) + (pageField ? 3 : 0);
    const bodyRows = Math.max(0, geometry.bodyRows - topGap - pageRows - extraRows);
    const paneRows = geometry.bodyRows + 2;
    const detailRows = Math.max(0, paneRows - rowsOf(title) - (mode ? 3 + Math.max(1, shownRows) : shownRows));
    const fullBrief = (session: Observation, paneWidth: number, stopRef: Ref<DOMElement>) => (
        <FullBrief
            session={session}
            color={color}
            now={now}
            width={Math.min(82, paneWidth)}
            late={!hooked(session.id, view.list)}
            metadataExpanded={view.metadataExpanded}
            closing={closing}
            stopRef={stopRef}
            taskCut={title.endsWith("…")}
        />
    );
    const shownLine = <FeedbackLine line={shown} width={shownWidth} color={color} />;
    const content = useRef<DOMElement>(null);
    const viewport = useRef<DOMElement>(null);
    const detailPane = useRef<DOMElement>(null);
    const detailContent = useRef<DOMElement>(null);
    const detailViewport = useRef<DOMElement>(null);
    const sessionElements = useRef(new Map<string, DOMElement>());
    const lineElements = useRef(new Map<string, DOMElement>());
    const lineRef = (focus: string) =>
        kept(focusedCheckout(focus) !== undefined ? lineElements : sessionElements, focus);
    const backControl = useRef<DOMElement>(null);
    const helpControl = useRef<DOMElement>(null);
    const stopControl = useRef<DOMElement>(null);
    const detailStopControl = useRef<DOMElement>(null);
    const hideControl = useRef<DOMElement>(null);
    const homeTab = useRef<DOMElement>(null);
    const sessionsTab = useRef<DOMElement>(null);
    const fieldFrame = useRef<DOMElement>(null);
    const fieldContent = useRef<DOMElement>(null);
    const sendControl = useRef<DOMElement>(null);
    const [fieldOrigin, setFieldOrigin] = useState<CursorPosition>();
    const viewportHistory = useRef<ViewportHistory>(undefined);
    const [layout, setLayout] = useState<ViewportLayout>({
        maxScroll: 0,
        pageSize: bodyRows,
        scroll: 0,
    });
    useLayoutEffect(() => {
        if (small) {
            onLayout?.({ maxScroll: 0, pageSize: 0, scroll: view.scroll, targets: [] });
            return;
        }
        if (fieldContent.current) {
            const { x, y } = measureElement(fieldContent.current);
            if (fieldOrigin?.x !== x || fieldOrigin.y !== y) setFieldOrigin({ x, y });
        }
        if (!content.current) return;
        const selected =
            view.focused !== null
                ? (lineElements.current.get(view.focused) ?? sessionElements.current.get(view.focused))
                : undefined;
        const targets: MeasuredTarget[] = [];
        const target = (target: HitTarget, pane?: "main" | "detail") =>
            targets.push(pane ? { target, pane } : { target });
        const viewportRect = viewport.current ? measureElement(viewport.current) : undefined;
        if (!expanded && !view.help && viewportRect) {
            for (const [id, element] of sessionElements.current) {
                target({ type: "session", id, rect: measureElement(element) }, "main");
            }
            for (const [focus, element] of lineElements.current) {
                const checkout = focusedCheckout(focus);
                if (checkout !== undefined)
                    target({ type: "project", checkout, rect: measureElement(element) }, "main");
            }
        }
        if (backControl.current) target({ type: "back", rect: measureElement(backControl.current) });
        if (homeTab.current) target({ type: "tab", screen: "home", rect: measureElement(homeTab.current) });
        if (sessionsTab.current) target({ type: "tab", screen: "sessions", rect: measureElement(sessionsTab.current) });
        if (helpControl.current) target({ type: "help", rect: measureElement(helpControl.current) });
        if (sendControl.current) target({ type: "send", rect: measureElement(sendControl.current) });
        if (fieldFrame.current && fieldContent.current) {
            target({
                type: "field",
                rect: measureElement(fieldFrame.current),
                origin: measureElement(fieldContent.current).x,
                indices: fieldInput.indices,
            });
        }
        if (expanded && !view.help && stopControl.current) {
            target({ type: "stop", id: expanded.id, rect: measureElement(stopControl.current) }, "main");
        }
        if (hideControl.current) target({ type: "hide", rect: measureElement(hideControl.current) });
        let detail;
        if (showDetail && detailContent.current && detailViewport.current) {
            detail = {
                content: measureElement(detailContent.current),
                pageSize: detailRows,
                scroll: view.detailScroll,
                viewport: measureElement(detailViewport.current),
            };
            if (detailStopControl.current && selectedSession)
                target(
                    { type: "stop", id: selectedSession.id, rect: measureElement(detailStopControl.current) },
                    "detail",
                );
            if (detailPane.current) target({ type: "detail", rect: measureElement(detailPane.current) });
        }
        const result = viewportLayout(
            {
                page: view.help
                    ? { kind: "help" }
                    : expanded
                      ? { kind: "brief", id: expanded.id }
                      : { kind: "overview", screen: view.screen },
                size,
                focused: view.focused,
                focus: selected && measureElement(selected),
                main: {
                    content: measureElement(content.current),
                    viewport: viewportRect,
                    pageSize: bodyRows,
                    scroll: view.scroll,
                },
                detail,
                targets,
            },
            viewportHistory.current,
        );
        const next = result.layout;
        viewportHistory.current = result.history;
        if (!sameScrollLayout(layout, next)) setLayout(next);
        onLayout?.(next);
    });

    const { setCursorPosition } = useCursor();
    setCursorPosition(
        !small && fieldFocused && fieldOrigin ? { x: fieldOrigin.x + fieldInput.cursor, y: fieldOrigin.y } : undefined,
    );
    const fieldBox = mode && {
        color,
        width: fieldWidth,
        tone: (fieldFocused ? "focus" : "border") as Tone,
        title: `─ ${fieldTitle(mode)} `,
        text: fieldInput.text,
        empty: !view.field.text,
        placeholder: placeholderOn(mode, fieldSession, view.list, closing.length > 0),
        submitLabel: SEND,
        boxRef: fieldFrame,
        contentRef: fieldContent,
        submitRef: sendControl,
    };
    const sideField = showDetail ? <SideField box={fieldBox} line={shownLine} /> : undefined;
    if (small) {
        return (
            <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
                <Copy color={color} tone="focus">
                    {clip("izbor · window too small", columns)}
                </Copy>
                <Copy color={color}>{clip("Resize terminal to at least 40 × 12", columns)}</Copy>
                <Copy color={color} tone="muted">
                    {clip("Your view is preserved. Ctrl-C quits.", columns)}
                </Copy>
            </Box>
        );
    }
    return (
        <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
            <Box marginLeft={inset} width={available} height={rows} flexDirection="column" flexShrink={0}>
                <Box height={1} flexShrink={0} justifyContent="space-between">
                    <Copy color={color} tone={corner.tone}>
                        {corner.text}
                    </Copy>
                    <Copy color={color} tone={izbor.tone}>
                        {clip(izbor.text, available - (corner.text ? corner.text.length + 1 : 0))}
                    </Copy>
                </Box>
                <Box height={paneRows} flexShrink={0}>
                    <Box width={width} height={paneRows} flexDirection="column" flexShrink={0}>
                        <Box flexShrink={0} justifyContent="space-between">
                            {view.help ? (
                                <Copy color={color} tone="muted">
                                    Help
                                </Copy>
                            ) : expanded ? (
                                <Box>
                                    <Box ref={backControl} width={10} height={1} flexShrink={0}>
                                        <Copy color={color} tone="focus" underline>
                                            Back · Esc
                                        </Copy>
                                    </Box>
                                    <Box marginLeft={2}>
                                        <SessionHeading session={expanded} width={width - 12} color={color} />
                                    </Box>
                                </Box>
                            ) : (
                                <Box>
                                    {(["home", "sessions"] as const).map((screen) => (
                                        <Box
                                            key={screen}
                                            ref={screen === "home" ? homeTab : sessionsTab}
                                            marginRight={2}
                                            flexShrink={0}
                                        >
                                            <Copy
                                                color={color}
                                                tone={view.screen === screen ? "text" : "muted"}
                                                bold={view.screen === screen}
                                                underline={view.screen !== screen}
                                            >
                                                {tabLabels[screen]}
                                            </Copy>
                                        </Box>
                                    ))}
                                    {width >=
                                        tabLabels.home.length + tabLabels.sessions.length + 4 + "Ctrl-O".length && (
                                        <Copy color={color} tone="muted">
                                            Ctrl-O
                                        </Copy>
                                    )}
                                </Box>
                            )}
                        </Box>
                        <Box
                            ref={viewport}
                            width={width}
                            height={bodyRows}
                            marginTop={topGap}
                            flexDirection="column"
                            flexShrink={0}
                            overflow="hidden"
                            contentOffsetY={layout.scroll}
                        >
                            <Box
                                ref={content}
                                width={width}
                                flexDirection="column"
                                flexShrink={0}
                                rowGap={expanded || view.help || tight ? 0 : 1}
                            >
                                {view.help ? (
                                    <Help color={color} width={width} />
                                ) : expanded ? (
                                    fullBrief(expanded, width, stopControl)
                                ) : !home ? (
                                    view.sessions.length ? (
                                        view.sessions.map((session) => (
                                            <SessionRow
                                                key={session.id}
                                                ref={kept(sessionElements, session.id)}
                                                session={session}
                                                marked={markedId === session.id}
                                                selected={view.selected === session.id}
                                                cueShown={!showDetail}
                                                width={width}
                                                color={color}
                                                at={now}
                                                down={izborDown(view.izbor)}
                                            />
                                        ))
                                    ) : (
                                        <Copy color={color} tone="muted">
                                            {wrapText("No session observed. Ctrl-O opens Home.", width)}
                                        </Copy>
                                    )
                                ) : (
                                    <>
                                        {listMessage && (
                                            <Copy color={color} tone={listMessage.tone}>
                                                {wrapText(listMessage.text, width)}
                                            </Copy>
                                        )}
                                        {projects.map((project) => (
                                            <ProjectGroup
                                                key={project.checkout}
                                                project={project}
                                                focused={view.focused}
                                                rows={view.sessions}
                                                width={width}
                                                color={color}
                                                now={now}
                                                lineRef={lineRef}
                                            />
                                        ))}
                                    </>
                                )}
                            </Box>
                        </Box>
                        <Box height={1 + extraRows} flexShrink={0}>
                            {showDetail ? null : shownLine}
                        </Box>
                        {pageField && fieldBox ? <FieldBox {...fieldBox} /> : null}
                    </Box>
                    {showDetail && selectedSession && (
                        <SideBrief
                            session={selectedSession}
                            color={color}
                            width={detailWidth}
                            paneRows={paneRows}
                            rows={detailRows}
                            focused={view.focused === DETAIL_FOCUS}
                            scroll={layout.detail?.scroll ?? 0}
                            paneRef={detailPane}
                            viewportRef={detailViewport}
                            contentRef={detailContent}
                            hideRef={hideControl}
                            field={sideField}
                        >
                            {fullBrief(selectedSession, detailWidth, detailStopControl)}
                        </SideBrief>
                    )}
                </Box>
                <LastLine
                    color={color}
                    width={available}
                    label={view.help ? CLOSE_LABEL : HELP_LABEL}
                    helpFocused={view.focused === HELP_FOCUS}
                    helpRef={helpControl}
                />
            </Box>
        </Box>
    );
}
