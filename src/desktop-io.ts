// SPDX-License-Identifier: GPL-3.0-only
import * as nativeFiles from 'fs'
import * as nativePath from 'path'
import * as nativeCrypto from 'crypto'
import { tmpdir as nativeTmpdir } from 'os'
import { Buffer as NodeBuffer } from 'buffer'

export interface Bytes extends Uint8Array {
    readUInt8(offset: number): number
    readUInt16LE(offset: number): number
    readUInt32LE(offset: number): number
    writeUInt16LE(value: number, offset: number): number
    writeUInt32LE(value: number, offset: number): number
    equals(other: Uint8Array): boolean
    copy(target: Uint8Array, targetStart?: number): number
    subarray(start?: number, end?: number): Bytes
    toString(encoding?: 'utf8' | 'hex', start?: number, end?: number): string
}

export const bytes: {
    alloc(size: number): Bytes
    allocUnsafe(size: number): Bytes
    from(text: string, encoding: 'utf8'): Bytes
    concat(chunks: readonly Uint8Array[], size?: number): Bytes
    byteLength(text: string): number
} = NodeBuffer

interface FileKind {
    isFile(): boolean
    isDirectory(): boolean
    isSymbolicLink(): boolean
}

export interface FileStat extends FileKind {
    size: number
    mode: number
    ino: number
    dev: number
    mtime: Date
    mtimeMs: number
    ctimeMs: number
}

export interface FileHandle {
    fd: number
    stat(): Promise<FileStat>
    close(): Promise<void>
    sync(): Promise<void>
    read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>
    write(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesWritten: number }>
    readFile(): Promise<Bytes>
    writeFile(data: string | Uint8Array): Promise<void>
}

export interface DirectoryEntry extends FileKind {
    name: string
}

export interface DesktopFileOperations {
    lstat(path: string): Promise<FileStat>
    stat(path: string): Promise<FileStat>
    open(path: string, flags: string | number, mode?: number): Promise<FileHandle>
    readFile(path: string): Promise<Bytes>
    readFile(path: string, encoding: 'utf8'): Promise<string>
    writeFile(path: string, data: string | Uint8Array, options?: { flag?: string; mode?: number }): Promise<void>
    readdir(path: string): Promise<string[]>
    readdir(path: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>
    realpath(path: string): Promise<string>
    mkdtemp(prefix: string): Promise<string>
    mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>
    copyFile(source: string, destination: string, flags?: number): Promise<void>
    rm(path: string, options: { force?: boolean; recursive?: boolean }): Promise<void>
    rename(from: string, to: string): Promise<void>
    link(from: string, to: string): Promise<void>
    unlink(path: string): Promise<void>
    chmod(path: string, mode: number): Promise<void>
    utimes(path: string, accessTime: Date, modificationTime: Date): Promise<void>
}

export const files: {
    constants: { O_RDONLY: number; O_NOFOLLOW?: number; COPYFILE_EXCL: number }
    promises: DesktopFileOperations
    createReadStream(path: string, options?: { fd: number; autoClose: boolean; start: number; end: number }): AsyncIterable<Uint8Array>
} = nativeFiles

export const paths: {
    readonly sep: string
    isAbsolute(path: string): boolean
    basename(path: string, suffix?: string): string
    dirname(path: string): string
    extname(path: string): string
    join(...parts: string[]): string
    resolve(...parts: string[]): string
    relative(from: string, to: string): string
} = nativePath

interface Digest {
    update(value: string | Uint8Array): Digest
    digest(encoding: 'hex'): string
}

export const hashes: {
    createHash(algorithm: 'sha256'): Digest
    randomBytes(size: number): Bytes
    randomUUID(): string
} = nativeCrypto

export const temporaryDirectory: () => string = nativeTmpdir

export function fileErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
        return error.code
    }
}

export type DesktopPaths = typeof paths
export type DesktopFiles = typeof files
export type DesktopHashes = typeof hashes
export const fileOperations = files.promises
export const fileFlags = files.constants
