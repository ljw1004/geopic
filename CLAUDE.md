# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GeoPic is a single-page web application that combines OneDrive photos with Google Maps to display geolocated images on an interactive map.

## Architecture

- **Typescript without webpack**: All code is `index.ts` and `index.html`. (There's also `test.ts` for development-time testing; it will be deleted). The typescript files get turned into js, which is included via script tags.
- **External dependencies**: Loaded via CDN (Google Maps API, MarkerClusterer)
- **OneDrive integration and authentication**: Uses Microsoft Graph API for photo access. Uses OAuth2 token flow with redirect back to index.html

### OneDrive Authentication
- Client ID: `e5461ba2-5cd4-4a14-ac80-9be4c017b685`
- OAuth2 redirect flow returns to index.html with access token in URL hash
- Access token stored in global `ACCESS_TOKEN` variable

### Data Structure
- `geo.json` format: `[{id, lat, long, date}, ...]`
- Coordinates rounded to 5 decimal places
- Stored in user's OneDrive Pictures folder

### Google Maps Integration
- Script tag already included for MarkerClusterer
- Needs Google Maps API key to be added
- Will use AdvancedMarkerElement for photo markers

## Development Notes

- Build process: `tsc` or `tsc --watch` to compile TypeScript to JavaScript
- Test by running the build, then opening https://unto.me/geopic in a browser; use F12 debugging within the browser to debug.
- OneDrive integration can never be done locally; it must done via that url on that domain.

## Check Type Definitions
When encountering type errors or uncertainty about external library APIs:
1. Read the relevant `.d.ts` files in `node_modules/` before guessing at usage
2. For imports like `import { X } from '@some/library'`, check `node_modules/@some/library/dist/*.d.ts`
3. This codebase uses minimal dependencies, so reading type definitions is feasible and expected

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
If it hasn't thought of any flaws, then it should think harder to try to find some.

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
  but weren't yet being reported, Claude should proceed to fix them by itself.
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

## Current Status & Next Steps

### Recently Completed
- Implemented first version of a faster batched+concurrent+cached "walk" algorithm in test.ts testWalk()

### TODO
- Improve the testWalk() component: (1) handle failure, particularly rate-limiting on the thumbnail fetch requests, (2) display progress, (3) handle ACCESS_TOKEN expiry
- Figure out realistic numbers for the entire cache strategy - in particular, total size for 60k photos, download time, google-maps-populate time
- If it all works, then switch the product over to use the testWalk approach.
- Add a sidebar for filtering, and change the map to fill the entire UI