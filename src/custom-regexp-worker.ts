/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit, modified 2026-11-19. See NOTICE.md for component attribution and licenses.
 */
export interface CustomRegexpPattern {
    source: string
    flags: string
    label?: string
}

export interface CustomRegexpOptions {
    signal?: AbortSignal
    shouldStop?: () => boolean
    timeoutMs?: number
}

interface WorkerPort {
    send(value: unknown): void
    listen(message: (value: unknown) => void, error: (value: unknown) => void): () => void
    stop(): void
}

type ThreadEvent = 'message' | 'messageerror' | 'error' | 'exit'
interface Thread {
    postMessage(value: unknown): void
    on(name: ThreadEvent, listener: (value: unknown) => void): Thread
    off(name: ThreadEvent, listener: (value: unknown) => void): Thread
    unref(): void
    terminate(): Promise<number>
}

function hasBuiltinLoader(value: unknown): value is { getBuiltinModule(name: string): unknown } {
    return typeof value === 'object' && value !== null && 'getBuiltinModule' in value && typeof value.getBuiltinModule === 'function'
}

function hasThreadWorker(value: unknown): value is { Worker: new (source: string, options: { eval: true }) => Thread } {
    return typeof value === 'object' && value !== null && 'Worker' in value && typeof value.Worker === 'function'
}

const defaultDeadlineMs = 1500
const idleDeadlineMs = 5000
const maxMatchCount = 60000
const maxResultCharacters = 16 * 1024 * 1024
const maxPatternLength = 64 * 1024
const maxPatterns = 512

const workerProgram = String.raw`
function execute(message, send) {
    const { text, patterns, maxMatchCount, maxResultCharacters } = message;
    try {
        let count = 0;
        let size = 0;
        const groups = [];
        for (const pattern of patterns) {
            send({ phase: 'pattern', label: pattern.label });
            const matches = [];
            const expression = new RegExp(pattern.source, pattern.flags);
            for (const match of text.matchAll(expression)) {
                if (++count > maxMatchCount) throw new Error('Too many regular-expression matches in this file.');
                const values = Array.from(match);
                size += values.reduce((total, value) => total + (value === undefined ? 1 : value.length + 1), 0);
                if (match.groups) for (const name of Object.keys(match.groups)) {
                    const value = match.groups[name];
                    size += name.length + (value === undefined ? 1 : value.length + 1);
                }
                if (size > maxResultCharacters) throw new Error('Regular-expression captures exceed the supported size for this file.');
                matches.push({ index: match.index, values, groups: match.groups });
            }
            groups.push(matches);
        }
        send({ phase: 'result', groups });
    } catch (error) {
        send({ phase: 'failure', message: error instanceof Error ? error.message : String(error) });
    }
}
`
const nodeWorkerProgram = workerProgram + String.raw`
const { parentPort } = require('worker_threads');
parentPort.on('message', value => execute(value, answer => parentPort.postMessage(answer)));
`
const browserWorkerProgram = workerProgram + String.raw`
self.addEventListener('message', event => execute(event.data, answer => self.postMessage(answer)));
`

let port: WorkerPort | undefined
let idleTimer: number | undefined
let queue: Promise<void> = Promise.resolve()

export function customRegexpKey({ source, flags }: CustomRegexpPattern): string {
    return JSON.stringify([source, flags])
}

function workerPort(): WorkerPort {
    const runtime: unknown = typeof process === 'undefined' ? undefined : process
    try {
        const threads: unknown = hasBuiltinLoader(runtime) ? runtime.getBuiltinModule('worker_threads') : undefined
        if (hasThreadWorker(threads)) {
            const worker = new threads.Worker(nodeWorkerProgram, { eval: true })
            worker.on('error', () => {})
            worker.unref()
            return {
                send: value => worker.postMessage(value),
                listen(message, error) {
                    const exited = (code: unknown) => error(new Error(`Regular-expression worker exited with code ${String(code)}.`))
                    worker.on('message', message).on('messageerror', error).on('error', error).on('exit', exited)
                    return () => { worker.off('message', message).off('messageerror', error).off('error', error).off('exit', exited) }
                },
                stop: () => { void worker.terminate().catch(() => undefined) },
            }
        }
    } catch {
        // Some Electron windows restrict the module lookup or the worker constructor.
    }
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('This Obsidian environment cannot isolate Custom Regexp. Update Obsidian or disable the expression.')
    }
    const url = URL.createObjectURL(new Blob([browserWorkerProgram], { type: 'text/javascript' }))
    try {
        const worker = new Worker(url)
        return {
            send: value => worker.postMessage(value),
            listen(message, error) {
                const onMessage = (event: MessageEvent) => message(event.data)
                const onError = (event: Event) => error(event instanceof ErrorEvent ? event.message : event.type)
                worker.addEventListener('message', onMessage)
                worker.addEventListener('messageerror', onError)
                worker.addEventListener('error', onError)
                return () => {
                    worker.removeEventListener('message', onMessage)
                    worker.removeEventListener('messageerror', onError)
                    worker.removeEventListener('error', onError)
                }
            },
            stop: () => { worker.terminate(); URL.revokeObjectURL(url) },
        }
    } catch (error) {
        URL.revokeObjectURL(url)
        throw error
    }
}

function forget(worker: WorkerPort): void {
    if (port === worker) port = undefined
    worker.stop()
}

function releaseIdle(worker: WorkerPort): void {
    if (idleTimer !== undefined) window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => {
        idleTimer = undefined
        if (port === worker) forget(worker)
    }, idleDeadlineMs)
}

function cancelled(options: CustomRegexpOptions): boolean {
    return options.signal?.aborted === true || options.shouldStop?.() === true
}

function abortError(): Error {
    const error = new Error('Custom Regexp check cancelled.')
    error.name = 'AbortError'
    return error
}

function decodeGroups(text: string, patterns: readonly CustomRegexpPattern[], groups: unknown): Map<string, readonly RegExpMatchArray[]> {
    if (!Array.isArray(groups) || groups.length !== patterns.length) throw new Error('Incomplete worker result.')
    return new Map(patterns.map((pattern, index) => {
        const list: unknown = groups[index]
        if (!Array.isArray(list)) throw new Error('Invalid worker matches.')
        const matches = list.map((result: unknown) => {
            if (!result || typeof result !== 'object' || !('index' in result) || typeof result.index !== 'number' ||
                !Number.isSafeInteger(result.index) || result.index < 0 || result.index > text.length ||
                !('values' in result) || !Array.isArray(result.values) || typeof result.values[0] !== 'string' ||
                !result.values.every((value: unknown) => typeof value === 'string' || value === undefined)) {
                throw new Error('Invalid worker match range.')
            }
            const match = result.values as RegExpMatchArray
            match.index = result.index
            match.input = text
            if ('groups' in result && result.groups !== undefined) {
                if (!result.groups || typeof result.groups !== 'object' || Array.isArray(result.groups)) throw new Error('Invalid named captures.')
                const named: Record<string, string> = {}
                Object.setPrototypeOf(named, null)
                for (const [name, value] of Object.entries(result.groups) as [string, unknown][]) {
                    if (value !== undefined && typeof value !== 'string') throw new Error('Invalid named capture.')
                    named[name] = typeof value === 'string' ? value : undefined
                }
                match.groups = named
            }
            return match
        })
        return [customRegexpKey(pattern), matches] as const
    }))
}

function runWorker(text: string, patterns: readonly CustomRegexpPattern[], options: CustomRegexpOptions):
    Promise<ReadonlyMap<string, readonly RegExpMatchArray[]>> {
    if (cancelled(options)) return Promise.reject(abortError())
    if (idleTimer !== undefined) {
        window.clearTimeout(idleTimer)
        idleTimer = undefined
    }
    const worker = port ??= workerPort()
    return new Promise((resolve, reject) => {
        let label: string | undefined
        let done = false
        let unlisten = () => {}
        let poll: number | undefined
        const deadline = options.timeoutMs ?? defaultDeadlineMs
        const timer = window.setTimeout(() => failure(`exceeded the ${deadline} ms limit for this file`, true), deadline)
        const finish = () => {
            if (done) return false
            done = true
            window.clearTimeout(timer)
            if (poll !== undefined) window.clearInterval(poll)
            options.signal?.removeEventListener('abort', abort)
            unlisten()
            return true
        }
        const abort = () => {
            if (!finish()) return
            forget(worker)
            reject(abortError())
        }
        const failure = (message: unknown, stop: boolean) => {
            if (!finish()) return
            if (stop) forget(worker)
            else releaseIdle(worker)
            const reason = message instanceof Error ? message.message : String(message)
            reject(new Error(`Custom Regexp${label ? ` for ${label}` : ''} ${reason}.`))
        }
        try {
            unlisten = worker.listen(value => {
                if (!value || typeof value !== 'object') { failure('returned an invalid result', true); return }
                const reply = value as { phase?: unknown; groups?: unknown; label?: unknown; message?: unknown }
                if (reply.phase === 'pattern') {
                    label = typeof reply.label === 'string' ? reply.label : undefined
                } else if (reply.phase === 'failure') {
                    failure(reply.message, false)
                } else if (reply.phase === 'result') {
                    try {
                        const result = decodeGroups(text, patterns, reply.groups)
                        if (finish()) { releaseIdle(worker); resolve(result) }
                    } catch (error) { failure(error, true) }
                } else {
                    failure('returned an invalid result', true)
                }
            }, error => failure(error, true))
            options.signal?.addEventListener('abort', abort, { once: true })
            if (options.shouldStop) poll = window.setInterval(() => { if (cancelled(options)) abort() }, 30)
            if (cancelled(options)) { abort(); return }
            worker.send({ text, patterns, maxMatchCount, maxResultCharacters })
        } catch (error) {
            failure(error, true)
        }
    })
}

export async function matchCustomRegexps(text: string, patterns: Iterable<CustomRegexpPattern>,
    options: CustomRegexpOptions = {}): Promise<ReadonlyMap<string, readonly RegExpMatchArray[]>> {
    const unique = new Map<string, CustomRegexpPattern>()
    for (const pattern of patterns) {
        if (pattern.source.length > maxPatternLength) throw new Error(`Custom Regexp for ${pattern.label ?? 'the note type'} is too long.`)
        unique.set(customRegexpKey(pattern), pattern)
        if (unique.size > maxPatterns) throw new Error('Too many Custom Regexps are configured for one file.')
    }
    if (!unique.size) return new Map()
    const task = queue.then(() => runWorker(text, [...unique.values()], options))
    queue = task.then(() => undefined, () => undefined)
    return task
}
