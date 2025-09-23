import * as vscode from "vscode";

import { ExtensionContext } from "vscode";
import { get_configuration } from "../utils";
import { globals } from "../extension";

const grayDecoration = vscode.window.createTextEditorDecorationType({
        color: "#888888",
    });

export class DecorationsProvider {
    private cachedConfig: Record<string, boolean> = {};

    constructor(private context: ExtensionContext) {
        if (vscode.window.activeTextEditor) {
            this.highlightUnusedSymbols(vscode.window.activeTextEditor);
        }

        this.updateCachedConfig();
                const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration("godotTools")) {
                        this.updateCachedConfig();
                    }
                });

        context.subscriptions.push(
            configChangeDisposable,

            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    this.highlightUnusedSymbols(editor);
                }
            }),

            vscode.workspace.onDidChangeTextDocument(event => {
                const editor = vscode.window.activeTextEditor;
                if (editor && event.document === editor.document) {
                    this.highlightUnusedSymbols(editor);
                }
            })
        );
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

    async highlightUnusedSymbols(editor: vscode.TextEditor) {
        if (!editor) return;

        const decorations: vscode.DecorationOptions[] = [];

        const funcRegex = /^(?:static\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*(->\s*[^:]+)?\s*:/m;
        const varRegex = /^(?:@[a-zA-Z_][a-zA-Z0-9_]*\s+)?(?:static\s+)?var\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
        const constRegex = /^const\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
        const signalRegex = /^signal\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
        const enumRegex = /^enum\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
        const classNameRegex = /^class_name\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;
        const classRegex = /^class\s+([a-zA-Z_][a-zA-Z0-9_]*)/m;

        const matchers = [
                { regex: funcRegex, enabled: this.cachedConfig.func },
                { regex: varRegex, enabled: this.cachedConfig.var },
                { regex: constRegex, enabled: this.cachedConfig.const },
                { regex: signalRegex, enabled: this.cachedConfig.signal },
                { regex: enumRegex, enabled: this.cachedConfig.enum },
                { regex: classNameRegex, enabled: this.cachedConfig.className },
                { regex: classRegex, enabled: this.cachedConfig.class },
            ];

        const text = editor.document.getText();
        const lines = text.split("\n");

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            let match: RegExpExecArray | null = null;
            let symbolName: string | undefined;
            let matchIndex: number | undefined;

            for (const matcher of matchers) {
                if (!matcher.enabled) continue;
                const m = matcher.regex.exec(line);
                if (m && m.index !== undefined) {
                    match = m;
                    symbolName = m[1];
                    matchIndex = m.index;
                    break;
                }
            }

            if (!match || !symbolName || matchIndex === undefined) {
                continue;
            }

            const nameIndex = line.indexOf(symbolName, matchIndex);
            const range = new vscode.Range(
                new vscode.Position(lineIndex, nameIndex),
                new vscode.Position(lineIndex, nameIndex + symbolName.length)
            );

            const references = await getReferences({
                FileUri: editor.document.uri,
                Line: range.start.line,
                Column: range.start.character
            });

            if (!references || references.length <= 1) {
                decorations.push({ range });
            }
        }

        editor.setDecorations(grayDecoration, decorations);
    }
}

interface ReferenceRequest {
    FileUri: vscode.Uri;
    Line: number;
    Column: number;
}

interface ReferenceLocation {
    uri: string;
    range: vscode.Range;
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