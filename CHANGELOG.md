# Changelog

## 0.1.2 — 2026-10-08

- Bass capture no longer explicitly unmutes the original tab when processed playback becomes active, preserving local echo suppression.
- Disabled capture echo cancellation, noise suppression, and automatic gain control for music playback.
- Runtime sound quality still requires listening verification; no tests were run.

## 0.1.1 — 2026-10-08

- Image downloads use the page session and report download failures.
- The image downloader supports a remembered destination folder and avoids overwriting existing files.
- Bass boost uses one low-shelf filter with input attenuation, a 0–6 dB range, and a 60–100 Hz range.
- Added gentle bass presets: Finom, Mély, and Erősebb.

These changes have not been verified with automated tests or runtime listening/download checks.
