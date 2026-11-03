// The page's virtual modules (vite.config.ts makes them), for the TypeScript that imports them.
declare module 'virtual:webpc-about' {
  const about: import('../../tools/third-party.ts').About;
  export default about;
}
