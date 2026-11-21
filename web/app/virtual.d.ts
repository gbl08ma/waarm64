// The page's virtual modules (vite.config.ts makes them), for the TypeScript that imports them.
declare module 'virtual:waarm64-about' {
  const about: import('../../tools/third-party.ts').About;
  export default about;
}
declare module 'virtual:waarm64-core-size' {
  /** The core's wasm's size in bytes when the page was built or the dev server started (0: not built). */
  const size: number;
  export default size;
}
