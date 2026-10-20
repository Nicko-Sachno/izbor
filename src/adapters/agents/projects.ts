import type { CreateProject, Platform } from "../../core/ports.js";
import { createAgentsList, type AgentsList } from "./claude/agentsList.js";
import { createClaudeProject } from "./claude/setup/project.js";

export type { AgentsList };

/** The CLI understands Claude's session list; setup and discovery must use that same provider. */
export const CLI_PROVIDER = {
    project: createClaudeProject,
    agentsList: createAgentsList,
} satisfies CliProvider;

type CliProvider = {
    project: CreateProject;
    agentsList: (deps: { run: Platform["run"] }) => AgentsList;
};
