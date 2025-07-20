# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GeoPic is a single-page web application that combines OneDrive photos with Google Maps to display geolocated images on an interactive map.


## UI design

1. A main page with (1) text title/instructions, (2) google map showing photos clusters/thumbnails, (3) timeline histograph of how many photos were taken on which day/time, (4) text filter
   that combines "navigate to placename" (with Google Place autocomplete) and "filter photos", (5) thumbnail area, in case the map had multiple photos under a cluster
2. An overlay used for (1) full-window display of photos/videos with buttons for left/right, metadata, full-screen button, close button, (2) also used for full-window error messages.

## Architecture and development

- Its architecture is typescript without webpack. The `index.html` contains all HTML and CSS for the main page and overlay. Code is in `index.ts` plus a few other typescript files.
- This is a minimal-dependency project.
- Build process: `npx tsc` or `npx tsc --watch` to compile TypeScript to JavaScript, and to see type errors.
- Test locally using localhost... (1) One-time setup involves changing mac's built-in Apache web-browser to serve project directory (with `sudo nano /etc/apache2/httpd.conf` which Claude can't do because it requires the user to enter sudo password, and set the DocumentRoot and Directory directvies), then `sudo apachectl restart`. (2) Each debug session can be launched by using VSCode debugger, which allows breakpoints to be hit in VSCode. Or just opening Chrome to http://localhost and use Chrome F2 debugging.
- Test in production by using the "deploy" task to deploy to http://unto.me/geopic, then open a browser to https://unto.me/geopic


## Codebase style and guidelines

All code MUST be written with a high degree of rigor:
- All functions are documented to say what they do, what side effects they have in any
- All state variables MUST be documented with INVARIANTS. Every function's comments MUST explain which
  invariants the function is assuming, and which ones it establishes/upholds, and how,
- When we do code review, we always review by checking it against invariants.
- When we write code, we add comments to explain whenever code relies upon a documented assumption, or ensures a documented guarantee.

IMPORTANT: Claude MUST ALWAYS evaluate code with skepticism and rigor.

- IMPORTANT: Claude MUST ALWAYS look for flaws, bugs, loopholes, in what the user writes and what Claude writes.
- IMPORTANT: instead of saying "that's right" to a user prompt, Claude must instead ultrathink to find flaws, loopholes, problems,
  and question what assumptions went into a question or solution.
- A good way to find flaws is to think through the code line by line with a worked example.

Example: instead of saying "That's right!" say "This approach seems to avoid {problem-we-identified} but what
a flaw is that it is non-idiomatic, and it hasn't considered the edge case of {counter-example}."

Coding style: All code must also be clean, documented and minimal. That means:
- If a helper is only called by a single callsite, then prefer to inline it into the caller
- If some code looks heavyweight, perhaps with lots of conditionals, then think harder for a more elegant way of achieving it.
- Code should have comments, and functions should have docstrings. The best comments are ones that introduce invariants, or prove that invariants are being upheld, or indicate which invariants the code relies upon.
- Prefer functional-style code, where variables are immutable "const" and there's less branching. Prefer to use ternary expressions "b ? x : y" rather than separate lines and assignments, if doing so allows for immutable variables.


## Claude interaction rules

- IMPORTANT. Claude MUST give advice only (no code edits) in response to user questions.
  Example: "what's wrong" or "what's the correct way" or "how could we fix" are brainstorming questions
  and should only result in advice. On the other hand, "please fix it" or "please implement"
  or "go ahead" are explicit user asks and should result in code edits.
- Typecheck errors are like an automatically-maintained TODO list:
  - The type system of a project is so important that it should only be changed by a human, or under explicit human construction.
    A human MUST be asked for any changes to inheritance, adding or removing members to a class or interface,
    or creating new types.
  - If Claude made changes that revealed pre-existing typecheck errors, then Claude must leave them for now and the user will decide later when and how to address them.
  - If Claude made changes where there were errors due to a mismatch between new code and existing code, then Claude should again leave them for the user to decide.
  - If Claude made changes where the new code has typecheck errors within itself, then Claude should address them immedaitely.

## TODO
- Zoom out still isn't working
- Browser back navigation while overlay is up should dismiss the overlay
- left+right cursor keys to scroll overlay
- Verify app. Once my MPN account is set up, (1) Azure Portal > App Registrations > My App > Branding & Properties > Publisher Domain that matches MPN account email domain. (2) Branding & Properties > add a verified publisher > MPN ID > verify and save.
- Overhaul the histogram/map interaction, so they feel more natural: user's work isn't overridden, and less panning is needed. Alsol I think nothing (zoom, selection, filter-text) need be saved nor reestored upon page reload.
