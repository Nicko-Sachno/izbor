import type { CreateProvider } from "../../core/ports.js";
import { createClaudeProvider } from "./claude/provider.js";

export const PROVIDERS = {
    claude: createClaudeProvider,
} satisfies Record<string, CreateProvider>;
