# I18N: the page's words in one catalog (the user's brief, 2026-11-02)

The user's words, from the session that started the track (lightly arranged, not reworded).

> presently, user-visible text in the frontend and error messages comes directly from strings hardcoded along thousands
> of places in the frontend source, helper source and possibly even the emulator core. prepare the entire repo
> (webpc-net excluded) for i18n, not so much because we'll actually have translations, but because I want to make it
> easy to review and change the user-visible copy. Where possible, we should be using an industry standard dependency
> for i18n rather than rolling our own bespoke system [...] Idea: have the rust and C code return error codes/IDs only
> instead of building user-visible strings directly (assuming it actually does that), and the frontend turns those into
> proper user-visible strings using the same i18n solution as everything else.

Answers to the questions asked then:

- The current "house voice" is not great, which is the main reason for this: so the user can review and adjust
  everything. No `docs/copy.md` now; it goes to the backlog, for once the copy has been adjusted.
1. Developer-facing output is out (`npm start`, console logs, URL parameters). Text inside guest images (e.g. systemd
   unit descriptions for the units created through systemd credentials) is adjustable through the i18n system.
2. No runtime language switching (a reload is fine). The page's frontend alone renders messages; workers don't build
   error messages, structured errors carry all the data needed to render a detailed error.
3. Generated code would be fine (Vite already builds), but i18next is the better choice; a linter brings some of
   Paraglide's benefits without relying on the TS type checker.
4. Per-area files, keys that mirror the source.
5. Headline + details (no "This: type: of: chaining").
6. Markers in messages are fine.
7. The guard makes sure the docs' quotes of UI elements match the catalog.
8. Done end to end, with subagents where it's a good idea.
9. No rewording now: that's for the user or a later session.
- Every string has a note on how and where it's used, written when it's lifted from its place.
