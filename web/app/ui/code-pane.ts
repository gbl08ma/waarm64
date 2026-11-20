// What a code pane draws (web/app/ui/CodePane.svelte): rows of code, some folded away under a label.

/** A line of code: what stands before it (an address, its bytes), its text, and the group it lights up with. */
export type CodeRow = { text: string; gutter?: string; group?: number; gap?: boolean };
/** Rows folded under a label until it's opened; `group`: the fold's label lights up with that group. */
export type CodeFold = { label: string; rows: CodeRow[]; group?: number };
export type CodeItem = CodeRow | CodeFold;

export const isFold = (i: CodeItem): i is CodeFold => 'rows' in i;
