import * as vscode from "vscode";

import { CancellationToken, CodeLens, CodeLensProvider, Event, ExtensionContext, TextDocument } from "vscode";

import { get_configuration } from "../utils";
import { globals } from "../extension";

interface SymbolRequest {
    FileUri: vscode.Uri;
    Line: number;
    Column: number;
}

interface SymbolLocation {
    uri: string;
    range: vscode.Range;
}

class ReferenceCodeLens extends vscode.CodeLens {
    symbolName: string;
    documentUri: string;

    constructor(range: vscode.Range, symbolName: string, documentUri: string) {
        super(range);
        this.symbolName = symbolName;
        this.documentUri = documentUri;
    }

    async resolve(token: CancellationToken): Promise<vscode.CodeLens> {
        if (token.isCancellationRequested) {
            return null;
        }
        const range = this.range;
        const locations = await getDefinition({
            FileUri: vscode.Uri.parse(this.documentUri),
            Line: range.start.line,
            Column: range.start.character
        }, token);
        if (token.isCancellationRequested) {
            return null;
        }
        if (!locations || (Array.isArray(locations) && locations.length === 0)) {
            return null;
        }

        const references = await getReferences({
            FileUri: vscode.Uri.parse(this.documentUri),
            Line: range.start.line,
            Column: range.start.character
        }, token);
        if (token.isCancellationRequested) {
            return null;
        }
        if (!references || references.length <= 1) {
            return null;
        }

        const remappedLocations = references
            .map(loc => new vscode.Location(vscode.Uri.parse(loc.uri), loc.range))
            .filter(loc => loc.range.start.line !== range.start.line);
        const count = remappedLocations.length;
        if (count === 0) {
            return null;
        }

        this.command = {
            title: count === 1 ? "1 reference" : `${count} references`,
            command: "editor.action.showReferences",
            arguments: [vscode.Uri.parse(this.documentUri), range.start, remappedLocations]
        };
        return this;
    }
}

class OverrideCodeLens extends vscode.CodeLens {
    symbolName: string;
    documentUri: string;

    constructor(range: vscode.Range, symbolName: string, documentUri: string) {
        super(range);
        this.symbolName = symbolName;
        this.documentUri = documentUri;
    }

    async resolve(token: CancellationToken): Promise<vscode.CodeLens> {
        if (token.isCancellationRequested) {
            return null;
        }
        const range = this.range;
        const locations = await getDefinition({
            FileUri: vscode.Uri.parse(this.documentUri),
            Line: range.start.line,
            Column: range.start.character
        }, token);
        if (token.isCancellationRequested) {
            return null;
        }
        if (!locations || (Array.isArray(locations) && locations.length === 0)) {
            this.command = {
                title: "overrides native",
                command: "",
                arguments: []
            };
            return this;
        }

        const loc = Array.isArray(locations) ? locations[0] : locations;
        const isSameFile = vscode.Uri.parse(loc.uri).toString() === this.documentUri;
        const isSameLine = loc.range?.start?.line === range.start.line;
        if (isSameFile && isSameLine) {
            return null;
        }

        const file = vscode.Uri.parse(loc.uri).fsPath.split(/[/\\]/).pop();
        const lineNum = (loc.range?.start?.line ?? 0) + 1;
        this.command = {
            title: `overrides: ${file}:${lineNum}`,
            command: "vscode.open",
            arguments: [
            vscode.Uri.parse(loc.uri),
            { selection: new vscode.Range(loc.range.start, loc.range.start) }
            ]
        };
        return this;
    }
}


export class GDCodeLensProvider implements CodeLensProvider {
    public readonly onDidChangeCodeLenses?: Event<void>;

    private funcRegex = /^(?:static\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*(->\s*[^:]+)?\s*:/m;
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
            const range = new vscode.Range(
                new vscode.Position(i, nameIndex),
                new vscode.Position(i, nameIndex + symbolName.length)
            );

            codeLenses.push(new ReferenceCodeLens(range, symbolName, document.uri.toString()));
            codeLenses.push(new OverrideCodeLens(range, symbolName, document.uri.toString()));
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

async function getReferences(request: SymbolRequest, token: CancellationToken): Promise<SymbolLocation[]> {
    return await globals.lsp.client.sendRequest(
        "textDocument/references",
        {
            textDocument: { uri: request.FileUri.toString() },
            position: {
                line: request.Line,
                character: request.Column
            },
            context: { includeDeclaration: false }
        },
        token
    );
}

async function getDefinition(request: SymbolRequest, token: CancellationToken): Promise<SymbolLocation[] | undefined> {
    return await globals.lsp.client.sendRequest(
        "textDocument/definition",
        {
            textDocument: { uri: request.FileUri.toString() },
            position: {
                line: request.Line,
                character: request.Column
            }
        },
        token
    );
}