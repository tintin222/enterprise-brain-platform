# Phase 7: productisation status

Build-plan Phase 7 is mostly outside this repository. This page records what is done and what is left, with what each remaining step involves.

## Done

| Task | What exists |
| --- | --- |
| 1. Mostlymatter instead of Team Edition | `infra/mostlymatter/Dockerfile` builds the pinned Team Edition image with Framasoft's Mostlymatter 11.7.12 binary (SHA-512 pinned, minisign signature checked, D40). `pnpm dev:up --mostlymatter` runs it on the same data; the Phase 6 load test ran on it with 500 people. Staging uses the same image. |
| 4. Sign-in | Mattermost email and password, no SSO and no licence (D22). Nothing to build; keep `EmailSettings.EnableSignInWithEmail` on, and set `TeamSettings.MaxUsersPerTeam` as `pnpm dev:seed` does (D42). |
| 5. "Add agent to channel" and "enable channel" in the brain product | The internal admin API (`pnpm admin-api`, port `ADMIN_API_PORT`, bearer `ADMIN_API_TOKEN`): `POST /agents` creates or updates an agent (the same operation as `pnpm agent:provision`), `POST /channels/{id}/enable` adds `@brain`, `POST /channels/{id}/agents` adds an agent's bot, `DELETE /channels/{id}/agents/{handle}` removes it, `GET /agents` lists agents without secrets. The bridge mirrors each change (e2e `admin-api.e2e.test.ts`). The brain product calls these from its server side; the token must never reach a browser. |
| 6. Licence review | The owner's lawyer confirmed the licence boundary (reported by the owner on 2026-10-12): our services use only Mattermost's and the relay's public APIs (CLAUDE.md rules 4 and 5), and the only server change is the fork in item 1 below. Third-party notices are in `infra/third_party/` and `packages/bridge/third_party/`. |
| Name and logo (for tasks 2 and 3) | The product is called Enterprise Brain (D44). The logo, app icons and favicon are in `branding/`. `pnpm dev:seed` applies Mattermost's built-in branding: the site name, the login-page image and description, and no desktop-app landing page. Mattermost's logo in the login header, its edition badge and its footer stay until the fork (spike findings item 32). |
| Container image for our services | `infra/services/Dockerfile` builds one image for the bridge, agent-runtime, ingestion and the admin API (pinned Node 24.21.0, production dependencies only, no `.env`). The command picks the program, for example `packages/ingestion/src/main.ts`. Checked on 2026-10-12: built for linux/amd64, the three services ran from it against the local stack, reported ready, and an echo agent answered a mention in about a second. |

## Left for the owner

These change things outside this repository (new public repositories, app store accounts, paid hosting), so each needs the owner's go-ahead.

1. **Our own thin Mattermost fork (task 2).** The name and logo are ready. Needs: the GitHub account or organisation that will host the public repository.
   - Fork `mattermost/mattermost` at the release in use (11.7.12).
   - Apply the user-limits patch; Mostlymatter's patch on framagit is the reference.
   - Replace the Mattermost name and logo with Enterprise Brain's (`branding/`). The Mattermost trademark guidelines forbid using the mark without permission; Mostlymatter's logo is CC BY-NC 4.0, so it cannot be used commercially either.
   - The server is AGPL v3: publish the fork's source, including the patch and branding changes, wherever we offer the service to users.
   - Build the server binary in CI and swap it into the image the same way `infra/mostlymatter/Dockerfile` does.
   - Re-run `pnpm spike` and the e2e suite against it before each upgrade.
2. **Branded desktop and mobile apps and a push proxy (task 3).** Needs: Apple and Google developer accounts in the company's name.
   - The desktop (`mattermost/desktop`) and mobile (`mattermost/mattermost-mobile`) clients are Apache-2.0: fork them, change the name, icons (`branding/png/app-icon-1024.png`) and default server URL, and sign them with our own Apple and Google developer accounts.
   - Mobile push needs our own `mattermost-push-proxy` (Apache-2.0) with our APNs and FCM credentials.
   - Point the server's `EmailSettings.PushNotificationServer` at that proxy. The relay's own push gateway stays disabled (D16).
3. **Staging (task 1 in a real environment).** The owner has a Railway account; the plan for running the stack there is in `docs/staging.md`.
   - Deploy the stack with the Mostlymatter image and the services image.
   - Keep secrets in the host's secret store (docs/operations.md section 4).
   - Keep the relay internal, with TLS for Mattermost.
   - Run the load test there with production-like resources (docs/load-test.md).

Phase 7's acceptance criterion: a new workspace can be created, branded clients connect, and an agent created in the brain can be added to a channel without a terminal. The last part is in place (the admin API); the first two depend on items 1 to 3.
