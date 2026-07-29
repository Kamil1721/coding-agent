/**
 * Bring the fixture API up before anything navigates, and take it down after.
 *
 * It runs IN THE RUNNER'S PROCESS rather than as a second `webServer` command,
 * because the fixture data is TypeScript that imports the app's own reducer and
 * its own contract types — `node` cannot resolve those extensionless specifiers
 * but the runner's loader can. One source of fixture truth, shared by the unit
 * spec and the browser specs, with no build step between them.
 */

import { startFixtureApi } from "./fixtures/api-server";
import { API_PORT } from "./fixtures/config";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const api = await startFixtureApi(API_PORT);
  return async (): Promise<void> => {
    await api.close();
  };
}
