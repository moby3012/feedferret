# Contributing to FeedFerret

Thank you for your interest in contributing! FeedFerret is open-source under the AGPL-3.0 license.

## How to Contribute

1. **Fork** the repository and create your branch from `main`.
2. **Make your changes** — keep PRs focused on a single concern.
3. **Run the checks** before opening a PR:
   ```bash
   pnpm run lint
   npx tsc --noEmit
   pnpm run build
   ```
4. **Open a pull request** against `main` with a clear description of what and why.

## Contributor License Agreement (CLA)

By submitting a pull request you agree that:

- Your contribution is your original work and you have the right to license it.
- You grant the FeedFerret project owner a perpetual, worldwide, non-exclusive, royalty-free license to use, modify, and distribute your contribution — including in commercial versions offered under a separate license.
- Your contribution is licensed to all other recipients under the AGPL-3.0 (the same license as the project).

This CLA is required so the project can offer a commercial license to organizations that cannot comply with the AGPL, without relicensing every contributor's code individually.

## Code Style

- TypeScript strict mode — no `any` without justification.
- No comments unless the *why* is non-obvious.
- Keep components focused; prefer small, composable functions.
- Follow the existing file and folder conventions.

## Reporting Issues

Use the GitHub Issue Templates:
- **Bug report** — steps to reproduce, deployment type, version, logs.
- **Feature request** — problem, proposed solution, alternatives.

## License

FeedFerret is licensed under the [GNU Affero General Public License v3.0](LICENSE). Any contribution you make is subject to the same license.
