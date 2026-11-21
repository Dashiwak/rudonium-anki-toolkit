const ANKI_PORT: number = 8765

import type { AnkiConnectNote } from './interfaces/note-interface'

export interface AnkiConnectRequest {
	action: string,
	version: 6,
	params: any
}

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

function request(action: string, params={}): AnkiConnectRequest {
	return {action, version:6, params}
}

export function multi(actions: AnkiConnectRequest[]): AnkiConnectRequest {
	return request('multi', {actions: actions})
}

export function addNote(note: AnkiConnectNote): AnkiConnectRequest {
	return request('addNote', {note: note})
}

export function createDeck(deck: string): AnkiConnectRequest {
	return request('createDeck', {deck: deck})
}

export function deleteNotes(note_ids: number[]): AnkiConnectRequest {
	return request('deleteNotes', {notes: note_ids})
}

export function updateNoteFields(id: number, fields: Record<string, string>): AnkiConnectRequest {
	return request(
		'updateNoteFields', {
			note: {
				id: id,
				fields: fields
			}
		}
	)
}

export function notesInfo(note_ids: number[]): AnkiConnectRequest {
	return request(
		'notesInfo', {
			notes: note_ids
		}
	)
}

export function changeDeck(card_ids: number[], deck: string): AnkiConnectRequest {
	return request(
		'changeDeck', {
			cards: card_ids,
			deck: deck
		}
	)
}

export function removeTags(note_ids: number[], tags: string): AnkiConnectRequest {
	return request(
		'removeTags', {
			notes: note_ids,
			tags: tags
		}
	)
}

export function addTags(note_ids: number[], tags: string): AnkiConnectRequest {
	return request(
		'addTags', {
			notes: note_ids,
			tags: tags
		}
	)
}

export function getTags(): AnkiConnectRequest {
	return request('getTags')
}

export function storeMediaFile(filename: string, data: string): AnkiConnectRequest {
	return request(
		'storeMediaFile', {
			filename: filename,
			data: data
		}
	)
}

export function storeMediaFileByPath(filename: string, path: string): AnkiConnectRequest {
	return request(
		'storeMediaFile', {
			filename: filename,
			path: path
		}
	)
}
