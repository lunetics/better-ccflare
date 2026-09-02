import "@better-ccflare/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

interface RawAccountRow {
	rate_limit_reset: number | null;
	rate_limit_status: string | null;
	rate_limit_remaining: number | null;
	rate_limited_until: number | null;
	rate_limited_reason: string | null;
	rate_limited_at: number | null;
	consecutive_rate_limits: number | null;
	provider: string;
}

describe("AccountRepository#markStaleRateLimitResetPassed (issue #443 recovery CAS)", () => {
	let db: Database;
	let repository: AccountRepository;

	function insertAccount(overrides: Partial<RawAccountRow> = {}): void {
		const row: RawAccountRow = {
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
			rate_limited_until: null,
			rate_limited_reason: null,
			rate_limited_at: null,
			consecutive_rate_limits: 0,
			provider: "anthropic",
			...overrides,
		};
		db.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at, created_at,
				rate_limit_reset, rate_limit_status, rate_limit_remaining,
				rate_limited_until, rate_limited_reason, rate_limited_at,
				consecutive_rate_limits
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"account-1",
				"Account 1",
				row.provider,
				"rt",
				"at",
				1,
				1,
				row.rate_limit_reset,
				row.rate_limit_status,
				row.rate_limit_remaining,
				row.rate_limited_until,
				row.rate_limited_reason,
				row.rate_limited_at,
				row.consecutive_rate_limits,
			],
		);
	}

	function getRaw(id = "account-1"): RawAccountRow {
		return db
			.query<RawAccountRow, [string]>(
				`SELECT rate_limit_reset, rate_limit_status, rate_limit_remaining,
					rate_limited_until, rate_limited_reason, rate_limited_at,
					consecutive_rate_limits, provider
				 FROM accounts WHERE id = ?`,
			)
			.get(id) as RawAccountRow;
	}

	beforeEach(() => {
		db = new Database(":memory:");
		db.run(`
			CREATE TABLE accounts (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				provider TEXT DEFAULT 'anthropic',
				api_key TEXT,
				refresh_token TEXT DEFAULT '',
				access_token TEXT,
				expires_at INTEGER,
				created_at INTEGER NOT NULL,
				last_used INTEGER,
				request_count INTEGER DEFAULT 0,
				total_requests INTEGER DEFAULT 0,
				rate_limited_until INTEGER,
				rate_limited_reason TEXT,
				rate_limited_at INTEGER,
				session_start INTEGER,
				session_request_count INTEGER DEFAULT 0,
				paused INTEGER DEFAULT 0,
				requires_reauth INTEGER DEFAULT 0,
				rate_limit_reset INTEGER,
				rate_limit_status TEXT,
				rate_limit_remaining INTEGER,
				priority INTEGER DEFAULT 0,
				auto_fallback_enabled INTEGER DEFAULT 0,
				auto_refresh_enabled INTEGER DEFAULT 0,
				auto_pause_on_overage_enabled INTEGER DEFAULT 0,
				peak_hours_pause_enabled INTEGER DEFAULT 0,
				custom_endpoint TEXT,
				model_mappings TEXT,
				cross_region_mode TEXT,
				model_fallbacks TEXT,
				billing_type TEXT,
				pause_reason TEXT,
				refresh_token_issued_at INTEGER,
				consecutive_rate_limits INTEGER DEFAULT 0
			)
		`);
		repository = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("applies the write and returns 1 change when the observed reset still matches", async () => {
		const staleReset = Date.now() + 5 * 24 * 60 * 60 * 1000;
		insertAccount({
			rate_limit_reset: staleReset,
			rate_limit_status: "rate_limited",
			rate_limit_remaining: 0,
			rate_limited_until: 1234,
			rate_limited_reason: "upstream_529_overloaded_no_reset",
			rate_limited_at: 999,
			consecutive_rate_limits: 3,
		});
		const now = Date.now();

		const changes = await repository.markStaleRateLimitResetPassed(
			"account-1",
			staleReset,
			now,
		);

		expect(changes).toBe(1);
		const row = getRaw();
		// Fields set exactly as specified.
		expect(row.rate_limit_reset).toBe(now);
		expect(row.rate_limit_status).toBeNull();
		expect(row.rate_limit_remaining).toBeNull();
		// Cooldown/audit tuple untouched — every column asserted individually.
		expect(row.rate_limited_until).toBe(1234);
		expect(row.rate_limited_reason).toBe("upstream_529_overloaded_no_reset");
		expect(row.rate_limited_at).toBe(999);
		expect(row.consecutive_rate_limits).toBe(3);
	});

	it("returns 0 changes and leaves the row untouched when the observed reset no longer matches (concurrent write)", async () => {
		const staleReset = Date.now() + 5 * 24 * 60 * 60 * 1000;
		const actualReset = Date.now() + 3 * 60 * 60 * 1000; // a concurrent response already rewrote it
		insertAccount({
			rate_limit_reset: actualReset,
			rate_limit_status: "rate_limited",
			rate_limit_remaining: 5,
		});
		const now = Date.now();

		const changes = await repository.markStaleRateLimitResetPassed(
			"account-1",
			staleReset, // stale value the caller last observed
			now,
		);

		expect(changes).toBe(0);
		const row = getRaw();
		expect(row.rate_limit_reset).toBe(actualReset);
		expect(row.rate_limit_status).toBe("rate_limited");
		expect(row.rate_limit_remaining).toBe(5);
	});

	it("returns 0 changes for a non-anthropic account even when the observed reset matches", async () => {
		const staleReset = Date.now() + 5 * 24 * 60 * 60 * 1000;
		insertAccount({ provider: "codex", rate_limit_reset: staleReset });
		const now = Date.now();

		const changes = await repository.markStaleRateLimitResetPassed(
			"account-1",
			staleReset,
			now,
		);

		expect(changes).toBe(0);
		expect(getRaw().rate_limit_reset).toBe(staleReset);
	});

	it("returns 0 changes when the account id does not exist", async () => {
		const changes = await repository.markStaleRateLimitResetPassed(
			"missing-account",
			1,
			2,
		);
		expect(changes).toBe(0);
	});
});
