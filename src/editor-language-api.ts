// SPDX-License-Identifier: GPL-3.0-only
declare module '@codemirror/language' {
    export interface EditorSyntaxNode {
        readonly name: string
        readonly from: number
        readonly to: number
        readonly parent: EditorSyntaxNode | null
    }

    export function syntaxTree(state: import('@codemirror/state').EditorState): {
        resolveInner(position: number, side?: number): EditorSyntaxNode
    }
    export function syntaxTreeAvailable(state: import('@codemirror/state').EditorState, until?: number): boolean
}
