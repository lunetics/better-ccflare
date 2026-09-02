import type { Logger } from "@better-ccflare/logger";
import {
	hasZeroUnscheduledWeeklyUsage,
	type UsageData,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";

/**
 * Only the account-level weekly window is "weekly-scale" — a real 5h/session
 * reset from an actual 429 is always well under this. Anything the caller
 * observed further out than this horizon is assumed stale rather than a
 * legitimate future cooldown.
 */
const HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Per-account minimum spacing between write ATTEMPTS (whether or not the
 * attempt actually applied), belt-and-braces on top of the confirmation
 * streak and the horizon gate — see {@link createStaleWeeklyResetRecovery}.
 */
const THROTTLE_MS = 6 * 60 * 60 * 1000;

/**
 * Consecutive matching polls required before acting. A single fresh-window
 * poll could be a transient/partial payload; requiring two in a row is the
 * cheapest defense against clearing a legitimately future rate_limit_reset
 * on a one-off glitch.
 */
const CONFIRM_STREAK = 2;

export interface StaleWeeklyResetRecoveryDeps {
	/** Injected clock so tests can control time exactly. */
	now: () => number;
	/** Config accessor for the `clear_stale_rate_limit_reset` flag, read at
	 * fire time (not at registration) so a runtime toggle takes effect on
	 * the next confirmed episode without a server restart. */
	isEnabled: () => boolean;
	dbOps: {
		getAccount(accountId: string): Promise<Account | null>;
		markStaleRateLimitResetPassed(
			accountId: string,
			observedReset: number,
			now: number,
		): Promise<boolean>;
	};
	log: Pick<Logger, "warn" | "info">;
}

/**
 * Builds the recovery handler for issue #443: an Anthropic account whose
 * weekly window was reset out of band keeps a stale, future
 * `accounts.rate_limit_reset` (only ever written from response headers),
 * which excludes it from both `AutoRefreshScheduler`'s probe eligibility and
 * drain-soonest ranking — a silent deadlock, since the only way to learn the
 * real reset is a request the account never gets. This module detects the
 * contradiction from usage-poll telemetry (zero, unscheduled weekly usage —
 * see `hasZeroUnscheduledWeeklyUsage`) and corrects the one stale field so
 * the scheduler's existing probe logic takes over from there.
 *
 * Returns a handler meant to be composed into the existing
 * `UsageCache.startPolling` `onSnapshot` callback — every state variable
 * (per-account confirmation streak, one-warn-per-episode latch, and the
 * write throttle) lives inside this closure, so each call to this factory
 * starts with a clean slate (tests construct a fresh instance per case;
 * production constructs exactly one, shared across every account, keyed by
 * accountId in the maps below).
 */
export function createStaleWeeklyResetRecovery(
	deps: StaleWeeklyResetRecoveryDeps,
): (accountId: string, data: UsageData) => Promise<void> {
	const streaks = new Map<string, number>();
	const warnedThisEpisode = new Map<string, boolean>();
	const lastWriteAttemptAt = new Map<string, number>();

	function warnOnce(accountId: string, message: string): void {
		if (warnedThisEpisode.get(accountId)) return;
		warnedThisEpisode.set(accountId, true);
		deps.log.warn(message);
	}

	return async function handleUsageSnapshot(
		accountId: string,
		data: UsageData,
	): Promise<void> {
		const account = await deps.dbOps.getAccount(accountId);
		// This callback is shared with xAI accounts (both providers poll
		// through the same refresh-backed usage-polling wrapper), and the
		// signature below is meaningless outside Anthropic — filter here
		// rather than relying on callers to pre-filter.
		if (!account || account.provider !== "anthropic") return;

		const signature = hasZeroUnscheduledWeeklyUsage(data, "anthropic");
		if (!signature) {
			streaks.delete(accountId);
			warnedThisEpisode.delete(accountId);
			return;
		}

		const streak = (streaks.get(accountId) ?? 0) + 1;
		streaks.set(accountId, streak);
		if (streak < CONFIRM_STREAK) return;

		const now = deps.now();
		const label = `${account.name} (${accountId})`;

		if (!deps.isEnabled()) {
			warnOnce(
				accountId,
				`Stale rate_limit_reset recovery for account ${label} skipped: clear_stale_rate_limit_reset is disabled`,
			);
			return;
		}

		if (!account.auto_refresh_enabled) {
			warnOnce(
				accountId,
				`Stale rate_limit_reset recovery for account ${label} skipped: auto-refresh is disabled, so no probe would follow the clear`,
			);
			return;
		}

		if (account.rate_limited_until && account.rate_limited_until > now) {
			warnOnce(
				accountId,
				`Stale rate_limit_reset recovery for account ${label} skipped: rate_limited_until is still in the future (real cooldown)`,
			);
			return;
		}

		const observedReset = account.rate_limit_reset;
		if (!observedReset || observedReset <= now + HORIZON_MS) {
			warnOnce(
				accountId,
				`Stale rate_limit_reset recovery for account ${label} skipped: rate_limit_reset is not more than 24h out (not weekly-scale, or already corrected)`,
			);
			return;
		}

		const lastAttempt = lastWriteAttemptAt.get(accountId);
		if (lastAttempt !== undefined && now - lastAttempt < THROTTLE_MS) {
			// Belt-and-braces: no WARN here, this is not a rejected gate, just a
			// deliberate rate limit on how often this account's row can be
			// touched by this recovery path.
			return;
		}

		lastWriteAttemptAt.set(accountId, now);
		const applied = await deps.dbOps.markStaleRateLimitResetPassed(
			accountId,
			observedReset,
			now,
		);
		if (applied) {
			deps.log.info(
				`Cleared stale rate_limit_reset for account ${label}: was ${new Date(observedReset).toISOString()}, usage poll shows a zero, unscheduled weekly window (likely reset out of band)`,
			);
			// Latch the episode: the write just moved rate_limit_reset to `now`
			// (past), so the very next poll's horizon gate will reject it —
			// without this, that rejection would emit a WARN saying the
			// recovery was "skipped" right after the INFO line said it applied.
			warnedThisEpisode.set(accountId, true);
		}
	};
}
