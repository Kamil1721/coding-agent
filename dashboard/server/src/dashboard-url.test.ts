/**
 * dashboard-url.test.ts — the bind side and the dial side read one number.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_PORT, LOOPBACK_HOST, dashboardBaseUrl, parsePort } from "./dashboard-url.js";
import { DEFAULT_PORT as HTTP_DEFAULT_PORT, LOOPBACK_HOST as HTTP_LOOPBACK } from "./http.js";

test("the base URL is loopback and the default port, with no trailing slash", () => {
  assert.equal(dashboardBaseUrl({}), `http://${LOOPBACK_HOST}:${String(DEFAULT_PORT)}`);
  assert.equal(dashboardBaseUrl({ DASHBOARD_PORT: "4321" }), `http://${LOOPBACK_HOST}:4321`);
  assert.equal(dashboardBaseUrl({ DASHBOARD_PORT: "  4321  " }), `http://${LOOPBACK_HOST}:4321`);
});

test("a port that is not a port is REFUSED, not defaulted", () => {
  // Defaulting here is trap row 2: the tick would POST to 4176 while the server
  // bound something else, and the only symptom is a run that never appears.
  assert.throws(() => parsePort("nope"), /must be a port number/);
  assert.throws(() => parsePort("0"));
  assert.throws(() => parsePort("70000"));
  assert.equal(parsePort(undefined), DEFAULT_PORT);
  assert.equal(parsePort("   "), DEFAULT_PORT);
});

test("ONE DECLARATION: http.ts's constants agree with this module's", () => {
  // WHAT THIS DETECTS, STATED HONESTLY RATHER THAN OVERSOLD. It is a VALUE
  // comparison, so it cannot see that a copy exists — two independent `4176`
  // literals compare equal and this test stays green. What it catches is a copy
  // that has DIVERGED, which is the failure that costs something: the server
  // binds one port and a local client dials another.
  //
  // MEASURED, not asserted: with `DEFAULT_PORT` moved to 4177 in
  // dashboard-url.ts and http.ts still re-exporting, this test stayed GREEN
  // (one binding, two names). With 4177 here and a literal `4176` re-declared
  // in http.ts, it went RED with `4176 !== 4177`. So the guarantee is
  // "the two names cannot hold different numbers", and the structural
  // guarantee — that there is only one declaration — is the re-export in
  // http.ts, which no test can assert from outside.
  assert.equal(HTTP_DEFAULT_PORT, DEFAULT_PORT);
  assert.equal(HTTP_LOOPBACK, LOOPBACK_HOST);
});
