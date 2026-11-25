import { spawn } from "node:child_process";
import { mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startFakeCompanies } from "./fake-companies";

async function empty(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await empty(path);
    else await unlink(path);
  }
  await rmdir(dir);
}

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

for (const cli of ["claude", "codex"] as const) {
  test(`${cli} completes a turn using a path-prefixed base URL`, { timeout: 45_000 }, async (context) => {
    const home = await mkdtemp(join(tmpdir(), "fake-company-cli-"));
    const fake = await startFakeCompanies();
    try {
      const blocked = "http://127.0.0.1:1";
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home,
        XDG_DATA_HOME: home,
        XDG_STATE_HOME: home,
        HTTP_PROXY: blocked,
        HTTPS_PROXY: blocked,
        ALL_PROXY: blocked,
        NO_PROXY: "127.0.0.1,localhost",
        http_proxy: blocked,
        https_proxy: blocked,
        all_proxy: blocked,
        no_proxy: "127.0.0.1,localhost",
        CLAUDE_CONFIG_DIR: home,
        CODEX_HOME: home,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_ERROR_REPORTING: "1",
      };
      let version;
      try {
        version = await run(cli, ["--version"], home, env);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const reason = `${cli} is not installed (not found on PATH)`;
        console.log(`Skipping: ${reason}`);
        context.skip(reason);
        return;
      }
      expect(version.code).toBe(0);
      console.log(version.stdout.trim());
      const account = fake.addAccount(cli === "claude" ? "anthropic" : "openai", cli);
      const base = `${fake.address}/plugins/agent-proxy/ACME`;
      const prompt = "Reply with exactly: Fake reply.";
      let result;
      if (cli === "claude") {
        result = await run(
          cli,
          ["--bare", "-p", "--tools", "", "--model", "claude-sonnet-4-6", "--no-session-persistence", prompt],
          home,
          {
            ...env,
            ANTHROPIC_BASE_URL: base,
            ANTHROPIC_API_KEY: account.accessToken,
          },
        );
      } else {
        await writeFile(
          join(home, "config.toml"),
          `
model = "gpt-5"
model_provider = "fixture"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"

[model_providers.fixture]
name = "Fixture"
base_url = "${base}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`,
        );
        result = await run(
          cli,
          ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", prompt],
          home,
          {
            ...env,
            OPENAI_API_KEY: account.accessToken,
          },
        );
      }
      for (const { method, path, headers, body } of fake.requests) {
        // Header names are useful even when the values contain device/session IDs.
        const safe = Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [
            key,
            /authorization|api-key|cookie|token/i.test(key)
              ? "[masked]"
              : /^(accept|content-type|user-agent|anthropic-version|anthropic-beta)$/.test(key)
                ? value
                : "[present]",
          ]),
        );
        const shape =
          body && typeof body === "object"
            ? Object.fromEntries(
                Object.entries(body).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
                ]),
              )
            : typeof body;
        console.log(`${method} ${path} headers=${JSON.stringify(safe)} body=${JSON.stringify(shape)}`);
      }
      expect(result.code, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain("Fake reply.");
      const endpoint = cli === "claude" ? "/v1/messages" : "/responses";
      expect(
        fake.requests.some(
          ({ method, account, path }) =>
            method === "POST" &&
            account === cli &&
            path.split("?")[0] === `/plugins/agent-proxy/ACME${endpoint}`,
        ),
        `Missing authenticated POST to the prefixed ${endpoint} endpoint`,
      ).toBe(true);
    } finally {
      await fake.stop();
      await empty(home);
    }
  });
}
