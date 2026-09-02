/**
 * Pure state-machine tests for the issue #443 stale-weekly-reset recovery
 * module. All dependencies (clock, config flag, dbOps, logger) are
 * injected, so these run with no real DB and no real clock.
 */
import { describe, expect, it, mock } from "bun:test";
import type { UsageData } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { createStaleWeeklyResetRecovery } from "../stale-weekly-reset-recovery";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account-one",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

const FRESH_WINDOW: UsageData = {
	seven_day: { utilization: 0, resets_at: null },
};
const NORMAL_WINDOW: UsageData = {
	seven_day: { utilization: 42, resets_at: "2030-01-08T00:00:00Z" },
};

function makeDeps(
	overrides: {
		now?: number;
		isEnabled?: boolean;
		account?: Account | null;
		applyWrite?: boolean;
	} = {},
) {
	let currentNow = overrides.now ?? 1_700_000_000_000;
	const account = overrides.account ?? makeAccount();
	const getAccount = mock(async (_accountId: string) => account);
	const markStaleRateLimitResetPassed = mock(
		async () => overrides.applyWrite ?? true,
	);
	const warn = mock(() => {});
	const info = mock(() => {});

	return {
		deps: {
			now: () => currentNow,
			isEnabled: () => overrides.isEnabled ?? true,
			dbOps: { getAccount, markStaleRateLimitResetPassed },
			log: { warn, info },
		},
		getAccount,
		markStaleRateLimitResetPassed,
		warn,
		info,
		setNow: (t: number) => {
			currentNow = t;
		},
		getNow: () => currentNow,
	};
}

describe("createStaleWeeklyResetRecovery — confirmation streak", () => {
	it("does not fire on the first matching poll", async () => {
		const { deps, markStaleRateLimitResetPassed } = makeDeps();
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).not.toHaveBeenCalled();
	});

	it("fires on the second consecutive matching poll", async () => {
		const staleReset = 1_700_000_000_000 + 5 * DAY;
		const { deps, markStaleRateLimitResetPassed } = makeDeps({
			account: makeAccount({ rate_limit_reset: staleReset }),
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).toHaveBeenCalledTimes(1);
	});

	it("does not fire when a non-matching poll interrupts the streak (true, false, true)", async () => {
		const staleReset = 1_700_000_000_000 + 5 * DAY;
		const { deps, markStaleRateLimitResetPassed } = makeDeps({
			account: makeAccount({ rate_limit_reset: staleReset }),
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", NORMAL_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).not.toHaveBeenCalled();
	});

	it("streak state is per account", async () => {
		const staleReset = 1_700_000_000_000 + 5 * DAY;
		const accountTwo = makeAccount({
			id: "acc-2",
			rate_limit_reset: staleReset,
		});
		const { deps, getAccount, markStaleRateLimitResetPassed } = makeDeps({
			account: makeAccount({ rate_limit_reset: staleReset }),
		});
		// Route acc-2 lookups to accountTwo, acc-1 to the default account.
		getAccount.mockImplementation(async (id: string) =>
			id === "acc-2"
				? accountTwo
				: makeAccount({ rate_limit_reset: staleReset }),
		);
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-2", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).not.toHaveBeenCalled();
	});
});

describe("createStaleWeeklyResetRecovery — gates", () => {
	it("skips accounts whose provider is not anthropic, without touching streak/warn state", async () => {
		const { deps, markStaleRateLimitResetPassed, warn } = makeDeps({
			account: makeAccount({ provider: "xai" }),
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns once and does not write when the flag is disabled", async () => {
		const staleReset = 1_700_000_000_000 + 5 * DAY;
		const { deps, markStaleRateLimitResetPassed, warn } = makeDeps({
			isEnabled: false,
			account: makeAccount({ rate_limit_reset: staleReset }),
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW); // still confirmed, same episode

		expect(markStaleRateLimitResetPassed).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("warns once and does not write when auto-refresh is disabled on the account", async () => {
		const staleReset = 1_700_000_000_000 + 5 * DAY;
		const { deps, markStaleRateLimitResetPassed, warn } = makeDeps({
			account: makeAccount({
				rate_limit_reset: staleReset,
				auto_refresh_enabled: false,
			}),
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("does not write while rate_limited_until is still in the future (real cooldown)", async () => {
		const now = 1_700_000_000_000;
		const staleReset = now + 5 * DAY;
		const { deps, markStaleRateLimitResetPassed } = makeDeps({
			now,
			account: makeAccount({
				rate_limit_reset: staleReset,
				rate_limited_until: now + HOUR,
			}),
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).not.toHaveBeenCalled();
	});

	it("does not write when rate_limit_reset is not more than 24h out (a real short-window value)", async () => {
		const now = 1_700_000_000_000;
		const nearReset = now + 3 * HOUR; // a real 5h/session-scale reset
		const { deps, markStaleRateLimitResetPassed } = makeDeps({
			now,
			account: makeAccount({ rate_limit_reset: nearReset }),
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).not.toHaveBeenCalled();
	});

	it("does not write when rate_limit_reset is null (nothing to correct)", async () => {
		const { deps, markStaleRateLimitResetPassed } = makeDeps({
			account: makeAccount({ rate_limit_reset: null }),
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).not.toHaveBeenCalled();
	});

	it("writes exactly once with (accountId, observedReset, now) when every gate passes", async () => {
		const now = 1_700_000_000_000;
		const staleReset = now + 5 * DAY;
		const { deps, markStaleRateLimitResetPassed, info } = makeDeps({
			now,
			account: makeAccount({ rate_limit_reset: staleReset }),
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).toHaveBeenCalledTimes(1);
		expect(markStaleRateLimitResetPassed).toHaveBeenCalledWith(
			"acc-1",
			staleReset,
			now,
		);
		expect(info).toHaveBeenCalledTimes(1);
	});

	it("does not warn on the next matching poll after a successful write in the same episode", async () => {
		// Mirrors what a successful CAS write actually does in production: the
		// account row's rate_limit_reset becomes `now` (past), so the very next
		// poll's horizon gate would reject it — that must not produce a WARN
		// contradicting the INFO line the write just logged. Unlike makeDeps'
		// static account fixture, getAccount here reads a mutable object that
		// markStaleRateLimitResetPassed updates, so the horizon gate actually
		// sees the post-write value on poll 3, reproducing the real sequence.
		const now = 1_700_000_000_000;
		const staleReset = now + 5 * DAY;
		const account = makeAccount({ rate_limit_reset: staleReset });
		const getAccount = mock(async () => account);
		const markStaleRateLimitResetPassed = mock(
			async (_id: string, _observed: number, writeNow: number) => {
				account.rate_limit_reset = writeNow;
				return true;
			},
		);
		const warn = mock(() => {});
		const info = mock(() => {});
		const recover = createStaleWeeklyResetRecovery({
			now: () => now,
			isEnabled: () => true,
			dbOps: { getAccount, markStaleRateLimitResetPassed },
			log: { warn, info },
		});

		await recover("acc-1", FRESH_WINDOW); // streak 1
		await recover("acc-1", FRESH_WINDOW); // streak 2 — writes, applies
		await recover("acc-1", FRESH_WINDOW); // streak 3 — post-write, still matching

		expect(markStaleRateLimitResetPassed).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledTimes(1);
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not log success info when the CAS write is a no-op (concurrent change)", async () => {
		const now = 1_700_000_000_000;
		const staleReset = now + 5 * DAY;
		const { deps, info } = makeDeps({
			now,
			account: makeAccount({ rate_limit_reset: staleReset }),
			applyWrite: false,
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(info).not.toHaveBeenCalled();
	});
});

describe("createStaleWeeklyResetRecovery — per-account throttle (belt-and-braces)", () => {
	it("does not attempt a second write within 6h of the first, even across a fresh confirmed episode", async () => {
		const now = 1_700_000_000_000;
		const staleReset = now + 5 * DAY;
		const account = makeAccount({ rate_limit_reset: staleReset });
		const { deps, markStaleRateLimitResetPassed, setNow } = makeDeps({
			now,
			account,
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		// First episode: confirms and writes.
		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);
		expect(markStaleRateLimitResetPassed).toHaveBeenCalledTimes(1);

		// Streak resets (a normal poll in between), then a second qualifying
		// episode builds up again — still within the 6h throttle window. The
		// account row is assumed to still show a qualifying (>24h) reset,
		// e.g. a different stale value written by another process — the
		// throttle, not the horizon gate, is what must block this.
		setNow(now + 30 * 60 * 1000); // 30 minutes later, well under 6h
		await recover("acc-1", NORMAL_WINDOW); // breaks the streak
		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).toHaveBeenCalledTimes(1);
	});

	it("allows a write again once 6h have passed since the last attempt", async () => {
		const now = 1_700_000_000_000;
		const staleReset = now + 5 * DAY;
		const account = makeAccount({ rate_limit_reset: staleReset });
		const { deps, markStaleRateLimitResetPassed, setNow } = makeDeps({
			now,
			account,
		});
		const recover = createStaleWeeklyResetRecovery(deps);

		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);
		expect(markStaleRateLimitResetPassed).toHaveBeenCalledTimes(1);

		setNow(now + 6 * HOUR + 1);
		await recover("acc-1", NORMAL_WINDOW); // breaks the streak
		await recover("acc-1", FRESH_WINDOW);
		await recover("acc-1", FRESH_WINDOW);

		expect(markStaleRateLimitResetPassed).toHaveBeenCalledTimes(2);
	});
});
