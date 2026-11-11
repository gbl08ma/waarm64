// What the page shows of the machine (docs/frontend.md "Views"): its screen, its serial terminal, or both.
export type View = 'screen' | 'terminal' | 'both';

export const screen = $state<{ view: View }>({ view: 'screen' });
