import { isTauri } from "@tauri-apps/api/core";
import { bearerHeaders } from "./auth";

type FieldKind = "text" | "email" | "password";
export type SignInFormFields = Record<string, FieldKind>;

export interface SignInMethod {
  id: string;
  name: string;
  form: SignInFormFields;
  setupOwnerForm?: SignInFormFields;
  createAccountForm?: SignInFormFields;
}

export interface SignInOptions {
  methods: SignInMethod[];
  ownerSetup: boolean;
}

type SignInFailure = { failed: true; kind: string };
export type SignInResult = { key: string } | SignInFailure;

async function call(
  origin: string,
  path: string,
  signal: AbortSignal,
  body?: object,
  key?: string,
): Promise<Response> {
  const url = new URL(path, origin);
  return fetch(url, {
    method: body ? "POST" : "GET",
    headers: { ...bearerHeaders(key ?? null), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
}

export async function discoverSignIn(
  origin: string,
  signal: AbortSignal,
): Promise<SignInOptions | undefined> {
  const response = await call(origin, "/auth/methods", signal).catch(() => undefined);
  if (!response?.ok) return undefined;
  const value = await response.json().catch(() => undefined);
  return Array.isArray(value?.methods) && typeof value.ownerSetup === "boolean" ? value : undefined;
}

const deviceName = () => (isTauri() ? "Tokamak desktop" : "This browser");

export async function exchangeOwnerKey(origin: string, key: string, signal: AbortSignal, setup = false) {
  const response = await call(origin, "/auth/owner", signal, { deviceName: deviceName(), setup }, key);
  if (response.status === 401 || response.status === 403) return { failed: true } as const;
  if (!response.ok) throw new Error("Owner key verification is unavailable");
  const value = await response.json();
  if (typeof value?.key !== "string" || !Array.isArray(value.setupMethods))
    throw new Error("Invalid owner key exchange response");
  return value as { key: string; setupMethods: SignInMethod[] };
}

function signInFailure(value: unknown): SignInFailure {
  const failure = value as Partial<SignInFailure> | null;
  if (failure?.failed === true && typeof failure.kind === "string")
    return { failed: true, kind: failure.kind };
  throw new Error("Sign-in is unavailable");
}

async function signInResult(response: Response): Promise<SignInResult> {
  const value = await response.json();
  if (response.ok && typeof value?.key === "string") return { key: value.key };
  return signInFailure(value);
}

export async function submitSignIn(
  origin: string,
  method: string,
  fields: Record<string, string>,
  signal: AbortSignal,
  newPassword?: string,
) {
  return signInResult(
    await call(origin, "/auth/sign-in", signal, { method, fields, deviceName: deviceName(), newPassword }),
  );
}

export async function createOwnerAccount(
  origin: string,
  deviceKey: string,
  method: string,
  fields: Record<string, string>,
  signal: AbortSignal,
) {
  const response = await call(origin, "/auth/owner/setup", signal, { method, fields }, deviceKey);
  if (response.status === 204) return;
  return signInFailure(await response.json());
}
