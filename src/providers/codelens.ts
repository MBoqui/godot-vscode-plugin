import * as vscode from "vscode";
import { CancellationToken, CodeLens, CodeLensProvider, Event, ExtensionContext, TextDocument } from "vscode";
import { get_configuration } from "../utils";
import { globals } from "../extension";

interface ReferenceRequest {
    FileUri: vscode.Uri;
    Line: number;
    Column: number;
}

interface ReferenceLocation {
    uri: string;
    range: vscode.Range;
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

    constructor(private context: ExtensionContext) {
        const selector = [{ language: "gdscript", scheme: "file" }];
        const providerDisposable = vscode.languages.registerCodeLensProvider(selector, this);
        context.subscriptions.push(providerDisposable);
    }

    public async provideCodeLenses(
        document: TextDocument,
        _token: CancellationToken
    ): Promise<CodeLens[]> {
        if (!get_configuration("referencesCodeLens.enabled")) {
            return [];
        }

        const codeLenses: CodeLens[] = [];
        const lines = document.getText().split("\n");

        const matchers = [
            { regex: this.funcRegex, enabled: () => get_configuration("referencesCodeLens.func") },
            { regex: this.varRegex, enabled: () => get_configuration("referencesCodeLens.var") },
            { regex: this.constRegex, enabled: () => get_configuration("referencesCodeLens.const") },
            { regex: this.signalRegex, enabled: () => get_configuration("referencesCodeLens.signal") },
            { regex: this.enumRegex, enabled: () => get_configuration("referencesCodeLens.enum") },
            { regex: this.classNameRegex, enabled: () => get_configuration("referencesCodeLens.className") },
            { regex: this.classRegex, enabled: () => get_configuration("referencesCodeLens.class") },
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let match: RegExpExecArray | null = null;
            for (const matcher of matchers) {
                if (!matcher.enabled()) continue;
                const type_match = matcher.regex.exec(line);
                if (type_match) {
                    match = type_match;
                    break;
                }
            }

            if (!match || match.index === undefined) {
                continue;
            }

            await this.provideReferences(match, line, i, document.uri, codeLenses);
            await this.provideOverride(match, line, i, document.uri, codeLenses);
        }

        return codeLenses;
    }

    private async provideReferences(
        match: RegExpExecArray,
        line: string,
        lineIndex: number,
        documentUri: vscode.Uri,
        codeLenses: CodeLens[]
    ) {
        const symbolName = match[1];
        const nameIndex = line.indexOf(symbolName, match.index);
        const range = new vscode.Range(
            new vscode.Position(lineIndex, nameIndex),
            new vscode.Position(lineIndex, nameIndex + symbolName.length)
        );

        const locations = await globals.lsp.client.sendRequest("textDocument/definition", {
            textDocument: { uri: documentUri.toString() },
            position: { line: range.start.line, character: range.start.character }
        });

        if (!locations || (Array.isArray(locations) && locations.length === 0)) {
            return;
        }

        const references = await getReferences({
            FileUri: documentUri,
            Line: range.start.line,
            Column: range.start.character
        });

        if (!references || references.length <= 1) {
            return;
        }

        const remappedLocations = references
            .map(loc => new vscode.Location(vscode.Uri.parse(loc.uri), loc.range))
            .filter(loc => loc.range.start.line !== range.start.line);

        const count = remappedLocations.length;
        if (count === 0) {
            return;
        }

        codeLenses.push(new CodeLens(range, {
            title: count === 1 ? "1 reference" : `${count} references`,
            command: "editor.action.showReferences",
            arguments: [documentUri, range.start, remappedLocations]
        }));
    }

    private async provideOverride(
        match: RegExpExecArray,
        line: string,
        lineIndex: number,
        documentUri: vscode.Uri,
        codeLenses: CodeLens[]
    ) {
        const symbolName = match[1];
        const nameIndex = line.indexOf(symbolName, match.index);
        const range = new vscode.Range(
            new vscode.Position(lineIndex, nameIndex),
            new vscode.Position(lineIndex, nameIndex + symbolName.length)
        );

        const locations = await globals.lsp.client.sendRequest("textDocument/definition", {
            textDocument: { uri: documentUri.toString() },
            position: { line: range.start.line, character: range.start.character }
        });
        if (!locations || (Array.isArray(locations) && locations.length === 0)) {
            codeLenses.push(new CodeLens(range, {
                title: "overrides native",
                command: '',
                arguments: []
            }));
            return;
        }
        const loc = Array.isArray(locations) ? locations[0] : locations;
        const isSameFile = vscode.Uri.parse(loc.uri).toString() === documentUri.toString();
        const isSameLine = loc.range?.start?.line === range.start.line;
        if (isSameFile && isSameLine) {
            return;
        }
        const file = vscode.Uri.parse(loc.uri).fsPath.split(/[/\\]/).pop();
        const lineNum = (loc.range?.start?.line ?? 0) + 1;
        codeLenses.push(new CodeLens(range, {
            title: `overrides: ${file}:${lineNum}`,
            command: '',
            arguments: []
        }));
    }

    public async resolveCodeLens(
        codeLens: CodeLens,
        _token: CancellationToken
    ): Promise<CodeLens | null> {
        if (!get_configuration("referencesCodeLens.enabled")) {
            return null;
        }
        return codeLens;
    }
}

async function getReferences(request: ReferenceRequest): Promise<ReferenceLocation[]> {
    return await globals.lsp.client.sendRequest("textDocument/references", {
        textDocument: { uri: request.FileUri.toString() },
        position: {
            line: request.Line,
            character: request.Column
        },
        context: { includeDeclaration: false }
    });
}