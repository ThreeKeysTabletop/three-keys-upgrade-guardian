# Changelog

## 1.0.0 — 2026-10-30
- First release for Foundry VTT v13–v14 (verified 14.369), system agnostic (tested with dnd5e 5.3.3). GM only.
- Report window: every module (and the game system) with its minimum / verified / maximum compatibility, judged against the current core and a target core version. Badges: **Safe**, **Untested**, **Likely to break**, **Blocked**.
- Target version defaults to the newest core release Foundry's own update check reported (or the newest stable generation, or an optional release API URL); otherwise type one in.
- Module update check: fetches each manifest URL (with a timeout, offline safe) and shows whether a newer version exists and whether it supports the target.
- Dependency and system checks from `relationships.requires` and `relationships.systems`, including version ranges and an optional target system version.
- Best-effort deprecation tracking: deprecation warnings logged during the session are attributed to the module or system in their stack trace.
- Export as Markdown or JSON, or copy Markdown to the clipboard.
- Pre-update checklist and **Disable modules likely to break**: proposes a list, changes nothing until the GM confirms, and saves a restorable snapshot of the module list (last 10 kept).
- Optional startup notice when the offline scan finds problems.
