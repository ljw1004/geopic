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

## Caching Design (To Be Implemented)

### Overview
To improve performance from ~15 minutes to seconds, we will cache geo data for each folder using OneDrive's app folder feature.

### Cache Storage
- Location: `/Apps/GEOPIC/cache/` (using OneDrive app folder via `/drive/special/approot`)
- File naming: Sanitized folder path, e.g.:
  - `Pictures.json` for the Pictures folder itself
  - `Pictures-2023.json` for Pictures/2023/
  - `Pictures-2023-Summer.json` for Pictures/2023/Summer/

### Cache File Structure
```json
{
  "folderMetadata": {
    "id": "folder-drive-id",
    "size": 123456789,
    "lastModifiedDateTime": "2024-01-15T10:30:00Z",
    "cTag": "ctag-value", 
    "eTag": "etag-value"
  },
  "geoItems": [
    {
      "position": {"lat": 37.422, "lng": -122.084},
      "date": "2023-06-15T14:30:00Z",
      "thumbnailUrl": "...",
      "webUrl": "...",
      "aspectRatio": 1.33
    }
  ]
}
```

### Caching Strategy
1. **Redundant storage**: Each folder's cache contains ALL photos from its entire subtree
   - A photo in A/B/c.jpg appears in caches for both A/ and A/B/
2. **Validation**: Primary check is folder size; if unchanged, entire subtree is valid
3. **Scanning algorithm**:
   - Start with top-level folders
   - If folder size matches cache, use cached data and skip all subfolders
   - Only scan folders whose size has changed
   - After scanning a changed folder, update its cache AND all ancestor folder caches

### Queue-Based Implementation Design

#### Work Queue Architecture
Uses a queue-based approach with state machine work items to enable batching and clean separation of concerns.

#### Work Item Types
```javascript
type StartFolderWorkItem = {
  type: 'START_FOLDER',
  folderId: string,
  path: string[],
  state: 
    | { phase: 'NEED_CHILDREN' }
    | { phase: 'NEED_CACHE', children: DriveItem[], folderMetadata: Metadata }
    | { phase: 'READY', children: DriveItem[], folderMetadata: Metadata, cache?: CacheData }
}

type EndFolderWorkItem = {
  type: 'END_FOLDER', 
  folderId: string,
  path: string[],
  state:
    | { phase: 'NEED_THUMBNAILS_AND_WRITE', cacheData: CacheData }
    | { phase: 'DONE' }
}
```

#### Processing Algorithm
1. **Main Loop**: While queue has items:
   - First try local computation (process READY items)
   - Otherwise batch up to 20 API calls
   - Update work items with responses and requeue

2. **API Operations** (only 3 types needed):
   - `GET /me/drive/items/{folderId}/children?$expand=thumbnails&select=...` - Gets both folder metadata AND children
   - `GET /me/drive/special/approot:/cache/{filename}:/content` - Read cache
   - `PUT /me/drive/special/approot:/cache/{filename}:/content` - Write cache

3. **Key Invariants**:
   - Every START_FOLDER will eventually be followed by END_FOLDER
   - END_FOLDER only executes after all child END_FOLDER operations complete
   - After END_FOLDER completes, both OneDrive cache and in-memory cache contain folder's subtree data
   - Work items are immutable - we create new items with updated state

4. **Thumbnail Data URL Processing**:
   - END_FOLDER NEED_THUMBNAILS_AND_WRITE phase extracts all thumbnail URLs from cacheData
   - Concurrently fetches data URLs (limit ~10 concurrent to respect browser connection limits)
   - Updates cacheData with data URLs, then writes cache and transitions to DONE
   - TODO: Add retry logic for failed thumbnail fetches
   - TODO: Handle individual thumbnail failures (skip items vs fail folder)
   - TODO: Make concurrency limit configurable

5. **Dependency Tracking**:
   - Track pending children for each folder
   - Only queue END_FOLDER when pendingChildren count reaches zero

6. **Microsoft Graph Batch API**:
   - Bundle up to 20 requests per batch call
   - Heterogeneous batches are supported (mixing different operation types)
   - See `testBatch()` in test.ts for sample implementation and important post-processing steps

7. **Implementation References**:
   - `testCache()` in test.ts: Shows how to read/write to OneDrive application-local cache
   - `testBatch()` in test.ts: Demonstrates Graph Batch API usage, heterogeneous calls, and response processing
   - These functions contain key learnings and patterns to reference during implementation
