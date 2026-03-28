# @ag-vibe/auth

Authentication SDK for ag-vibe frontends (allinone backend).

## Features

- Zustand-based auth session store with persistence (`localStorage`)
- Access token refresh (`/auth/refresh`) with in-flight dedupe
- 401 auto-retry interceptor for heyapi clients
- Does not clear session on transient refresh failures (network/429/5xx)
- Browser-less fallback storage (in-memory) for non-DOM runtimes

## Install

```bash
pnpm add @ag-vibe/auth
```

## Quick Start

```ts
import { createAuthClient } from "@ag-vibe/auth";
import { client as apiClient } from "@/api-gen/client.gen";

export const auth = createAuthClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "/api/v1",
  appId: "todo",
});

// 1) Provide bearer token for generated SDK
export const createClientConfig = (config: Record<string, unknown>) => ({
  ...config,
  auth: async (a: { scheme: string }) => {
    if (a.scheme === "bearer") {
      return (await auth.ensureValidAccessToken()) ?? undefined;
    }
    return undefined;
  },
});

// 2) Install 401 auto-retry interceptor
auth.applyTo(apiClient);
```

## API

### `createAuthClient({ baseUrl, appId })`

Returns:

- `store`: auth state store (`session`, `isAuthenticated`, `setSession`, `clearSession`)
- `ensureValidAccessToken(forceRefresh?)`: returns valid access token or `null`
- `applyTo(client | client[])`: installs idempotent 401 retry interceptor

### Refresh Behavior

- Proactive refresh when token is close to expiry
- Forced refresh when interceptor catches 401
- Refresh failure handling:
  - `401/403` from refresh endpoint: clear session
  - network errors / `429` / `5xx`: keep session, return `null`

## Interceptor Behavior

`applyTo(...)` response interceptor:

1. Skip non-401 responses
2. Skip auth endpoints (`/auth/sign-in`, `/auth/sign-up`, `/auth/sign-out`, `/auth/refresh`)
3. Refresh token once
4. Retry original request with updated `Authorization` header

## Development

```bash
vp install
vp check
vp test
vp pack
```
