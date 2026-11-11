// What a dialog (ui/Modal.svelte) gives the component that binds it (`bind:this`): its exported methods. Typed here,
// as the linters' TypeScript sees a component only as svelte.d.ts's `Component`, not its exports.
export type Dialog = { open: () => void; close: () => void };
