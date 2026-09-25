/**
 * Google OAuth 2.0 via Google Identity Services (token model).
 * Runs entirely in the browser: no client secret, no redirect URI, no backend.
 * Access tokens last ~1 hour; we keep them in sessionStorage so a page reload
 * in the same tab doesn't force a new sign-in.
 */
import { useSession, useSettings } from './store';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    google?: any;
  }
}

/**
 * Full Drive scope so the explorer can see files you add from the Drive app on
 * your phone/tablet (e.g. dropping a .cbz into the studio folder). Fine for a
 * personal app left in "Testing" mode. See README for the narrower drive.file option.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

const TOKEN_KEY = 'mrs-token';

export class AuthError extends Error {
  constructor(message = 'Your Google session expired. Tap “Reconnect” in the top bar and try again.') {
    super(message);
    this.name = 'AuthError';
  }
}

export function getClientId(): string {
  return (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || useSettings.getState().googleClientId || '').trim();
}

export function clientIdFromEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID);
}

/** The Google account Drive storage is pinned to ('' = any). Env var wins over Settings. */
export function getRequiredAccount(): string {
  return (process.env.NEXT_PUBLIC_DRIVE_ACCOUNT || useSettings.getState().driveAccountEmail || '').trim().toLowerCase();
}

/** True when a required account is configured and `email` isn't it. */
export function isWrongAccount(email?: string | null): boolean {
  const required = getRequiredAccount();
  return Boolean(required && email && email.toLowerCase() !== required);
}

function waitForGis(timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - started > timeoutMs)
        return reject(new Error('Google sign-in script failed to load. Check your connection or ad-blocker.'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

let tokenClient: any = null;
let tokenClientFor = '';
let pending: { resolve: (token: string) => void; reject: (err: Error) => void } | null = null;

function handleTokenResponse(resp: any) {
  const p = pending;
  pending = null;
  if (!p) return;
  if (resp?.error) {
    p.reject(new Error(resp.error_description || resp.error));
    return;
  }
  if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
    p.reject(
      new Error('Google Drive access was not granted. Sign in again and tick the “See, edit, create and delete… Google Drive” box.'),
    );
    return;
  }
  storeToken(resp.access_token, Number(resp.expires_in) || 3600);
  p.resolve(resp.access_token);
}

async function ensureTokenClient(): Promise<any> {
  const clientId = getClientId();
  if (!clientId) throw new Error('Missing Google OAuth Client ID. Add it on the Settings page (or as NEXT_PUBLIC_GOOGLE_CLIENT_ID).');
  if (tokenClient && tokenClientFor === clientId) return tokenClient;
  await waitForGis();
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: DRIVE_SCOPE,
    callback: handleTokenResponse,
    error_callback: (err: any) => {
      const p = pending;
      pending = null;
      p?.reject(new Error(err?.type === 'popup_closed' ? 'Sign-in window was closed.' : err?.message || 'Sign-in failed or was blocked.'));
    },
  });
  tokenClientFor = clientId;
  return tokenClient;
}

/** Pre-initialise on app load so sign-in can open its popup synchronously inside the click handler. */
export async function initAuth(): Promise<void> {
  if (!getClientId()) return;
  await ensureTokenClient();
}

/**
 * Must be called from a click/tap handler so the popup isn't blocked.
 * After the first consent, Google usually returns a fresh token without showing a prompt.
 */
export function signIn(): Promise<string> {
  return new Promise((resolve, reject) => {
    pending?.reject(new Error('Superseded by a newer sign-in request.'));
    const go = (client: any) => {
      pending = { resolve, reject };
      // Pre-select the pinned Drive account in Google's chooser.
      const email = getRequiredAccount() || useSession.getState().user?.emailAddress;
      client.requestAccessToken({ prompt: '', ...(email ? { login_hint: email } : {}) });
    };
    if (tokenClient && tokenClientFor === getClientId()) go(tokenClient);
    else ensureTokenClient().then(go, reject);
  });
}

/** If the token will expire within `minValidMs`, refresh it (call from a click handler). */
export async function refreshIfExpiringSoon(minValidMs = 50 * 60_000): Promise<void> {
  if (tokenValidForMs() < minValidMs) await signIn();
}

export function signOut() {
  const token = useSession.getState().token;
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => undefined);
  clearToken();
  useSession.getState().set({ user: null, rootId: null, projectsId: null, project: null });
}

function storeToken(token: string, expiresInSec: number) {
  const expiresAt = Date.now() + expiresInSec * 1000 - 60_000;
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt }));
  } catch {
    /* private mode */
  }
  useSession.getState().set({ token, expiresAt });
}

export function restoreToken(): boolean {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return false;
    const { token, expiresAt } = JSON.parse(raw);
    if (token && expiresAt > Date.now() + 30_000) {
      useSession.getState().set({ token, expiresAt });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  useSession.getState().set({ token: null, expiresAt: 0 });
}

export function tokenValidForMs(): number {
  const { token, expiresAt } = useSession.getState();
  return token ? Math.max(0, expiresAt - Date.now()) : 0;
}

export function getToken(): string {
  const { token, expiresAt } = useSession.getState();
  if (!token || Date.now() >= expiresAt) throw new AuthError();
  return token;
}

/** Called when Drive answers 401 — the token was revoked or expired early. */
export function markTokenExpired() {
  useSession.getState().set({ expiresAt: 0 });
}
