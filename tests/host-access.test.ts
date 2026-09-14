import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getHostProvider: vi.fn(),
    getAccountsProvider: vi.fn(),
    getPreimageManager: vi.fn(),
    createClient: vi.fn(),
    fromClient: vi.fn(),
    fromLiveClient: vi.fn(),
}));
vi.mock("@parity/product-sdk-host", () => ({
    getHostProvider: mocks.getHostProvider,
    getPreimageManager: mocks.getPreimageManager,
    getAccountsProvider: mocks.getAccountsProvider,
    requestPermission: vi.fn().mockResolvedValue({ ok: true, value: true }),
}));
vi.mock("@parity/product-sdk-contracts", () => ({
    ContractManager: { fromClient: mocks.fromClient, fromLiveClient: mocks.fromLiveClient },
    QUERY_FALLBACK_ORIGIN: "0x0000000000000000000000000000000000000000",
    ensureContractAccountMapped: vi.fn(),
}));
vi.mock("polkadot-api", async (original) => ({
    ...await original<typeof import("polkadot-api")>(),
    createClient: mocks.createClient,
}));

let utils: typeof import("../src/utils");
const bytes = new TextEncoder().encode('{"title":"A survey"}');
let cid: string;
let onBytes: (value: Uint8Array | null) => void;
let interrupt: () => void;
const unsubscribe = vi.fn();
const removeInterrupt = vi.fn();
let lookup: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Direct network access is forbidden"); }));
    utils = await import("../src/utils");
    cid = utils.calculateCID(bytes);
    lookup = vi.fn((_key, callback) => {
        onBytes = callback;
        return {
            unsubscribe,
            onInterrupt: (callback: () => void) => { interrupt = callback; return removeInterrupt; },
        };
    });
    mocks.getPreimageManager.mockResolvedValue({ lookup });
    mocks.getHostProvider.mockResolvedValue(null);
});

afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

async function startRead(timeout?: number) {
    const pending = utils.fetchFromBulletin(cid, timeout);
    await Promise.resolve();
    return { pending };
}

describe("host Bulletin reads", () => {
    it("waits for content, checks its CID and releases the subscription", async () => {
        const { pending } = await startRead();
        onBytes(null);
        expect(unsubscribe).not.toHaveBeenCalled();
        onBytes(bytes);
        await expect(pending).resolves.toEqual(bytes);
        expect(lookup.mock.calls[0][0]).toMatch(/^0x[0-9a-f]{64}$/);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(removeInterrupt).toHaveBeenCalledTimes(1);
    });

    it("releases a subscription that supplies cached bytes synchronously", async () => {
        lookup.mockImplementation((_key, callback) => {
            callback(bytes);
            return { unsubscribe, onInterrupt: () => removeInterrupt };
        });
        await expect(utils.fetchFromBulletin(cid)).resolves.toEqual(bytes);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(removeInterrupt).toHaveBeenCalledTimes(1);
    });

    it("rejects absent hosts without opening another network path", async () => {
        mocks.getPreimageManager.mockResolvedValue(null);
        await expect(utils.fetchFromBulletin(cid)).rejects.toThrow("Polkadot host");
        expect(lookup).not.toHaveBeenCalled();
    });

    it("rejects malformed CIDs before starting host work", async () => {
        await expect(utils.fetchFromBulletin("not-a-cid")).rejects.toThrow();
        expect(mocks.getPreimageManager).not.toHaveBeenCalled();
    });

    it("rejects content with a different digest", async () => {
        const { pending } = await startRead();
        onBytes(new Uint8Array([1, 2, 3]));
        await expect(pending).rejects.toThrow("does not match");
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("cleans up and rejects host interruption", async () => {
        const { pending } = await startRead();
        interrupt();
        await expect(pending).rejects.toThrow("interrupted");
        onBytes(bytes);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("cleans up a lookup that never returns content", async () => {
        vi.useFakeTimers();
        const { pending } = await startRead(50);
        const rejection = expect(pending).rejects.toThrow("timed out");
        await vi.advanceTimersByTimeAsync(50);
        await rejection;
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("clears its timeout when subscription setup fails", async () => {
        vi.useFakeTimers();
        lookup.mockImplementation(() => { throw new Error("lookup failed"); });
        await expect(utils.fetchFromBulletin(cid)).rejects.toThrow("lookup failed");
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("host contract initialization", () => {
    it("rejects an unavailable host and retries after it becomes available", async () => {
        utils.stageCdmJson({ registry: utils.NETWORK.registry });
        const contract = utils.getContract();
        await expect(contract.getSurvey.query()).rejects.toThrow("Asset Hub is unavailable");
        expect(mocks.createClient).not.toHaveBeenCalled();
        const query = vi.fn().mockResolvedValue({ success: true, value: 7 });
        mocks.getHostProvider.mockResolvedValue(() => {});
        mocks.createClient.mockReturnValue({
            getChainSpecData: vi.fn().mockResolvedValue({}),
            getBestBlocks: vi.fn().mockResolvedValue([]),
            destroy: vi.fn(),
        });
        mocks.fromClient.mockReturnValue({ getContract: () => ({ getSurvey: { query } }) });
        await expect(contract.getSurvey.query()).resolves.toEqual({ success: true, value: 7 });
        expect(mocks.getHostProvider).toHaveBeenCalledTimes(2);
    });

    it("propagates provider failures without creating a raw client", async () => {
        mocks.getHostProvider.mockRejectedValue(new Error("Chain permission denied"));
        utils.stageCdmJson({ registry: utils.NETWORK.registry });
        await expect(utils.getContract().getSurvey.query()).rejects.toThrow("Chain permission denied");
        expect(mocks.createClient).not.toHaveBeenCalled();
    });
});

describe("transaction follow recovery", () => {
    it.each([true, false])("retries only no-active-follow errors (recoverable=%s)", async (recoverable) => {
        mocks.getHostProvider.mockResolvedValue(() => {});
        const getBestBlocks = vi.fn().mockResolvedValue([]);
        mocks.createClient.mockReturnValue({ getChainSpecData: vi.fn().mockResolvedValue({}), getBestBlocks, destroy: vi.fn() });
        const error = new Error(recoverable ? "No active follow for this chain" : "Transaction rejected");
        const tx = vi.fn().mockResolvedValueOnce({ ok: false, error }).mockResolvedValue({ ok: true, value: "receipt" });
        mocks.fromClient.mockReturnValue({ getContract: () => ({ respond: { tx } }) });
        utils.stageCdmJson({ registry: utils.NETWORK.registry });
        const pending = utils.getContract().respond.tx();
        if (recoverable) {
            await expect(pending).resolves.toBe("receipt");
            expect(tx).toHaveBeenCalledTimes(2);
            expect(getBestBlocks).toHaveBeenCalledTimes(3);
        } else {
            await expect(pending).rejects.toThrow("Transaction rejected");
            expect(tx).toHaveBeenCalledTimes(1);
        }
    });
});

it("resolves a contract against the selected network registry when the snapshot differs", async () => {
    mocks.getHostProvider.mockResolvedValue(() => {});
    mocks.createClient.mockReturnValue({ getChainSpecData: vi.fn().mockResolvedValue({}), getBestBlocks: vi.fn().mockResolvedValue([]), destroy: vi.fn() });
    const query = vi.fn().mockResolvedValue({ success: true, value: 9 });
    mocks.fromLiveClient.mockResolvedValue({ ok: true, value: { getContract: () => ({ getSurvey: { query } }) } });
    utils.stageCdmJson({ registry: "0x1111111111111111111111111111111111111111" });
    await expect(utils.getContract().getSurvey.query()).resolves.toEqual({ success: true, value: 9 });
    expect(mocks.fromLiveClient).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ registryAddress: utils.NETWORK.registry, registryOrigin: "0x0000000000000000000000000000000000000000" }));
    expect(mocks.fromClient).not.toHaveBeenCalled();
    const descriptor = await utils.NETWORK.loadDescriptor();
    expect(mocks.getHostProvider).toHaveBeenCalledWith(descriptor.genesis);
});

it("applies an account that signs in during live registry resolution", async () => {
    mocks.getHostProvider.mockResolvedValue(() => {});
    mocks.createClient.mockReturnValue({ getChainSpecData: vi.fn().mockResolvedValue({}), getBestBlocks: vi.fn().mockResolvedValue([]), destroy: vi.fn() });
    let finishLookup!: (value: unknown) => void;
    mocks.fromLiveClient.mockReturnValue(new Promise(resolve => { finishLookup = resolve; }));
    const signer = { publicKey: new Uint8Array(32).fill(1) };
    mocks.getAccountsProvider.mockResolvedValue({
        getProductAccount: vi.fn().mockResolvedValue({ isErr: () => false, value: { publicKey: signer.publicKey } }),
        getProductAccountSigner: () => signer,
        getUserId: vi.fn().mockResolvedValue({ isOk: () => false }),
    });
    utils.stageCdmJson({ registry: "a different network" });
    const pending = utils.getContract().getSurvey.query();
    await vi.waitFor(() => expect(mocks.fromLiveClient).toHaveBeenCalled());
    await utils.connectAccount();
    const setDefaults = vi.fn();
    finishLookup({ ok: true, value: { setDefaults, getContract: () => ({ getSurvey: { query: vi.fn().mockResolvedValue({ success: true }) } }) } });
    await pending;
    expect(setDefaults).toHaveBeenCalledWith({ origin: expect.any(String), signer });
});
