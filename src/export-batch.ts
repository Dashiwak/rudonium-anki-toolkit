/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
import type { AnkiConnectRequest } from './anki'
import { AnkiWritePendingError, hasPendingAnkiWrite, isDefiniteAddNoteRejection, pendingAnkiWriteMessage, withAnkiDeadline, withAnkiWriteDeadline } from './anki-transport'

interface PendingAction {
    request: AnkiConnectRequest
    replies: unknown[]
    index: number
    bytes?: number
}

interface ExportBatchResult {
    responses: unknown[]
    problem?: string
    uncertain: boolean
}

interface ExportBatchOptions {
    scope?: object
    timeoutMs?: number
    onResponse?: () => void
    prepareJournalPacket?: (packet: readonly AnkiConnectRequest[]) => Promise<void>
    observeJournalResponse?: (request: AnkiConnectRequest, response: unknown, unsent: boolean) => void
    reviewEveryPacket?: boolean
    preparePacket?: (packet: readonly AnkiConnectRequest[]) => Promise<{
        reject?: ReadonlyMap<AnkiConnectRequest, string>
        problem?: string
    }>
}

const maxActions = 500
const maxBytes = 2 * 1024 * 1024
const encoder = new TextEncoder()
const emptyPacketBytes = encoder.encode(JSON.stringify({ action: 'multi', version: 6, params: { actions: [] } })).length
const unsent = Symbol('Anki action was not sent')

export function isUnsentExportResponse(response: unknown): boolean {
    return typeof response === 'object' && response !== null && unsent in response
}

function collectActions(requests: readonly AnkiConnectRequest[], replies: unknown[], pending: PendingAction[]): void {
    for (const request of requests) {
        if (request.action === 'multi') {
            const nested: unknown[] = []
            replies.push({ result: nested, error: null })
            collectActions(request.params.actions, nested, pending)
        } else {
            pending.push({ request, replies, index: replies.length })
            replies.push(undefined)
        }
    }
}

function isEnvelope(response: unknown): response is { result: unknown; error: string | null } {
    if (typeof response !== 'object' || response === null || !('result' in response) || !('error' in response)) return false
    const { result, error } = response
    return result !== undefined && (error === null || (typeof error === 'string' && result === null))
}

function isConfirmedNoteId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export async function sendExportBatches(actions: readonly AnkiConnectRequest[],
    send: (actions: AnkiConnectRequest[]) => Promise<unknown>, isStopRequested?: () => boolean,
    beforeSend?: () => Promise<string | undefined>, options: ExportBatchOptions = {}): Promise<ExportBatchResult> {
    const responses: unknown[] = []
    const pending: PendingAction[] = []
    const createdIds = new Map<number, PendingAction>()
    collectActions(actions, responses, pending)

    let offset = 0
    let problem: string | undefined
    let uncertain = false
    const { scope, timeoutMs = 60_000, onResponse, preparePacket, reviewEveryPacket } = options
    while (offset < pending.length) {
        if (isStopRequested?.()) {
            problem = 'Export stopped before sending the next batch.'
            break
        }

        let bytes = emptyPacketBytes
        const packet: AnkiConnectRequest[] = []
        while (offset + packet.length < pending.length && packet.length < maxActions) {
            const action = pending[offset + packet.length]
            action.bytes ??= encoder.encode(JSON.stringify(action.request)).length
            const added = action.bytes + (packet.length ? 1 : 0)
            if (packet.length && bytes + added > maxBytes) break
            packet.push(action.request)
            bytes += added
        }
        if (options.prepareJournalPacket) {
            try {
                await options.prepareJournalPacket(packet)
            } catch (error) {
                problem = error instanceof Error ? error.message : String(error)
                break
            }
        }
        let rejected: ReadonlyMap<AnkiConnectRequest, string> | undefined
        try {
            if (beforeSend) {
                problem = await beforeSend()
                if (problem) break
                if (isStopRequested?.()) {
                    problem = 'Export stopped before sending the next batch.'
                    break
                }
            }
            if (preparePacket && (reviewEveryPacket || packet.some(request => request.action === 'updateNoteFields' || request.action === 'changeDeck'))) {
                const prepared = await preparePacket(packet)
                problem = prepared.problem
                if (problem) break
                rejected = prepared.reject
                if (isStopRequested?.()) {
                    problem = 'Export stopped before sending the next batch.'
                    break
                }
            }
        } catch (error) {
            // No writes from this packet have reached Anki yet. Preserve earlier replies
            // so their confirmed note IDs can still be recorded after this failure.
            problem = error instanceof Error ? error.message : String(error)
            break
        }

        const outgoing = rejected?.size ? packet.filter(request => !rejected.has(request)) : packet
        let reply: unknown = []
        if (outgoing.length) {
            if (scope && hasPendingAnkiWrite(scope)) {
                problem = pendingAnkiWriteMessage
                break
            }
            try {
                const transmit = () => send(outgoing)
                reply = scope
                    ? await withAnkiWriteDeadline(scope, transmit, 'AnkiConnect write batch', timeoutMs)
                    : await withAnkiDeadline(transmit, 'AnkiConnect write batch', timeoutMs)
                onResponse?.()
            } catch (error) {
                if (error instanceof AnkiWritePendingError) {
                    problem = error.message
                    break
                }
                problem = `Anki did not confirm the submitted batch. ${error instanceof Error ? error.message : String(error)}`
            }
        }
        const rows = Array.isArray(reply) && reply.length === outgoing.length ? reply : undefined
        if (!rows && !problem) problem = 'Anki returned an incomplete or malformed batch response.'
        const end = offset + packet.length
        let sentIndex = 0
        for (let index = offset; index < end; index++) {
            const { request, replies, index: position } = pending[index]
            const reason = rejected?.get(request)
            if (reason !== undefined) {
                replies[position] = { result: null, error: 'This action was not sent. ' + reason, [unsent]: true }
                continue
            }
            const row: unknown = rows?.[sentIndex++]
            if (isEnvelope(row)) {
                replies[position] = row
                if (request.action !== 'addNote') continue
                if (row.error === null && isConfirmedNoteId(row.result)) {
                    const previous = createdIds.get(row.result)
                    if (!previous) {
                        createdIds.set(row.result, pending[index])
                        continue
                    }
                    const error = 'Anki returned the same ID for different creations: ' + row.result
                    previous.replies[previous.index] = replies[position] = { result: null, error }
                    problem ??= error
                    uncertain = true
                } else if (row.error === null || !isDefiniteAddNoteRejection(row.error)) {
                    uncertain = true
                    problem ??= 'Anki returned an unconfirmed creation result. Review pending creations before retrying.'
                }
            } else {
                uncertain = true
                problem ??= 'Anki returned an incomplete or malformed batch response.'
                replies[position] = { result: null, error: problem }
            }
        }
        offset = end
        if (problem) break
    }
    if (problem) {
        for (let index = offset; index < pending.length; index++) {
            const { replies, index: position } = pending[index]
            replies[position] = { result: null, error: 'This action was not sent. ' + problem, [unsent]: true }
        }
    }
    if (options.observeJournalResponse) for (const { request, replies, index } of pending) {
        const response = replies[index]
        options.observeJournalResponse(request, response, isUnsentExportResponse(response))
    }
    return { responses, problem, uncertain }
}
