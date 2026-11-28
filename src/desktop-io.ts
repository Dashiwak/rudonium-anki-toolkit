// SPDX-License-Identifier: GPL-3.0-only
import { constants, createReadStream, promises } from 'node:fs'
import * as paths from 'node:path'
import * as hashes from 'node:crypto'

export { constants as fileFlags, promises as fileOperations, paths, hashes }
export { tmpdir as temporaryDirectory } from 'node:os'
export { Buffer as bytes } from 'node:buffer'
export type { Buffer as Bytes } from 'node:buffer'
export type { Dirent as DirectoryEntry, Stats as FileStat } from 'node:fs'
export type { FileHandle } from 'node:fs/promises'

export type DesktopPaths = typeof paths
export type DesktopHashes = typeof hashes
export type DesktopFileOperations = typeof promises

// All plugin reads are binary. No string encoding or object-mode stream is requested.
export interface DesktopFiles {
    constants: typeof constants
    promises: DesktopFileOperations
    createReadStream(path: string): AsyncIterable<Uint8Array>
}
export const files: DesktopFiles = { constants, promises, createReadStream }

export function fileErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
        return error.code
    }
}
