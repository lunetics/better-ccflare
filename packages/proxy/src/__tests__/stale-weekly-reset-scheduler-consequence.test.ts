/**
 * Pins the consequence chain issue #443's recovery relies on: after
 * AccountRepository#markStaleRateLimitResetPassed sets `rate_limit_reset`
 * to a PAST timestamp (`now`) rather than NULL, AutoRefreshScheduler must
 * treat that as "new window, probe it" on its very next tick.
 *
 * This is what makes "now" the right value instead of NULL — see plan
 * point 1 in .review/issue-443-stale-reset/plan-v2.md: once the scheduler
 * has ever refreshed an account (`lastRefreshResetTime` holds an entry for
 * it, the normal steady-state case), `shouldRefreshAccount` returns false
 * for a NULL `rate_limit_reset` but true for one that has already passed.
 * A regression here (e.g. someone "simplifying" the recovery write back to
 * NULL) would silently reintroduce the exact deadlock #443 reports.
 */
import { describe, expect, it } from "bun:test";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

type AccountRow = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
	paused: number;
	pause_reason: string | null;
};

type TestableScheduler = AutoRefreshScheduler & {
	shouldRefreshAccount(account: AccountRow, now: number): boolean;
	lastRefreshResetTime: Map<string, number>;
};

function makeDb() {
	return {
		run: async () => {},
		query: async () => [],
	};
}

function makeAccountRow(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		id: "acc-1",
		name: "account-one",
		provider: "anthropic",
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
		rate_limit_reset: null,
		custom_endpoint: null,
		paused: 0,
		pause_reason: null,
		...overrides,
	};
}

async function makeScheduler(): Promise<TestableScheduler> {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		makeDb() as never,
		{
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
		} as never,
	) as TestableScheduler;
}

describe("AutoRefreshScheduler — consequence of a past (not NULL) rate_limit_reset", () => {
	it("judges the account eligible when rate_limit_reset has already passed and it was previously refreshed", async () => {
		const scheduler = await makeScheduler();
		const now = Date.now();
		// Simulate the steady state the scheduler is normally in: it has
		// refreshed this account before, so lastRefreshResetTime holds an
		// entry — this is the exact condition under which a NULL
		// rate_limit_reset stops being probed (see the next test).
		scheduler.lastRefreshResetTime.set("acc-1", now - 60_000);

		const account = makeAccountRow({ rate_limit_reset: now - 1000 });

		expect(scheduler.shouldRefreshAccount(account, now)).toBe(true);
	});

	it("does NOT judge the account eligible on a NULL rate_limit_reset under the same previously-refreshed condition", async () => {
		const scheduler = await makeScheduler();
		const now = Date.now();
		scheduler.lastRefreshResetTime.set("acc-1", now - 60_000);

		const account = makeAccountRow({ rate_limit_reset: null });

		// This is precisely why the recovery write sets rate_limit_reset to
		// `now` instead of clearing it to NULL: NULL leaves the account
		// exactly as stuck as the stale future value did.
		expect(scheduler.shouldRefreshAccount(account, now)).toBe(false);
	});

	it("still refreshes an account it has never refreshed before, regardless of rate_limit_reset", async () => {
		const scheduler = await makeScheduler();
		const now = Date.now();
		// No lastRefreshResetTime entry — first-time refresh branch.
		const account = makeAccountRow({ rate_limit_reset: now + 999_999 });

		expect(scheduler.shouldRefreshAccount(account, now)).toBe(true);
	});
});
