import * as vscode from "vscode";

import { CancellationToken, ExtensionContext, Location, Position, Range, TextDocument } from "vscode";

import { get_configuration } from "../utils";
import { globals } from "../extension";

const grayDecoration = vscode.window.createTextEditorDecorationType({
        color: "#888888",
    });

export class GDDecorationsProvider {
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
            enabled: get_configuration("decoration.noReference.enabled", true),
            func: get_configuration("decoration.noReference.func", true),
            var: get_configuration("decoration.noReference.var", true),
            const: get_configuration("decoration.noReference.const", true),
            signal: get_configuration("decoration.noReference.signal", true),
            enum: get_configuration("decoration.noReference.enum", true),
            className: get_configuration("decoration.noReference.className", true),
            class: get_configuration("decoration.noReference.class", true),
        };
    }

    async highlightUnusedSymbols(editor: vscode.TextEditor) {
        if (!editor) return;
        if (!this.cachedConfig.enabled) return;

        const decorations: vscode.DecorationOptions[] = [];

        const funcRegex = /^(?:@[a-zA-Z_][a-zA-Z0-9_]*\s+)?(?:static\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*(->\s*[^:]+)?\s*:??/m;
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

        const regexes = matchers.filter(m => m.enabled).map(m => m.regex);
        const found_ranges = getMatches(regexes, editor.document);

        for (const range of found_ranges) {
            const references = await getReferences(editor.document, range.start);

            if (!references || references.length <= 0) {
                decorations.push({ range });
            }
        }

        editor.setDecorations(grayDecoration, decorations);
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

async function getReferences(document: TextDocument, position: Position, token?: CancellationToken): Promise<Location[]> {
    const referenceProvider = globals.referenceProvider;
    return await referenceProvider.provideReferences(
        document,
        position,
        {includeDeclaration: false},
        token
    );
}
