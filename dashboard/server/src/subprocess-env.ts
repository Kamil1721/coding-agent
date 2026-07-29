/**
 * subprocess-env.ts — the environment handed to every SDK subprocess, with the
 * metered credentials removed.
 *
 * THIS FILE EXISTS BECAUSE OF A BUG THAT COSTS REAL MONEY AND HIDES ITSELF.
 *
 * Both SDKs spawn a CLI and pass it an environment. Both CLIs will use an API
 * KEY if they find one: the Agent SDK's own documentation lists
 * `ANTHROPIC_API_KEY` among the variables the subprocess inherits, and the
 * Codex SDK sets `CODEX_API_KEY` when given one. The dashboard's entire
 * contract is that a run is SUBSCRIPTION traffic — quota consumed, nothing
 * billed — which is why `RunDetail.costUsd` is null for every run.
 *
 * So if the owner happens to have `ANTHROPIC_API_KEY` exported (and this repo
 * ships a `.env.example` that asks for exactly that variable, for the bake-off
 * harness), the CLI would silently authenticate with the key and bill the API
 * per token, while the dashboard kept reporting `costUsd: null`. The failure is
 * invisible from inside the program: same models, same output, a bill that
 * appears somewhere else entirely.
 *
 * The fix is not "hope it is unset". It is to DELETE the metered credentials
 * from the environment of every subprocess this program spawns, every time, in
 * one place, with a test that proves it.
 *
 * `ANTHROPIC_BASE_URL` goes too, for a different reason: bakeoff's README
 * records two documented community cost blowups caused by gateway bugs that
 * silently broke prompt caching — a 0%-hit-rate run at up to 2.4x the modelled
 * bill, invisible everywhere except the cache usage fields. A subscription CLI
 * has no business being pointed at a gateway by an environment variable this
 * program did not set on purpose.
 */

/**
 * Variables removed from every subprocess environment.
 *
 * Each one either selects metered API billing or redirects the endpoint. None
 * of them is needed by a CLI that is already logged in.
 */
export const STRIPPED_ENV_NAMES: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  // The bake-off's other vendors. Nothing here ever talks to them, but an
  // inherited key is an inherited key.
  "MOONSHOT_API_KEY",
  "MOONSHOT_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
]);

/**
 * A copy of `env` with every metered credential and endpoint override removed.
 *
 * Everything else is preserved: PATH, HOME and CODEX_HOME are how the CLIs find
 * themselves and their own login, so this is a subtraction, never an allowlist.
 */
export function subscriptionSubprocessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const name of STRIPPED_ENV_NAMES) delete copy[name];
  return copy;
}

/**
 * The same thing as `Record<string, string>`, which is what the Codex SDK's
 * `CodexOptions.env` requires. Undefined values are dropped rather than
 * stringified: `String(undefined)` in an environment variable is a value, and a
 * CLI reading it would see the four characters "undefined".
 */
export function subscriptionSubprocessEnvStrings(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(subscriptionSubprocessEnv(env))) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
