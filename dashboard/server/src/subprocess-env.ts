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
  /*
   * THE REPAIR LANE'S MAIL CREDENTIAL — 2026-08-16, AND IT IS NOT A PROVIDER KEY,
   * WHICH IS WHY IT WAS MISSED.
   *
   * `REPAIR_SMTP_URL` carries a password in its userinfo
   * (`smtps://user:<app-password>@host:465`). Every name above it is an LLM
   * provider credential, so a new credential that is not one reads as "not this
   * list's business" — and this list is a SUBTRACTION, so anything unlisted is
   * inherited by default. The failure direction of an allowlist is a broken
   * subprocess; the failure direction of a subtraction is a leaked secret.
   *
   * WHY IT MATTERS MORE HERE THAN A PROVIDER KEY WOULD. The builder is an LLM
   * agent WITH BASH, running unattended against a ticket the owner may not have
   * written. One `env` or `printenv`, one dependency postinstall that dumps
   * configuration, and the plaintext password is in the model's context and in
   * `runs/<id>/results/build.log`.
   *
   * AND THE REDACTOR CANNOT SAVE IT. `bakeoff/src/redact.ts`'s
   * `DEFAULT_KNOWN_ENV_NAMES` holds four names, all provider keys, so the
   * known-value pass does not know to look for this one; and a Gmail app
   * password is four lowercase words, which no entropy rule will flag. The only
   * place this can be stopped is here, before the subprocess exists.
   *
   * THE ADDRESS IS NOT STRIPPED, deliberately. `REPAIR_MAIL_TO` is an email
   * address, and `repair-mail.ts:104-109` already rules that an address is not a
   * credential. Stripping it would be security theatre that also breaks nothing
   * usefully.
   */
  "REPAIR_SMTP_URL",
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
 * The environment for a subprocess that is NOT an agent and DOES need the
 * owner's project credentials: the preview/start process that serves a SERVER
 * artefact on this machine.
 *
 * WHY THIS IS A SEPARATE FUNCTION AND NOT A PARAMETER ON THE ONE ABOVE.
 * `subscriptionSubprocessEnv` is the environment of the BUILDER, the SPEC seat
 * and the JUDGE seat (`orchestrator.ts:766`, `:777`, `:1217`). All three are LLM
 * agents; the builder has Bash. A value in their environment is one `env` away
 * from a transcript, and that transcript's redaction pass knows four provider
 * variable names by default (`redact.ts:218-223`) and is called with no options
 * everywhere in this package — so an intake secret would be covered by the shape
 * rules alone. Giving the value to an agent is therefore a decision with a
 * measured leak surface, and this program does not make it: agents get NAMES
 * (`secretsForBuildPrompt`), and this function is for the process that actually
 * has to authenticate.
 *
 * THE SUBTRACTION STILL RUNS FIRST, AND THE INJECTION MAY NOT UNDO IT. Every
 * name in {@link STRIPPED_ENV_NAMES} is refused here rather than overwritten,
 * because the whole point of that list is that a metered credential never reaches
 * a subprocess this program spawns; a caller re-adding one after the subtraction
 * would silently bill the owner per token while `costUsd` stays null. The intake
 * refuses those names too — this is the second of the two checks, deliberately,
 * because the first one lives behind an HTTP route and this one cannot be reached
 * without a compile.
 *
 * NOT WIRED BY THIS PHASE. The caller would be `preview.ts`, which this phase
 * does not own. Until it calls this, a SERVER artefact does not receive the
 * value at run time and the store is write-only in practice.
 */
export function runtimeSubprocessEnv(
  env: NodeJS.ProcessEnv,
  secrets: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const out = subscriptionSubprocessEnv(env);
  for (const [name, value] of Object.entries(secrets)) {
    if (STRIPPED_ENV_NAMES.includes(name)) {
      throw new Error(
        `refusing to inject ${name}: it is stripped from every subprocess environment on purpose. ` +
          "Injection happens after that subtraction, so re-adding it here would send a metered " +
          "credential to a CLI that is already logged in to a subscription, and the run would be " +
          "billed per token while the dashboard reported costUsd: null.",
      );
    }
    out[name] = value;
  }
  return out;
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
