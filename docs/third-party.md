# Third-party code and its attribution

Everything waarm64 takes from other projects is in one machine-readable file, **`THIRD_PARTY.json`** at the root: code
ported or copied, ideas reimplemented, the dependencies (runtime and development), the workloads and media used, the
firmware distributed, and the reference projects with their verified licenses. It is the authoritative list: there is
no `THIRD_PARTY.md` (it was replaced, 2026-11-03; `node tools/third-party.ts --markdown` prints the file in that
page's layout, and a job that writes it from the JSON may come later). The rows marked `about` are what the page credits
on the Machines page's **[About](ui:machines:MachinesPage.about)** pane ([frontend.md](frontend.md) "About").

## The file

```json
{
  "sections": [
    {
      "id": "derived", "title": "Code in this repository derived from other projects", "intro": ["…"],
      "columns": [{ "key": "ours", "title": "Our file(s)" }, { "key": "source", "title": "Source project, file, commit" }, { "key": "license", "title": "License" }],
      "entries": [
        {
          "id": "dynarmic-decoder", "name": "dynarmic", "about": "core",
          "url": "https://github.com/lioncash/dynarmic/tree/a41c380246d3", "version": "a41c380246d3", "license": "0BSD",
          "licenseTexts": [{ "name": "LICENSE.txt", "url": "https://github.com/lioncash/dynarmic/blob/a41c380246d3/LICENSE.txt" }],
          "md": { "ours": "`core/src/a64/a64.inc`", "source": "dynarmic, `src/…/a64.inc`, `a41c380246d3` (verbatim, header added) …", "license": "0BSD" }
        }
      ]
    }
  ]
}
```

- A **section** is a table: `title` its heading (`null` continues the previous one's, as the copyleft references do
  under the permissive ones'), `intro` and `outro` paragraphs (Markdown), `columns` its cells' keys and headings.
  The sections: `derived` (code ported, copied or patched), `techniques` (ideas and papers, no code), `npm`,
  `rust-net-ts` (the tailnet client's crates), `rust-core` (the core's crates: lz4_flex, crc32fast), `go-net-tailscale` (the Go backend, a test fixture), `toolchain` (the
  toolchains' libraries built into our binaries), `dev` (development dependencies, not distributed), `workloads`
  (fetched at build time), `media` (fixtures), `firmware`, `references-permissive`, `references-copyleft`.
- An **entry** has an `id` (unique, lower case), a `name` (the project's), and `md`: its cells, Markdown, by column
  key. That's all a row needs that the page doesn't show.
- A row the page shows has **`about`**: the pane's group, where in waarm64 the code ends up: `page` (the interface's
  npm packages), `core` (the emulator's wasm), `graphics` (virgl's renderer), `vulkan` (Venus's renderer module),
  `network` (the tailnet client), `firmware` (EDK2). Then it needs `url` (the project, pinned where the host allows),
  `version` (a release or a commit), `license` (an SPDX expression) and `licenseTexts` (each file's name and a link
  **pinned to that commit or tag**, never a branch: `blob/<commit>/LICENSE`; a crate's own files on docs.rs at its
  version; SPDX's page for a project without a license file) — or `parts`, a list of those, for a row that is several
  projects in one binary (Venus's module, EDK2 with OpenSSL and libfdt). `bundled` names a license file that `npm run
  dist` puts beside the page (`EDK2-LICENSES.txt`, `VENUS-LICENSES.txt`; `BUNDLED` in `tools/third-party.ts`), linked
  under the group.

## What the About pane shows

The rule is visibility in what users get: a project is shown when its code is **built into** what the page serves, when
files or data were **copied** from it, or when our code is a **1:1 reimplementation** of it (a protocol written from
Tailscale's and tailcat's code, virglrenderer's command layouts, Mesa's video structures). Test, build and development
tools, oracles, benchmark workloads, guests' packages, and ideas taken from papers or other projects' designs stay in
the file only; all the same, they keep their rows. Rows of one project and version are one line on the pane (their
license texts joined); one whose code ours derives from (the `derived` section) is tagged
[Derived code](ui:machines:About.derived).

Only those rows reach the page: Vite's `virtual:waarm64-about` (`vite.config.ts`, `aboutData` in
`tools/third-party.ts`) builds the pane's data from them at build time, with the build's commit (and the tag on it, if
one was cut), the commit's date and whether the work tree had changes (`tools/stamp.ts` `buildInfo`, as the console's
line has it), and the repository from `package.json`. The dev server links the license files where they're built
(`/target/images/edk2/LICENSES.txt`), the static copy beside the page; a file the copy leaves out (Venus's, without
Vulkan's renderer) isn't linked.

## Keeping it

- **Porting or copying code** (CLAUDE.md "Licensing"): check the reference's row first (copy only from the permissive
  section), keep the original header, add a row to `derived`, and mark it `about` with its pinned links when the code
  ships in the page.
- **A new dependency** of the page, the core, the tailnet client, Venus's module or the firmware: a row in its section
  with `about`. A dependency only of the tools and tests goes in `dev`, without.
- **A version bump** moves `version`, the pins in `url` and `licenseTexts`, and the cells.
- `node tools/third-party.ts` (in `scripts/ci.sh`) checks the file: ids, cells for every column, the fields a shown
  row needs, pinned links. `node tools/third-party.ts --links` fetches every link the pane shows (by hand, it needs the
  network; npm's and crates.io's pages are checked through their registries, a file on GitHub through its raw copy).
  `tests/third-party.test.ts` checks what reaches the pane; `tests/page-about.test.ts` the pane in Chromium (every
  link to another site in a new tab with `rel="external nofollow noopener noreferrer"`).
