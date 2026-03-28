/**
 * Auth state store powered by zustand.
 *
 * Uses `persist` middleware with localStorage for persistence and
 * cross-tab synchronisation via the native `storage` event.
 */

import { createStore } from "zustand/vanilla";
import { persist, createJSONStorage } from "zustand/middleware";

/** Represents a stored authentication session. */
export interface AuthSession {
  /** JWT access token. */
  accessToken: string;
  /** Opaque refresh token used to obtain a new access token. */
  refreshToken?: string;
  /** Token type, typically `"Bearer"`. */
  tokenType?: string;
}

export interface AuthState {
  /** Current session, or `null` when unauthenticated. */
  session: AuthSession | null;
  /** Convenience flag derived from `session`. */
  isAuthenticated: boolean;
  /** Replace the current session (login / token refresh). */
  setSession: (session: AuthSession) => void;
  /** Clear the current session (logout). */
  clearSession: () => void;
}

const memoryStorageState = new Map<string, string>();

const memoryStorage: Storage = {
  get length() {
    return memoryStorageState.size;
  },
  clear() {
    memoryStorageState.clear();
  },
  getItem(key: string) {
    return memoryStorageState.get(key) ?? null;
  },
  key(index: number) {
    return Array.from(memoryStorageState.keys())[index] ?? null;
  },
  removeItem(key: string) {
    memoryStorageState.delete(key);
  },
  setItem(key: string, value: string) {
    memoryStorageState.set(key, value);
  },
};

function resolveStorage(): Storage {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // localStorage may exist but be inaccessible in strict browser contexts.
  }
  return memoryStorage;
}

/**
 * Creates a vanilla zustand store for auth state.
 *
 * @param appId - Used to namespace the localStorage key.
 * @internal
 */
export function createAuthStore(appId: string) {
  return createStore<AuthState>()(
    persist(
      (set) => ({
        session: null,
        isAuthenticated: false,
        setSession: (session) => set({ session, isAuthenticated: true }),
        clearSession: () => set({ session: null, isAuthenticated: false }),
      }),
      {
        name: `ag-vibe.auth.${appId}.v1`,
        storage: createJSONStorage(resolveStorage),
        // Only persist the session data, not the derived flag or functions.
        partialize: (state) => ({ session: state.session }),
        merge: (persisted, current) => {
          const p = persisted as { session?: AuthSession | null };
          return {
            ...current,
            session: p?.session ?? null,
            isAuthenticated: p?.session != null,
          };
        },
      },
    ),
  );
}

export type AuthStore = ReturnType<typeof createAuthStore>;
