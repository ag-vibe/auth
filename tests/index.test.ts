import { expect, test, beforeEach, afterEach, vi } from "vite-plus/test";
import { createAuthClient, type AuthClient } from "../src/client.ts";
import { decodeJwtPayload, isTokenExpiringSoon } from "../src/core/jwt.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJwt(expInSeconds: number): string {
  const payload = btoa(JSON.stringify({ exp: expInSeconds })).replace(/=/g, "");
  return `header.${payload}.sig`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let auth: AuthClient;

beforeEach(() => {
  localStorage.clear();
  auth = createAuthClient({ baseUrl: "http://localhost:8080/api/v1", appId: "test" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// store — basic session management
// ---------------------------------------------------------------------------

test("initial state is unauthenticated", () => {
  const { session, isAuthenticated } = auth.store.getState();
  expect(session).toBeNull();
  expect(isAuthenticated).toBe(false);
});

test("setSession / getState round-trip", () => {
  auth.store
    .getState()
    .setSession({ accessToken: "tok", refreshToken: "ref", tokenType: "Bearer" });
  const { session, isAuthenticated } = auth.store.getState();
  expect(session).toEqual({ accessToken: "tok", refreshToken: "ref", tokenType: "Bearer" });
  expect(isAuthenticated).toBe(true);
});

test("clearSession resets to unauthenticated", () => {
  auth.store.getState().setSession({ accessToken: "tok" });
  auth.store.getState().clearSession();
  expect(auth.store.getState().session).toBeNull();
  expect(auth.store.getState().isAuthenticated).toBe(false);
});

test("subscribe fires on state changes", () => {
  const calls: boolean[] = [];
  const unsub = auth.store.subscribe((s) => calls.push(s.isAuthenticated));

  auth.store.getState().setSession({ accessToken: "a" });
  auth.store.getState().clearSession();

  expect(calls).toEqual([true, false]);
  unsub();

  auth.store.getState().setSession({ accessToken: "b" });
  expect(calls).toHaveLength(2); // no new calls after unsub
});

test("storage key is namespaced by appId", () => {
  auth.store.getState().setSession({ accessToken: "tok" });
  const raw = localStorage.getItem("ag-vibe.auth.test.v1");
  expect(raw).not.toBeNull();
});

test("session persists across store instances", () => {
  auth.store.getState().setSession({ accessToken: "persisted" });

  // Create a new client with the same appId — should rehydrate
  const auth2 = createAuthClient({ baseUrl: "http://localhost:8080/api/v1", appId: "test" });
  expect(auth2.store.getState().session?.accessToken).toBe("persisted");
  expect(auth2.store.getState().isAuthenticated).toBe(true);
});

// ---------------------------------------------------------------------------
// jwt
// ---------------------------------------------------------------------------

test("decodeJwtPayload returns parsed payload", () => {
  const payload = decodeJwtPayload(makeJwt(9999999999));
  expect(payload?.exp).toBe(9999999999);
});

test("decodeJwtPayload returns null for malformed token", () => {
  expect(decodeJwtPayload("onlyone")).toBeNull();
  expect(decodeJwtPayload("")).toBeNull();
  expect(decodeJwtPayload("header.!!invalid!!.sig")).toBeNull();
});

test("isTokenExpiringSoon returns false for a fresh token", () => {
  expect(isTokenExpiringSoon(makeJwt(nowSec() + 3600))).toBe(false);
});

test("isTokenExpiringSoon returns true when within leeway", () => {
  expect(isTokenExpiringSoon(makeJwt(nowSec() + 30))).toBe(true);
});

test("isTokenExpiringSoon returns false without exp claim", () => {
  const payload = btoa(JSON.stringify({ sub: "123" })).replace(/=/g, "");
  expect(isTokenExpiringSoon(`header.${payload}.sig`)).toBe(false);
});

// ---------------------------------------------------------------------------
// ensureValidAccessToken
// ---------------------------------------------------------------------------

test("returns null when not authenticated", async () => {
  expect(await auth.ensureValidAccessToken()).toBeNull();
});

test("returns token when not expiring", async () => {
  const jwt = makeJwt(nowSec() + 3600);
  auth.store.getState().setSession({ accessToken: jwt });
  expect(await auth.ensureValidAccessToken()).toBe(jwt);
});

test("refreshes when token is expiring soon", async () => {
  const oldJwt = makeJwt(nowSec() + 30);
  const newJwt = makeJwt(nowSec() + 3600);

  auth.store.getState().setSession({ accessToken: oldJwt, refreshToken: "ref" });

  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ accessToken: newJwt, refreshToken: "new-ref", tokenType: "Bearer" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
  );

  expect(await auth.ensureValidAccessToken()).toBe(newJwt);
  expect(auth.store.getState().session?.accessToken).toBe(newJwt);
});

test("refresh clears session on 401 response", async () => {
  auth.store.getState().setSession({ accessToken: "tok", refreshToken: "ref" });

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));

  expect(await auth.ensureValidAccessToken(true)).toBeNull();
  expect(auth.store.getState().session).toBeNull();
});

test("refresh clears session on 403 response", async () => {
  auth.store.getState().setSession({ accessToken: "tok", refreshToken: "ref" });

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })));

  expect(await auth.ensureValidAccessToken(true)).toBeNull();
  expect(auth.store.getState().session).toBeNull();
});

test("refresh does NOT clear session on 429 response", async () => {
  auth.store.getState().setSession({ accessToken: "tok", refreshToken: "ref" });

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("Too Many Requests", { status: 429 })),
  );

  expect(await auth.ensureValidAccessToken(true)).toBeNull();
  // Session should still be there
  expect(auth.store.getState().session).not.toBeNull();
});

test("refresh does NOT clear session on 500 response", async () => {
  auth.store.getState().setSession({ accessToken: "tok", refreshToken: "ref" });

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 })),
  );

  expect(await auth.ensureValidAccessToken(true)).toBeNull();
  expect(auth.store.getState().session).not.toBeNull();
});

// ---------------------------------------------------------------------------
// applyTo — 401 interceptor
// ---------------------------------------------------------------------------

test("applyTo installs interceptor that retries on 401", async () => {
  const newJwt = makeJwt(nowSec() + 3600);

  auth.store.getState().setSession({ accessToken: "old", refreshToken: "ref" });

  // First call: the interceptor's refresh call.
  // Second call: the interceptor's retry of the original request.
  const mockFetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ accessToken: newJwt, refreshToken: "new-ref", tokenType: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(new Response("OK", { status: 200 }));
  vi.stubGlobal("fetch", mockFetch);

  // Build a mock interceptable client
  type InterceptorFn = (
    response: Response,
    request: Request,
    options: { serializedBody?: unknown; signal?: AbortSignal },
  ) => Promise<Response> | Response;

  const interceptors: InterceptorFn[] = [];
  const mockClient = {
    interceptors: {
      response: {
        use: (fn: InterceptorFn) => interceptors.push(fn),
      },
    },
  };

  auth.applyTo(mockClient);

  // Simulate a 401 response going through the interceptor
  const originalRequest = new Request("http://localhost:8080/api/v1/todos", {
    method: "GET",
    headers: { Authorization: "Bearer old" },
  });
  const originalResponse = new Response("Unauthorized", { status: 401 });

  const result = await interceptors[0]!(originalResponse, originalRequest, {});
  expect(result.status).toBe(200);
  // The fetch should have been called twice: once for refresh, once for retry
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

test("applyTo skips auth endpoints", async () => {
  auth.store.getState().setSession({ accessToken: "tok", refreshToken: "ref" });

  type InterceptorFn = (
    response: Response,
    request: Request,
    options: { serializedBody?: unknown; signal?: AbortSignal },
  ) => Promise<Response> | Response;

  const interceptors: InterceptorFn[] = [];
  const mockClient = {
    interceptors: { response: { use: (fn: InterceptorFn) => interceptors.push(fn) } },
  };

  auth.applyTo(mockClient);

  const req = new Request("http://localhost:8080/api/v1/auth/refresh", { method: "POST" });
  const res = new Response("Unauthorized", { status: 401 });

  const result = await interceptors[0]!(res, req, {});
  // Should return original response — no retry
  expect(result.status).toBe(401);
});

test("applyTo skips auth endpoints with query string", async () => {
  auth.store.getState().setSession({ accessToken: "tok", refreshToken: "ref" });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  type InterceptorFn = (
    response: Response,
    request: Request,
    options: { serializedBody?: unknown; signal?: AbortSignal },
  ) => Promise<Response> | Response;

  const interceptors: InterceptorFn[] = [];
  const mockClient = {
    interceptors: { response: { use: (fn: InterceptorFn) => interceptors.push(fn) } },
  };

  auth.applyTo(mockClient);

  const req = new Request("http://localhost:8080/api/v1/auth/refresh?tenant=demo", {
    method: "POST",
  });
  const res = new Response("Unauthorized", { status: 401 });

  const result = await interceptors[0]!(res, req, {});
  expect(result.status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("applyTo skips sign-out endpoint", async () => {
  auth.store.getState().setSession({ accessToken: "tok", refreshToken: "ref" });

  type InterceptorFn = (
    response: Response,
    request: Request,
    options: { serializedBody?: unknown; signal?: AbortSignal },
  ) => Promise<Response> | Response;

  const interceptors: InterceptorFn[] = [];
  const mockClient = {
    interceptors: { response: { use: (fn: InterceptorFn) => interceptors.push(fn) } },
  };

  auth.applyTo(mockClient);

  const req = new Request("http://localhost:8080/api/v1/auth/sign-out", { method: "POST" });
  const res = new Response("Unauthorized", { status: 401 });

  const result = await interceptors[0]!(res, req, {});
  expect(result.status).toBe(401);
});

test("applyTo respects custom authEndpointPaths", async () => {
  const customAuth = createAuthClient({
    baseUrl: "http://localhost:8080/api/v1",
    appId: "custom",
    authEndpointPaths: ["/identity/token/refresh"],
  });
  customAuth.store.getState().setSession({ accessToken: "tok", refreshToken: "ref" });

  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  type InterceptorFn = (
    response: Response,
    request: Request,
    options: { serializedBody?: unknown; signal?: AbortSignal },
  ) => Promise<Response> | Response;

  const interceptors: InterceptorFn[] = [];
  const mockClient = {
    interceptors: { response: { use: (fn: InterceptorFn) => interceptors.push(fn) } },
  };

  customAuth.applyTo(mockClient);

  const req = new Request("http://localhost:8080/api/v1/identity/token/refresh?tenant=demo", {
    method: "POST",
  });
  const res = new Response("Unauthorized", { status: 401 });

  const result = await interceptors[0]!(res, req, {});
  expect(result.status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("applyTo retries with JSON body for object serializedBody", async () => {
  const newJwt = makeJwt(nowSec() + 3600);

  auth.store.getState().setSession({ accessToken: "old", refreshToken: "ref" });

  const mockFetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ accessToken: newJwt, refreshToken: "new-ref", tokenType: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(new Response("OK", { status: 200 }));
  vi.stubGlobal("fetch", mockFetch);

  type InterceptorFn = (
    response: Response,
    request: Request,
    options: { serializedBody?: unknown; signal?: AbortSignal },
  ) => Promise<Response> | Response;

  const interceptors: InterceptorFn[] = [];
  const mockClient = {
    interceptors: {
      response: {
        use: (fn: InterceptorFn) => interceptors.push(fn),
      },
    },
  };

  auth.applyTo(mockClient);

  const originalRequest = new Request("http://localhost:8080/api/v1/todos", {
    method: "POST",
    headers: { Authorization: "Bearer old" },
  });
  const originalResponse = new Response("Unauthorized", { status: 401 });
  const payload = { title: "retry-body" };

  const result = await interceptors[0]!(originalResponse, originalRequest, {
    serializedBody: payload,
  });
  expect(result.status).toBe(200);

  const retryInit = mockFetch.mock.calls[1]?.[1] as RequestInit;
  expect(retryInit.body).toBe(JSON.stringify(payload));

  const retryHeaders = new Headers(retryInit.headers as HeadersInit);
  expect(retryHeaders.get("Content-Type")).toBe("application/json");
});

test("applyTo is idempotent for the same client", () => {
  type InterceptorFn = (
    response: Response,
    request: Request,
    options: { serializedBody?: unknown; signal?: AbortSignal },
  ) => Promise<Response> | Response;

  const interceptors: InterceptorFn[] = [];
  const mockClient = {
    interceptors: { response: { use: (fn: InterceptorFn) => interceptors.push(fn) } },
  };

  auth.applyTo(mockClient);
  auth.applyTo(mockClient);
  auth.applyTo(mockClient);

  expect(interceptors).toHaveLength(1);
});
