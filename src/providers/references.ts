import * as vscode from "vscode";

import { CancellationToken, ExtensionContext, Location, Position, Range, ReferenceContext, ReferenceProvider, TextDocument, Uri } from "vscode";

import { globals } from "../extension";

interface ReferenceResponse {
    uri: string;
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
}

interface QueuedRequest {
    uri: Uri;
    position: Position;
    includeDeclaration: boolean;
    token?: CancellationToken;
    resolve: (value: Location[] | null) => void;
}

export class GDReferenceProvider implements ReferenceProvider {
    private referenceCache = new Map<string, Location[]>();

    private requestQueue: QueuedRequest[] = [];
    private isProcessing = false;

    constructor(private context: ExtensionContext) {
        const selector = [{ language: "gdscript", scheme: "file" }];
        const referencesDisposable = vscode.languages.registerReferenceProvider(selector, this);
        context.subscriptions.push(referencesDisposable);

        vscode.workspace.onDidChangeTextDocument(event => {
            this.invalidateCacheForFile(event.document.uri);
        });
    }

    public async provideReferences(
        document: TextDocument,
        position: Position,
        context: ReferenceContext,
        token?: CancellationToken
    ): Promise<Location[] | null> {
        const uri = document.uri;
        const includeDeclaration = context.includeDeclaration;

        const cacheKey = this.getCacheKey(uri, position);

        if (this.referenceCache.has(cacheKey)) {
            const references = this.referenceCache.get(cacheKey);
            return this.filterReferences(references, uri, position, includeDeclaration);
        }

        return new Promise<Location[] | null>((resolve, reject) => {
            this.requestQueue.push({
                uri,
                position,
                includeDeclaration,
                token,
                resolve,
            });
            this.processQueue();
        });
    }

    private getCacheKey(uri: Uri, position: Position): string {
        return `${uri.fsPath}:${position.line}:${position.character}`;
    }

    private filterReferences(references: Location[], uri: Uri, position: Position, includeDeclaration: boolean): Location[] {
        return includeDeclaration ? references : references.filter(loc =>
                !(loc.uri.fsPath === uri.fsPath && loc.range.start.isEqual(position))
            );
    }

    private async processQueue() {
        if (this.isProcessing || this.requestQueue.length === 0) return;

        this.isProcessing = true;

        while (this.requestQueue.length > 0) {
            const cancelledRequests = new Set<QueuedRequest>();
            for (const request of this.requestQueue) {
                if (request.token?.isCancellationRequested) {
                    request.resolve(null);
                    cancelledRequests.add(request);
                }
            }
            if (cancelledRequests.size > 0) {
                this.requestQueue = this.requestQueue.filter(r => !cancelledRequests.has(r));
                continue;
            }

            const request = this.requestQueue.at(0);
            const uri = request.uri;
            const position = request.position;

            const cacheKey = this.getCacheKey(uri, position);

            const references = await this.requestReferences(uri, position);
            this.referenceCache.set(cacheKey, references);

            const requestsToResolve = new Set<QueuedRequest>();
            for (const request of this.requestQueue) {
                if (request.uri.fsPath === uri.fsPath && request.position.isEqual(position)) {
                    requestsToResolve.add(request);
                }
            }
            for (const request of requestsToResolve) {
                const result = this.filterReferences(references, uri, position, request.includeDeclaration);
                request.resolve(result);
            }
            this.requestQueue = this.requestQueue.filter(r => !requestsToResolve.has(r));
        }

        this.isProcessing = false;
    }

    private async requestReferences(uri: Uri, position: Position): Promise<Location[]> {
        const result = await globals.lsp.client.send_request<ReferenceResponse[]>("textDocument/references", {
            textDocument: { uri: uri.toString() },
            position: position,
            context: { includeDeclaration: true }
        });

        return result.map(response => new Location(
            Uri.parse(response.uri),
            new Range(
                new Position(response.range.start.line, response.range.start.character),
                new Position(response.range.end.line, response.range.end.character)
            )
        ));
    }

    private invalidateCacheForFile(uri: Uri) {
        const changedKeyStart = `${uri.fsPath}:`;

        const keysToDelete = new Set<string>();

        for (const [key, locations] of this.referenceCache) {
            if (key.startsWith(changedKeyStart)) {
                keysToDelete.add(key);
                continue;
            }

            for (const location of locations) {
                if (location.uri.fsPath === uri.fsPath) {
                    keysToDelete.add(key);
                    break;
                }
            }
        }

        for (const key of keysToDelete) {
            this.referenceCache.delete(key);
        }
    }
}