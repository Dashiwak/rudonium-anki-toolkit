/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
export const pendingAnkiWriteMessage = 'AnkiConnect is still processing a previous write. Check Anki and retry after the connection settles.'

const pendingWrites = new WeakMap<object, Promise<unknown>>()

export class AnkiWritePendingError extends Error {
    constructor() {
        super(pendingAnkiWriteMessage)
        this.name = 'AnkiWritePendingError'
    }
}

export function hasPendingAnkiWrite(scope: object): boolean {
    return pendingWrites.has(scope)
}

export function withAnkiDeadline<T>(operation: () => Promise<T>, description: string,
    timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    const cancellation = () => new DOMException(`${description} cancelled.`, 'AbortError')
    if (signal?.aborted) return Promise.reject(cancellation())
    return new Promise((resolve, reject) => {
        const abort = () => {
            cleanup()
            reject(cancellation())
        }
        const timer = window.setTimeout(() => {
            cleanup()
            reject(new DOMException(`${description} did not respond within ${timeoutMs / 1000} seconds.`, 'TimeoutError'))
        }, timeoutMs)
        function cleanup(): void {
            window.clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
        }
        signal?.addEventListener('abort', abort, { once: true })
        void Promise.resolve().then(() => {
            if (signal?.aborted) throw cancellation()
            return operation()
        }).then(
            value => { cleanup(); resolve(value) },
            (error: unknown) => {
                cleanup()
                reject(error instanceof Error ? error : new Error(String(error)))
            },
        )
    })
}

export function withAnkiWriteDeadline<T>(scope: object, operation: () => Promise<T>, description: string,
    timeoutMs = 60_000): Promise<T> {
    if (hasPendingAnkiWrite(scope)) return Promise.reject(new AnkiWritePendingError())
    const transport = Promise.resolve().then(operation)
    pendingWrites.set(scope, transport)
    const release = () => {
        if (pendingWrites.get(scope) === transport) pendingWrites.delete(scope)
    }
    void transport.then(release, release)
    return withAnkiDeadline(() => transport, description, timeoutMs)
}

export function isDuplicateFirstFieldErrorMessage(error: string): boolean {
    return /^cannot create note because it is (?:a )?duplicate[.!]?$/i.test(error.trim())
}

export function isDefiniteAddNoteRejection(error: unknown): boolean {
    return typeof error === 'string' && (isDuplicateFirstFieldErrorMessage(error) ||
        /^(?:cannot create note because it is empty[.!]?|(?:model|deck) was not found:\s*.+)$/i.test(error.trim()))
}
