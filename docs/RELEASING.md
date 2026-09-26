# Publishing and releasing

## Before making the repository public

1. Choose and add a `LICENSE`. MIT is simple and permissive; Apache-2.0 adds explicit patent terms. This is an owner decision and is not selected automatically.
2. Run `npm run check:public` and `npm test`.
3. Confirm `git check-ignore -v secrets.env config.yml` reports both local files as ignored.
4. Review `git diff --cached` before the first commit.
5. Publish privately first, inspect the GitHub file tree, then change the repository to public.

The official repository is [Outlain/ai-intermediary](https://github.com/Outlain/ai-intermediary). Verify the repository and remote before publishing.

## Create a release

The release workflow runs for semantic version tags matching `v*.*.*`:

```sh
npm run check:public
npm test
git tag -a v2.0.1 -m "AI Intermediary v2.0.1"
git push origin v2.0.1
```

The workflow:

1. Repeats publication checks, JavaScript tests, isolated host/ComfyUI bridge tests and machine-credential tooling tests.
2. Builds a Linux `amd64` image with SBOM and provenance metadata.
3. Publishes a versioned image at `ghcr.io/outlain/ai-intermediary` using the workflow's built-in `GITHUB_TOKEN`. Only stable tags also update `latest`; tags containing a prerelease suffix such as `-rc.1` never do.
4. Generates a deployment bundle whose Compose file pins the release image tag.
5. Creates a GitHub Release with generated notes, the bundle, and its SHA-256 checksum. Release candidates are marked prerelease and explicitly excluded from GitHub's latest-release selection.

Publishing is an explicit maintainer action after validation. A source commit
alone does not publish an image or deployment bundle.

## First GHCR release

GitHub Container Registry creates the first package as private by default. After the first workflow publishes it:

1. Open the owner or organization **Packages** page.
2. Open the `ai-intermediary` package.
3. Open **Package settings**.
4. Confirm it is connected to the public repository.
5. Change package visibility to **Public**.

Once public, GHCR permits anonymous pulls and release-bundle users do not need a registry login. GitHub warns that a public package cannot be made private again, so verify the image and metadata before changing visibility.

## Required repository settings

- GitHub Actions must be enabled.
- Workflow `GITHUB_TOKEN` must be allowed to write packages and releases. The workflow requests only `packages: write` and `contents: write`.
- Protect `main` and require the CI workflow before merging once the initial repository is established.

## Release verification

Do not describe a release as published until the workflow has succeeded and its image/bundle are available. A version in source is not itself proof that its release or image exists.

Before release, test both object and ended-review regeneration against the intended Frigate build, confirm live-work priority, verify settings and backlog survive container recreation, and confirm real media-retention failure reporting. Automated mocks exercise protocol and state-machine behavior but do not certify Frigate deployment permissions or ROCm driver recovery. Keep that distinction in release notes.

The source and release Compose templates must retain matching state mounts, security options, settings recovery listener, and bounded logging. Deployment bundles contain examples only: update instructions must preserve users' `config.yml`, `secrets.env`, ignored Compose overrides, and named state volume.

The release bundles the optional `integrations/host` helper and installation guide. Verify its tests and deployment artifacts separately: helper sockets stay local/group-restricted, sudoers permits only the fixed Ollama service operation, application and helper restart budgets persist, maintenance pause is preserved, and no GPU reset/reboot/general command route exists. Neither a source push nor a container update installs host privileges. Host telemetry/recovery remain explicitly opt-in; deployment acceptance on the target AMD driver must verify reported telemetry without deliberately inducing a production GPU fault.
