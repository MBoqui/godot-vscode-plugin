import {
    CancellationToken,
    CodeAction,
    CodeActionKind,
    CodeActionProvider,
    ExtensionContext,
    ProviderResult,
    Range,
    TextDocument,
    WorkspaceEdit,
    languages,
} from "vscode";

class ConvertToPrivateSetterPropertyAction extends CodeAction {
    constructor(document: TextDocument, range: Range) {
        super("Convert to public property with private setter", CodeActionKind.RefactorRewrite);

        const regexPattern = /^(\s*)(static)?\s*var\s+_?(\w+)(?::\s*(.+))?$/;
        const line = document.lineAt(range.start.line);
        const text = line.text.trimEnd();

        const match = text.match(regexPattern);
        if (!match) {
            this.disabled = { reason: "The selected line does not match the expected variable declaration pattern." };
            return;
        }

        const leading = match[1];
        const isStatic = !!match[2];
        const name = match[3];
        const type = match[4] ?? "";

        const typeAnnotation = type ? `: ${type}` : "";
        const replacement = isStatic
            ? `${leading}static var ${name}${typeAnnotation}:\n${leading}\tset(x): assert(false, \"Private setter\")\n${leading}\tget(): return _${name}\n${leading}static var _${name}${typeAnnotation}`
            : `${leading}var ${name}${typeAnnotation}:\n${leading}\tset(x): assert(false, \"Private setter\")\n${leading}\tget(): return _${name}\n${leading}var _${name}${typeAnnotation}`;

        const edit = new WorkspaceEdit();
        edit.replace(document.uri, line.range, replacement);
        this.edit = edit;
    }
}

export class GDCodeActionProvider implements CodeActionProvider {
    constructor(private context: ExtensionContext) {
        const selector = [{ language: "gdscript", scheme: "file" }];
        const providerDisposable = languages.registerCodeActionsProvider(selector, this);
        context.subscriptions.push(providerDisposable);
    }

    public provideCodeActions(
        document: TextDocument,
        range: Range,
        _context: any,
        _token: CancellationToken
    ): ProviderResult<CodeAction[]> {
        const actions: CodeAction[] = [];

        actions.push(new ConvertToPrivateSetterPropertyAction(document, range));

        return actions;
    }
}
