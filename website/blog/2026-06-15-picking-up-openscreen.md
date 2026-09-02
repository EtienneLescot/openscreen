---
title: Picking up OpenScreen
description: The original repo was archived after v1.5.0. I forked it, kept the name and the MIT license, and moved it to a new home.
authors: [etienne]
tags: [announcement]
image: /img/og-image.png
---

The last commit on [siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) landed on June 6, 2026. It bumped the Nix package to v1.5.0. Then the repo went read-only, like the README had been warning it would for a while. 39k stars, and v1.5.0 as the final release.

I picked it up on June 15, with the original author's approval. Same name, same MIT license, new URL. This post starts a journal of what happens next.

<!-- truncate -->

## Where it lives now

[github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen). It started as a personal fork and moved under the `getopenscreen` org in the first week. It stays there.

The archived original is still online and still read-only. Every commit of it is in this repo's history.

I tagged v1.5.0 on day one with no code changes at all. Same code, same installer, same version number. It only exists to prove the release pipeline works on my infrastructure before anything real ships through it. v1.6.0 is the first release with new work in it.

## What I'm committing to

Forking a popular archived project is a good way to quietly turn it into something else. So, written down where you can hold me to it:

- Free forever, MIT. No paid tier, no premium features, no usage caps. Nothing is gated on who you are.
- Stability before features. The recorder has to work on macOS, Windows and Linux. Bugs from real users go first.
- It's not production-grade, and I'll keep saying so. Expect rough edges and breaking changes, including to the project format.

The [roadmap](https://github.com/getopenscreen/openscreen/blob/main/ROADMAP.md) is public: record, edit, export, plus an optional AI editing layer that's off by default and never required. There's a [Discord](https://getopenscreen.com/discord) with a roadmap channel if you want to argue about any of it.

## It already had contributors

Four days in, before I'd shipped anything, someone I'd never met opened [a fix for exports stalling](https://github.com/getopenscreen/openscreen/pull/4) when trim regions leave long decoder gaps. Real bug, correct diagnosis, regression test included.

That's roughly what the job turned out to be. Very little of it is features. Mostly it's release candidates that mean something, CI that fails loudly, and diagnostics for the parts that break on other people's machines. Native capture on Windows and macOS is as finicky as its reputation.

I'll write up what ships and what breaks here. Next: v1.6.0 and v1.7.0.
