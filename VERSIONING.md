# Version management

Update versions for each completed group of application changes, once per group.

- Bug fixes: increment the patch version (0.1.1 → 0.1.2).
- New features: increment the minor version (0.1.1 → 0.2.0).
- Breaking changes: agree on the version with the user before release.
- Keep package.json and the root package versions in package-lock.json identical.
- Record changes in CHANGELOG.md. Documentation-only edits do not require a bump.
- Release tags use v followed by the package version (for example, v0.1.1).
- Creating tags or publishing releases requires a user request.

The current group is treated as a patch release because it repairs existing image download and bass booster features.
