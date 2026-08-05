# Fission Optimiser for Monifactory's Nuclearcraft

Try it out: https://messiah7.github.io/Monifactory-Fission-Opt/

Fork of [tadyen/Monifactory-Fission-Opt](https://github.com/tadyen/Monifactory-Fission-Opt), which is itself a hard fork of [leu-235](https://leu-235.com/) by [cyb0124](https://github.com/cyb0124) — [view original source](https://github.com/cyb0124/FissionOpt).

Modified rules to work with [NuclearCraft Neoteric](https://github.com/igentuman/NuclearCraft-Neoteric).

**Probably updated for Monifactory 1.36.7** — fuel values and default cooler/moderator limits in this fork have been adjusted to match that version. As always, double-check the generated design's numbers against the in-game reactor controller before committing to a build.

## Changes from upstream (tadyen's fork)

- English tooltips added throughout (Step 1 core dimensions, Step 5 options, Custom Targets table)
- Fuel presets limited to the isotopes currently obtainable in-progression; unavailable presets (Cm/B/Cf-series) are commented out rather than removed, so they can be restored later
- Updated fuel Base Power / Base Heat values
- Default `Max Allowed` in Step 3 restricts coolers to Lapis, Enderium, Tin and Manganese, with everything else (including moderators) set to `0` by default, since moderators are disabled in this pack
- Fixed a CSS typo (`.Nt` → `.Nr`) so the Netherite cooler column renders with its intended color

<details>
<summary>⚠️ Upstream note from tadyen (kept for reference) ⚠️</summary>

> ⚠️ OUTDATED WARNING ⚠️ ([#2](https://github.com/tadyen/Monifactory-Fission-Opt/issues/2))
>
> I haven't had the time lately to patch for upstream changes into Monifactory's updates on NCN.
> This calculator is currently supported until Monifactory < 0.12.0
> I've been seeing a bit of interest on it still despite being slated for depreciation.
> Do write issues, (or send PRs) - I might find time to fix this up!

</details>
