/*!
 * SPDX-License-Identifier: GPL-3.0-only
 * Rudonium Anki Toolkit — изменённый комплект от 2026-11-19.
 * Уведомления о происхождении и исходных разрешениях: NOTICE.md в корне выпуска.
 * Авторские уведомления и отдельные лицензии исходных компонентов сохраняются.
 */
export interface ImageOptimizationSettings {
    enabled: boolean
    maxWidth: number
    maxHeight: number
    targetKb: number
    checkChanges: boolean
    saveCopy: boolean
    replaceOriginal: boolean
    keepOriginal: boolean
    originalsFolder: string
}

export interface OptimizedImage {
    bytes: ArrayBuffer
    originalWidth: number
    originalHeight: number
    width: number
    height: number
}

export const imageOptimizationLimits = {
    minDimension: 1,
    maxDimension: 8192,
    minTargetKb: 0,
    maxTargetKb: 32768,
} as const

const maxSourceBytes = 64 * 1024 * 1024
const maxSourcePixels = 64_000_000
const preferredJpegQuality = 0.9
const minJpegQuality = 0.75

type ImageFormat = 'image/jpeg' | 'image/png'
type Dimensions = { width: number; height: number }

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

export function readImageOptimization(value: unknown): ImageOptimizationSettings {
    const settings = value && typeof value === 'object' ? value as Partial<ImageOptimizationSettings> : {}
    const { minDimension, maxDimension, minTargetKb, maxTargetKb } = imageOptimizationLimits
    const replaceOriginal = settings.replaceOriginal === true
    return {
        enabled: settings.enabled === true,
        maxWidth: boundedInteger(settings.maxWidth, 1600, minDimension, maxDimension),
        maxHeight: boundedInteger(settings.maxHeight, 1600, minDimension, maxDimension),
        targetKb: boundedInteger(settings.targetKb, 300, minTargetKb, maxTargetKb),
        checkChanges: settings.checkChanges === true,
        saveCopy: !replaceOriginal && settings.saveCopy === true,
        replaceOriginal,
        keepOriginal: settings.keepOriginal === true,
        originalsFolder: typeof settings.originalsFolder === 'string' ? settings.originalsFolder.trim() : '',
    }
}

export async function imageHash(bytes: ArrayBuffer): Promise<string> {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

function readPng(bytes: DataView): Dimensions | undefined {
    if (bytes.byteLength < 33 || bytes.getUint32(0) !== 0x89504e47 || bytes.getUint32(4) !== 0x0d0a1a0a ||
        bytes.getUint32(8) !== 13 || bytes.getUint32(12) !== 0x49484452) return undefined
    for (let offset = 8; offset + 12 <= bytes.byteLength;) {
        const length = bytes.getUint32(offset)
        const type = bytes.getUint32(offset + 4)
        if (type === 0x6163544c || type === 0x6663544c || type === 0x66644154) return undefined
        offset += 12 + length
        if (offset > bytes.byteLength) return undefined
        if (type === 0x49454e44 && length === 0) return {
            width: bytes.getUint32(16),
            height: bytes.getUint32(20),
        }
    }
    return undefined
}

function readJpeg(bytes: DataView): Dimensions | undefined {
    if (bytes.byteLength < 4 || bytes.getUint16(0) !== 0xffd8) return undefined
    let dimensions: Dimensions | undefined
    for (let offset = 2; offset + 2 <= bytes.byteLength;) {
        if (bytes.getUint8(offset) !== 0xff) return undefined
        while (offset < bytes.byteLength && bytes.getUint8(offset) === 0xff) offset++
        if (offset >= bytes.byteLength) return undefined
        const marker = bytes.getUint8(offset++)
        if (marker === 0xda) return dimensions
        if (marker === 0x01) continue
        if (marker === 0xd9 || offset + 2 > bytes.byteLength) return undefined
        const length = bytes.getUint16(offset)
        if (length < 2 || offset + length > bytes.byteLength) return undefined
        // JPEG может содержать несколько полноразмерных изображений в контейнере MPF.
        if (marker === 0xe2 && length >= 6 && bytes.getUint32(offset + 2) === 0x4d504600) return undefined
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            if (length < 8 || dimensions) return undefined
            dimensions = { width: bytes.getUint16(offset + 5), height: bytes.getUint16(offset + 3) }
        }
        offset += length
    }
    return undefined
}

function imageFormat(filename: string): ImageFormat | undefined {
    if (/\.jpe?g$/i.test(filename)) return 'image/jpeg'
    if (/\.png$/i.test(filename)) return 'image/png'
    return undefined
}

function validDimensions({ width, height }: Dimensions): boolean {
    return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 &&
        width * height <= maxSourcePixels
}

function fit({ width, height }: Dimensions, settings: ImageOptimizationSettings): Dimensions {
    const ratio = Math.min(1, settings.maxWidth / width, settings.maxHeight / height)
    return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

async function encode(canvas: HTMLCanvasElement, format: ImageFormat, quality?: number): Promise<Blob | undefined> {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, format, quality))
    return blob && blob.type === format && blob.size ? blob : undefined
}

async function encodedImage(canvas: HTMLCanvasElement, format: ImageFormat, targetBytes: number): Promise<Blob | undefined> {
    if (format === 'image/png') return encode(canvas, format)
    const preferred = await encode(canvas, format, preferredJpegQuality)
    if (!preferred || !targetBytes || preferred.size <= targetBytes) return preferred
    const minimum = await encode(canvas, format, minJpegQuality)
    if (!minimum || minimum.size > targetBytes) return minimum && minimum.size < preferred.size ? minimum : preferred
    let chosen = minimum
    let low = minJpegQuality
    let high = preferredJpegQuality
    for (let step = 0; step < 4; step++) {
        const quality = (low + high) / 2
        const candidate = await encode(canvas, format, quality)
        if (!candidate) break
        if (candidate.size <= targetBytes) {
            chosen = candidate
            low = quality
        } else high = quality
    }
    return chosen
}

/** Возвращает уменьшенную копию, если неподвижное изображение поддерживается и его можно обработать безопасно. */
export async function optimizeImage(bytes: ArrayBuffer, filename: string,
    settings: ImageOptimizationSettings): Promise<OptimizedImage | undefined> {
    if (!settings.enabled || !bytes.byteLength || bytes.byteLength > maxSourceBytes) return undefined
    const format = imageFormat(filename)
    if (!format || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return undefined
    const source = new DataView(bytes)
    const header = format === 'image/png' ? readPng(source) : readJpeg(source)
    if (!header || !validDimensions(header)) return undefined
    const targetBytes = format === 'image/jpeg' ? settings.targetKb * 1000 : 0
    const fitsAsStored = header.width <= settings.maxWidth && header.height <= settings.maxHeight
    const fitsRotated = header.width <= settings.maxHeight && header.height <= settings.maxWidth
    if (fitsAsStored && fitsRotated && (!targetBytes || bytes.byteLength <= targetBytes)) {
        return undefined
    }

    let canvas: HTMLCanvasElement | undefined
    try {
        // При декодировании учитываем ориентацию исходника перед измерением видимых размеров.
        const bitmap = await createImageBitmap(new Blob([bytes], { type: format }))
        const { width: originalWidth, height: originalHeight } = bitmap
        let size: Dimensions
        try {
            if (!validDimensions(bitmap)) return undefined
            size = fit(bitmap, settings)
            if (size.width === originalWidth && size.height === originalHeight && (!targetBytes || bytes.byteLength <= targetBytes)) {
                return undefined
            }
            canvas = document.createElement('canvas')
            canvas.width = size.width
            canvas.height = size.height
            const context = canvas.getContext('2d')
            if (!context) return undefined
            context.imageSmoothingQuality = 'high'
            context.drawImage(bitmap, 0, 0, size.width, size.height)
        } finally {
            bitmap.close()
        }
        const output = await encodedImage(canvas, format, targetBytes)
        if (!output || output.size >= bytes.byteLength) return undefined
        return { bytes: await output.arrayBuffer(), originalWidth, originalHeight, ...size }
    } catch {
        return undefined
    } finally {
        if (canvas) { canvas.width = 0; canvas.height = 0 }
    }
}
