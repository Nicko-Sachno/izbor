# Izbor

Domain glossary: the words Izbor's code and docs use. Read it before changing `src/domain`.

Izbor watches Claude Code sessions by their id, saves each as records and streams what happens in it to listeners: the terminal app and a developer with curl today, an agent later. It acts on a session only on the user's command, and only in an acting project, by answering a request or sending an Izbor prompt: an answer or an Izbor prompt from the terminal app's field, or through Izbor's HTTP routes.

## Language

### What Claude Code produces

**Agent provider**:
A coding agent product whose sessions Izbor can watch. Claude Code is the only one today; one Izbor can run several at once.
_Avoid_: Vendor, backend, integration

**Session**:
One conversation with an agent in one agent provider, identified by its session id. It has one main thread and zero or more subagent threads.
_Avoid_: Conversation, chat

**Thread**:
The ordered messages of one agent within a session: either the main thread or one subagent's.
_Avoid_: Chain, sidechain

**Subagent**:
An agent started by a tool call inside a session; its messages form their own thread.
_Avoid_: Child agent, task

**Transcript**:
Claude Code's own stored copy of a session. Izbor never reads it directly, only through the Agent SDK.
_Avoid_: Log, history

**Hook**:
A notice Claude Code sends to Izbor when something happens in a session. It says that something changed, not what the session now contains.
_Avoid_: Event (an event record is saved, a stream event is sent), callback

**Event hook**:
A hook that reports a "waiting for the user" moment: a permission request, a permission denial or a notification. An answer hook is not an event hook.

**Running session**:
A session that Claude Code lists as running right now: one entry of `claude agents --json`. It is not a watch: Izbor may watch it or not, and a watched session that is no longer running has the Status not listed.
_Avoid_: Available session, agent, live session

**Status**:
What a watched session is doing right now, according to Claude Code's own list of running sessions: busy, idle, waiting, not listed or unknown. Waiting comes with what the session waits for, such as a permission prompt.
_Avoid_: State, activity

**Not listed**:
The Status of a watched session that is missing from Claude Code's list of running sessions: it exited, or `/clear` gave it a new session id.
_Avoid_: Stopped, ended, dead

**Unknown**:
What a field of the brief shows when Izbor has no evidence for it, and what the brief shows in place of an explanation while the summarizer has written none. The terminal app shows Explanation unknown only when Izbor gave a reason, and nothing while there is none. As a Status it means Izbor got no answer it could read. It says nothing about the session, so it never means the session stopped.
_Avoid_: Stopped, offline, error, empty

**Task notification**:
A prompt Claude Code submits by itself when background work ends. The user did not write it.
_Avoid_: Synthetic prompt

**Background work**:
The shells and subagents a session keeps running after its reply is finished.
_Avoid_: Background tasks (the hook's field name), jobs

**Request**:
Something Claude Code asks the user to decide before the session goes on: a permission prompt or a question.
_Avoid_: Question (a question is one kind of request), prompt (a prompt is what the user writes), block

**Question**:
A request in which Claude asks the user to choose an answer. It ends answered, with what the user chose or wrote, or dismissed, with no answer. Izbor answers one by an option's number, and only a question of exactly one question with one choice; any other is answered in the session.
_Avoid_: Dialog, poll, rejected question

**Interrupt**:
The user ending the session's work with Esc before it is finished: a reply while Claude writes it, or a tool call while it runs. A rejected request is not an interrupt: the session waited for the user, and the tool call never ran.
_Avoid_: Cancel (a summary request is cancelled), abort, stop (`Stop` is the hook for a finished reply)

### Running Izbor

**Watch**:
Izbor observing one session, chosen by its session id, from a watch start to a watch stop. Hooks of a session that is not watched are ignored, and nothing about it is saved. In an acting project Izbor also holds the answer hook of an unwatched session's request on its main thread, and keeps that session's latest PermissionRequest hook in memory only, so that a later watch start can show the request and answer it.
_Avoid_: Selected session, observed session, subscription, observation (an observation is one listener a terminal app holds)

**Watch start**:
Izbor beginning to watch a session, when a listener tunes in to a session that is not watched. Izbor did not observe what the session did before it: it catches up from the transcript and a first Status reading before it sends the first brief.
_Avoid_: Izbor start, restart, launch

**Watch stop**:
Izbor ending its work on one watched session, after it has written every record still waiting: 30 seconds after its last listener left, on a delete, or at the Izbor stop. The session keeps running.
_Avoid_: Unsubscribe, stop on its own (`Stop` is the hook for a finished reply)

**Listener**:
One open stream of the stream events of one watched session. A watch lasts while it has a listener, and 30 seconds more. A stream of every watched session is not a listener: it starts nothing and keeps nothing alive.
_Avoid_: Subscriber, client, viewer

**Platform**:
The operating system Izbor runs on, as far as Izbor must treat it differently: locking the data folder, starting and stopping processes, private files. macOS and Windows (Windows untested by a person yet).
_Avoid_: OS layer, environment

**Data folder**:
The folder that holds everything Izbor saves about sessions, including the session files and the hook files. It belongs to Izbor alone.
_Avoid_: Storage, data dir, output folder

**Per-user folder**:
The folder, one per OS user and outside every project, that holds the port file and the send key, where Izbor's plugin finds them. Izbor and its plugin find it by the same rule.
_Avoid_: Config folder, home folder, data folder (the data folder holds what Izbor saves about sessions)

**Izbor stop**:
Izbor ending on request: every stream ends, every watch stops, then Izbor exits. The sessions keep running. It can be requested over HTTP, with the send key (`izbor stop` does), or with Ctrl-C where Izbor runs.
_Avoid_: Stop on its own (`Stop` is the hook for a finished reply), shutdown, kill

**Izbor log**:
The lines Izbor writes about itself: its start, watch starts and stops, each answer and Izbor prompt it sends, warnings and errors. They go to the terminal Izbor runs in, or to a file when it runs in the background. Listeners never get them.
_Avoid_: Terminal (the terminal app is what the user looks at), console, output

**Status query**:
One request to Claude Code for its list of running sessions, made to learn the Status of every watched session.
_Avoid_: Poll, check

**Status reading**:
The Status one Status query found, with the time Izbor observed it.

**Summarizer**:
The part of Izbor that asks a Claude model to put evidence into words, on the user's Claude subscription. It is apart from every session: it sends no hooks, writes no transcript and can use no tools.
_Avoid_: Explainer, the model, AI

**Summary request**:
One request the summarizer makes to the model, for the Task, the brief and the recent actions of one watched session. At most one is in flight across Izbor. It ends in one of three ways: with the text the model wrote, as unavailable with the reason, or as cancelled, by a watch stop or because it took too long. An unavailable request is never repeated on a route that costs money.
_Avoid_: Query (a Status query asks Claude Code, not a model), model call, prompt

**Summary turn**:
The right to make the one summary request in flight across Izbor. Watches get it first come, first served, and a watch that stops while it waits loses its place.
_Avoid_: Lock, slot, queue

### What Izbor shows

**Brief**:
What Izbor tells the user about a watched session right now: five fields (Task, Status, Latest activity, Needs you and Last observed) and an explanation. The five fields are built from evidence only, with no model request, and never wait for the explanation. Listeners get it as a brief event.
_Avoid_: Summary, dashboard, state

**Stream event**:
One piece of news Izbor sends on an open stream: a session event (watching, not listed or stopped), a brief event, an action event or a prompt event (what the session's plugin reported of an Izbor prompt: delivered or dropped). It names the watched session it is about.
_Avoid_: Event (an event record is saved, an event hook is a hook), message, update

**Evidence**:
A hook, a Status reading or a message record that supports a field of the brief. Silence is not evidence, and neither is an answer hook or what Izbor sent: an answer or an Izbor prompt reaches the brief only through what Claude Code reports after it.
_Avoid_: Signal, data

**Task**:
The latest prompt the user wrote in a watched session, word for word. A task notification is not a Task. A Task whose prompt Izbor did not receive, such as one written before the watch start, is read from the transcript and marked so in the brief.
_Avoid_: Goal, job, request (a request is what Claude Code asks the user)

**Action**:
One thing a watched session was observed doing: a prompt submitted, a tool call started, finished, failed, rejected or interrupted, a permission asked for or denied, a question asked, answered or dismissed, a subagent started or finished, a reply written, finished, failed or interrupted, a task notification, the session started or ended.
_Avoid_: Event (an action event is how a listener gets an action), step

**Latest activity**:
The last action Izbor observed, with the time it happened.
_Avoid_: Current activity, progress, last event

**Recent actions**:
The latest actions of the Task, oldest first: what a summary request carries. An action that happened before the prompt of the Task is the work of a Task before it and is not one of them. After a watch start they include the actions of the Task that Izbor read from the transcript. While the Task is unknown, they are the latest actions Izbor observed.
_Avoid_: History, context, action log

**Finished reply**:
The action that ends one reply of the main thread when Claude ends it. It does not say the Task succeeded, and it names the background work still running. The reply counts as finished while this is the latest activity. A reply the user ended, by an interrupt or by rejecting a request, has no finished reply.
_Avoid_: Done, completed, task finished

**Needs you**:
The pending request, exactly as Claude Code made it. It is "nothing" only when evidence says no request is pending, and it is cleared only by evidence that the request is over. A session that waits for something Izbor saw no request for leaves it unknown. Izbor holds no subagent's request yet: the terminal app says a subagent's request is answered in Claude Code.
_Avoid_: Blocked, attention, waiting (waiting is a Status)

**Last observed**:
The time Izbor last received a hook or a Status reading that was not unknown. It also keeps the time of the last hook, which is none for a session that sends Izbor no hooks.
_Avoid_: Last seen, last updated, heartbeat

**Explanation**:
One sentence the summarizer wrote about a watched session, shown in the brief with its age: what Claude is working on, after a finished reply what that reply did, or after an interrupt what Claude was doing when the user interrupted it. It is not evidence: no field is built from it, and no summary request carries it. It covers the evidence of its summary request and nothing newer. After a watch start Izbor asks for one at once about the last turn the transcript holds; while it holds none, there is none until Izbor observes an action. It is removed when the Task it was written for is replaced.
_Avoid_: Summary (a summary request can end without one), description, AI status

**Outdated explanation**:
An explanation that no longer holds for the brief it is shown in: the request that was pending when it was asked for is over, another request took its place in Needs you, or the reply finished after it was asked for. It stays in the brief, marked with which of the three, until the next explanation comes.
_Avoid_: Stale, old (every explanation has an age), expired, removed

**Age**:
How long ago the summary request of an explanation was made: the explanation knows nothing Izbor observed since.
_Avoid_: Freshness, staleness

### Acting on a session

**Acting project**:
A project where the user turned acting on, with its own command, apart from adding Izbor's hooks. Izbor answers requests and sends Izbor prompts only in the sessions of an acting project.
_Avoid_: Plugin project, enabled project

**Answer**:
What the user sends from Izbor to the request in Needs you: `yes` allows a permission prompt; `no` rejects the request and stops Claude, as Claude Code's own No does; `no` with words rejects it, and Claude goes on with the words; an option's number, counted from 1, answers a question of one question with one choice. A `no` is a rejected request, never an interrupt; a `no` to a question dismisses it.
_Avoid_: Reply (a reply is Claude's), response, approval (only evidence says what Claude Code did with an answer)

**Answer hook**:
A PermissionRequest hook that Izbor holds open to deliver an answer; Claude Code keeps the first answer, from its own dialog or from Izbor. It is not evidence and not an event hook, and Izbor records nothing from it.
_Avoid_: PermissionRequest hook (Izbor's other one, which is evidence)

**Answerable**:
Izbor's own state beside Needs you: yes while Izbor holds the answer hook of the request in Needs you, otherwise the reason Izbor cannot deliver an answer to it. It is not evidence, and it never sets or clears Needs you.
_Avoid_: Actionable, can answer

**Izbor prompt**:
A prompt the user sent to a session through Izbor. Izbor hands it to the session's plugin, which collects it, or withdraws it when no plugin collects it in time; the plugin then reports it delivered, taken by Claude Code to run as the user's own words, or dropped before it ran. It is the user's prompt and can be the Task. It reaches Claude as plain text: an `@file` mention in it attaches no file.
_Avoid_: Message (Claude Code's peer messages are not from the user), reply (a reply is Claude's), injected prompt

**Izbor's plugin**:
A Claude Code hooks module shipped with Izbor and installed, at local scope, in an acting project. Inside a session it asks Izbor for the session's next Izbor prompt with a long poll, submits it as the user's own words and reports what became of it. Its reports are not evidence.
_Avoid_: Hook (a hook is Claude Code's notice to Izbor), mod, the answer hook (another route)

**Send key**:
The secret Izbor makes at each start, readable only by the user's OS user. Only a sender that shows it can send an answer or an Izbor prompt, or request the Izbor stop; it keeps out other OS users, web pages and scripts that guess Izbor's address, not programs that already run as the user.
_Avoid_: Token, password, API key

**Subagent wait**:
How long Izbor would hold the answer hook of a subagent's request in a watched session before it lets go with no decision. Not built yet: Izbor holds no subagent's request, its `answerable` reads `subagent wait over` in an acting project, and the terminal app says the answer is given in Claude Code.
_Avoid_: Timeout (a hook has its own), hold limit, delay

### The terminal app

**Terminal app**:
The program the user opens with `izbor`: it lists running sessions, shows the brief of each of its observations, and sends the user's answers and Izbor prompts through Izbor. It never stops a session. Every window that runs it is its own terminal app, with its own observations.
_Avoid_: Terminal (Izbor log goes to a terminal too), client (curl is a client too), Izbor (Izbor is the service it listens to), TUI

**Observation**:
One session a terminal app shows in a row, through one listener of its own. Leaving it closes only that stream, never the watch: the watch goes on for its other listeners, or 30 seconds if none is left. A delete is what stops the watch for every listener. A stopped or disconnected observation keeps its last brief until it is left or observed again.
_Avoid_: Watch (the watch is Izbor's, shared by every listener), subscription, observed session

**Last change**:
How the terminal app labels Last observed. A listener gets Last observed only with a brief, so it tells when something last changed, not that Izbor is still there: on a quiet session it grows old while Izbor still watches.
_Avoid_: Updated, last seen, heartbeat

**Gap**:
A time the terminal app marks as not observed by Izbor: from the moment an observation's stream ended with no stopped event, to the first brief of its next stream. Izbor's watch may have ended in it, so hooks and requests of that time can be lost.
_Avoid_: Outage, downtime, missing data

### What Izbor writes

**Record**:
One entry of a session file or a hook file.
_Avoid_: Entry, row, line

**Message record**:
The record of one message of a thread. The Agent SDK is its only source.

**Event record**:
The record of one "waiting for the user" moment, made from an event hook. It is not in the transcript, so the hook is its only source.

**Hook record**:
The record of one hook of a watched session: its whole payload, unchanged, and the time Izbor received it.
_Avoid_: Raw hook, raw event

**Izbor record**:
The record of something that happened to Izbor itself and can leave hooks or messages missing: a watch start, a watch stop, a rejected payload or a sync error.
_Avoid_: Gap record, service record

**Status record**:
The record of one Status change: the first Status reading since the watch started, and every later one that differs from the reading before it.
_Avoid_: Status event, state record

**Rejected payload**:
Something posted to Izbor's hook address that Izbor could not read as a hook.
_Avoid_: Bad request, invalid hook

**Block**:
One part of a message record's content: text, thinking, a tool call, a tool result, or anything else.
_Avoid_: Part, chunk

**Tool call**:
A block in which the agent asks to run a tool. Its tool result is a block in a later message record, linked by the tool call id.
_Avoid_: Tool use

**Tool result**:
A block holding the outcome of one tool call: completed or failed, with the tool's full output.

**Tool kind**:
The category of a tool call (read, edit, execute, search, …), taken from ACP's set.

**Tool title**:
A short human-readable label for a tool call, such as the command or the file path.

**Session file**:
The file that holds every message record and event record of one session.
_Avoid_: Log file, output file

**Hook file**:
The file that holds every hook record, Izbor record and Status record of one session. Izbor only adds to it; no sync changes it.
_Avoid_: Hook log, raw file

### Keeping a session file up to date

**Sync**:
Bringing a session file up to date with the Agent SDK: every thread is read, then the file is rebuilt or appended to.
_Avoid_: Read (a read is only the SDK half of a sync), refresh

**Rebuild**:
A sync that replaces all message records in the session file with what the Agent SDK returns, keeping the file's event records.
_Avoid_: Reload, reset

**Append**:
A sync that adds only the message records past each thread's cursor.

**Cursor**:
How many messages of one thread are already in the session file.
_Avoid_: Offset, seen count

**First contact**:
The first sync since the watch started in which the Agent SDK returns messages for the watched session. It is always a rebuild.

**Shrink**:
A thread for which the Agent SDK returns fewer messages than its cursor.

**Burst**:
Hooks for one session that arrive close together and share a single sync.

**Delayed sync**:
A sync scheduled some time after a session stops or ends, to pick up a final reply that reached the transcript late.
_Avoid_: Re-read
