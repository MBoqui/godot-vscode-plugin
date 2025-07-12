import * as vscode from "vscode";
import { ExtensionContext } from "vscode";
import { globals } from "../extension";

export class DecorationsProvider {
    constructor(private context: ExtensionContext) {
        if (vscode.window.activeTextEditor) {
            highlightUnusedMethods(vscode.window.activeTextEditor);
        }

        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    highlightUnusedMethods(editor);
                }
            }),

            vscode.workspace.onDidChangeTextDocument(event => {
                const editor = vscode.window.activeTextEditor;
                if (editor && event.document === editor.document) {
                    highlightUnusedMethods(editor);
                }
            })
        );
    }
}

const grayDecoration = vscode.window.createTextEditorDecorationType({
    color: "#888888",
});

async function highlightUnusedMethods(editor: vscode.TextEditor) {
    if (!editor) return;

    const decorations: vscode.DecorationOptions[] = [];

    const funcRegex = /^func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*(->\s*[^:]+)?\s*:/m;
    const text = editor.document.getText();
    const lines = text.split("\n");

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const match = funcRegex.exec(line);

        if (!match || match.index == undefined) {
            continue;
        }

        const functionName = match[1];

        const nameIndex = line.indexOf(functionName, match.index);
        const range = new vscode.Range(
            new vscode.Position(lineIndex, nameIndex),
            new vscode.Position(lineIndex, nameIndex + functionName.length)
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