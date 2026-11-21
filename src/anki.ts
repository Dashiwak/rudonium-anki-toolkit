const ANKI_PORT: number = 8765

import type { AnkiConnectNote } from './interfaces/note-interface'

interface RequestParams {
    multi: { actions: AnkiConnectRequest[] }
    addNote: { note: AnkiConnectNote }
    createDeck: { deck: string }
    deleteNotes: { notes: number[] }
    updateNoteFields: { note: { id: number; fields: Record<string, string> } }
    notesInfo: { notes: number[] }
    changeDeck: { cards: number[]; deck: string }
    removeTags: { notes: number[]; tags: string }
    addTags: { notes: number[]; tags: string }
    getTags: Record<string, never>
    storeMediaFile: { filename: string; data: string } | { filename: string; path: string }
}

type Action = keyof RequestParams
type RequestFor<A extends Action> = { action: A; version: 6; params: RequestParams[A] }
export type AnkiConnectRequest = { [A in Action]: RequestFor<A> }[Action]

// Helper function for parsing the result of a multi, also used for the top-level envelope.
export function parse<T>(response: { error: string | null; result: T }): T
export function parse(response: unknown): unknown
export function parse(response: unknown): unknown {
    if (typeof response !== 'object' || response === null || Array.isArray(response) ||
        Object.getOwnPropertyNames(response).length !== 2) {
        throw new Error('response has an unexpected number of fields')
    }
    if (!('error' in response) || !Object.prototype.hasOwnProperty.call(response, 'error')) {
        throw new Error('response is missing required error field')
    }
    if (!('result' in response) || !Object.prototype.hasOwnProperty.call(response, 'result')) {
        throw new Error('response is missing required result field')
    }
    if (response.error !== null) {
        if (typeof response.error === 'string' && response.error) throw new Error(response.error)
        throw new Error('response contains an invalid error field')
    }
    return response.result
}

export function invoke(action: string, params = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.addEventListener('error', () => reject(new Error('failed to issue request')))
        xhr.addEventListener('abort', () => reject(new Error('AnkiConnect request aborted')))
        xhr.addEventListener('load', () => {
            try {
                if (xhr.status < 200 || xhr.status >= 300) throw new Error('AnkiConnect HTTP ' + xhr.status)
                const response: unknown = JSON.parse(xhr.responseText)
                resolve(parse(response))
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)))
            }
        })

        xhr.open('POST', 'http://127.0.0.1:' + ANKI_PORT.toString())
        xhr.send(JSON.stringify({action, version: 6, params}))
    })
}

// All the rest of these functions only return request objects as opposed to actually carrying out the action. For efficiency!

function request<A extends Action>(action: A, params: RequestParams[A]): RequestFor<A> {
	return {action, version:6, params}
}

export function multi(actions: AnkiConnectRequest[]) {
	return request('multi', {actions: actions})
}

export function addNote(note: AnkiConnectNote) {
	return request('addNote', {note: note})
}

export function createDeck(deck: string) {
	return request('createDeck', {deck: deck})
}

export function deleteNotes(note_ids: number[]) {
	return request('deleteNotes', {notes: note_ids})
}

export function updateNoteFields(id: number, fields: Record<string, string>) {
	return request(
		'updateNoteFields', {
			note: {
				id: id,
				fields: fields
			}
		}
	)
}

export function notesInfo(note_ids: number[]) {
	return request(
		'notesInfo', {
			notes: note_ids
		}
	)
}

export function changeDeck(card_ids: number[], deck: string) {
	return request(
		'changeDeck', {
			cards: card_ids,
			deck: deck
		}
	)
}

export function removeTags(note_ids: number[], tags: string) {
	return request(
		'removeTags', {
			notes: note_ids,
			tags: tags
		}
	)
}

export function addTags(note_ids: number[], tags: string) {
	return request(
		'addTags', {
			notes: note_ids,
			tags: tags
		}
	)
}

export function getTags() {
	return request('getTags', {})
}

export function storeMediaFile(filename: string, data: string) {
	return request(
		'storeMediaFile', {
			filename: filename,
			data: data
		}
	)
}

export function storeMediaFileByPath(filename: string, path: string) {
	return request(
		'storeMediaFile', {
			filename: filename,
			path: path
		}
	)
}
