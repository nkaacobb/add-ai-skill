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
}

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
  id: string;
  label: string;
  title?: string;
  run: (markdown: string, agent: AiAgent) => unknown;
  doneLabel?: string;
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
  /** Debounce for contextChanged(), in ms. */
  debounceMs?: number;
  codeActions?: CodeAction[];
  replyActions?: ReplyAction[];
  /** Application defaults for the settings (users can change them). */
  defaults?: Partial<AgentSettings>;
  /** Extra headers for relay requests, e.g. a CSRF token. */
  relayHeaders?: Record<string, string> | (() => Record<string, string>);
  /** Keep conversations in localStorage (Saved chats). Default true. */
  saveChats?: boolean;
  /** Per browser tab, reopen the active chat (and the drawer, if it was open) after a reload/navigation. Default true. */
  resume?: boolean;
  /** Where the drawer and modal are appended. Default document.body. */
  mount?: string | Element;
}

export type AgentEvent = 'open' | 'close' | 'send' | 'reply' | 'error' | 'context' | 'settings';

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
  openSettings(tab?: 'model' | 'agent' | 'context'): void;

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
