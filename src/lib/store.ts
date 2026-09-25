import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Project } from './projects';
import type { RecapScript } from './script';

/* ------------------------------------------------------------------ */
/* Settings — persisted in this browser's localStorage only.           */
/* ------------------------------------------------------------------ */

export type ScriptEngine = 'gemini' | 'openai';
export type TtsProvider = 'elevenlabs' | 'google';
export type TtsTransport = 'edge' | 'direct';

export interface Settings {
  googleClientId: string;
  /** Only this Google account may be used for Drive storage (empty = any account). */
  driveAccountEmail: string;

  scriptEngine: ScriptEngine;
  geminiApiKey: string;
  geminiModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;

  ttsProvider: TtsProvider;
  ttsTransport: TtsTransport;
  elevenApiKey: string;
  elevenVoiceId: string;
  elevenModelId: string;
  googleTtsApiKey: string;
  googleTtsVoice: string;
  speakingRate: number;

  lastProjectId: string;
}

export const DEFAULT_SETTINGS: Settings = {
  googleClientId: '',
  driveAccountEmail: 'info.killer12131@gmail.com',

  scriptEngine: 'gemini',
  geminiApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  openaiBaseUrl: 'https://api.groq.com/openai/v1',
  openaiApiKey: '',
  openaiModel: 'llama-3.3-70b-versatile',

  ttsProvider: 'elevenlabs',
  ttsTransport: 'edge',
  elevenApiKey: '',
  elevenVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
  elevenModelId: 'eleven_multilingual_v2',
  googleTtsApiKey: '',
  googleTtsVoice: 'en-US-Neural2-D',
  speakingRate: 1,

  lastProjectId: '',
};

interface SettingsState extends Settings {
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      update: (patch) => set(patch),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    { name: 'mrs-settings', storage: createJSONStorage(() => localStorage), version: 1 },
  ),
);

/* ------------------------------------------------------------------ */
/* Session — in-memory state shared across pages.                      */
/* ------------------------------------------------------------------ */

export interface DriveUser {
  displayName?: string;
  emailAddress?: string;
  photoLink?: string;
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

interface SessionState {
  token: string | null;
  expiresAt: number;
  user: DriveUser | null;
  rootId: string | null;
  projectsId: string | null;
  project: Project | null;
  projectLoading: boolean;

  /** Working script shared between the Script and Voice pages. */
  script: RecapScript | null;
  scriptFileId: string | null;

  toasts: Toast[];
  set: (patch: Partial<Omit<SessionState, 'set' | 'toast' | 'dismissToast'>>) => void;
  toast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

export const useSession = create<SessionState>()((set) => ({
  token: null,
  expiresAt: 0,
  user: null,
  rootId: null,
  projectsId: null,
  project: null,
  projectLoading: false,
  script: null,
  scriptFileId: null,
  toasts: [],
  set: (patch) => set(patch),
  toast: (message, kind = 'info') => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }].slice(-4) }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 9000 : 4500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (message: string, kind?: Toast['kind']) => useSession.getState().toast(message, kind);
