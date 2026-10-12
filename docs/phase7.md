# Phase 7: productisation status

Build-plan Phase 7 is mostly outside this repository. This page records what is done and what is left, with what each remaining step involves.

## Done

| Task | What exists |
| --- | --- |
| 1. Mostlymatter, then our own build, instead of Team Edition | `infra/mostlymatter/Dockerfile` builds the pinned Team Edition image with Framasoft's Mostlymatter 11.7.12 binary (SHA-512 pinned, minisign signature checked, D40); the Phase 6 load test ran on it with 500 people. Our own build (task 2) replaced it on staging. |
| 1. Staging in a real environment | Railway project `enterprise-brain-staging` (docs/staging.md, D46), created by `pnpm staging:railway`: our own Mattermost build, the relay kept internal, TLS for Mattermost, secrets as Railway variables. An echo agent answered a mention through the public address in 1.2 s, and no staging secret appeared in any log. |
| 2. Our own thin Mattermost fork | [tintin222/enterprise-brain-chat](https://github.com/tintin222/enterprise-brain-chat), public (AGPL v3), branch `enterprise-brain/v11.7.12` (D48): no user limit, Enterprise Brain name and logo in the web app and user-facing server strings, and a release workflow. Release `eb-v11.7.12-1` passed its limit tests; `infra/chat/Dockerfile` builds the image from it (`pnpm dev:up --enterprise-brain`). Checked on 2026-10-12: every spike gives its earlier result, the e2e suite passes, `pnpm spike X3` reached 260 active users, and staging runs it. The footer links to the source code. |
| 4. Sign-in | Mattermost email and password, no SSO and no licence (D22). Nothing to build; keep `EmailSettings.EnableSignInWithEmail` on, and set `TeamSettings.MaxUsersPerTeam` as `pnpm dev:seed` does (D42). |
| 5. "Add agent to channel" and "enable channel" in the brain product | The internal admin API (`pnpm admin-api`, port `ADMIN_API_PORT`, bearer `ADMIN_API_TOKEN`): `POST /agents` creates or updates an agent (the same operation as `pnpm agent:provision`), `POST /channels/{id}/enable` adds `@brain`, `POST /channels/{id}/agents` adds an agent's bot, `DELETE /channels/{id}/agents/{handle}` removes it, `GET /agents` lists agents without secrets. The bridge mirrors each change (e2e `admin-api.e2e.test.ts`). The brain product calls these from its server side; the token must never reach a browser. On staging, `pnpm staging:agent` calls it. |
| 6. Licence review | The owner's lawyer confirmed the licence boundary (reported by the owner on 2026-10-12): our services use only Mattermost's and the relay's public APIs (CLAUDE.md rules 4 and 5), and the only server change is the fork (task 2). Third-party notices are in `infra/third_party/` and `packages/bridge/third_party/`. |
| Name and logo | The product is called Enterprise Brain (D44). The logo, app icons and favicon are in `branding/`; the fork carries them through the web app. `pnpm dev:seed` also sets the site name, the login-page image and description, turns off the desktop-app landing page, and hides Mattermost's About, Help, Privacy and problem-report links. |
| Container image for our services | `infra/services/Dockerfile` builds one image for the bridge, agent-runtime, ingestion and the admin API (pinned Node 24.21.0, production dependencies only, no `.env`); staging runs it. Checked on 2026-10-12: the three services ran from it against the local stack, reported ready, and an echo agent answered a mention in about a second. |

## Left for the owner

These need the owner's accounts or decisions.

1. **Branded desktop and mobile apps and a push proxy (task 3).** Needs: Apple and Google developer accounts in the company's name.
   - The desktop (`mattermost/desktop`) and mobile (`mattermost/mattermost-mobile`) clients are Apache-2.0: fork them, change the name, icons (`branding/png/app-icon-1024.png`) and default server URL, and sign them with our own Apple and Google developer accounts.
   - Mobile push needs our own `mattermost-push-proxy` (Apache-2.0) with our APNs and FCM credentials.
   - Point the server's `EmailSettings.PushNotificationServer` at that proxy. The relay's own push gateway stays disabled (D16).
   - Until then, people can use Mattermost's official apps with our server; they show the Mattermost name.
2. **Staging follow-ups** (docs/staging.md): run the load test there, configure SMTP for email, schedule volume backups, and set the product's own Terms of Service and Privacy Policy links (System Console, Customization); Mattermost restores its own Terms link when the setting is empty.
3. **Keeping the fork current.** For each Mattermost upgrade: rebase `enterprise-brain/v11.7.12` onto the new tag in a new branch, run the release workflow, update `infra/chat/Dockerfile` with the new release and its SHA-512 sums, and run `pnpm spike`, `pnpm spike X3` and the e2e suite before deploying (docs/operations.md section 6).

Phase 7's acceptance criterion: a new workspace can be created (staging), branded clients connect (the web app; desktop and mobile apps wait for item 1), and an agent created in the brain can be added to a channel without a terminal (the admin API).
