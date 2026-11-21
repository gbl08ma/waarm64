// The local helper's release as the page shows it (docs/networking/local-helper.md "Decisions", "Plain install lines"): its version,
// the published SHA-256 of each binary, and the install lines for a platform, the same as the release's INSTALL.md
// (waarm64-net's build.sh `install`; tests/local-release.test.ts holds the two together). Each release replaces
// `RELEASE` from its SHA256SUMS (a change of waarm64's, separate from the release itself).

export type Os = 'linux' | 'darwin' | 'windows';
export type Arch = 'amd64' | 'arm64';
export type Target = { os: Os; arch: Arch };
export type Release = { version: string; /** SHA256SUMS: file name to hash. */ sums: Record<string, string> };

/** The release the page offers: its SHA256SUMS, from github.com/gbl08ma/waarm64-net/releases (built twice there, and matched). */
export const RELEASE: Release = {
  version: 'v0.4.0',
  sums: {
    'LICENSES.txt': 'f2975483ed7ed5758a9cd99890868eb87f3d18f3731d191b6fd1b73910735deb',
    'waarm64-net-v0.4.0-darwin-amd64': 'fd9479d7c812277503901b50c08cc62b622349a0872168738b4fc6876dea88aa',
    'waarm64-net-v0.4.0-darwin-arm64': '3fd0421b51eb5939b537586c40ffa695c7732df053b0d5e94b903e2cef6fa50b',
    'waarm64-net-v0.4.0-linux-amd64': 'd18dce52de674a846a6899e591b87224f89b955fa4fd60e8cbb29471a1182325',
    'waarm64-net-v0.4.0-linux-arm64': '5fa686da83a21ba470f066cae2d746e87627317083ceb2b1b46ef4ee8fd8ace6',
    'waarm64-net-v0.4.0-windows-amd64.exe': '1da4b883f0ba3dd0dc925b0814f5f5aa429c0d4a2d475853c840f15026449a3d',
    'waarm64-net-v0.4.0-windows-arm64.exe': '8d9828c80b212723446aeb93e9ec54978507c05956d88a33f1dff617fee09cb8',
  },
};

export const TARGETS: Target[] = [
  { os: 'linux', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'darwin', arch: 'amd64' },
  { os: 'darwin', arch: 'arm64' },
  { os: 'windows', arch: 'amd64' },
  { os: 'windows', arch: 'arm64' },
];

export const SOURCE = 'https://github.com/gbl08ma/waarm64-net';
const download = (version: string) => `https://github.com/gbl08ma/waarm64-net/releases/download/${version}`;

export const targetName = (t: Target) =>
  `${{ linux: 'Linux', darwin: 'macOS', windows: 'Windows' }[t.os]}, ${t.arch === 'amd64' ? 'x86-64' : 'ARM'}`;
const fileOf = (r: Release, t: Target) =>
  `waarm64-net-${r.version}-${t.os}-${t.arch}${t.os === 'windows' ? '.exe' : ''}`;

/** The install lines for `t` (a shell's, or PowerShell's on Windows): download, check the hash, mark it executable, run it. */
export function installLines(r: Release, t: Target): string {
  const file = fileOf(r, t);
  const sum = r.sums[file] ?? '';
  if (t.os === 'windows') {
    return [
      `$d = "$env:LOCALAPPDATA\\Programs\\waarm64-net"; New-Item -ItemType Directory -Force $d | Out-Null; $ProgressPreference = 'SilentlyContinue'`,
      `Invoke-WebRequest ${download(r.version)}/${file} -OutFile "$d\\waarm64-net.exe"`, // i18n-ignore: a PowerShell command
      `if ((Get-FileHash "$d\\waarm64-net.exe").Hash -ne '${sum}') { Remove-Item "$d\\waarm64-net.exe"; throw 'not the published hash' }`,
      `& "$d\\waarm64-net.exe"`,
    ].join('\n');
  }
  return [
    'mkdir -p ~/.local/bin',
    `curl -fLo ~/.local/bin/waarm64-net ${download(r.version)}/${file}`,
    `echo "${sum}  $HOME/.local/bin/waarm64-net" | ${t.os === 'darwin' ? 'shasum -a 256 -c' : 'sha256sum -c'} || rm ~/.local/bin/waarm64-net`,
    'chmod +x ~/.local/bin/waarm64-net',
    '~/.local/bin/waarm64-net',
  ].join('\n');
}

/** The release's SHA256SUMS text parsed. */
export function parseSums(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split('\n').flatMap((l) => {
      const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(l.trim());
      return m ? [[m[2], m[1]]] : [];
    }),
  );
}

type UAData = { getHighEntropyValues(hints: string[]): Promise<{ platform?: string; architecture?: string }> };

/** This browser's platform and architecture, where it says (Chromium's client hints; else the user agent's guess). */
export async function thisTarget(
  nav: { userAgentData?: UAData; userAgent: string } = navigator as never,
): Promise<Target | undefined> {
  let platform = '',
    arch = '';
  try {
    const v = await nav.userAgentData?.getHighEntropyValues(['platform', 'architecture']);
    [platform, arch] = [v?.platform ?? '', v?.architecture ?? ''];
  } catch {
    /* no client hints */
  }
  const ua = nav.userAgent;
  const os: Os | undefined = /mac/i.test(platform || ua)
    ? 'darwin'
    : /win/i.test(platform || ua)
      ? 'windows'
      : /linux|x11|cros/i.test(platform || ua)
        ? 'linux'
        : undefined;
  if (!os) return undefined;
  // Without client hints a Mac is assumed ARM (every Mac since 2020 and the user agent says Intel either way).
  const a: Arch = arch
    ? /arm/i.test(arch)
      ? 'arm64'
      : 'amd64'
    : os === 'darwin' || /aarch64|arm/i.test(ua)
      ? 'arm64'
      : 'amd64';
  return { os, arch: a };
}
