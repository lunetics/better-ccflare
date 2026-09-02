import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("getClearStaleRateLimitResetEnabled / setClearStaleRateLimitResetEnabled", () => {
	const originalEnv = process.env.BETTER_CCFLARE_CLEAR_STALE_RATE_LIMIT_RESET;

	beforeEach(() => {
		delete process.env.BETTER_CCFLARE_CLEAR_STALE_RATE_LIMIT_RESET;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.BETTER_CCFLARE_CLEAR_STALE_RATE_LIMIT_RESET;
		} else {
			process.env.BETTER_CCFLARE_CLEAR_STALE_RATE_LIMIT_RESET = originalEnv;
		}
	});

	it("defaults to false when no env or file override", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getClearStaleRateLimitResetEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("honors a truthy env override", () => {
		process.env.BETTER_CCFLARE_CLEAR_STALE_RATE_LIMIT_RESET = "1";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getClearStaleRateLimitResetEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("treats a non-true env value as disabled", () => {
		process.env.BETTER_CCFLARE_CLEAR_STALE_RATE_LIMIT_RESET = "disabled";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getClearStaleRateLimitResetEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("honors a config-file override set via setClearStaleRateLimitResetEnabled", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setClearStaleRateLimitResetEnabled(true);
			expect(config.getClearStaleRateLimitResetEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("prioritizes the env override over a config-file value", () => {
		process.env.BETTER_CCFLARE_CLEAR_STALE_RATE_LIMIT_RESET = "false";
		const { config, cleanup } = makeConfig();
		try {
			config.setClearStaleRateLimitResetEnabled(true);
			expect(config.getClearStaleRateLimitResetEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("is included in getAllSettings()", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getAllSettings().clear_stale_rate_limit_reset).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("reports source 'default' when neither env nor file is set", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getClearStaleRateLimitResetEnabledSource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("reports source 'file' when only the config-file field is set", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setClearStaleRateLimitResetEnabled(true);
			expect(config.getClearStaleRateLimitResetEnabledSource()).toBe("file");
		} finally {
			cleanup();
		}
	});

	it("reports source 'env' when a valid env override is present, even with a file value set", () => {
		process.env.BETTER_CCFLARE_CLEAR_STALE_RATE_LIMIT_RESET = "1";
		const { config, cleanup } = makeConfig();
		try {
			config.setClearStaleRateLimitResetEnabled(false);
			expect(config.getClearStaleRateLimitResetEnabledSource()).toBe("env");
		} finally {
			cleanup();
		}
	});
});
