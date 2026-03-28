import * as vscode from "vscode";

import { CancellationToken, CodeLens, CodeLensProvider, Event, ExtensionContext, Location, Position, Range, TextDocument, Uri } from "vscode";

import { get_configuration } from "../utils";
import { globals } from "../extension";

interface GDCodeLens extends CodeLens {
    resolve(token: CancellationToken): Promise<CodeLens>;
}

class OverrideCodeLens extends CodeLens implements GDCodeLens {
    uri: Uri;

    constructor(uri: Uri, range: Range) {
        super(range);
        this.uri = uri;
    }

    static async provide(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        if (!globals.codeLensProvider.cachedConfig.overrideEnabled) {
            return [];
        }

        const codeLenses: CodeLens[] = [];

        const regexes = [/^(?:@[a-zA-Z_][a-zA-Z0-9_]*\s+)?(?:static\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*(->\s*[^:]+)?\s*:??/m];
        const found_ranges = getMatches(regexes, document);

        for (const range of found_ranges) {
            const lens = new OverrideCodeLens(document.uri, range);
            await lens.resolve(token);

            if (token.isCancellationRequested) {
                return [];
            }

            if (lens.isResolved) {
                codeLenses.push(lens);
            }
        }

        return codeLenses;
    }

    async resolve(token: CancellationToken): Promise<CodeLens> {
        if (this.isResolved) {
            return this;
        }

        if (token.isCancellationRequested) {
            return null;
        }

        const definition = await getDefinition(this.uri, this.range.start);
        if (token.isCancellationRequested) {
            return null;
        }

        if (definition.range.isEqual(this.range) && definition.uri.fsPath === this.uri.fsPath) {
            return null;
        }

        const fileName = definition.uri.fsPath.split(/[/\\]/).pop();
        const lineNumber = (definition.range.start.line) + 1;

        const definitionIsDocs = fileName.endsWith(".gddoc");
        const commandTitle = definitionIsDocs ? "overrides native" : `overrides: ${fileName}:${lineNumber}`;

        this.command = {
            title: commandTitle,
            command: "vscode.open",
            arguments: [
                definition.uri,
                { selection: definition.range }
            ]
        };
        return this;
    }
}

class ReferenceCodeLens extends CodeLens implements GDCodeLens {
    document: TextDocument;

    constructor(document: TextDocument, range: Range) {
        super(range);
        this.document = document;
    }

    static provide(document: TextDocument): CodeLens[] {
        if (!globals.codeLensProvider.cachedConfig.referenceEnabled) {
            return [];
        }

        const funcRegex = /^(?:@[a-zA-Z_][a-zA-Z0-9_]*\s+)?(?:static\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*(->\s*[^:]+)?\s*:??/m;
        const varRegex = /^(?:@[a-zA-Z_][a-zA-Z0-9_]*\s+)?(?:static\s+)?var\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
        const constRegex = /^const\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
        const signalRegex = /^signal\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
        const enumRegex = /^enum\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
        const classNameRegex = /^class_name\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
        const classRegex = /^class\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;

        const matchers = [
            { regex: funcRegex, enabled: globals.codeLensProvider.cachedConfig.referenceFunc },
            { regex: varRegex, enabled: globals.codeLensProvider.cachedConfig.referenceVar },
            { regex: constRegex, enabled: globals.codeLensProvider.cachedConfig.referenceConst },
            { regex: signalRegex, enabled: globals.codeLensProvider.cachedConfig.referenceSignal },
            { regex: enumRegex, enabled: globals.codeLensProvider.cachedConfig.referenceEnum },
            { regex: classNameRegex, enabled: globals.codeLensProvider.cachedConfig.referenceClassName },
            { regex: classRegex, enabled: globals.codeLensProvider.cachedConfig.referenceClass },
        ];

        const codeLenses: CodeLens[] = [];

        const regexes = matchers.filter(m => m.enabled).map(m => m.regex);
        const found_ranges = getMatches(regexes, document);

        for (const range of found_ranges) {
            codeLenses.push(new ReferenceCodeLens(document, range));
        }

        return codeLenses;
    }

    async resolve(token: CancellationToken): Promise<CodeLens> {
        if (token.isCancellationRequested) {
            return null;
        }

        const references = await getReferences(this.document, this.range.start, token);
        if (token.isCancellationRequested) {
            return null;
        }

        const count = references.length;
        this.command = {
            title: count === 1 ? "1 reference" : `${count} references`,
            command: count === 0 ?"" : "editor.action.showReferences",
            arguments: [this.document.uri, this.range.start, references]
        };
        return this;
    }
}

export class GDCodeLensProvider implements CodeLensProvider {
    public readonly onDidChangeCodeLenses?: Event<void>;

    public cachedConfig: Record<string, boolean> = {};

    constructor(private context: ExtensionContext) {
        const selector = [{ language: "gdscript", scheme: "file" }];
        const providerDisposable = vscode.languages.registerCodeLensProvider(selector, this);
        context.subscriptions.push(providerDisposable);

        this.updateCachedConfig();
        const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("godotTools")) {
                this.updateCachedConfig();
            }
        });
        context.subscriptions.push(configChangeDisposable);
    }

    private updateCachedConfig() {
        this.cachedConfig = {
            overrideEnabled: get_configuration("codeLens.override.enabled", true),
            referenceEnabled: get_configuration("codeLens.reference.enabled", true),
            referenceFunc: get_configuration("codeLens.reference.func", true),
            referenceVar: get_configuration("codeLens.reference.var", true),
            referenceConst: get_configuration("codeLens.reference.const", true),
            referenceSignal: get_configuration("codeLens.reference.signal", true),
            referenceEnum: get_configuration("codeLens.reference.enum", true),
            referenceClassName: get_configuration("codeLens.reference.className", true),
            referenceClass: get_configuration("codeLens.reference.class", true),
        };
    }

    public async provideCodeLenses(
        document: TextDocument,
        token: CancellationToken
    ): Promise<CodeLens[]> {
        if (token.isCancellationRequested) {
            return [];
        }

        const codeLenses: CodeLens[] = [];

        if (this.cachedConfig.referenceEnabled) {
            codeLenses.push(...ReferenceCodeLens.provide(document));
        }

        if (this.cachedConfig.overrideEnabled) {
            const overrideLenses = await OverrideCodeLens.provide(document, token);
            codeLenses.push(...overrideLenses);
        }
        return codeLenses;
    }

    public async resolveCodeLens(
        codeLens: GDCodeLens,
        token: CancellationToken
    ): Promise<CodeLens | null> {
        if (token.isCancellationRequested) {
            return null;
        }

        return await codeLens.resolve(token);
    }
}

function getMatches(regexes: RegExp[], document: TextDocument): Range[] {
    const ranges: Range[] = [];

    const lines = document.getText().split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let all_matches: RegExpExecArray | null = null;
        for (const regex of regexes) {
            const match = regex.exec(line);
            if (match) {
                all_matches = match;
                break;
            }
        }

        if (!all_matches || all_matches.index === undefined) {
            continue;
        }

        const symbolName = all_matches[1];
        const nameIndex = line.indexOf(symbolName, all_matches.index);
        const range = new Range(
            new Position(i, nameIndex),
            new Position(i, nameIndex + symbolName.length)
        );

        ranges.push(range);
    }

    return ranges;
}

async function getReferences(document: TextDocument, position: Position, token: CancellationToken): Promise<Location[]> {
    const referenceProvider = globals.referenceProvider;
    return await referenceProvider.provideReferences(
        document,
        position,
        {includeDeclaration: false},
        token
    );
}

async function getDefinition(uri: Uri, position: Position): Promise<Location> {
    const allDefinition = await vscode.commands.executeCommand<Location[]>(
        "vscode.executeDefinitionProvider",
        uri,
        position
    );
    return allDefinition[0];
}
