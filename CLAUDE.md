# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GeoPic is a single-page web application that combines OneDrive photos with Google Maps to display geolocated images on an interactive map.

## Architecture

- **Typescript without webpack**: All code is in `index.html` for the page, `index.ts` for the main logic, `utils.ts` for a few common libraries, `geoitem.ts` for datatype and logic concerning how OneDrive scrapes photos. There's also `test.ts` for prototypes.
- **Minimal dependencies**

## Development Notes

- Build process: `npx tsc` or `npx tsc --watch` to compile TypeScript to JavaScript, and to see type errors.
- Test locally using localhost... (1) One-time setup involves changing mac's built-in Apache web-browser to serve project directory (with `sudo nano /etc/apache2/httpd.conf` which Claude can't do because it requires the user to enter sudo password, and set the DocumentRoot and Directory directvies), then `sudo apachectl restart`. (2) Each debug session can be launched by using VSCode debugger, which allows breakpoints to be hit in VSCode. Or just opening Chrome to http://localhost and use Chrome F2 debugging.
- Test using remote... first have to use VSCode "deploy" task to deploy the files, and then open a browser to https://unto.me/geopic


## Style for Claude's interactions

### All code must be written with a high degree of rigor. That means:
- All non-trivial functions are documented to say what they do, what their input parameter values/types are, what their return is.
- If functions have side effects then those are documented.
- Where useful, function documentation includes explanation of INVARIANTS (pre-conditions, post-conditions, assumptions,
  guarantees).
- When we reason about code, we always check whether our reasoning is valid against the documented INVARIANTS.
  We also check whether our reasoning is valid against the function implementation, just to check whether
  the invariants are still correct.
- When we write code, we add comments to explain whenever code relies upon a documented assumption, or ensures a documented guarantee.

### Be skeptical, not sycophantic
Claude should approach all ideas (both those from the user and those from itself) with skepticism and rigor.
Claude should actively think about flaws: loopholes, potential issues, limitations, invalid assumptions.
If it hasn't thought of any flaws, then it should think harder to try to find some. A good way to find flaws is to think through the code line by line with a worked example.

Claude should avoid complimentary language like "excellent!", "perfect!", "great job!", etc. Instead of praising solutions, focus on:
- Pointing out the list of flaws it has considered, and an assessment of whether each one has been mitigated.
- Questioning the assumptions that went into a solution.
- Being matter-of-fact about what works and what doesn't

Example: Instead of "That's an excellent approach!" say "This approach seems to avoid the naming conflict issue that was identified,
and makes async loading explicit, but at the expense of being non-idiomatic".

### Don't pre-emptively take action on type errors and lints.
- If the user asks "what's wrong?" or "what's the correct way" -- explain the solution WITHOUT implementing it.
  Only change files if the user explicitly asks you make a change.
- In all cases Claude should inform itself of typecheck and lint errors so it's aware of them.
  However, it shouldn't always take action...
- If Claude is introducing new code, it should learn whether the new code has introduced
  new typecheck errors or lint errors. It must make a context-specific judgment call whether these
  new errors are expected and should be left for the human to interactively fix,
  or if Claude's new code was defective and should be tried again.
- If Claude's work reveals underlying issues that pre-existed, including issues that were pre-existing
  but weren't yet being reported, Claude should NEVER proceed to fix them by itself.
- The general principle is that the type system of a project is the single most important
  part of its architecture. Any changes to the type system require careful peer review
  with a human.

## Brainstorming vs Implementation

When the user is:
- Describing problems or observations
- Asking "how could we..." or "what if we..." or "let's think about" questions
- Sharing performance data or analysis
- Discussing tradeoffs or approaches

DO NOT immediately start implementing solutions. Instead:
- Be skeptical, think about flaws, and point them out if you see them
- Suggest your own different ideas
- Think further about considerations/problems/issues/concerns that haven't yet been raised.
- Wait for explicit instruction to proceed with implementation

Only take action when the user gives clear implementation instructions like:
- "Please implement..."
- "Go ahead and..."
- "Could you please..."

If you are unclear whether the user has given explicit go-ahead, then ask them:
- "Shall I ...?"

## Code style

I prefer clean documented minimal code. That means:
- If a helper is only called by a single callsite, then prefer to inline it into the caller
- If some code looks heavyweight, perhaps with lots of conditionals, then think harder for a more elegant way of achieving it.
- Code should have comments, and functions should have docstrings. The best comments are ones that introduce invariants, or prove that invariants are being upheld, or indicate which invariants the code relies upon.
- Prefer functional-style code, where variables are immutable "const" and there's less branching. Prefer to use ternary expressions "b ? x : y" rather than separate lines and assignments, if doing so allows for immutable variables.

## TODO
- Implement the histogram + filter UI currently described in test.ts
- Sort out the thumbnail display. Hopefully use a pool of items, maybe even re-using an existing element if it's still needed?
- Switch to OAuth2 Code Flow with PKCE (based on the sample in oauth2-notes.txt). We'll probably verify that refresh token works during page load, so that if subsequent fetches fail then they can be retried purely through javascript without needing redirection. And probably make a helper function "fetchAsync" which fetches/stores in local storage, manages refresh, and also has a global pause so that other requests queue up while waiting for refresh to finish. I wonder if the validator will have to live for the duration of the page, in case we need subsequent refresh?
- find a source of 1000 free images from around the world, maybe of tourism or animals. See if I can strip their thumbnails of exif metadata and use lossy compression and low resolution, with a target of <1k per dataUrl. Maybe from https://commons.wikimedia.org/wiki/Category:Media_with_locations or from https://www.pic2map.com/random.php
- Change markers in the map to be square. I'd like to prove out that if tiles are roughly square, and markers are roughly square, and markers are shown at the center of each tile, then it looks like a heatmap. Change the "image count" tag to not look like a notification; it should be more subtle
- If I zoom out all the way, then sw.lng and ne.lng are meaningless since the view wraps. I wonder if I can recognize this from lat and switch to a hard-coded division of some sort? probably using the map's zoom-level.
- In postProcessBatchResults(), if we got a redirect fetch which failed, then it crashes with an unhandled promise failure. Also of course generateImpl might run into access token expiration, and it currently raises an uncaught FetchError.
- When you click "Sign in to index..." then it should proceed to do the work after signin
- Click-to-zoom on the map while ingesting is too slow. Should disable click-to-zoom during this phase.
- Normalize the instruct() text.