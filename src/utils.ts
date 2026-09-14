import { useState, useEffect } from "react";
import {
    getAccountsProvider,
    getHostProvider,
    getPreimageManager,
    requestPermission,
    type AccountsProvider,
    type ProductAccount,
    type HostSubscription,
} from "@parity/product-sdk-host";
import { ContractManager, ensureContractAccountMapped } from "@parity/product-sdk-contracts";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { createClient, AccountId, type PolkadotSigner } from "polkadot-api";
import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import type { MultihashDigest } from "multiformats/hashes/interface";

const CONTRACT_KEY = "@example/surveys";

// Paseo Next v2. The genesis comes from the descriptor so it tracks chain
// resets with the descriptors package instead of going stale (the old
// hardcoded constant predated the 2026-06-02 reset).
const PASEO_ASSET_HUB_GENESIS = paseo_asset_hub.genesis as `0x${string}`;

/**
 * Unwrap a product-sdk `Result` to its value, re-throwing the `err` channel as
 * an `Error`. Since product-sdk 0.18 fallible calls return `Result` instead of
 * throwing; this bridges them back onto throw / try-catch control flow. Mirrors
 * the CLI's `unwrapResult` (playground-cli #470).
 */
export function unwrapResult<T>(
    result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
    if (!result.ok) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }
    return result.value;
}

// ---------------------------------------------------------------------------
// Permissions (RFC-0002)
// ---------------------------------------------------------------------------

const _grantedPermissions = new Set<string>();

async function ensurePermission(tag: "ChainSubmit" | "PreimageSubmit" | "StatementSubmit") {
    if (_grantedPermissions.has(tag)) return;
    try {
        const result = await requestPermission({ tag, value: undefined });
        if (result.ok && result.value) {
            _grantedPermissions.add(tag);
            console.log(`[Permission] ${tag} granted`);
        } else {
            console.warn(`[Permission] ${tag} denied`, result.ok ? "user rejected" : result.error);
        }
    } catch (err) {
        console.warn(`[Permission] ${tag} request failed:`, err);
    }
}

// ---------------------------------------------------------------------------
// Account flow — direct against product-sdk (matches t3rminal / RPS pattern).
// ---------------------------------------------------------------------------

// Lazy: the provider handshakes with the host on first use and is null when
// the app runs outside a host container.
let _accountsProvider: AccountsProvider | null | undefined;
async function getProvider(): Promise<AccountsProvider | null> {
    if (_accountsProvider === undefined) _accountsProvider = await getAccountsProvider();
    return _accountsProvider;
}

const accountIdCodec = AccountId();

/**
 * Identifier the host uses to scope our product. Polkadot Desktop ≥ 0.7.5
 * accepts the raw `window.location.host` for both `.dot` domains and
 * `localhost:PORT`; the signing permission check matches the identifier
 * against that same host context, so we use it verbatim.
 */
function getProductIdentifier(): string | null {
    if (typeof window === "undefined") return null;
    return window.location.host || null;
}

export function getAppAccountId(): [string, number] {
    const identifier = getProductIdentifier() ?? "simple-survey.dot";
    return [identifier, 0];
}

export interface AppAccount {
    /** SS58 string derived from the host's product public key. */
    address: string;
    /** EVM-style H160 (keccak256(publicKey).slice(12)) — what Revive + bytes20/address args expect. */
    h160Address: string;
    /** 32-byte sr25519 public key. */
    publicKey: Uint8Array;
    name: string | null;
    signer: PolkadotSigner;
    productAccountId: [string, number];
    productAccount: ProductAccount;
    getSigner(): PolkadotSigner;
}

interface AccountState {
    status: "idle" | "connecting" | "ready" | "signed-out" | "error";
    account: AppAccount | null;
    error?: string;
}

let _state: AccountState = { status: "idle", account: null };
const _listeners = new Set<(s: AccountState) => void>();

function setState(next: AccountState) {
    _state = next;
    for (const cb of _listeners) cb(next);
}

export function useAccountState(): AccountState {
    const [state, set] = useState<AccountState>(_state);
    useEffect(() => {
        const cb = (s: AccountState) => set(s);
        _listeners.add(cb);
        return () => { _listeners.delete(cb); };
    }, []);
    return state;
}

export async function connectAccount(): Promise<void> {
    if (_state.status === "connecting") return;
    setState({ status: "connecting", account: null });

    try {
        const [identifier, derivationIndex] = getAppAccountId();
        console.log(`[Account] Requesting product account ${identifier}#${derivationIndex}`);

        const provider = await getProvider();
        if (!provider) {
            setState({
                status: "error",
                account: null,
                error: "Host unavailable — open this app inside a Polkadot host.",
            });
            return;
        }

        const result = await provider.getProductAccount(identifier, derivationIndex);
        if (result.isErr()) {
            // Errors arrive as truapi's CallErrorValue envelope: domain errors
            // (e.g. NotConnected = not signed in) are wrapped as
            // { tag: "Domain", value: { tag: "V1", value: <domain error> } }.
            const error = result.error;
            const domain = error.tag === "Domain" ? (error.value as any)?.value : null;
            if (domain?.tag === "NotConnected") {
                setState({ status: "signed-out", account: null });
                return;
            }
            const errMsg = `${domain?.tag ?? error.tag}: ${domain?.value?.reason ?? (error as any)?.value?.reason ?? "request failed"}`;
            console.warn("[Account] getProductAccount error:", errMsg);
            setState({ status: "error", account: null, error: errMsg });
            return;
        }

        // The provider returns the full product account (id + publicKey bytes).
        const productAccount: ProductAccount = result.value;
        const { publicKey } = productAccount;
        // The signer routes through the host's `createTransaction` path, the only
        // path that signs Paseo Next v2's pallet-revive signed extensions
        // (AsPgas, AsRingAlias, …).
        const signer = provider.getProductAccountSigner(productAccount);
        const ss58 = accountIdCodec.dec(publicKey);
        const h160Address = ss58ToH160(ss58 as never) as `0x${string}`;

        let displayName: string | null = null;
        try {
            const userIdResult = await provider.getUserId();
            if (userIdResult.isOk()) {
                displayName = userIdResult.value.primaryUsername ?? null;
            }
        } catch { /* optional */ }

        const account: AppAccount = {
            address: ss58,
            h160Address,
            publicKey,
            name: displayName,
            signer,
            productAccountId: [identifier, derivationIndex],
            productAccount,
            getSigner: () => signer,
        };

        // Wire signer + origin defaults so queries don't fall back to the dev
        // origin and tx calls don't need an explicit `{ signer }`.
        if (_contractManager) {
            _contractManager.setDefaults({ origin: ss58, signer });
        }

        console.log(`[Account] Ready — ${ss58} (h160 ${h160Address}) (${displayName ?? identifier})`);
        setState({ status: "ready", account });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Account] Connect failed:", msg);
        setState({ status: "error", account: null, error: msg });
    }
}

/** Open the host's sign-in UI and refresh the account on success. */
export async function signIn(): Promise<void> {
    const provider = await getProvider();
    if (provider) await provider.requestLogin("Sign in to use Surveys");
    await connectAccount();
}

// ---------------------------------------------------------------------------
// Bulletin upload — host preimage path (works in dev mode)
// ---------------------------------------------------------------------------

const BLAKE2B_256_CODE = 0xb220;

function encodeVarint(value: number): Uint8Array {
    const bytes: number[] = [];
    let num = value;
    while (num >= 0x80) {
        bytes.push((num & 0x7f) | 0x80);
        num >>= 7;
    }
    bytes.push(num & 0x7f);
    return new Uint8Array(bytes);
}

export function calculateCID(bytes: Uint8Array): string {
    const hash = blake2b(bytes, { dkLen: 32 });
    const codeBytes = encodeVarint(BLAKE2B_256_CODE);
    const lengthBytes = encodeVarint(hash.length);
    const multihash = new Uint8Array(codeBytes.length + lengthBytes.length + hash.length);
    multihash.set(codeBytes, 0);
    multihash.set(lengthBytes, codeBytes.length);
    multihash.set(hash, codeBytes.length + lengthBytes.length);
    const digest: MultihashDigest = {
        code: BLAKE2B_256_CODE,
        size: hash.length,
        bytes: multihash,
        digest: hash,
    };
    return CID.createV1(raw.code, digest).toString();
}

export async function uploadToBulletin(bytes: Uint8Array): Promise<string> {
    await ensurePermission("PreimageSubmit");
    const cid = calculateCID(bytes);
    console.log("[Bulletin] Submitting preimage via host, size:", bytes.length, "expected CID:", cid);
    const preimageManager = await getPreimageManager();
    if (!preimageManager) {
        throw new Error("Preimage manager unavailable — open this app inside a Polkadot host.");
    }
    await preimageManager.submit(bytes);
    console.log("[Bulletin] Preimage stored.");
    return cid;
}

// ---------------------------------------------------------------------------
// Contract — @parity/product-sdk-contracts ContractManager.
// Lazy init: the Asset Hub chain client (with its chain-head follow) only spins
// up on the first contract call, so Bulletin preimage submits at startup don't
// compete with a chain follow.
// ---------------------------------------------------------------------------

let _contractManager: ContractManager | null = null;
let _contract: any = null;
let _polkadotClient: ReturnType<typeof createClient> | null = null;
let _cdmJson: any = null;
let _contractInitPromise: Promise<void> | null = null;

/** Stage cdm.json without opening the Asset Hub chain client yet. */
export function stageCdmJson(cdmJson: any): void {
    _cdmJson = cdmJson;
}

export async function initContracts(cdmJson: any): Promise<void> {
    stageCdmJson(cdmJson);
}

/**
 * Wake the Asset Hub chain follow before a contract call. The host container
 * tears down the follow when the tab is backgrounded; the first request after
 * wake bails with "No active follow for this chain" until we touch the client.
 */
export async function wakeChainFollow(): Promise<void> {
    if (!_polkadotClient) return;
    try {
        await _polkadotClient.getBestBlocks();
    } catch (err) {
        console.warn("[CDM] wakeChainFollow failed:", err);
    }
}

const NO_FOLLOW_RE = /no active follow/i;

function withFollowRetry<T extends Record<string, any>>(method: T): T {
    const wrap = <Fn extends (...a: any[]) => Promise<any>>(fn: Fn, isTransaction: boolean): Fn =>
        (async (...args: any[]) => {
            await wakeChainFollow();
            try {
                const result = await fn(...args);
                // SDK transaction failures are values; inspect them inside the
                // retry boundary before getContract unwraps the final result.
                if (isTransaction && result && result.ok === false) throw result.error;
                return result;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!NO_FOLLOW_RE.test(msg)) throw err;
                console.warn("[CDM] follow lost mid-call, retrying once:", msg);
                await wakeChainFollow();
                return await fn(...args);
            }
        }) as Fn;

    return new Proxy(method, {
        get(target, prop) {
            const v = target[prop as keyof T];
            if (typeof v === "function") return wrap(v.bind(target), prop === "tx");
            return v;
        },
    });
}

function wrapContract(contract: any): any {
    return new Proxy(contract, {
        get(target, prop) {
            const m = target[prop];
            if (m && typeof m === "object" && ("query" in m || "tx" in m)) {
                return withFollowRetry(m);
            }
            return m;
        },
    });
}

async function ensureContractsReady(): Promise<void> {
    if (_contractManager || !_cdmJson) return;
    if (_contractInitPromise) return _contractInitPromise;
    _contractInitPromise = (async () => {
        await ensurePermission("ChainSubmit");

        const provider = await getHostProvider(PASEO_ASSET_HUB_GENESIS);
        if (!provider) {
            throw new Error("Asset Hub is unavailable — open this app inside a Polkadot host that supports the selected chain.");
        }
        _polkadotClient = createClient(provider);

        console.log("[CDM] Waking Asset Hub chain follow...");
        await _polkadotClient.getChainSpecData();
        await _polkadotClient.getBestBlocks();
        console.log("[CDM] Chain follow active.");

        _contractManager = ContractManager.fromClient(
            _cdmJson,
            _polkadotClient,
            paseo_asset_hub,
            _state.account
                ? { defaultOrigin: _state.account.address as never, defaultSigner: _state.account.signer }
                : undefined,
        );
        _contract = wrapContract(_contractManager.getContract(CONTRACT_KEY));
        console.log("[CDM] Contract manager ready");
    })();
    try {
        await _contractInitPromise;
    } catch (error) {
        _polkadotClient?.destroy();
        _polkadotClient = null;
        _contractManager = null;
        _contract = null;
        throw error;
    } finally {
        _contractInitPromise = null;
    }
}

/**
 * Lazy contract handle. The chain client doesn't spin up until a method is
 * actually called. `getContract().method.query(...)` returns `{ success, value }`;
 * `.tx(...)` submits with the account defaults set on connect.
 *
 * Since product-sdk 0.18, `.tx(...)` returns a `Result` instead of throwing.
 * Unwrap it here (re-throw the `err` channel) so the existing try/catch flow
 * at every call site keeps working. `.query(...)` is unchanged upstream.
 */
export function getContract(): any {
    if (!_cdmJson) return null;
    return new Proxy({}, {
        get(_target, prop) {
            return new Proxy({} as any, {
                get(_t, methodProp) {
                    if (methodProp !== "query" && methodProp !== "tx") return undefined;
                    return async (...args: any[]) => {
                        await ensureContractsReady();
                        if (!_contract) throw new Error("Contract init failed");
                        const real = _contract[prop as string];
                        if (!real) throw new Error(`Unknown method: ${String(prop)}`);
                        const outcome = await real[methodProp](...args);
                        return methodProp === "tx" ? unwrapResult(outcome) : outcome;
                    };
                },
            });
        },
    });
}

// ---------------------------------------------------------------------------
// Account mapping (Revive). pallet-revive on Paseo Next v2 requires every SS58
// origin that calls a contract to have an explicit Revive.map_account() entry.
// Idempotent — first call costs one signature, subsequent calls short-circuit.
// ---------------------------------------------------------------------------

const _mappedAccounts = new Set<string>();

export async function ensureMapping(account: AppAccount): Promise<void> {
    if (_mappedAccounts.has(account.address)) return;
    await ensureContractsReady();
    if (!_contractManager) throw new Error("Contract manager not ready");
    try {
        // Since product-sdk 0.18, ensureContractAccountMapped returns a Result
        // (ok(null) = already mapped) instead of throwing. Unwrap it so the
        // catch handles both a returned `err` and any thrown failure with the
        // same cause-chain logging.
        const mapped = unwrapResult(
            await ensureContractAccountMapped(
                _contractManager.getRuntime(),
                account.address as never,
                account.signer,
            ),
        );
        if (mapped === null) {
            console.log(`[Revive] Account ${account.address} already mapped`);
        } else {
            console.log(`[Revive] Account mapped in block #${mapped.block.number}`);
        }
        _mappedAccounts.add(account.address);
    } catch (err) {
        console.error("[Revive] ensureContractAccountMapped failed:", err);
        const cause = err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
        if (cause) console.error("[Revive] underlying cause:", cause);
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Bulletin reads through the host preimage subscription
// ---------------------------------------------------------------------------

export async function fetchFromBulletin(cid: string, timeoutMs = 30000): Promise<Uint8Array> {
    const parsed = CID.parse(cid);
    // Survey uploads use raw blocks with a BLAKE2b-256 digest (calculateCID).
    if (parsed.code !== raw.code || parsed.multihash.code !== BLAKE2B_256_CODE || parsed.multihash.size !== 32) {
        throw new Error("Unsupported survey CID: expected a raw BLAKE2b-256 block.");
    }
    const key = `0x${Array.from(parsed.multihash.digest, byte => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
    const manager = await getPreimageManager();
    if (!manager) throw new Error("Bulletin storage is unavailable — open this app inside a Polkadot host.");

    return new Promise((resolve, reject) => {
        let done = false;
        let subscription: HostSubscription | undefined;
        let removeInterrupt: (() => void) | undefined;
        const cleanup = () => {
            clearTimeout(timer);
            removeInterrupt?.();
            subscription?.unsubscribe();
        };
        const fail = (error: unknown) => {
            if (done) return;
            done = true;
            cleanup();
            reject(error);
        };
        const timer = setTimeout(() => fail(new Error("Bulletin read timed out")), timeoutMs);
        try {
            subscription = manager.lookup(key, (bytes) => {
                if (done || bytes === null) return;
                if (calculateCID(bytes) !== parsed.toString()) {
                    fail(new Error("Bulletin content does not match the requested CID"));
                    return;
                }
                done = true;
                cleanup();
                resolve(bytes);
            });
            removeInterrupt = subscription.onInterrupt(() => fail(new Error("Bulletin host connection interrupted")));
            // A host may return its cached preimage synchronously during setup.
            if (done) cleanup();
        } catch (error) {
            fail(error);
        }
    });
}

export async function fetchJsonFromBulletin<T = unknown>(cid: string): Promise<T> {
    const bytes = await fetchFromBulletin(cid);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const short = (addr: string) => (addr ? addr.slice(0, 6) + "..." + addr.slice(-4) : "");

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
        ),
    ]);
}
