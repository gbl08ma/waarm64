// What a code pane draws (web/app/ui/CodePane.svelte): rows of code, some folded away under a label, and notes in
// plain words between them.

/** A line of code: what stands before it (an address, its bytes), its text, and the group it lights up with. */
export type CodeRow = { text: string; gutter?: string; group?: number; gap?: boolean };
/** A note in plain words about the rows after it: not code, and drawn apart from it. */
export type CodeNote = { note: string };
/**
 * Rows folded under a label until it's opened; `group`: the fold's label lights up with that group. Its first note
 * shows under the label while it is folded.
 */
export type CodeFold = { label: string; rows: (CodeRow | CodeNote)[]; group?: number };
export type CodeItem = CodeRow | CodeFold | CodeNote;

export const isFold = (i: CodeItem): i is CodeFold => 'rows' in i;
export const isNote = (i: CodeItem): i is CodeNote => 'note' in i;
