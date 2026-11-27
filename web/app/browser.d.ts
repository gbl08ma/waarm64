// Browser APIs the page uses that TypeScript's lib.dom doesn't have (Chromium's, some still experimental), optional
// where other browsers lack them (docs/frontend-code.md §5.4). A global script: no imports or exports.

/** A file picker's file types (`showOpenFilePicker`, `showSaveFilePicker`). */
interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface Window {
  /** The File System Access API's pickers (Chromium). */
  showOpenFilePicker?(o?: { types?: FilePickerAcceptType[]; multiple?: boolean }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(o?: { suggestedName?: string; types?: FilePickerAcceptType[] }): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(o?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  /** The File Handling API's launches (Chromium, an installed app): the files the OS opened it with (web/app/launch.ts). */
  launchQueue?: { setConsumer(consumer: (params: LaunchParams) => void): void };
}

/** A launch of the installed app: its URL and, for a file the OS opened with it, the files' handles. */
interface LaunchParams {
  readonly targetURL?: string;
  readonly files: readonly FileSystemHandle[];
}

interface FileSystemHandle {
  /** A kept handle's permission in this session, and asking for it (from a click). */
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface FileSystemFileHandle {
  /** Moves the file into directory `dir` (as `name`), in place (Chromium's OPFS). */
  move?(dir: FileSystemDirectoryHandle, name?: string): Promise<void>;
}

interface DataTransferItem {
  /** A dropped item's handle (Chromium), so a file dropped can be read in later sessions too. */
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}

interface Navigator {
  /** The Keyboard Lock and Keyboard Map APIs (Chromium). */
  keyboard?: { lock(): Promise<void>; unlock(): void; getLayoutMap?(): Promise<ReadonlyMap<string, string>> };
  /** The device's memory, GiB, rounded (Chromium). */
  deviceMemory?: number;
  /** User-Agent Client Hints (Chromium). */
  userAgentData?: { platform?: string; brands: { brand: string }[] };
}
