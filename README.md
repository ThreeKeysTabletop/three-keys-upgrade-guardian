# Three Keys Upgrade Guardian

*By Three Keys Tabletop · Foundry VTT v13–v14 · system agnostic · MIT · free*

Before you update Foundry or your game system, find out which modules will break. Upgrade Guardian scans the world's modules and tells you, for the version you plan to install, what is **Safe**, **Untested**, **Likely to break** or **Blocked**, then helps you get ready: a checklist, an export, and a reversible "disable risky modules" button. GM only.

## Install
Manifest URL: `https://github.com/ThreeKeysTabletop/three-keys-upgrade-guardian/releases/latest/download/module.json`

## Open the report
Game Settings sidebar > **Upgrade Guardian**, or Configure Settings > Three Keys Upgrade Guardian > **Open report**, or a macro: `game.modules.get("three-keys-upgrade-guardian").api.open()`.

## What the badges mean
| Badge | Meaning |
|---|---|
| Safe | The module's `verified` version covers the target. |
| Untested | No `verified` version, verified only for an older build of the same generation, deprecation warnings seen, or a Foundry package warning. |
| Likely to break | Verified only for an older generation (for example verified 13, target 14), or a dependency is at risk or inactive. |
| Blocked | The target is below `minimum` or above `maximum`, a required module is missing or the wrong version, or the module is not for your system or system version. |

A one-part version such as `14` covers the whole generation, as in Foundry.

## Features
- **Target version.** Defaults to the newest release Foundry's update check found when the world launched. Click **Detect latest** to re-check, or type any version (for example `15.330`). Optional target system version checks `relationships.systems` ranges against the system version you plan to install.
- **Module updates.** **Check for module updates** fetches each manifest URL with a timeout (Settings: *Manifest timeout*). It shows the newer version and whether it supports the target. Offline, blocked or slow hosts show *could not check* and nothing else is affected.
- **Dependencies and systems.** `relationships.requires` (missing, wrong version, inactive or itself at risk) and `relationships.systems`.
- **Deprecations (best effort).** Deprecation warnings that appear in the console during this session are counted against the module named in their stack trace. Play for a while, then rescan.
- **Export.** Markdown or JSON download, or Copy as Markdown (paste into a bug report or Discord).
- **Pre-update checklist.** Ticks are saved in the world.
- **Disable modules likely to break.** Shows the active modules marked Likely to break or Blocked with checkboxes. Nothing changes until you confirm. The current module list is saved first; **Restore module list** puts it back. Both ask before reloading.
- **Startup notice.** When a GM logs in, an offline scan warns if active modules are at risk on the target. Turn off in settings.

## Limits
- Compatibility data is whatever each module author declared. Safe is not a guarantee.
- Some manifest hosts do not allow browser requests (CORS). Those show *could not check*, and the browser console may log the blocked request.
- Foundry only reports the latest core release when its update check can reach foundryvtt.com.

## API
`game.modules.get("three-keys-upgrade-guardian").api`: `open()`, `scan({target, targetSystem, remote})`, `toMarkdown(report)`, `problems(report)`, `applyDisable(ids, label)`, `restoreSnapshot(id)`, `evaluate(compat, version)`, `detectLatestCore()`.

## Building
`./build.sh` writes `dist/module.zip` and `dist/module.json`. Pushing a new `version` in `module.json` to `main` publishes a GitHub release (`.github/workflows/release.yml`).

## License
MIT. See LICENSE.
