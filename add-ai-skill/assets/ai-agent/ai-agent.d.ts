// Type declarations for the ai-agent-drawer runtime (ai-agent.js). Plain JS at runtime; these are for TS/IDE users.

/** A value, or a (possibly async) function that returns it. Hooks are called when the agent needs them. */
export type Hook<T> = T | (() => T | Promise<T>);

/** What the application is. Strings pass through; objects become "Label: value" lines and bullet lists. */
export type AppContext = string | {
  name?: string;
  purpose?: string;
  description?: string;
  audience?: string;
  capabilities?: string[];
  limits?: string[];
  glossary?: Record<string, string>;
  [key: string]: unknown;
};

export interface PageContext {
  /** Stable id of the page/view/route, e.g. 'orders' or 'settings/billing'. */
  id: string;
  /** Human title of the page. */
  title?: Hook<string>;
  /** What the page is for and what the user does here. */
  purpose?: string;
  /** Any other descriptive fields (sent with the page context). */
  [key: string]: unknown;
  /**
   * The live screen content. FINGERPRINTED: a new hash means "the agent's copy is stale".
   * Return a string (sent as written) or JSON-able data (sent as sorted-key JSON). Keep it deterministic.
   */
  content?: Hook<unknown>;
  /** Volatile UI state (cursor, selection, scroll, active tab). Sent with every question; NOT fingerprinted. */
  view?: Hook<unknown>;
  /** Tools that exist only on this page (sent to the model as tools, not as page description). */
  tools?: ToolDefinition[];
}

/** A tool parameter: the parseBlockValues field format plus required/default/description and arrays. */
export interface ToolParameter extends Omit<BlockField, 'type'> {
  type: 'number' | 'integer' | 'boolean' | 'enum' | 'string' | 'array';
  required?: boolean;
  description?: string;
  default?: unknown;
  /**
   * For 'string': the longest text accepted (default 500). Longer text is an error the model is told about, with both
   * sizes; it is never cut, so a JSON payload cannot reach run() half-written. Raise it for tools that take large text.
   */
  maxLength?: number;
  /** For 'array': the item field (default string). */
  items?: Omit<BlockField, 'aliases'>;
  maxItems?: number;
}

/** A function of the host app the agent may call. See references/tools.md. */
export interface ToolDefinition {
  /** Letters, digits, _ or -, starting with a letter; unique. */
  name: string;
  /** Shown in the chat and in Settings > Tools (default: from the name). */
  title?: string;
  /** What it does, in the user's words — the model reads this to decide when to call it. */
  description: string;
  parameters?: Record<string, ToolParameter>;
  /** read: runs without asking · write: asks first (confirmWrites) · destructive: always asks (confirmDestructive). Default 'write'. */
  effect?: 'read' | 'write' | 'destructive';
  /** Page ids where it can be used ('orders/*' = any sub-page). Default: everywhere. */
  pages?: string | string[];
  /** Whether it can be used right now (e.g. a row is selected). */
  when?: () => boolean;
  /** Groups the Settings > Tools list. */
  group?: string;
  /** On before the user or toolsConfig decides. Default false. */
  enabled?: boolean;
  /** Default 30000. */
  timeoutMs?: number;
  /** The app's own function. Its return value goes to the model (strings as written, else compact JSON, max 4,000 chars). */
  run: (args: Record<string, any>, ctx: { agent: AiAgent; signal?: AbortSignal; call: { id: string; name: string } }) => unknown;
}

/** The app's default tool selection (ai-tools.json); Settings > Tools > "Download ai-tools.json" writes it. */
export interface ToolsConfig {
  toolsEnabled?: boolean;
  confirmWrites?: boolean;
  confirmDestructive?: boolean;
  toolMode?: 'auto' | 'native' | 'text';
  maxToolSteps?: number;
  tools?: Record<string, boolean | { enabled: boolean; [key: string]: unknown }>;
}

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  effect: 'read' | 'write' | 'destructive';
  group: string;
  pages: string[];
  /** Turned on (settings > toolsConfig > the tool's own default). */
  enabled: boolean;
  /** Usable on the current page right now. */
  available: boolean;
}

/** A note the agent keeps between conversations (Settings > Memory). */
export interface Memory {
  /** Stable id the model uses to correct or delete it, e.g. 'm3'. */
  id: string;
  /** One short sentence (at most 500 characters). */
  text: string;
  /** ISO dates. */
  created: string;
  updated?: string;
  /** Who wrote it: the user in Settings, the agent when asked to remember, or the app's memory file. */
  source: 'user' | 'agent' | 'app';
}

/** The memory file an app ships (ai-memory.json); Settings > Memory > "Download ai-memory.json" writes it. */
export interface MemoryFile {
  version?: number;
  memories: Array<string | (Partial<Memory> & { text: string })>;
}

/** What a `screenshot` hook may return: something that can be drawn, or null to use the browser's screen capture. */
export type ScreenshotSource = HTMLCanvasElement | OffscreenCanvas | ImageBitmap | HTMLImageElement | HTMLVideoElement | ImageData | Blob | string | null | undefined | false;

export type ProviderId = 'lmstudio' | 'ollama' | 'custom' | 'openai' | 'anthropic' | 'google' | 'deepseek' | 'openrouter';

export interface AgentSettings {
  provider: ProviderId;
  /** Per-provider address and model, remembered when switching. An empty model means "whatever is loaded" (LM Studio). */
  profiles: Partial<Record<ProviderId, { baseUrl?: string; model?: string }>>;
  transport: 'direct' | 'relay';
  /** Absolute URL or same-origin path of the app relay (assets/relay/relay.php or relay.mjs). */
  relayUrl: string;
  fallbackProvider: ProviderId | '';
  /** '' = use the application's default system prompt. */
  systemPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  historyMessages: number;
  maxContextChars: number;
  reasoning: 'show' | 'hide' | 'off';
  shareScreen: boolean;
  timeoutSec: number;
  rememberKeys: boolean;
  /** Master switch for tools. */
  toolsEnabled: boolean;
  /** 'native' tool calls, 'text' tool blocks (any model), 'auto' = native, text if the server refuses tools. */
  toolMode: 'auto' | 'native' | 'text';
  confirmWrites: boolean;
  confirmDestructive: boolean;
  maxToolSteps: number;
  /** Per-tool on/off, merged over toolsConfig and each tool's `enabled`. */
  toolStates: Record<string, boolean>;
  /** Add the memories to every conversation. Default true. */
  memoryEnabled: boolean;
  /** The agent may save, correct and delete memories when the user asks (built-in tools remember / forget). Default true. */
  memoryWrite: boolean;
  /** The model accepts images: the camera button and screenshots are offered. Default true. */
  vision: boolean;
  /** The agent may take a screenshot on its own (built-in tool take_screenshot). Default false: only the camera button. */
  screenshotAuto: boolean;
}

export interface CodeBlock { language: string; code: string }

export interface CodeAction {
  id: string;
  label: string;
  title?: string;
  /** Show the button only for some blocks, e.g. (b) => b.language === 'sql'. */
  when?: (block: CodeBlock) => boolean;
  /** Return false to suppress the "Done" flash. Never run anything destructive without the user confirming. */
  run: (block: CodeBlock, agent: AiAgent) => unknown;
  doneLabel?: string;
}

export interface ReplyAction {
  /** 'copy' and 'copy-tools' are the built-in Copy and Copy tool log buttons. */
  id: string;
  label: string;
  title?: string;
  run: (markdown: string, agent: AiAgent) => unknown;
  doneLabel?: string;
}

/** A field of a parseBlockValues() schema: the values the app accepts, with the ranges of its real controls. */
export interface BlockField {
  type: 'number' | 'integer' | 'boolean' | 'enum' | 'string';
  min?: number;
  max?: number;
  /** Numbers are rounded to this step (from `min`, or 0). */
  step?: number;
  /** For 'enum': the allowed values (matched case- and punctuation-insensitively). */
  values?: Array<string | number>;
  /** Other names the model may use for this key (matched case- and punctuation-insensitively). */
  aliases?: string[];
  maxLength?: number;
}

export interface BlockValues {
  /** Known keys, coerced and clamped. */
  values: Record<string, unknown>;
  /** Keys that are not in the schema (ignored). */
  unknown: string[];
  /** Known keys whose value could not be read (ignored). */
  invalid: string[];
  /** Known keys whose value was clamped or rounded. */
  adjusted: string[];
}

/** What a relay's GET answer says (agent.relayInfo(), the 'relay' event). */
export interface RelayInfo {
  url: string;
  available: boolean;
  mode: 'local' | 'public' | '';
  version?: string;
  providers: ProviderId[];
  serverKeys: Partial<Record<ProviderId, boolean>>;
  /** The server's fixed provider/model choice (public mode), or its suggestion (local mode). `vision` when the config says so. */
  preset: { provider: ProviderId; model: string; models: string[]; vision?: boolean } | null;
  /** How many images (screenshots) one request may carry through this relay. 0: none (or a relay older than 1.3). */
  images: number;
  reason: string;
}

export type ContextState = 'synced' | 'dirty' | 'unread' | 'none' | 'off';

export interface ContextStatus {
  /** synced: the agent has exactly what is on screen · dirty: changed since · unread: not read in this chat · none: no content · off: sharing disabled */
  state: ContextState;
  /** True when the next question will carry a fresh snapshot. */
  pending: boolean;
  reason: string;
  /** Fingerprint of the screen now (14 hex chars; show the first 7). */
  hash: string | null;
  /** Fingerprint of the newest snapshot the agent has in this conversation. */
  syncedHash: string | null;
  pageId: string | null;
  title: string;
  chars: number;
  truncated: boolean;
  forced: boolean;
}

export interface AiAgentOptions {
  /** Namespaces everything stored in the browser (settings, keys, chats, width). One per application. */
  appId: string;
  /** Drawer title, e.g. 'Assistant' or 'Security analyst'. */
  title?: string;
  app?: Hook<AppContext>;
  page?: PageContext;
  /** The application's default system prompt (users can override it in Settings > Agent). */
  systemPrompt?: string | (() => string);
  /** Markdown shown when a chat starts. */
  welcome?: string;
  /** Clickable starter questions. */
  suggestions?: string[];
  placeholder?: string;
  /** Element(s) that open/close the drawer. Omit to get a floating launcher button. */
  toggle?: string | Element | Element[] | null;
  launcher?: boolean;
  /** Show a coloured context-state dot on the toggle(s). Default true. */
  toggleBadge?: boolean;
  /** Element(s) that get right padding while the drawer is open, so nothing hides under it. Default document.body; false = overlay. */
  push?: string | Element | Element[] | boolean | null;
  /** Keyboard shortcut to toggle, e.g. 'mod+i' (Ctrl on Windows/Linux, Cmd on macOS). false to disable. */
  hotkey?: string | false;
  theme?: 'auto' | 'light' | 'dark';
  /** Default drawer width in px (users can drag it; the choice is remembered). */
  width?: number;
  /** Poll the content hook every N ms while the drawer is open (for apps that cannot call contextChanged()). 0 = off. */
  watch?: number;
  /** Debounce for contextChanged(), in ms. Default 300. */
  debounceMs?: number;
  /**
   * While contextChanged() keeps being called (animation, simulation, live data), refresh the flag at least every
   * N ms anyway. Default 1000; 0 = plain debounce (the flag waits until the changes stop).
   */
  debounceMaxMs?: number;
  /**
   * Keep keystrokes typed in the drawer and the settings modal away from the host page's bubbling key listeners, so
   * host shortcuts (Space = play/pause, letters, arrows) cannot swallow them. Ctrl/Cmd app shortcuts (Ctrl+S…) still
   * reach the host. Default true.
   */
  isolateKeys?: boolean;
  /**
   * Native modal dialogs make everything else inert, the drawer included. 'dock': while the drawer is open, managed
   * dialogs are shown non-modally beside it (class .aia-docked-dialog) and become modal again when it closes; the
   * switch fires no close/toggle events at the host. Pass { selector } to manage only some dialogs. Default false.
   */
  dialogs?: false | 'dock' | { mode?: 'dock'; selector?: string };
  /**
   * Dev-time console warnings: the pushed layout overflows or hides elements under the drawer, or a modal dialog
   * makes the drawer inert. 'auto' (default) = on for localhost, 127.x, *.localhost, *.test, *.local and file:.
   */
  devWarnings?: boolean | 'auto';
  /**
   * Ask the relay (GET) at startup whether it will serve this page: if it says `available`, use it (and its preset
   * provider/model); otherwise send requests directly. true = probe defaults.relayUrl; a string = that URL.
   * Questions wait for the probe (agent.ready). Default false.
   */
  relayProbe?: boolean | string | { url?: string; timeoutMs?: number };
  /** Settings > Context warns (for local models) when the first request is estimated above this many tokens. Default 3000. */
  contextWarnTokens?: number;
  /** The app's tool catalog (references/tools.md). */
  tools?: ToolDefinition[];
  /** The app's default tool selection: a URL (e.g. 'ai-tools.json'), an object, or a (possibly async) function. */
  toolsConfig?: string | ToolsConfig | Promise<ToolsConfig> | (() => ToolsConfig | Promise<ToolsConfig>) | null;
  /**
   * Memory: notes the agent keeps between conversations (Settings > Memory; the agent saves one when the user asks it
   * to remember something). Default true; false removes the tab, the tools and the prompt section.
   */
  memory?: boolean;
  /**
   * The app's memory file: a URL (e.g. 'ai-memory.json'), an object, or a (possibly async) function. Its memories are
   * the starting point for every user; what a user adds, edits or deletes is kept in their browser on top of it.
   */
  memoryFile?: string | MemoryFile | Promise<MemoryFile> | (() => MemoryFile | Promise<MemoryFile>) | null;
  /**
   * Called (debounced) with the whole memory file after every change made in this browser, so an app with a backend
   * can keep it somewhere durable (a file on its server, the user's profile). Pair it with `memoryFile` for loading.
   */
  memorySave?: ((file: MemoryFile) => void | Promise<void>) | null;
  /**
   * Screenshots for models that see images (Settings > Vision, the camera button, the agent's take_screenshot tool).
   * Default true; false removes them.
   */
  screenshots?: boolean;
  /**
   * The app's own picture of what the user is looking at (best for canvas / WebGL views; needs no permission).
   * Without it — or when it returns null — the browser's screen capture of this tab is used (the browser asks first).
   * A canvas returned synchronously is read at once, so a WebGL canvas works when the hook renders a frame first.
   */
  screenshot?: ((info: { reason: 'user' | 'agent' }) => ScreenshotSource | Promise<ScreenshotSource>) | null;
  /** Screenshots are scaled down so their longer edge is at most this many pixels. Default 1280. */
  screenshotMaxEdge?: number;
  codeActions?: CodeAction[];
  replyActions?: ReplyAction[];
  /**
   * Application defaults for the settings (users can change them). May also be a promise or a (possibly async)
   * function: questions wait until it has resolved (agent.ready).
   */
  defaults?: Partial<AgentSettings> | Promise<Partial<AgentSettings>> | (() => Partial<AgentSettings> | Promise<Partial<AgentSettings>>);
  /** Extra headers for relay requests, e.g. a CSRF token. */
  relayHeaders?: Record<string, string> | (() => Record<string, string>);
  /** Keep conversations in localStorage (Saved chats). Default true. */
  saveChats?: boolean;
  /** Per browser tab, reopen the active chat (and the drawer, if it was open) after a reload/navigation. Default true. */
  resume?: boolean;
  /** Where the drawer and modal are appended. Default document.body. */
  mount?: string | Element;
}

/**
 * 'open' detail: {} — or { resumed: true } when `resume` reopened the drawer during createAiAgent (replayed once, to
 * listeners registered in the same tick; later, check agent.isOpen()). 'relay' detail: RelayInfo (relayProbe).
 * 'tool' detail: { name, args, status: 'ok'|'error'|'declined'|'off'|'skipped', result }. result: what the tool returned,
 * or why it failed (e.g. 'Cut off: …' when the reply reached Max reply tokens mid-call; such a call is never run).
 * 'tool-state': { name, enabled }.
 * 'memory' detail: { memories: Memory[], change: { type: 'add'|'update'|'remove'|'replace'|'clear'|'base', id? } }.
 * 'screenshot' detail: { by: 'user'|'agent', width, height, source: 'app'|'screen' }.
 */
export type AgentEvent = 'open' | 'close' | 'send' | 'reply' | 'error' | 'context' | 'settings' | 'relay' | 'tool' | 'tool-state' | 'memory' | 'screenshot';

export interface AiAgent {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Ask a question as if the user typed it (opens the drawer). */
  ask(text: string): Promise<void>;
  /** Stop the reply that is streaming. */
  stop(): void;
  newChat(): void;
  openSettings(tab?: 'model' | 'agent' | 'tools' | 'memory' | 'vision' | 'context'): void;

  setApp(app: Hook<AppContext>): void;
  /** Call on navigation. */
  setPage(page: PageContext | null): void;
  setContent(content: Hook<unknown>): void;
  setView(view: Hook<unknown>): void;
  /** Tell the agent the screen may have changed (debounced). Updates the flag; the page is re-sent on the next question if its hash changed. */
  contextChanged(): void;
  /** Recompute the flag now. */
  refreshContext(): Promise<ContextStatus>;
  getContextStatus(): ContextStatus;
  /** Resolves (to the agent) once async `defaults` and the relay probe have been applied. Resolves at once without them. */
  ready: Promise<AiAgent>;
  /** What the relay probe found, or null (no relayProbe, or not finished yet). */
  relayInfo(): RelayInfo | null;
  tools: {
    /** Every tool known now (app-wide + this page), with its state. */
    list(): ToolInfo[];
    register(defs: ToolDefinition | ToolDefinition[]): void;
    unregister(name: string): void;
    /** Turn a tool on/off for this user (saved like Settings > Tools). */
    setEnabled(name: string, on: boolean): void;
    /** Run a tool directly: arguments validated, no confirmation, on/off ignored. Resolves to what the model would read. */
    run(name: string, args?: Record<string, unknown>): Promise<string>;
    /** The current selection as an ai-tools.json object. */
    exportConfig(): ToolsConfig;
  };
  /** The notes kept between conversations; null with `memory: false`. Changes are saved at once and fire 'memory'. */
  memory: {
    list(): Memory[];
    /** Add a note (an identical one is returned instead). Throws when the text is empty or memory is full (100). */
    add(text: string): Memory;
    update(id: string, text: string): Memory | null;
    remove(id: string): Memory | null;
    clear(): void;
    /** The memories as an ai-memory.json object. */
    export(): MemoryFile;
    /** Add the memories of a file; { replace: true } makes them the whole memory. Returns how many were added. */
    import(file: MemoryFile | Array<string | Partial<Memory>>, options?: { replace?: boolean }): number;
  } | null;
  /**
   * Take a screenshot and put it in the composer for the next question (what the camera button does). With the
   * browser's screen capture, call it from a click handler. Resolves to null when none was taken.
   */
  screenshot(): Promise<{ width: number; height: number; source: 'app' | 'screen' } | null>;
  /** Subscribe to the flag; called immediately with the current status. Returns an unsubscribe function. */
  onContextStatus(fn: (status: ContextStatus) => void): () => void;
  /** Force the page to be re-sent with the next question. */
  rereadPage(): Promise<ContextStatus>;
  /** The full system prompt as it would be sent now. */
  systemPrompt(): Promise<string>;

  on(event: AgentEvent, fn: (detail: any) => void): () => void;
  settings: {
    get(): AgentSettings;
    save(patch: Partial<AgentSettings>): boolean;
    reset(): void;
    setKey(provider: ProviderId, key: string): boolean;
  };
  destroy(): void;
}

export function createAiAgent(options: AiAgentOptions): AiAgent;

/** Content hook that reads the rendered text of an element (plus visible form-field values). */
export function fromDom(target: string | Element, options?: { exclude?: string; fields?: boolean }): () => string;

/**
 * Values from a fenced code block, checked against an allowlisted schema. A block tagged with one of `tags` is
 * accepted when at least one key is known; a generic block (json, yaml, text, untagged…) only when every key is
 * known. JSON or `key: value` lines; values coerced and clamped. null when the block is not for you.
 */
export function parseBlockValues(block: { language?: string; code: string }, options: { tags?: string | string[]; schema: Record<string, BlockField>; generic?: string[] }): BlockValues | null;

/**
 * Set a form control like a user: numbers clamped to min/max/step, the native value setter (so React & co. notice),
 * bubbling input + change events; checkboxes/radios are clicked. Returns true when the control now holds the value.
 */
export function setControlValue(target: string | Element, value: unknown): boolean;

/** GET the relay and report whether it will serve this page. Never throws. */
export function probeRelay(url: string, options?: { timeoutMs?: number; headers?: Record<string, string>; fetch?: typeof fetch }): Promise<RelayInfo>;

/** Memories from an ai-memory.json object (or a plain array); entries without an id get one. */
export function parseMemoryFile(json: unknown): Memory[];
export function exportMemoryFile(memories: Memory[]): MemoryFile;

export function renderMarkdown(markdown: string, options?: { codeActions?: Array<Pick<CodeAction, 'id' | 'label' | 'title' | 'when'>> }): { html: string; code: CodeBlock[] };
export function hashText(text: string): string;
export function stableStringify(value: unknown, indent?: number): string;
export const DEFAULT_SYSTEM_PROMPT: string;
export const PROVIDERS: Readonly<Record<ProviderId, Readonly<Record<string, unknown>>>>;
export const PROVIDER_IDS: readonly ProviderId[];
export const VERSION: string;
export class AiError extends Error {
  code: 'auth' | 'missing-model' | 'bad-endpoint' | 'network' | 'timeout' | 'rate-limit' | 'refused' | 'malformed' | 'cancelled' | 'budget';
  status?: number;
  hints: string[];
}
