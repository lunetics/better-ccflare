import { describe, expect, it, mock } from "bun:test";
import type { AnyUsageData, UsageData } from "../usage-fetcher";
import {
	extractWeeklyResetTime,
	extractWindowResetTime,
	hasZeroUnscheduledWeeklyUsage,
	usageCache,
} from "../usage-fetcher";
import type { XaiUsageData } from "../xai-usage-fetcher";
import type { ZaiUsageData } from "../zai-usage-fetcher";

// ── extractWindowResetTime ────────────────────────────────────────────────────

describe("extractWindowResetTime", () => {
	it("returns tokens_limit.resetAt for zai provider", () => {
		const data: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 10,
				remaining: 90,
				percentage: 10,
				resetAt: 9999000,
				type: "tokens_limit",
			},
		};
		expect(extractWindowResetTime(data, "zai")).toBe(9999000);
	});

	it("returns null for zai provider when tokens_limit is null", () => {
		const data: ZaiUsageData = { time_limit: null, tokens_limit: null };
		expect(extractWindowResetTime(data, "zai")).toBeNull();
	});

	it("returns parsed resets_at ms for anthropic provider", () => {
		const resetIso = "2030-01-01T12:00:00Z";
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: resetIso },
			seven_day: { utilization: 10, resets_at: null },
		};
		expect(extractWindowResetTime(data, "anthropic")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns null for anthropic when resets_at is null", () => {
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: null },
			seven_day: { utilization: 10, resets_at: null },
		};
		expect(extractWindowResetTime(data, "anthropic")).toBeNull();
	});

	it("falls back to limits[] session resets_at for anthropic limits-only payloads", () => {
		const resetIso = "2030-03-01T00:00:00.000Z";
		const data = {
			limits: [
				{ kind: "session", percent: 40, resets_at: resetIso, scope: null },
			],
		} as unknown as UsageData;
		expect(extractWindowResetTime(data, "anthropic")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns parsed credits reset for xai provider", () => {
		const resetIso = "2030-02-01T00:00:00.000Z";
		const data: XaiUsageData = {
			credits: { utilization: 11, resets_at: resetIso },
		};
		expect(extractWindowResetTime(data, "xai")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns null for unknown/unsupported provider", () => {
		expect(extractWindowResetTime({} as AnyUsageData, "nanogpt")).toBeNull();
	});
});

// ── extractWeeklyResetTime ─────────────────────────────────────────────────

describe("extractWeeklyResetTime", () => {
	it("returns parsed seven_day resets_at ms for anthropic provider", () => {
		const resetIso = "2030-01-08T12:00:00Z";
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: "2030-01-01T12:00:00Z" },
			seven_day: { utilization: 10, resets_at: resetIso },
		};
		expect(extractWeeklyResetTime(data, "anthropic")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns null for anthropic when seven_day resets_at is null", () => {
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: "2030-01-01T12:00:00Z" },
			seven_day: { utilization: 10, resets_at: null },
		};
		expect(extractWeeklyResetTime(data, "anthropic")).toBeNull();
	});

	it("falls back to limits[] weekly_all resets_at for limits-only payloads", () => {
		const resetIso = "2030-03-08T00:00:00.000Z";
		const data = {
			limits: [
				{ kind: "session", percent: 40, resets_at: null, scope: null },
				{
					kind: "weekly_all",
					percent: 60,
					resets_at: resetIso,
					scope: null,
				},
			],
		} as unknown as UsageData;
		expect(extractWeeklyResetTime(data, "codex")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns null for providers without a weekly_all window (zai, xai, unsupported)", () => {
		expect(extractWeeklyResetTime({} as any, "zai")).toBeNull();
		expect(extractWeeklyResetTime({} as any, "xai")).toBeNull();
		expect(extractWeeklyResetTime({} as any, "nanogpt")).toBeNull();
	});
});

// ── hasZeroUnscheduledWeeklyUsage ──────────────────────────────────────────
//
// The fetcher-level fact issue #443's recovery module gates on: the weekly
// window reports zero usage AND no scheduled reset, which is the payload
// signature Anthropic sends right after resetting a window out of band
// (while `accounts.rate_limit_reset` still holds a stale future value from
// an earlier 429). Fails closed on anything that isn't unambiguously that
// signature — a false positive here would clear a legitimately future
// rate_limit_reset.

describe("hasZeroUnscheduledWeeklyUsage", () => {
	it("returns true for seven_day utilization 0 with resets_at null", () => {
		const data: UsageData = { seven_day: { utilization: 0, resets_at: null } };
		expect(hasZeroUnscheduledWeeklyUsage(data, "anthropic")).toBe(true);
	});

	it("returns true for seven_day utilization 0 with resets_at absent", () => {
		const data = {
			seven_day: { utilization: 0 },
		} as unknown as UsageData;
		expect(hasZeroUnscheduledWeeklyUsage(data, "anthropic")).toBe(true);
	});

	it("returns true for a limits-only weekly_all entry at 0% with no resets_at", () => {
		const data = {
			limits: [
				{ kind: "weekly_all", percent: 0, resets_at: null, scope: null },
			],
		} as unknown as UsageData;
		expect(hasZeroUnscheduledWeeklyUsage(data, "anthropic")).toBe(true);
	});

	it("returns false when the weekly_all entry is explicitly inactive", () => {
		const data = {
			limits: [
				{
					kind: "weekly_all",
					percent: 0,
					resets_at: null,
					scope: null,
					is_active: false,
				},
			],
		} as unknown as UsageData;
		expect(hasZeroUnscheduledWeeklyUsage(data, "anthropic")).toBe(false);
	});

	it("returns false when seven_day utilization is above 0", () => {
		const data: UsageData = { seven_day: { utilization: 5, resets_at: null } };
		expect(hasZeroUnscheduledWeeklyUsage(data, "anthropic")).toBe(false);
	});

	it("returns false when resets_at is present even at 0% utilization", () => {
		const data: UsageData = {
			seven_day: { utilization: 0, resets_at: "2030-01-08T12:00:00Z" },
		};
		expect(hasZeroUnscheduledWeeklyUsage(data, "anthropic")).toBe(false);
	});

	it("returns false when neither seven_day nor a weekly_all limits entry is present", () => {
		const data: UsageData = {
			five_hour: { utilization: 0, resets_at: null },
		};
		expect(hasZeroUnscheduledWeeklyUsage(data, "anthropic")).toBe(false);
	});

	it("returns false for an empty payload", () => {
		expect(hasZeroUnscheduledWeeklyUsage({} as UsageData, "anthropic")).toBe(
			false,
		);
	});

	it("returns false when seven_day and the weekly_all limits entry disagree", () => {
		// seven_day reads as fresh (0%, no reset) but the limits[] weekly_all
		// entry still carries a scheduled reset — a genuinely fresh window
		// would agree in both representations, so a mismatch fails closed.
		const disagreeingReset: UsageData = {
			seven_day: { utilization: 0, resets_at: null },
			limits: [
				{
					kind: "weekly_all",
					percent: 0,
					resets_at: "2030-01-08T12:00:00Z",
					scope: null,
				},
			],
		} as unknown as UsageData;
		expect(hasZeroUnscheduledWeeklyUsage(disagreeingReset, "anthropic")).toBe(
			false,
		);

		const disagreeingUtilization: UsageData = {
			seven_day: { utilization: 0, resets_at: null },
			limits: [
				{ kind: "weekly_all", percent: 12, resets_at: null, scope: null },
			],
		} as unknown as UsageData;
		expect(
			hasZeroUnscheduledWeeklyUsage(disagreeingUtilization, "anthropic"),
		).toBe(false);
	});

	it("returns false for a non-anthropic provider even with a matching payload shape", () => {
		const data: UsageData = { seven_day: { utilization: 0, resets_at: null } };
		expect(hasZeroUnscheduledWeeklyUsage(data, "codex")).toBe(false);
		expect(hasZeroUnscheduledWeeklyUsage(data, "xai")).toBe(false);
		expect(hasZeroUnscheduledWeeklyUsage(data, "zai")).toBe(false);
	});

	it("agrees with extractWeeklyResetTime on which entry carries the reset", () => {
		// Same limits-only payload extractWeeklyResetTime's own test reads via
		// the weekly_all fallback — pins that both functions select the same
		// entry rather than drifting apart under a future edit.
		const resetIso = "2030-03-08T00:00:00.000Z";
		const limitsOnly = {
			limits: [
				{ kind: "session", percent: 40, resets_at: null, scope: null },
				{ kind: "weekly_all", percent: 0, resets_at: resetIso, scope: null },
			],
		} as unknown as UsageData;

		// extractWeeklyResetTime reads the weekly_all entry's resets_at...
		expect(extractWeeklyResetTime(limitsOnly, "anthropic")).toBe(
			new Date(resetIso).getTime(),
		);
		// ...and hasZeroUnscheduledWeeklyUsage reads the very same entry: a
		// present resets_at fails the "unscheduled" check even at 0%.
		expect(hasZeroUnscheduledWeeklyUsage(limitsOnly, "anthropic")).toBe(false);

		const limitsOnlyFresh = {
			limits: [
				{ kind: "session", percent: 40, resets_at: null, scope: null },
				{ kind: "weekly_all", percent: 0, resets_at: null, scope: null },
			],
		} as unknown as UsageData;
		expect(extractWeeklyResetTime(limitsOnlyFresh, "anthropic")).toBeNull();
		expect(hasZeroUnscheduledWeeklyUsage(limitsOnlyFresh, "anthropic")).toBe(
			true,
		);
	});
});

// ── onWindowReset callback via usageCache.set ─────────────────────────────────

describe("usageCache window-reset callback", () => {
	it("fires onWindowReset when zai resetAt advances to a later value", () => {
		const accountId = "zai-window-reset-test";
		const callback = mock(() => {});

		const oldData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 80,
				remaining: 20,
				percentage: 80,
				resetAt: 1000000,
				type: "tokens_limit",
			},
		};
		const newData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 2,
				remaining: 98,
				percentage: 2,
				resetAt: 2000000,
				type: "tokens_limit",
			},
		};

		// Seed the cache with old data, then simulate a poll delivering new data
		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "zai", callback);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(accountId);

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset when resetAt stays the same", () => {
		const accountId = "zai-no-reset-test";
		const callback = mock(() => {});

		const data: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 50,
				remaining: 50,
				percentage: 50,
				resetAt: 1000000,
				type: "tokens_limit",
			},
		};

		usageCache.set(accountId, data);
		usageCache.notifyWindowReset(accountId, data, "zai", callback);

		expect(callback).not.toHaveBeenCalled();

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset on the first poll (no previous data)", () => {
		const accountId = "zai-first-poll-test";
		const callback = mock(() => {});

		const data: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 5,
				remaining: 95,
				percentage: 5,
				resetAt: 3000000,
				type: "tokens_limit",
			},
		};

		// No prior set() — first time seeing this account
		usageCache.notifyWindowReset(accountId, data, "zai", callback);

		expect(callback).not.toHaveBeenCalled();
	});

	// The upstream reset timestamp jitters by fractions of a second around the
	// same wall-clock instant, so a bare `newResetAt > prevResetAt` misreads that
	// jitter as a window rollover. Measured over 48h of production logs: 1554 of
	// 1564 detections were jitter (largest 1.879s), the 10 genuine rollovers all
	// advanced by exactly 5.00h — an empty gap of 1.9s…17999s between the classes.
	// The literals below pin that measurement, deliberately not derived from the
	// threshold constant so a wrong constant still fails these tests.

	it("does not fire onWindowReset on sub-second jitter (332ms, as observed)", () => {
		const accountId = "zai-jitter-test";
		const callback = mock(() => {});

		const base = 1_700_000_000_000;
		const oldData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 60,
				remaining: 40,
				percentage: 60,
				resetAt: base,
				type: "tokens_limit",
			},
		};
		const newData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 61,
				remaining: 39,
				percentage: 61,
				resetAt: base + 332,
				type: "tokens_limit",
			},
		};

		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "zai", callback);

		expect(callback).not.toHaveBeenCalled();

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset when the advance stays below the threshold (59s)", () => {
		const accountId = "zai-below-threshold-test";
		const callback = mock(() => {});

		const base = 1_700_000_000_000;
		const oldData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 60,
				remaining: 40,
				percentage: 60,
				resetAt: base,
				type: "tokens_limit",
			},
		};
		const newData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 62,
				remaining: 38,
				percentage: 62,
				resetAt: base + 59_000,
				type: "tokens_limit",
			},
		};

		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "zai", callback);

		expect(callback).not.toHaveBeenCalled();

		usageCache.delete(accountId);
	});

	it("fires onWindowReset on a genuine 5h window rollover", () => {
		const accountId = "zai-real-rollover-test";
		const callback = mock(() => {});

		const base = 1_700_000_000_000;
		const oldData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 95,
				remaining: 5,
				percentage: 95,
				resetAt: base,
				type: "tokens_limit",
			},
		};
		const newData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 1,
				remaining: 99,
				percentage: 1,
				resetAt: base + 5 * 60 * 60 * 1000,
				type: "tokens_limit",
			},
		};

		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "zai", callback);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(accountId);

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset on anthropic five_hour jitter (real payload)", () => {
		const accountId = "anthropic-jitter-test";
		const callback = mock(() => {});

		// Verbatim from the production log that surfaced this bug.
		const oldData: UsageData = {
			five_hour: { utilization: 74, resets_at: "2026-08-04T07:19:59.388Z" },
			seven_day: { utilization: 31, resets_at: null },
		};
		const newData: UsageData = {
			five_hour: { utilization: 75, resets_at: "2026-08-04T07:19:59.720Z" },
			seven_day: { utilization: 31, resets_at: null },
		};

		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "anthropic", callback);

		expect(callback).not.toHaveBeenCalled();

		usageCache.delete(accountId);
	});
});
