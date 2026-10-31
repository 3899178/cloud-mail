# Independent coordinator image publication implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the exact accepted Cloud Mail runtime through the approved standalone build repository so web-first deployment can resume.

**Architecture:** Keep the existing application-repository publisher compatible. Add one explicit trusted publisher context for 3899178/cloud-mail-build, owner-only manual main execution, with distinct application and coordinator commits. A coordinator workflow must run the complete unchanged acceptance gates, push that same image using only its short-lived GitHub token, then verify anonymous manifest/config digests and immutable pull in a separate read-only job.

**Tech Stack:** Node.js 24, existing Docker/Linux gates, GitHub Actions and GHCR.

**Spec:** docs/superpowers/specs/2026-10-27-cloud-mail-unified-design.md, plus the user-approved standalone build coordinator. This adds infrastructure publication, not application features or production promotion.

## Global constraints

- Existing original-repository tag/main publication contracts remain valid.
- Only the fixed repositories 3899178/cloud-mail and 3899178/cloud-mail-build and actor3899178 may publish. Coordinator publication accepts manual main only.
- Application checkout must equal the separately supplied full application SHA. Coordinator SHA must be recorded and verified independently; never impersonate the application repository as the workflow repository.
- GHCR package namespace follows the actual publisher repository. Coordinator images link to that repository and also carry required original application-source and coordinator-revision labels.
- Preserve full Linux, 320MiB/no-extra-swap, lifecycle and source-identity acceptance. No image rebuild after acceptance.
- Only publication receives packages:write and the ephemeral GITHUB_TOKEN. Tests and anonymous verification receive no publication token. No new long-lived secret or server build.
- Actual environment protection, package visibility and public digest verification must be established before treating an image as deployable. No production deployment implied by publication.

## Task 1: Trusted context and image provenance

- [x] Add failing tests in deploy/tests/publication.test.mjs for coordinator manual-main admission, invalid actor/repository/event/ref/source/coordinator SHA refusal, CLI environment derivation, build-label environment binding, exact same-image push to the coordinator package, and anonymous verification with required source/coordinator labels.
- [x] Observe expected RED before changing implementation.
- [x] Extend deploy/publication.mjs with an explicit two-repository policy, separate application/coordinator context derivation and validation, and context-specific image target and required provenance labels. Preserve original contracts.
- [x] Extend deploy/ci.sh with guarded coordinator labels. The normal acceptance path retains existing labels; the coordinator publication path requires matching repository and valid coordinator SHA.
- [x] Run the publication tests and complete deploy unit suite. Obtain independent scoped review and address findings.

## Task 2: Reviewed publication workflow and actual runtime evidence

- [ ] Prepare a coordinator workflow pinned to the reviewed application commit, owner/manual-main gate, protected environment, package-writing job and independent read-only anonymous verification job. Keep the initial acceptance-only workflow separate.
- [ ] Validate YAML and review the complete source/coordinator chain and token boundaries before updating the approved coordinator repository.
- [ ] Configure and verify protection without weakening any existing publisher settings. Publish only within the user's approved public-image goal; request any genuinely missing permission with the exact reviewable change.
- [ ] Run the full source-bound Linux/image publication job, retain actual job logs and immutable digest, establish package public visibility, and verify the same image anonymously in the second job.
- [ ] Resume fresh runtime backup, preview-only image rollout and the existing controlled Gmail message/attachment verification. Production web promotion retains all original acceptance gates; Android remains later.

