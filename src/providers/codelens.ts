import * as vscode from "vscode";

import { CancellationToken, CodeLens, CodeLensProvider, Event, ExtensionContext, Location, Position, Range, TextDocument, Uri } from "vscode";

import { get_configuration } from "../utils";
import { globals } from "../extension";

class ReferenceCodeLens extends CodeLens {
    document: TextDocument;

    constructor(document: TextDocument, range: Range) {
        super(range);
        this.document = document;
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

class OverrideCodeLens extends CodeLens {
    uri: Uri;

    constructor(uri: Uri, range: Range) {
        super(range);
        this.uri = uri;
    }

    async resolve(token: CancellationToken): Promise<CodeLens> {
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

export class GDCodeLensProvider implements CodeLensProvider {
    public readonly onDidChangeCodeLenses?: Event<void>;

    private funcRegex = /^(?:@[a-zA-Z_][a-zA-Z0-9_]*\s+)?(?:static\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*(->\s*[^:]+)?\s*:??/m;
    private varRegex = /^(?:@[a-zA-Z_][a-zA-Z0-9_]*\s+)?(?:static\s+)?var\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
    private constRegex = /^const\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
    private signalRegex = /^signal\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
    private enumRegex = /^enum\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
    private classNameRegex = /^class_name\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
    private classRegex = /^class\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;

    private cachedConfig: Record<string, boolean> = {};

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
            enabled: get_configuration("referencesCodeLens.enabled", true),
            func: get_configuration("referencesCodeLens.func", true),
            var: get_configuration("referencesCodeLens.var", true),
            const: get_configuration("referencesCodeLens.const", true),
            signal: get_configuration("referencesCodeLens.signal", true),
            enum: get_configuration("referencesCodeLens.enum", true),
            className: get_configuration("referencesCodeLens.className", true),
            class: get_configuration("referencesCodeLens.class", true),
        };
    }

    public async provideCodeLenses(
        document: TextDocument,
        token: CancellationToken
    ): Promise<CodeLens[]> {
        if (token.isCancellationRequested) {
            return [];
        }
        if (!this.cachedConfig.enabled) {
            return [];
        }

        const codeLenses: CodeLens[] = [];
        const lines = document.getText().split("\n");

        const matchers = [
            { regex: this.funcRegex, enabled: this.cachedConfig.func },
            { regex: this.varRegex, enabled: this.cachedConfig.var },
            { regex: this.constRegex, enabled: this.cachedConfig.const },
            { regex: this.signalRegex, enabled: this.cachedConfig.signal },
            { regex: this.enumRegex, enabled: this.cachedConfig.enum },
            { regex: this.classNameRegex, enabled: this.cachedConfig.className },
            { regex: this.classRegex, enabled: this.cachedConfig.class },
        ];

        for (let i = 0; i < lines.length; i++) {
            if (token.isCancellationRequested) {
                return [];
            }
            const line = lines[i];
            let match: RegExpExecArray | null = null;
            for (const matcher of matchers) {
                if (!matcher.enabled) continue;
                const type_match = matcher.regex.exec(line);
                if (type_match) {
                    match = type_match;
                    break;
                }
            }

            if (!match || match.index === undefined) {
                continue;
            }

            const symbolName = match[1];
            const nameIndex = line.indexOf(symbolName, match.index);
            const range = new Range(
                new Position(i, nameIndex),
                new Position(i, nameIndex + symbolName.length)
            );

            codeLenses.push(new ReferenceCodeLens(document, range));
            codeLenses.push(new OverrideCodeLens(document.uri, range));
        }
        return codeLenses;
    }

    public async resolveCodeLens(
        codeLens: CodeLens,
        token: CancellationToken
    ): Promise<CodeLens | null> {
        if (token.isCancellationRequested) {
            return null;
        }
        if (!this.cachedConfig.enabled) {
            return null;
        }
        if (codeLens instanceof ReferenceCodeLens || codeLens instanceof OverrideCodeLens) {
            return await codeLens.resolve(token);
        }
        return codeLens;
    }
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
