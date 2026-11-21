# Homeasy — active handoff (2026-11-21)

## Published integration

Owner approved modernization stage 1 with main for production and develop for integration. Separate integration worktree: /private/tmp/homeasy-develop-20261121. Original Mac checkout on main 7ad0ec7 stays dirty.

- Published develop commits 03075b1 (selected source, CI, manifests and release guide) and f935941 (four frontend test waits). GitHub Actions run 44875663342 on SHA f935941cd4bea35dc8e66e48d2bc4493e1a2ff33 completed SUCCESS. Both Node 22 checks/builds and Docker api-runner build succeeded. CI verifies backend typecheck/lint/Jest/build, Bright Data tools, frontend lint/Vitest, Web/TMA builds and artifact SHA-256.
- GitHub build artifact ID 14694969574, name homeasy-f935941cd4bea35dc8e66e48d2bc4493e1a2ff33-builds, ZIP SHA-256 865d0d5a5769e43227919dbdb8a055130304dc73f8ac1faa038f8a1047f7d706. Docker provenance artifact ID 14695643157, ZIP SHA-256 91036f13d2897288ee6d5f17407489352f6644b5b982c5dc775d8be41619966e. ZIP digests differ from individual built-file and Docker image hashes, which are in the respective artifacts.
- Preservation bundle /private/tmp/homeasy-stage1-20261121-preserve contains selected-source.tar.gz, tracked.patch, manifest and detached-worktree archives. Original Mac, VPS and detached working trees were never reset. Integration has an untracked node_modules symlink that must stay untracked.
- Verified GitHub branches: main 7ad0ec7, develop f935941, codex/vps-migration-ready 9d57576, feature/telegram-mini-app 23c6bd2.
- GitHub Cloudflare Pages check on develop f935941 succeeded for homeasy-app deployment a39a9363-39e1-4163-80e2-8b8fa0d9f8d3. Earlier main 7ad0ec7 check succeeded for homeasy-app deployment 18dd8691-befe-4125-8dcd-5f3742ae4f90. Success checks do not prove the current production-branch setting or public delivery.

## Open verification gates

- Cloudflare Dashboard redirected to login (2026-11-21). Wrangler OAuth credentials expired 2026-10-21. Wrangler interactive CLI initiated a fresh login and it was cancelled. Current production and preview branch bindings, particularly the Telegram Mini App project, are unverified. Keep feature/telegram-mini-app remote ref.
- Earlier 2026-11-21 SSH read verified VPS /home/ubuntu/homeasy on codex/vps-migration-ready at 07bf9eb with 20 local changes and five running Homeasy containers. Latest probe authenticated using the existing SSH key and ran a printf command after ~45 seconds, but subsequent Git/Compose read timed out and a minimal recheck could not connect. Current VPS Git/service state is unverified. Keep codex/vps-migration-ready remote ref and all VPS local changes.
- No production deployment, live SQLite modification, scraper, paid provider, container recreation or Cloudflare branch switch. Release and rollback are documented in release_process.md but production rollback has not been rehearsed.

## Next approved work

1. Authenticated read of each Cloudflare Pages project to record production branch, current deployment ID/source SHA and preview-branch behavior.
2. Stable read-only VPS SSH and reconciliation of its dirty 07bf9eb checkout against remote 9d57576.
3. Only after both dependencies clear, delete obsolete GitHub branches and verify only main and develop remain. A production release is a separate step.
