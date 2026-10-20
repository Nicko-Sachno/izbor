// Ratchet rules. test/terminal-ratchet.json (src/terminal) and test/service-ratchet.json (the rest of src/)
// hold a ceiling for each metric this script measures. test/terminalRatchet.test.ts and
// test/serviceRatchet.test.ts fail when a number goes over its ceiling. A ceiling may only go down: do not raise
// one to make a change pass, make the change smaller instead. When the numbers drop, lower the ceilings with
// `--lower-ratchet` (src/terminal) or `--service --lower-ratchet` (the rest of src/) and commit the ratchet file.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { parseArgs } from "node:util";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
    NodeFlags,
    SyntaxKind,
    type Expression,
    type FunctionLikeDeclaration,
    type NamedExportBindings,
    type NamedImportBindings,
    type Node,
    type SourceFile,
} from "typescript/unstable/ast";
import {
    isArrayLiteralExpression,
    isArrowFunction,
    isBinaryExpression,
    isBlock,
    isCallExpression,
    isCallOrNewExpression,
    isConditionalExpression,
    isConstructorDeclaration,
    isExportDeclaration,
    isExpressionStatement,
    isFunctionLikeDeclaration,
    isIdentifier,
    isImportDeclaration,
    isImportExpression,
    isJsxAttribute,
    isJsxExpression,
    isNamedExports,
    isNamedImports,
    isNewExpression,
    isNoSubstitutionTemplateLiteral,
    isParenthesizedExpression,
    isPropertyAccessExpression,
    isPropertyAssignment,
    isPropertyDeclaration,
    isPropertySignatureDeclaration,
    isStringLiteral,
    isTemplateHead,
    isTemplateMiddle,
    isTemplateTail,
    isVariableDeclaration,
    isVariableStatement,
} from "typescript/unstable/ast/is";

type Files = Readonly<Record<string, string>>;

type Fn = { file: string; line: number; name: string; lines: number };

type Edge = { from: string; to: string; line: number; value: boolean };

const ROOT = "/terminal-metrics";
const TSCONFIG = { compilerOptions: { noLib: true, noResolve: true, types: [] }, include: ["**/*.ts", "**/*.tsx"] };

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function parse(files: Files): Map<string, SourceFile> {
    const virtual = new Map<string, string>([[`${ROOT}/tsconfig.json`, JSON.stringify(TSCONFIG)]]);
    for (const [path, text] of Object.entries(files)) virtual.set(`${ROOT}/${path}`, text);
    const fs = createVirtualFileSystem(Object.fromEntries(virtual));
    const api = new API({ cwd: ROOT, fs: { ...fs, readFile: (path) => virtual.get(path) ?? null } });
    try {
        const program = api.updateSnapshot({ openProjects: [`${ROOT}/tsconfig.json`] }).getProjects()[0]?.program;
        const trees = new Map<string, SourceFile>();
        for (const path of Object.keys(files)) {
            const tree = program?.getSourceFile(`${ROOT}/${path}`);
            if (!tree) throw new Error(`TypeScript did not parse ${path}.`);
            trees.set(path, tree);
        }
        return trees;
    } finally {
        api.close();
    }
}

const lineAt = (tree: SourceFile, position: number) => tree.getLineAndCharacterOfPosition(position).line + 1;

const startLine = (node: Node, tree: SourceFile) => lineAt(tree, node.getStart(tree));

const lengthOf = (node: Node, tree: SourceFile) => lineAt(tree, node.getEnd()) - startLine(node, tree) + 1;

const unparenthesized = (node: Expression): Expression =>
    isParenthesizedExpression(node) ? unparenthesized(node.expression) : node;

function calleeName(callee: Node): string | undefined {
    if (isIdentifier(callee)) return callee.text;
    if (isPropertyAccessExpression(callee)) return callee.name.text;
    return undefined;
}

function ownName(fn: FunctionLikeDeclaration, tree: SourceFile): string | undefined {
    if (isConstructorDeclaration(fn)) return "constructor";
    if (!isArrowFunction(fn) && fn.name) return fn.name.getText(tree);
    const parent = fn.parent;
    if ((isVariableDeclaration(parent) || isPropertyAssignment(parent) || isPropertyDeclaration(parent)) && parent.name)
        return parent.name.getText(tree);
    if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.EqualsToken && parent.right === fn)
        return calleeName(parent.left);
    return undefined;
}

function functionName(fn: FunctionLikeDeclaration, tree: SourceFile): string {
    const own = ownName(fn, tree);
    if (own) return own;
    const parent = fn.parent;
    if (isCallOrNewExpression(parent) && parent.arguments?.some((argument) => argument === fn)) {
        const callee = calleeName(parent.expression);
        if (callee) return `${callee} callback`;
    }
    if (isJsxExpression(parent) && isJsxAttribute(parent.parent)) return `${parent.parent.name.getText(tree)} handler`;
    return "anonymous";
}

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

type Effect = {
    file: string;
    line: number;
    hook: string;
    in: string;
    lines: number;
    deps: number | "none" | "not an array";
};

function depsOf(deps: Node | undefined): Effect["deps"] {
    if (!deps) return "none";
    return isArrayLiteralExpression(deps) ? deps.elements.length : "not an array";
}

function setsStateFirst(callback: FunctionLikeDeclaration): boolean {
    const body = callback.body;
    const first = body && isBlock(body) ? body.statements[0] : body;
    const call = first && isExpressionStatement(first) ? first.expression : first;
    return !!call && isCallExpression(call) && /^set[A-Z]/.test(calleeName(call.expression) ?? "");
}

const SMELLS = [
    "booleanModes",
    "renderProps",
    "inlineComponents",
    "stateSyncEffects",
    "andInJsx",
    "consoleCalls",
    "timers",
    "hexColours",
    "barrels",
    "any",
    "moduleLets",
    "moduleSingletons",
    "ioInUi",
    "logicInUi",
    "syncIo",
] as const;
type Smell = (typeof SMELLS)[number];

const CACHES = new Set(["Map", "Set", "WeakMap", "WeakSet", "LRUCache"]);
const IO_MODULES = new Set(["node:fs", "node:fs/promises", "node:child_process", "node:net", "node:http"]);
const IO_PROCESS = new Set(["exit", "env", "stdout", "stderr"]);
const LOGIC_CALLS = new Set(["fetch", "exec", "spawn", "execa"]);
const HEX_COLOR = /#[0-9a-fA-F]{3,6}\b/g;

function smellsAt(node: Node, tree: SourceFile, inFunction: boolean): [Smell, number][] {
    const found: [Smell, number][] = [];
    const add = (smell: Smell, at: Node) => found.push([smell, startLine(at, tree)]);
    if (isPropertySignatureDeclaration(node) && isIdentifier(node.name)) {
        const typed = node.type?.kind;
        if (/^(is|has|show|hide|with)[A-Z]/.test(node.name.text) && typed === SyntaxKind.BooleanKeyword)
            add("booleanModes", node);
        if (/^render[A-Z]/.test(node.name.text)) add("renderProps", node);
    }
    if (isFunctionLikeDeclaration(node) && inFunction && /^[A-Z]/.test(ownName(node, tree) ?? ""))
        add("inlineComponents", node);
    if (isCallExpression(node)) {
        const callee = calleeName(node.expression);
        const [callback] = node.arguments;
        if (callee && EFFECT_HOOKS.has(callee) && callback && isFunctionLikeDeclaration(callback))
            if (setsStateFirst(callback)) add("stateSyncEffects", node);
        const target = node.expression;
        if (
            isPropertyAccessExpression(target) &&
            isIdentifier(target.expression) &&
            target.expression.text === "console"
        )
            add("consoleCalls", node);
        if (callee === "setInterval") add("timers", node);
        if (isIdentifier(target) && LOGIC_CALLS.has(target.text)) add("logicInUi", node);
        if (callee && /\wSync$/.test(callee)) add("syncIo", node);
    }
    if (isJsxExpression(node) && !isJsxAttribute(node.parent) && node.expression) {
        const inside = unparenthesized(node.expression);
        if (isBinaryExpression(inside) && inside.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken)
            add("andInJsx", node);
    }
    if (
        isStringLiteral(node) ||
        isNoSubstitutionTemplateLiteral(node) ||
        isTemplateHead(node) ||
        isTemplateMiddle(node) ||
        isTemplateTail(node)
    ) {
        const start = node.getStart(tree);
        for (const match of tree.text.slice(start, node.getEnd()).matchAll(HEX_COLOR))
            found.push(["hexColours", lineAt(tree, start + match.index)]);
    }
    if (isExportDeclaration(node) && node.moduleSpecifier && !node.exportClause && !node.isTypeOnly)
        add("barrels", node);
    if (node.kind === SyntaxKind.AnyKeyword) add("any", node);
    if (isVariableStatement(node) && node.parent === tree) {
        const kind = node.declarationList.flags & (NodeFlags.Const | NodeFlags.Using);
        if (kind === 0) add("moduleLets", node);
        for (const declaration of kind === NodeFlags.Const ? node.declarationList.declarations : []) {
            const value = declaration.initializer && unparenthesized(declaration.initializer);
            if (value && isNewExpression(value) && !CACHES.has(value.expression.getText(tree)))
                add("moduleSingletons", declaration);
        }
    }
    if (isPropertyAccessExpression(node) && isIdentifier(node.expression) && node.expression.text === "process")
        if (IO_PROCESS.has(node.name.text)) add("ioInUi", node);
    return found;
}

function resolve(specifier: string, from: string, files: Files): string {
    if (!specifier.startsWith(".")) return specifier;
    const path = posix.join(posix.dirname(from), specifier);
    if (!path.endsWith(".js")) return path;
    const base = path.slice(0, -".js".length);
    return Object.hasOwn(files, `${base}.tsx`) ? `${base}.tsx` : `${base}.ts`;
}

const valueNamesIn = (bound: NamedImportBindings | NamedExportBindings, tree: SourceFile) =>
    isNamedImports(bound) || isNamedExports(bound)
        ? bound.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.getText(tree))
        : [`* as ${bound.name.getText(tree)}`];

function importAt(node: Node, tree: SourceFile): { specifier: string; names: string[] } | undefined {
    if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const clause = node.importClause;
        if (!clause) return { specifier, names: [node.moduleSpecifier.getText(tree)] };
        if (clause.phaseModifier === SyntaxKind.TypeKeyword) return { specifier, names: [] };
        const names = clause.name ? [clause.name.text] : [];
        if (clause.namedBindings) names.push(...valueNamesIn(clause.namedBindings, tree));
        return { specifier, names };
    }
    if (isExportDeclaration(node) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (node.isTypeOnly) return { specifier, names: [] };
        return { specifier, names: node.exportClause ? valueNamesIn(node.exportClause, tree) : ["*"] };
    }
    if (isCallExpression(node) && isImportExpression(node.expression)) {
        const [specifier] = node.arguments;
        if (specifier && isStringLiteral(specifier)) return { specifier: specifier.text, names: ["import()"] };
    }
    return undefined;
}

function reachingUi(edges: readonly Edge[]): Set<string> {
    const reaching = new Set<string>();
    let grew = true;
    while (grew) {
        grew = false;
        for (const { from, to, value } of edges)
            if (value && !reaching.has(from) && (to === "react" || to === "ink" || reaching.has(to))) {
                reaching.add(from);
                grew = true;
            }
    }
    return reaching;
}

function valueCyclesIn(paths: readonly string[], edges: readonly Edge[]): string[][] {
    const next = new Map<string, string[]>(paths.map((path) => [path, []]));
    for (const { from, to, value } of edges) if (value && next.has(to)) next.get(from)?.push(to);
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const groups: string[][] = [];
    const connect = (path: string) => {
        const at = index.size;
        index.set(path, at);
        low.set(path, at);
        stack.push(path);
        for (const to of next.get(path) ?? []) {
            if (!index.has(to)) connect(to);
            if (stack.includes(to)) low.set(path, Math.min(low.get(path) ?? at, low.get(to) ?? at));
        }
        if (low.get(path) !== at) return;
        const group = stack.splice(stack.indexOf(path));
        if (group.length > 1 || next.get(path)?.includes(path)) groups.push(group.sort(byCodeUnit));
    };
    for (const path of paths) if (!index.has(path)) connect(path);
    return groups.sort((a, b) => byCodeUnit(a[0] ?? "", b[0] ?? ""));
}

export function measure(files: Files) {
    const trees = parse(files);
    const paths = Object.keys(files).sort(byCodeUnit);
    const sizes: {
        path: string;
        lines: number;
        useRef: number;
        refProps: number;
        colorProps: number;
        deepestTernary: number;
    }[] = [];
    const functions: Fn[] = [];
    const effects: Effect[] = [];
    const edges: Edge[] = [];
    const hits: { smell: Smell; file: string; line: number }[] = [];
    const viewToControllerValues: string[] = [];

    for (const path of paths) {
        const text = files[path] ?? "";
        const tree = trees.get(path);
        if (!tree) continue;
        const file = {
            path,
            lines: text.split("\n").length - 1,
            useRef: 0,
            refProps: 0,
            colorProps: 0,
            deepestTernary: 0,
        };
        sizes.push(file);

        const visit = (node: Node, scope: readonly string[], ternaries: number): void => {
            for (const [smell, line] of smellsAt(node, tree, scope.length > 0)) hits.push({ smell, file: path, line });
            const imported = importAt(node, tree);
            if (imported) {
                const { specifier, names } = imported;
                const line = startLine(node, tree);
                const to = resolve(specifier, path, files);
                edges.push({ from: path, to, line, value: names.length > 0 });
                if (IO_MODULES.has(specifier)) hits.push({ smell: "ioInUi", file: path, line });
                if (path.endsWith(".tsx") && posix.basename(to) === "controller.ts")
                    viewToControllerValues.push(...names.map((name) => `${path}:${line} ${name}`));
            }
            let inner = scope;
            let nested = ternaries;
            if (isFunctionLikeDeclaration(node)) {
                inner = [...scope, functionName(node, tree)];
                nested = 0;
                functions.push({
                    file: path,
                    line: startLine(node, tree),
                    name: inner.join(" > "),
                    lines: lengthOf(node, tree),
                });
            }
            if (isConditionalExpression(node)) {
                nested = ternaries + 1;
                file.deepestTernary = Math.max(file.deepestTernary, nested);
            }
            if (isCallExpression(node)) {
                const hook = calleeName(node.expression);
                if (hook === "useRef") file.useRef++;
                const [callback, deps] = node.arguments;
                if (hook && EFFECT_HOOKS.has(hook) && callback && isFunctionLikeDeclaration(callback))
                    effects.push({
                        file: path,
                        line: startLine(node, tree),
                        hook,
                        in: scope.join(" > "),
                        lines: lengthOf(callback, tree),
                        deps: depsOf(deps),
                    });
            }
            if (isJsxAttribute(node)) {
                const name = node.name.getText(tree);
                if (/^[a-z]\w*Ref$/.test(name)) file.refProps++;
                const value = node.initializer;
                if (name === "color" && value && isJsxExpression(value) && value.expression)
                    if (isIdentifier(value.expression) && value.expression.text === "color") file.colorProps++;
            }
            node.forEachChild((child) => visit(child, inner, nested));
        };
        visit(tree, [], 0);
    }

    const reaching = reachingUi(edges);
    const valueCycles = valueCyclesIn(paths, edges);
    const inkImporters = paths.filter((path) => edges.some(({ from, to }) => from === path && to === "ink"));
    const ui = paths.filter((path) => path.endsWith(".tsx") || reaching.has(path));
    const counted = hits.filter(
        ({ smell, file }) => (smell !== "ioInUi" && smell !== "logicInUi") || ui.includes(file),
    );
    const smells = Object.fromEntries(
        SMELLS.map((smell) => [
            smell,
            counted.filter((hit) => hit.smell === smell).map(({ file, line }) => `${file}:${line}`),
        ]),
    );

    const most = (numbers: number[]) => Math.max(0, ...numbers);
    const sum = (numbers: number[]) => numbers.reduce((total, n) => total + n, 0);
    const ceilings: Record<string, number> = {
        "conditionals.deepestTernary": most(sizes.map(({ deepestTernary }) => deepestTernary)),
        "effects.longestLines": most(effects.map(({ lines }) => lines)),
        "files.largestLines": most(sizes.map(({ lines }) => lines)),
        "files.over300Lines": sizes.filter(({ lines }) => lines > 300).length,
        "functions.longestLines": most(functions.map(({ lines }) => lines)),
        "imports.valueCycles": valueCycles.length,
        "imports.viewToControllerValues": viewToControllerValues.length,
        "jsx.colorProps": sum(sizes.map(({ colorProps }) => colorProps)),
        "refs.props": sum(sizes.map(({ refProps }) => refProps)),
        "refs.useRef": sum(sizes.map(({ useRef }) => useRef)),
        ...Object.fromEntries(SMELLS.map((smell) => [`smells.${smell}`, smells[smell]?.length ?? 0])),
    };
    return {
        files: sizes,
        functions,
        effects,
        ui,
        smells,
        edges,
        viewToControllerValues,
        valueCycles,
        inkImporters,
        ceilings,
    };
}

type ServiceGrep = { count: "lines" | "files" | "names"; pattern: RegExp; paths: RegExp; not?: RegExp };

const SERVICE = /^src\/(?!terminal\/).+\.ts$/;
const CORE_AND_DOMAIN = /^src\/(core|domain)\//;
const COMMENT = /^[^:]+:[0-9]+:\s*(\/\*\*|\*|\/\/)/;
const PLATFORM = /^src\/adapters\/platform\//;
const SHIPPED = /^(src|bin|plugin)\/.+\.(tsx?|js)$/;
const PROVIDER_WORDS = /claude|Claude|SDK|PermissionRequest|AskUserQuestion|ExitPlanMode|hookSpecificOutput/;

export const SERVICE_GREPS: Readonly<Record<string, ServiceGrep>> = {
    "greps.siblingAdapterImports": {
        count: "lines",
        pattern: /from "\.\.\/[a-zA-Z]+(\/[a-zA-Z]+)?\.js"/,
        paths: /^src\/adapters\/[^/]+\/[^/]+\.ts$/,
    },
    "greps.defaultedDeps": {
        count: "lines",
        pattern:
            /^\s+[a-zA-Z: ]+ = (homedir\(\)|process\.|create[A-Z][A-Za-z]*\(|\(ms(, signal)?\) => sleep|\(\) => (new Date|performance\.now|Date\.now))/,
        paths: SERVICE,
        not: / const /,
    },
    "greps.processOutsideEntry": {
        count: "files",
        pattern: /\bprocess\.[a-zA-Z]|homedir\(\)/,
        paths: SERVICE,
        not: /^src\/(main|cli\/main|foreground)\.ts|^src\/adapters\/platform\//,
    },
    "greps.exportedTwice": {
        count: "names",
        pattern: /^export (async )?(function|type|const) [A-Za-z0-9_]+/,
        paths: SERVICE,
    },
    "greps.messageOfCopies": {
        count: "lines",
        pattern: /instanceof Error \? \w+\.message : String/,
        paths: SERVICE,
    },
    "greps.returnTypeOfCreate": { count: "lines", pattern: /ReturnType<typeof create/, paths: SERVICE },
    "greps.untypedWaits": { count: "lines", pattern: /wait\??: \(ms: number/, paths: SERVICE },
    "greps.clockInCoreOrDomain": {
        count: "lines",
        pattern: /new Date\(|Date\.now\(|setTimeout|setInterval|randomUUID|Math\.random/,
        paths: CORE_AND_DOMAIN,
    },
    "greps.toListener": { count: "lines", pattern: /toListener\(/, paths: SERVICE },
    "greps.loopbackLiterals": { count: "lines", pattern: /127\.0\.0\.1/, paths: SERVICE, not: COMMENT },
    "greps.sessionIdLowerCasings": {
        count: "lines",
        pattern: /(sessionId|\bid)\.toLowerCase\(\)/,
        paths: /^src\/(core\/|adapters\/http\/|(izbor|watch)\.ts$)/,
    },
    "greps.uncheckedJsonParse": {
        count: "lines",
        pattern: /JSON\.parse\(/,
        paths: SERVICE,
        not: /: unknown = JSON\.parse/,
    },
    "greps.edgeTypesInside": {
        count: "lines",
        pattern: /HookPayload|SessionMessage|SessionReaders|IncomingMessage|ServerResponse/,
        paths: /^src\/(izbor|watch|service|(core|domain)\/[^/]+)\.ts$/,
    },
    "greps.throwNewError": { count: "lines", pattern: /\bthrow new Error\(/, paths: SERVICE },
    "greps.errorCasts": {
        count: "lines",
        pattern: / as (NodeJS\.ErrnoException|Error)\b|\(err: Error\)/,
        paths: SERVICE,
    },
    "greps.voidedPromises": {
        count: "lines",
        pattern: /\bvoid [a-zA-Z_.]+\(|\.catch\(\(\) => (\{\}|"")\)/,
        paths: SERVICE,
    },
    "greps.sdkOutsideProvider": {
        count: "files",
        pattern: /@anthropic-ai/,
        paths: SERVICE,
        not: /^src\/adapters\/(agents\/claude|summarizer)\//,
    },
    "greps.providerWordsCoreDomain": {
        count: "lines",
        pattern: PROVIDER_WORDS,
        paths: CORE_AND_DOMAIN,
        not: COMMENT,
    },
    "greps.providerWordsEdge": {
        count: "lines",
        pattern: new RegExp(`CLAUDE|${PROVIDER_WORDS.source}`),
        paths: /^src\/([^/]+|cli\/(main|args)|cli\/commands\/[^/]+|adapters\/[^/]+|adapters\/(http|izbor)\/[^/]+)\.ts$/,
        not: COMMENT,
    },
    "greps.providerIdentityChecks": { count: "lines", pattern: /provider\.(id|name) ===/, paths: SERVICE },
    "greps.platformReads": {
        count: "lines",
        pattern: /process\.platform|os\.platform\(|os\.type\(/,
        paths: SHIPPED,
        not: /^src\/(main|cli\/main)\.ts/,
    },
    "greps.fileModesOutsidePlatform": {
        count: "files",
        pattern: /fchmod|chmodSync|O_NOFOLLOW|O_EXLOCK|O_NONBLOCK|0o[0-7]{3}/,
        paths: SERVICE,
        not: PLATFORM,
    },
    "greps.childProcessOutsidePlatform": {
        count: "files",
        pattern: /process\.kill\(|from "node:child_process"/,
        paths: SERVICE,
        not: PLATFORM,
    },
    "greps.shellTrue": { count: "lines", pattern: /shell: true/, paths: SHIPPED },
    "greps.consoleOutsideLog": {
        count: "files",
        pattern: /\bconsole\./,
        paths: SERVICE,
        not: /^src\/adapters\/log\//,
    },
    "greps.stdStreamsOutsideEntry": {
        count: "lines",
        pattern: /process\.(stdout|stderr)/,
        paths: SERVICE,
        not: /^src\/(cli\/main|main)\.ts/,
    },
    "greps.logPrefixesInComposition": {
        count: "lines",
        pattern: /(izbor|\}) (error|warning): /,
        paths: /^src\/(watch|izbor|service)\.ts$/,
    },
    "greps.dynamicImportsOutsideCli": {
        count: "lines",
        pattern: /\bimport\(/,
        paths: SERVICE,
        not: /^src\/cli\/main\.ts/,
    },
    "greps.routeIfsAndStatuses": {
        count: "lines",
        pattern: /method === "|answerError\(\s*res,\s*[0-9]{3}/,
        paths: /^src\/adapters\/http\//,
    },
    "greps.cliCommandIfs": { count: "lines", pattern: /args\.command === "/, paths: /^src\/cli\/main\.ts$/ },
    "greps.signalNamesOutsideForeground": {
        count: "lines",
        pattern: /"SIG(INT|TERM|HUP|KILL)"/,
        paths: SERVICE,
        not: /^src\/(foreground\.ts|adapters\/platform\/)/,
    },
    "greps.fixedSleepsInTests": {
        count: "lines",
        pattern: /await (sleep|setTimeout|delay)\([0-9]/,
        paths: /^test\/[^/]+\.test\.ts$/,
    },
    "greps.supportLines": { count: "lines", pattern: /^/, paths: /^test\/support\.ts$/ },
    "greps.httpServerInTestHelper": {
        count: "lines",
        pattern: /createHttpServer\(/,
        paths: /^test\/helpers\/izborServer\.ts$/,
    },
    "greps.classesEnumsDefaults": {
        count: "lines",
        pattern: /^\s*(export )?(abstract )?(class|enum|namespace|interface) |export default/,
        paths: SERVICE,
    },
    "greps.emittersExecSyncLets": {
        count: "lines",
        pattern: /EventEmitter|node:events|\bexecSync\(|^(export )?let /,
        paths: SERVICE,
    },
    "greps.nodeImportsInCoreOrDomain": {
        count: "lines",
        pattern: /from "(node:|@)/,
        paths: CORE_AND_DOMAIN,
        not: /"node:util"/,
    },
    "greps.domainMutations": {
        count: "lines",
        pattern: /\.(set|add|delete|splice)\(/,
        paths: /^src\/domain\/[^/]+\.ts$/,
    },
};

function linesOf(text: string): string[] {
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
}

function grepCount({ count, pattern, paths, not }: ServiceGrep, files: Files): number {
    const printed = Object.keys(files)
        .filter((path) => paths.test(path))
        .flatMap((path) =>
            linesOf(files[path] ?? "").flatMap((text, at) => {
                const match = pattern.exec(text)?.[0];
                return match === undefined ? [] : [{ path, match, line: `${path}:${at + 1}:${text}` }];
            }),
        );
    if (count === "lines") return printed.filter(({ line }) => !not?.test(line)).length;
    if (count === "files") return new Set(printed.map(({ path }) => path).filter((path) => !not?.test(path))).size;
    const names = printed.map(({ match }) => match.split(" ").at(-1));
    return new Set(names.filter((name, at) => names.indexOf(name) !== at)).size;
}

export function countGreps(files: Files): Record<string, number> {
    return Object.fromEntries(Object.entries(SERVICE_GREPS).map(([id, grep]) => [id, grepCount(grep, files)]));
}

export function measureService(files: Files, testFiles: Files, shipped: Files): ReturnType<typeof measure> {
    const metrics = measure(files);
    return { ...metrics, ceilings: { ...metrics.ceilings, ...countGreps({ ...files, ...testFiles, ...shipped }) } };
}

type Ratchet = { ceilings: Record<string, number>; functions: Record<string, number> };

type Measured = { ceilings: Readonly<Record<string, number>>; functions: readonly Fn[] };

const own = (record: Readonly<Record<string, number>>, key: string) =>
    Object.hasOwn(record, key) ? record[key] : undefined;

const RATCHET = "test/terminal-ratchet.json";
const SERVICE_RATCHET = "test/service-ratchet.json";

const SEE_RULES = " See the ratchet rules at the top of scripts/terminal-metrics.ts.";

export function overCeilings(metrics: Measured, ratchet: Ratchet, path: string = RATCHET): string[] {
    const ids = [...new Set([...Object.keys(metrics.ceilings), ...Object.keys(ratchet.ceilings)])].sort(byCodeUnit);
    const messages: string[] = [];
    for (const id of ids) {
        const now = own(metrics.ceilings, id);
        const ceiling = own(ratchet.ceilings, id);
        if (ceiling === undefined) messages.push(`${id} is measured but has no ceiling in ${path}.`);
        else if (now === undefined) messages.push(`${id} has a ceiling in ${path} but names no metric.`);
        else if (now > ceiling) messages.push(`${id} is ${now}, over its ceiling ${ceiling} in ${path}.`);
    }
    for (const { file, line, name, lines } of metrics.functions) {
        const ceiling = own(ratchet.functions, name);
        if (ceiling !== undefined && lines > ceiling)
            messages.push(
                `The function ${name} at ${file}:${line} is ${lines} lines, over its ceiling ${ceiling} in ${path}.`,
            );
    }
    return messages.map((message) => message + SEE_RULES);
}

function longestByName(functions: readonly Fn[]): Map<string, number> {
    const longest = new Map<string, number>();
    for (const { name, lines } of functions) longest.set(name, Math.max(longest.get(name) ?? 0, lines));
    return longest;
}

export function lowerRatchet(metrics: Measured, ratchet: Ratchet | undefined): Ratchet {
    const lower = (old: number | undefined, now: number) => (old === undefined ? now : Math.min(old, now));
    const ceilings = Object.keys(metrics.ceilings)
        .sort(byCodeUnit)
        .map((id) => [id, lower(ratchet && own(ratchet.ceilings, id), own(metrics.ceilings, id) ?? 0)]);
    const functions = [...longestByName(metrics.functions)]
        .filter(([name, lines]) => lines >= 50 || (ratchet && own(ratchet.functions, name)) !== undefined)
        .sort(([a], [b]) => byCodeUnit(a, b))
        .map(([name, lines]) => [name, lower(ratchet && own(ratchet.functions, name), lines)]);
    return { ceilings: Object.fromEntries(ceilings), functions: Object.fromEntries(functions) };
}

function ratchetFrom(text: string, path: string): Ratchet {
    const parsed: unknown = JSON.parse(text);
    const numbers = (value: unknown): value is Record<string, number> =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((n) => typeof n === "number");
    if (typeof parsed === "object" && parsed !== null && "ceilings" in parsed && "functions" in parsed)
        if (numbers(parsed.ceilings) && numbers(parsed.functions))
            return { ceilings: parsed.ceilings, functions: parsed.functions };
    throw new Error(`${path} is not { ceilings: {…}, functions: {…} }, each of numbers.`);
}

const ratchetText = (ratchet: Ratchet) => JSON.stringify(ratchet, null, 4) + "\n";

function changes(before: Ratchet | undefined, after: Ratchet): string[] {
    const of = (label: (key: string) => string, old: Record<string, number>, now: Record<string, number>) =>
        [...new Set([...Object.keys(old), ...Object.keys(now)])].sort(byCodeUnit).flatMap((key) => {
            const [was, is] = [own(old, key), own(now, key)];
            if (was === is) return [];
            if (was === undefined) return [`added ${label(key)} ${is}`];
            if (is === undefined) return [`dropped ${label(key)} ${was}`];
            return [`${label(key)} ${was} -> ${is}`];
        });
    return [
        ...of((id) => id, before?.ceilings ?? {}, after.ceilings),
        ...of((name) => `functions["${name}"]`, before?.functions ?? {}, after.functions),
    ];
}

const REPO = join(import.meta.dirname, "..");

const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 });

function filesUnder(dir: string, keep: (path: string) => boolean, rev?: string): Record<string, string> {
    if (rev === undefined) {
        const names = readdirSync(join(REPO, dir), { recursive: true, encoding: "utf8" });
        const paths = names.map((name) => posix.join(dir, ...name.split(sep))).filter(keep);
        return Object.fromEntries(paths.map((path) => [path, readFileSync(join(REPO, path), "utf8")]));
    }
    const paths = git("ls-tree", "-r", "-z", "--name-only", rev, "--", dir).split("\0").filter(keep);
    return Object.fromEntries(paths.map((path) => [path, git("show", `${rev}:${path}`)]));
}

export function terminalFiles(rev?: string): Record<string, string> {
    return filesUnder("src/terminal", (path) => /\.tsx?$/.test(path), rev);
}

export function serviceFiles(rev?: string): Record<string, string> {
    return filesUnder("src", (path) => path.endsWith(".ts") && !path.startsWith("src/terminal/"), rev);
}

export function serviceTestFiles(rev?: string): Record<string, string> {
    return filesUnder("test", (path) => /^test\/([^/]+\.test|support|helpers\/izborServer)\.ts$/.test(path), rev);
}

export function shippedFiles(rev?: string): Record<string, string> {
    const shipped = (path: string) => SHIPPED.test(path);
    return {
        ...filesUnder("src", shipped, rev),
        ...filesUnder("bin", shipped, rev),
        ...filesUnder("plugin", shipped, rev),
    };
}

function readRatchet(path: string, rev?: string): Ratchet | undefined {
    if (rev === undefined) {
        const file = join(REPO, path);
        return existsSync(file) ? ratchetFrom(readFileSync(file, "utf8"), path) : undefined;
    }
    if (git("ls-tree", "--name-only", rev, "--", path) === "") return undefined;
    return ratchetFrom(git("show", `${rev}:${path}`), path);
}

type Metrics = ReturnType<typeof measure>;

function columns(rows: readonly (readonly (string | number)[])[]): string[] {
    const widths: number[] = [];
    const numeric: boolean[] = [];
    for (const row of rows)
        row.forEach((cell, at) => {
            widths[at] = Math.max(widths[at] ?? 0, String(cell).length);
            numeric[at] = numeric[at] || typeof cell === "number";
        });
    const pad = (cell: string | number, at: number) =>
        numeric[at] ? String(cell).padStart(widths[at] ?? 0) : String(cell).padEnd(widths[at] ?? 0);
    return rows.map((row) => row.map(pad).join("  ").trimEnd());
}

const section = (title: string, lines: readonly string[]) =>
    [title, ...(lines.length > 0 ? lines : ["none"])].join("\n");

const list = (title: string, items: readonly string[]) => [
    title,
    ...(items.length > 0 ? items : ["none"]).map((item) => `  ${item}`),
];

function report(metrics: Metrics, ratchet: Ratchet | undefined): string {
    const ids = Object.keys(metrics.ceilings).sort(byCodeUnit);
    const ceilingCell = (ceiling: number | undefined) => (ratchet ? [ceiling ?? "none"] : []);
    const overCell = (now: number, ceiling: number | undefined, missing: string) =>
        ratchet ? [ceiling === undefined ? missing : now > ceiling ? "over" : ""] : [];
    const long = metrics.functions
        .filter(({ lines }) => lines >= 50)
        .sort((a, b) => b.lines - a.lines || byCodeUnit(a.file, b.file) || a.line - b.line);
    const longestIn = (path: string) =>
        metrics.functions
            .filter(({ file }) => file === path)
            .reduce<Fn | undefined>((longest, fn) => (longest && longest.lines >= fn.lines ? longest : fn), undefined);
    const total = metrics.files.reduce((sum, { lines }) => sum + lines, 0);
    return (
        [
            section(
                "Ceilings",
                columns([
                    ["id", "now", ...(ratchet ? ["ceiling"] : [])],
                    ...ids.map((id) => {
                        const now = own(metrics.ceilings, id) ?? 0;
                        const ceiling = ratchet && own(ratchet.ceilings, id);
                        return [id, now, ...ceilingCell(ceiling), ...overCell(now, ceiling, "no ceiling")];
                    }),
                ]),
            ),
            section(
                "Long functions (50 lines or more)",
                columns([
                    ["lines", ...(ratchet ? ["ceiling"] : []), "name", "where"],
                    ...long.map(({ lines, name, file, line }) => {
                        const ceiling = ratchet && own(ratchet.functions, name);
                        return [
                            lines,
                            ...ceilingCell(ceiling),
                            name,
                            `${file}:${line}`,
                            ...overCell(lines, ceiling, ""),
                        ];
                    }),
                ]),
            ),
            section(
                "Files",
                columns([
                    ["lines", "path", "longest function"],
                    ...metrics.files.map(({ path, lines }) => {
                        const longest = longestIn(path);
                        return [lines, path, longest ? `${longest.name} (${longest.lines})` : "none"];
                    }),
                    [total, "total", ""],
                ]),
            ),
            section(
                "Effects",
                columns([
                    ["lines", "hook", "in", "deps", "where"],
                    ...metrics.effects.map((effect) => [
                        effect.lines,
                        effect.hook,
                        effect.in,
                        String(effect.deps),
                        `${effect.file}:${effect.line}`,
                    ]),
                ]),
            ),
            section(
                "Per-file counts",
                columns([
                    ["useRef", "ref props", "color={color}", "deepest ?:", "path"],
                    ...metrics.files.map((file) => [
                        file.useRef,
                        file.refProps,
                        file.colorProps,
                        file.deepestTernary,
                        file.path,
                    ]),
                ]),
            ),
            section(
                "Smell hits",
                columns(SMELLS.flatMap((smell) => (metrics.smells[smell] ?? []).map((at) => [`smells.${smell}`, at]))),
            ),
            section("Imports", [
                ...list("Value names a .tsx file imports from controller.ts:", metrics.viewToControllerValues),
                ...list(
                    "Value cycles:",
                    metrics.valueCycles.map((group) => group.join(", ")),
                ),
                ...list("Files that import ink:", metrics.inkImporters),
                ...list(
                    "Every edge:",
                    columns(
                        metrics.edges.map(({ from, line, to, value }) => [
                            `${from}:${line}`,
                            "->",
                            to,
                            value ? "value" : "type",
                        ]),
                    ),
                ),
            ]),
        ].join("\n\n") + "\n"
    );
}

const USAGE = `Usage: node --import tsx scripts/terminal-metrics.ts [--service] [--rev <commit> | --lower-ratchet]
Measures every .ts and .tsx file under src/terminal and prints the report, with each ceiling of
test/terminal-ratchet.json beside its number. Exits 1 when a number is over its ceiling.
  --service         measure every .ts file of src/ outside src/terminal instead, with one greps.* count for each
                    row of SERVICE_GREPS, against test/service-ratchet.json
  --rev <commit>    measure that commit's files and ratchet, read from git, instead of the working tree
  --lower-ratchet   lower the ratchet file to the working tree's numbers and print each change
`;

function usage(): number {
    process.stderr.write(USAGE);
    return 2;
}

function main(args: string[]): number {
    const options = {
        service: { type: "boolean" },
        rev: { type: "string" },
        "lower-ratchet": { type: "boolean" },
    } as const;
    let values: { service?: boolean | undefined; rev?: string | undefined; "lower-ratchet"?: boolean | undefined };
    try {
        values = parseArgs({ args, options, strict: true, allowPositionals: false }).values;
    } catch {
        return usage();
    }
    if (values.rev !== undefined && values["lower-ratchet"]) return usage();
    const path = values.service ? SERVICE_RATCHET : RATCHET;
    const metrics = values.service
        ? measureService(serviceFiles(values.rev), serviceTestFiles(values.rev), shippedFiles(values.rev))
        : measure(terminalFiles(values.rev));
    const ratchet = readRatchet(path, values.rev);
    if (values["lower-ratchet"]) {
        const lowered = lowerRatchet(metrics, ratchet);
        writeFileSync(join(REPO, path), ratchetText(lowered));
        const changed = changes(ratchet, lowered);
        process.stdout.write((changed.length > 0 ? changed : [`${path} is unchanged.`]).join("\n") + "\n");
        return 0;
    }
    process.stdout.write(report(metrics, ratchet));
    const over = ratchet ? overCeilings(metrics, ratchet, path) : [];
    if (over.length === 0) return 0;
    process.stderr.write(over.join("\n") + "\n");
    return 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
