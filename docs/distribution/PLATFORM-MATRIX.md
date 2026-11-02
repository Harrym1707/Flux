# Platform support matrix

An honest statement of what FLUX runs on. The rule governs the rest:

> **Never advertise a platform on the website until it is tested.**

The website is where users decide to pipe real API traffic through FLUX. A
platform claim there is a promise. We list a platform only once the install path
and the always-on service have actually been exercised on it.

## Matrix

| Platform | Arch | Install | Always-on service | Status |
|---|---|---|---|---|
| macOS | arm64, x64 | script install (`install.sh`) | launchd agent | **supported / tested** |
| Linux | x64, arm64 | script install (`install.sh`) | systemd service | **planned** |
| Windows | x64 | PowerShell installer | Windows Service | **not yet** |

## macOS — supported / tested

The only platform the always-on path is wired for today. `flux install` writes a
launchd agent at `~/Library/LaunchAgents/dev.fluxtoken.flux.plist` that runs
`flux serve`, and explicitly refuses on any other platform
(`packages/cli/src/daemon.ts:26-32,87-109`). `flux start` (the foreground path)
is platform-agnostic and works anywhere Node runs, but the advertised,
service-backed experience is macOS-only right now. Both arm64 and x64 are
covered.

## Linux — planned

The script installer (`docs/site/install.sh`) already works on Linux — it only
needs Node and `curl`, and puts `~/.flux/bin` on `PATH` via the user's shell
profile. What is missing is the always-on service: `flux install` has no systemd
unit and will refuse (`daemon.ts:26-32`). Until a systemd equivalent of the
launchd agent is written and tested, Linux users get `flux start` only, and Linux
is not advertised as supported on the website.

Work to promote Linux to supported:
- a systemd user service equivalent to `writePlist` (`daemon.ts:87-109`),
- the `flux install` / `uninstall` / `status` paths taught to drive systemd,
- an actual test run on x64 and arm64.

## Windows — not yet

Nothing is wired. Promoting Windows needs, at minimum:
- a **PowerShell installer** (the `sh` installer does not run natively),
- a **Windows Service** equivalent of the launchd agent,
- a **code-signing certificate** so the download and service are not flagged by
  SmartScreen / antivirus — an unsigned binary asking to carry an API key is a
  non-starter.

Windows is not advertised and `flux install` refuses there, same as Linux.

## Relationship to signing and runtime policy

When native binaries arrive (see `RUNTIME-POLICY.md`'s bundled-runtime track),
each platform/arch gets one signed binary published to GitHub Releases, not
committed to git (`RELEASE-SIGNING.md`). The matrix above is then also the list
of binaries a release builds — and the same rule holds: a binary is not linked
from the website until it has been tested on that platform.
