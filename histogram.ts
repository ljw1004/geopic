import { Numdate, OneDayTally, Tally } from "./geoitem";


const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type InclusiveDateRange = { start: Numdate, end: Numdate };

type HistogramBarInfo = {
    granularity: 'days' | 'weeks' | 'months';
    bounds: InclusiveDateRange; // in months view, this is from the 1st of the first bar to the 31st of the last bar
    bar: (date: Numdate) => number;  // bar number for this date (also works for out of range bars)
    left: (date: Numdate) => number;  // pixel coordinate of the left edge of the bar encompassing this date
    width: number;  // pixel width of each bar    
    find: (bar: number) => Numdate; // finds the start date for the bar (also works for out of range bars)
    count: number; // number of bars in the histogram
    snap: (date: Numdate) => Numdate; // snaps a date to the sentinel date for its bar
}

/**
 * Converts a number in YYYYMMDD format to a Date object.
 */
function numToDate(yyyymmdd: number): Date {
    const year = Math.floor(yyyymmdd / 10000);
    const month = Math.floor((yyyymmdd % 10000) / 100) - 1; // Month is 1-indexed in YYYYMMDD, but 0-indexed in Date
    const day = yyyymmdd % 100;
    return new Date(Date.UTC(year, month, day));
}

/**
 * Converts Date object to a number in YYYYMMDD format
 */
function dateToNum(date: Date): Numdate {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1; // Month is 0-indexed in Date, but 1-indexed in YYYYMMDD
    const day = date.getUTCDate();
    return year * 10000 + month * 100 + day;
}

/**
 * Calculates the number of days between two (inclusive) dates in YYYYMMDD format
 */
function dayInterval(range: InclusiveDateRange): number {
    return (numToDate(range.end).getTime() - numToDate(range.start).getTime()) / (1000 * 60 * 60 * 24) + 1;
}

/*
 * Calculates the number of months between two (inclusive) dates in YYYYMMDD format. e.g.
 * monthInterval(2025-01-01, 2025-01-15) === 1  // because it's inclusive, and both are 2025-01
 * monthInterval(2025-01-31, 2025-02-01) === 2
 */
function monthInterval(range: InclusiveDateRange): number {
    const [startYear, startMonth] = [Math.floor(range.start / 10000), Math.floor((range.start / 100) % 100)];
    const [endYear, endMonth] = [Math.floor(range.end / 10000), Math.floor((range.end / 100) % 100)];
    return (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
}

/**
 * If the range doesn't cover at least minimum days, expands it.
 * We'll expand the range centered, shifting end date forwards one day at a time
 * and start date backwards, until the range covers at least minimum days.
 */
function expandToMinimum(range: InclusiveDateRange): InclusiveDateRange {
    const minimumDays = 7;
    function diff(start: Date, end: Date): number {
        return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    }
    const [start, end] = [numToDate(range.start), numToDate(range.end)];
    while (true) {
        if (diff(start, end) + 1 >= minimumDays) break;
        start.setDate(start.getDate() - 1);
        if (diff(start, end) + 1 >= minimumDays) break;
        end.setDate(end.getDate() + 1);
    }
    return { start: dateToNum(start), end: dateToNum(end) };
}

/**
 * HISTOGRAM DESIGN PRINCIPLES
 * 
 * This model defines the interaction between the map, histogram and text-filter. These are the principles:
 * 1. All three surfaces (map, histogram, filter-text) are places where the user does filtering work.
 *    The user's work on the map is pan/zoom to find an area. The work on the histogram is making/adjusting
 *    a selection (not pan/zoom). The work on the text is typing a search term. They often iterate through
 *    all three forms of work.
 * 2. We must never erase a user's work. However, we deem that when the user releases their mouse button
 *    in the click-drag act of making a histogram selection, then the user has themself erased their map
 *    work of panning/zooming.
 * 3. We will strive to "autosuggest" a user's next iteration of filtering work, a way of offering context or suggestions.
 *    If the user pans/zooms the map, the context/suggestion we make is to pan/zoom the histogram to the smallest
 *    time range that contains all photos in the map viewport. If the user makes a selection on the histogram,
 *    the context/suggestion we make is to pan/zoom the map to contain all the photos in the selection.
 *    However, we don't use the text box as a place to provide context, and we don't offer context/suggestions
 *    in response to the user typing in the text box, since that's not a reliable enough signal.
 * 4. The histogram will always offer full context: if the user zooms out far enough, they'll see every photo in
 *    the database represented in the histogram. It uses color: grey for all photos, but blue if a photo is
 *    within the current map viewport, and yellow if it matches a filter.
 * 5. The map will offer only filtered results: it will only show photos that (1) are within map bounds, (2)
 *    pass the histogram selection filter if any, (3) pass the text filter if any.
 * 6. We prioritize simplicity and predictability. We avoid creating novel non-standard interactions on the
 *    map (like drawing a map selection box). We think that selecting in the histogram is familiar, much like
 *    selecting text in a text editor.
 * 7. We might choose to have have additional context: "Geopic. 65500 photos (5 visible, 100 hidden)". These
 *    numbers are already implied by the histogram when fully zoomed out, but might be useful. We'll place
 *    them for now along with the title at the top left of the page.
 *
 * From these principles we derive that there must be two modes!
 * 1. Map-led exploratory mode. This is defined as whenever the histogram lacks a selection. The user will
 *    be panning and zooming the map. We will autosuggest by panning/zooming the histogram to encompass all
 *    items in the map viewport. Data-flow is one-way `map -> histogram`. Note that if the user pans/zooms
 *    the histogram in this mode, that is considered a temporary inspection rather than work, and will be
 *    lost next time the user pans/zooms the map. When the user makes a selection, we enter filtering mode.
 * 2. Filtering mode. This is defined as whenever the histogram has a selection. The user will be adjusting
 *    the selection and panning/zooming the map. We will autosuggest by automatically panning/zooming the
 *    map to match the selection, dataflow `histogram -> map`, but we can only do this up until the user's
 *    first pan/zoom of the map, after which point we can't automatically move it, dataflow `none`. When the
 *    user deselects their selection, we revert to map-led exploratory mode. We'll introduce one minor nit
 *    here. You might think that  by reverting to map-led exploratory mode then the histogram should
 *    automatically pan/zoom to reflect what's in the viewport. But that's not right, because it wouldn't
 *    be the right opportunity to make an autosuggestion. We'll only make this autosuggestion in response
 *    to the user's first pan/zoom of the map. This will also feel less jarring.
 * 3. Changes to the text filter will not influence either form of autosuggestion. That's because while I
 *    trust that date and geolocation of photos are universal and continuous properties, I think that text
 *    terms are sparse and discontinuous. When a text filter is cleared, all that does is remove yellow
 *    highlights from the histogram and show more photos on the map; it doesn't alter the histogram or map.
 *
 * USER SCENARIOS
 * 
 * These scenarios are used to test the robustness of the interaction model. They focus on the user's goal
 * and mental model, not the implementation.
 * - Scenario 1: The "Reminiscing" Query.
 *   - Goal: "We were just talking about our trip to Italy. I want to pull up the photos from that trip to show everyone."
 *   - User Intent: The user thinks of an event as a whole ("Italy trip"). They want to see all photos associated with it,
 *     likely starting with a location they remember.
 * - Scenario 2: The "Specific Moment" Hunt.
 *   - Goal: "I'm looking for that one photo of the sunset over the Grand Canyon. I think we were there in the fall of 2021."
 *   - User Intent: The user has a specific image in mind and uses partial information (a famous place, an approximate time)
 *     to narrow the search.
 * - Scenario 3: The "Rediscovery" Journey.
 *   - Goal: "We stopped at a beautiful little town on our drive through the Alps a few years ago, but I can't remember its name.
 *     I want to trace our route to find it."
 *   - User Intent: The user's memory is spatial and sequential. They want to follow a path and browse visually to jog their memory.
 * - Scenario 4: The "Then and Now" Comparison.
 *   - Goal: "I want to find a photo of our house right after we bought it, and another one from this year to see how the
 *     garden has changed."
 *   - User Intent: The user needs to isolate a single location and then pinpoint two distinct moments in time associated with it.
 * 
 * HISTOGRAM API DESIGN
 * 
 * Construction
 * - constructor(container: HTMLElement)
 *   This sets up the histogram component, creating subsidiary elements as needed, and reads state from localStorage.
 *   It will use the container's offsetWidth and offsetHeight.
 *   All other options will be hard-coded; it will use hard-coded CSS identifiers and styles.
 *   It doesn't yet display any data!
 * 
 * State
 * - selection: {start: Numdate, end: Numdate} | undefined  // the date-range the user has selected
 * - bounds: {start: Numdate, end: Numdate}   // the date-range currently visible
 * - fullRange: {start: Numdate, end: Numdate}  // the full date-range of the data
 * - All three are private. They're persisted to localStorage, and read by the component upon construction.
 *   (The only way for callers to learn about the selection is on the onSelectionChange event).
 * - data: Tally | undefined
 *   This private state is set by setData(). It lives only in memory (not persisted to localStorage).
 *   It's present so that as the user zooms the histogram, the DOM elements can be recomputed.
 * - currentDrag: ...
 *   This is a private state used to track the current drag operations. We needn't go into details here.
 * 
 * Public methods and events
 * - onSelectionChange(selection: {start:Numdate, end:Numdate} | undefined): void
 *   When user makes an selection by clicking and dragging on the histogram, this event is fired
 *   when the drag is released. When the user updates the selection by dragging an edge of an
 *   existing selection, this event is fired during the drag (and hence not on release).
 * - setData(data: Tally): void
 *   If tally's range differs from fullRange then we might update 'bounds' and 'selection' (the precise
 *   logic is subtle and not worth documenting; it satisfies the goal of remembering the user's selection
 *   if possible even in the common case that new photos are added past the end date, but also updating bounds
 *   to reflect the new end date.)
 *   It updates the 'fullRange'. And if selection is undefined, it also updates 'bounds' appropriately.
 *   Updates the 'data' state. Recomputes all DOM elements as needed.
 *   If the tally contained no datapoints, then we set tally to 'undefined'.
 * 
 * Appearance and behavior
 * - The histogram will display one bar per day if the current bounds would cause 100 or fewer bars,
 *   otherwise it displays one bar per month. (Therefore, as the user zooms in and out, the histogram will
 *   switch between months and days). In month mode each bar uses the sum of tallies for all days in that month.
 *   Each bar is colored according to the tallies on that date (or sum of tallies on that month).
 *   The details are unimportant for now, but in general a bar might be made
 *   up of stacked vertical parts: blue (relating to inBounds tallies), grey (relating to outBounds tallies),
 *   yellow (relating to inFilter tallies).
 *   However, if data is undefined, then no DOM elements will be visible.
 * - We use DOM element pooling for the bars, so they don't need to be recreated every time.
 * - If selection is defined, the histogram displays a selection rectangle, a semi-transparent overlay.
 *   If we are in months view, the visual selection rectangle is rounded to the full encompassing month
 *   (even while the exact value of the 'selection' property might have its start or end land in the middle of a month);
 *   the user will have to zoom into day-view to see the exact boundaries of the selection.
 *   The edges of the selection have a few-pixel-wide draggable area. When the user hovers over them,
 *   (1) the mouse pointer changes to a "horizontal resize" pointer, (2) the vertical edges are colored
 *   slightly more intensely, (3) two small tooltips appear, like little flags attached to each edge,
 *   showing the start and end dates of the selection. These three behaviors also apply while the user
 *   is adjust-dragging a selection edge, or new-dragging a new selection.
 *   The selection may be clipped, and its draggable edges may be out of bounds.
 * - When the user hovers over any part of the chart that isn't a draggable edge, a thin black vertical
 *   line appears centered on the bar and the full height of the bar area, and it has a tooltip under
 *   it (in the label area) showing the date of that bar.
 * - When the user uses the mouse wheel, it zooms the bounds in and out centered on the cursor position,
 *   with maximum zoom levels according to limits from the current 'data' field (or has no effect if 'data'
 *   is undefined). Fully zoomed in is seven days. Fully zoomed out is the full range of dates in the
 *   'data.tally' field, or seven days, whichever is larger. In future zooms will be accompanied by
 *   a brief 100-200ms animation, but for now they'll be instantaneous.
 * - When the user clicks and drags while holding down Space then this is a pan:
 *   the bounds will be updated while the user drags. No events are fired.)
 * - When the user clicks and releases anywhere except a draggable edge, and a selection is present,
 *   then it erases the selection and fires the onSelectionChange event. A click and release is defined
 *   as one where (1) the click wasn't on a draggable edge, (2) the mouse pointer never moved more than
 *   5 pixels horizontally or vertically while the duration was held down, (3) the release location
 *   is within 5 pixels of the mouse-down location. (This last part might seem redundant, but it's not
 *   if we calculate part (2) during mouse-move events, and the action was so quick that we never
 *   got any mouse-move events during it). This stipulation is to support the scenario that the
 *   user wants to select just a single day.
 * - When the user clicks and drags on one a draggable part at the end of the selection, then every
 *   change of date updates 'selection', updates the selection rectangle and draggable areas, and causes
 *   an onSelectionChanged event to be fired. Note that if the user drags the left edge but drags it over
 *   to the right, then what used to be the end edge is now the start edge!
 *   The draggable edge always snaps to units of whole bars (be they days or months), not to precisely
 *   where the mouse pointer is. Note that the non-dragged edge retains its exact date, not snapped.
 *   In months view, if the edge we are dragging is the right edge of the selection then it's deemed to be
 *   the last day of the month; if it's the left edge then it's deemed to be the first day of the month.
 * - When the user clicks anywhere else and drags, then the at the start of this drag and upon every
 *   change of date we update 'selection', and update the selection rectangle and draggable areas,
 *   but we only fire onSelectionChanged when the drag is released. Note that the user might drag to
 *   the left or to the right of where they initially clicked; hence which one counts as selection.start
 *   and selection.end will depend on which way they've dragged.
 * - In both cases of drags, if the user drags past the edge of the histogram, then this causes a pan
 *   to happen at some suitable rate.
 * - Incidentally, a selection of just one bar is a valid selection! e.g. if the user wants to see
 *   photos from just one single day. Both edge-dragging and new-select-dragging support this.
 * - Underneath the chart there'll be time labels. They will adjust to be appropriate to the current zoom level:
 *   if we're zoomed out so far that only years make sense, they'll show years; if zoomed in more so that months
 *   make sense then they'll show months; if zoomed in more then they'll show days. We should only show at
 *   most three labels under the chart: one towards the left, one towards the right, one roughly centered.
 *   They might not be exactly at the left/center/right of the chart, e.g. if the leftmost sensible label
 *   to show is "2024" then we'd show it centered where 2024-01-01 is exactly.
 * - Accessibility. The histogram will be focusable with tabindex="0". We'll activate keyboard support
 *   when the user clicks on the histogram, or when the user tabs to it. If the user tabbed to it, then
 *   we'll display a visual focus indicator: a tooltip that shows keyboard controls, and an outline.
 *   Keyboard controls are (1) left/right to pan the bounds, up/+/= to zoom in, and down/- to zoom out centered
 *   on the current center by a sensible amount ~10%, (2) shift+left/right to pan the selection,
 *   and shift with zoom keys to enlarge and shrink the selection by a sensible amount, but if no selection
 *   exists then one is instead created in a sensible middle portion of the histogram, (4) esc to clear the
 *   selection. Screen-reader support will report the start and end date of the selection whenever the selection
 *   is changed.
 * 
 * DOM ELEMENT STRUCTURE
 * div id="histogram-container" tabindex="0"
 *   div class="histogram-chart"
 *     div class="histogram-bar" style="display:none"  // availabe bars for re-use
 *     div class="histogram-bar histogram-bar-{grey,blue,yellow}" style="display:block"  // in-use bars
 *     div class="histogram-selection" // select overlay (display:none when no selection)
 *       div class="histogram-selection-fill"  // the visual selection bar
 *       div class="histogram-selection-edge histogram-left"   // draggable edge
 *       div class="histogram-selection-edge histogram-right"  // draggable edge
 *   div class="histogram-labels"
 *     div class="histogram-label histogram-left"
 *     div class="histogram-label histogram-center"
 *     div class="histogram-label histogram-right"
 *     div class="histogram-selection-tooltip histogram-left"
 *     div class="histogram-selection-tooltip histogram-right"
 *   div class="histogram-sr-announcements"  // screen-reader
 */
export class Histogram {
    private bounds: InclusiveDateRange; // invariant: minimum 7 days
    private selection: InclusiveDateRange | undefined;
    private fullRange: InclusiveDateRange;
    private tally: Tally | undefined;
    private bi: HistogramBarInfo; // the latest state of the histogram bars (only meaningful if tally is defined)
    private currentDrag: undefined
        | { type: 'pan', startX: number, initialBounds: InclusiveDateRange }
        | { type: 'new-selection', startX: number, startY: number, hasBlown5Pixels: boolean, startDate: Numdate, currentDate: Numdate }
        | { type: 'edge-selection', fixedEdge: Numdate };

    // DOM interaction
    private container: HTMLElement;
    private chartArea: HTMLElement;
    private barTemplate: HTMLElement;
    private selectionOverlay: HTMLElement;
    private selectionFill: HTMLElement;
    private selectionEdgeLeft: HTMLElement;
    private selectionEdgeRight: HTMLElement;
    private selectionTooltipLeft: HTMLElement;
    private selectionTooltipRight: HTMLElement;
    private labelsContainer: HTMLElement;
    private labelLeft: HTMLElement;
    private labelCenter: HTMLElement;
    private labelRight: HTMLElement;
    private srAnnouncements: HTMLElement;
    private hoverIndicator: HTMLElement;
    private hoverTooltip: HTMLElement;

    public onSelectionChange: (selection: { start: number, end: number } | undefined) => void = () => { };

    /**
     * Constructor sets up the histogram component by finding existing DOM elements
     * and setting up event handlers. Reads state from localStorage.
     */
    constructor(container: HTMLElement) {
        this.container = container;

        // Set up DOM interaction
        this.chartArea = container.querySelector('.histogram-chart')!;
        this.barTemplate = this.chartArea.querySelector('.histogram-bar')!;
        this.selectionOverlay = container.querySelector('.histogram-selection')!;
        this.selectionFill = this.selectionOverlay.querySelector('.histogram-selection-fill')!;
        this.selectionEdgeLeft = this.selectionOverlay.querySelector('.histogram-selection-edge.histogram-left')!;
        this.selectionEdgeRight = this.selectionOverlay.querySelector('.histogram-selection-edge.histogram-right')!;
        this.labelsContainer = container.querySelector('.histogram-labels')!;
        this.labelLeft = this.labelsContainer.querySelector('.histogram-label.histogram-left')!;
        this.labelCenter = this.labelsContainer.querySelector('.histogram-label.histogram-center')!;
        this.labelRight = this.labelsContainer.querySelector('.histogram-label.histogram-right')!;
        this.selectionTooltipLeft = this.labelsContainer.querySelector('.histogram-selection-tooltip.histogram-left')!;
        this.selectionTooltipRight = this.labelsContainer.querySelector('.histogram-selection-tooltip.histogram-right')!;
        this.srAnnouncements = container.querySelector('.histogram-sr-announcements')!;
        this.hoverIndicator = this.chartArea.querySelector('.histogram-hover-indicator')!;
        this.hoverTooltip = this.labelsContainer.querySelector('.histogram-hover-tooltip')!;
        this.container.addEventListener('wheel', this.handleMouseWheel.bind(this));
        this.container.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.container.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.container.addEventListener('mouseleave', this.handleMouseLeave.bind(this));
        this.container.addEventListener('keydown', this.handleKeyDown.bind(this));
        this.selectionEdgeLeft.addEventListener('dragstart', (e) => e.preventDefault());
        this.selectionEdgeRight.addEventListener('dragstart', (e) => e.preventDefault());
        document.addEventListener('keydown', this.handleGlobalKeyDown.bind(this));
        document.addEventListener('keyup', this.handleGlobalKeyUp.bind(this));
        document.addEventListener('mousemove', this.handleGlobalMouseMove.bind(this));
        document.addEventListener('mouseup', this.handleGlobalMouseUp.bind(this));
        document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));

        // Logical state
        this.tally = undefined;
        this.currentDrag = undefined;
        this.bounds = { start: 0, end: 0 };
        this.selection = undefined;
        this.fullRange = { start: 0, end: 0 };
        this.bi = undefined as unknown as HistogramBarInfo; // only defined if tally is defined
        // Try to fetch from last time
        const savedStateRaw = localStorage.getItem('histogram-state');
        if (savedStateRaw) {
            const savedState = JSON.parse(savedStateRaw);
            this.bounds = savedState.bounds || { start: 20250101, end: 20251231 };
            this.selection = savedState.selection || undefined;
            this.fullRange = savedState.fullRange || { start: 0, end: 0 };
        }
    }

    /**
     * Saves current state to localStorage.
     */
    private saveState(): void {
        const state = {
            bounds: this.bounds,
            selection: this.selection,
            fullRange: this.fullRange,
        };
        localStorage.setItem('histogram-state', JSON.stringify(state));
    }


    /**
     * Sets the data for the histogram, recomputs bounds, saves state, and updates the DOM.
     */
    setData(tally: Tally): void {
        const prevSelection = this.tally ? this.selection : undefined;

        // If tally has no datapoints, set it to undefined and leave bounds and selection as they are
        if (!tally || tally.dateCounts.size === 0) {
            this.tally = undefined;
        } else {
            this.tally = tally;

            // Compute maximums and minimums
            let fullRange: InclusiveDateRange = { start: Number.MAX_SAFE_INTEGER, end: 0 };
            let inBounds: InclusiveDateRange = { start: Number.MAX_SAFE_INTEGER, end: 0 };
            for (const [date, counts] of tally.dateCounts) {
                fullRange.start = Math.min(fullRange.start, date);
                fullRange.end = Math.max(fullRange.end, date);
                if (counts.inBounds.inFilter === 0 && counts.inBounds.outFilter === 0) continue;
                inBounds.start = Math.min(inBounds.start, date);
                inBounds.end = Math.max(inBounds.end, date);
            }
            if (inBounds.end === 0) inBounds = { start: fullRange.start, end: fullRange.end }; // If no inBounds data, use full range

            // Has a change in fullRange invalidated the selection?
            if (fullRange.start !== this.fullRange.start || fullRange.end < this.fullRange.end) this.selection = undefined;
            // Should we extend the bounds?
            if (this.selection && fullRange.end > this.fullRange.end) this.bounds.end = fullRange.end;
            // Should we entirely reset the bounds?
            if (!this.selection) this.bounds = expandToMinimum(inBounds);

            this.fullRange = fullRange;
            this.saveState();
            if (this.selection !== prevSelection) this.reportSelectionChanged();
        }

        this.recomputeDOM_chart();
    }

    private handleMouseWheel(event: WheelEvent): void {
        event.preventDefault(); // Prevent default scrolling behavior
        if (!this.tally) return; // No zoom if no data
        const rect = this.chartArea.getBoundingClientRect();
        const cursorX = event.clientX - rect.left; // relative to chart area
        if (cursorX < 0 || cursorX > rect.width) return; // scroll out of bounds

        // Calculates new bounds based on zoom factor, keeping the date under the cursor at the same pixel position.
        // We'll do our calculation in milliseconds for easier maths.
        const [startMs, endMs] = [numToDate(this.bounds.start).getTime(), numToDate(this.bounds.end).getTime()];
        const cursorFraction = cursorX / rect.width;
        const cursorMs = startMs + cursorFraction * (endMs - startMs);
        const zoomFactor = Math.exp(-event.deltaY * 0.001); // deltaY is negative when scrolling up (zoom in), positive down (zoom out)
        const newSpanMs = (endMs - startMs) / zoomFactor;
        const [newStartMs, newEndMs] = [cursorMs - cursorFraction * newSpanMs, cursorMs + (1 - cursorFraction) * newSpanMs];
        const newBounds = { start: dateToNum(new Date(newStartMs)), end: dateToNum(new Date(newEndMs)) };

        // Constrain those bounds to stay within limits: not too zoomed-out, not too zoomed-in
        const constrainedBounds = expandToMinimum({
            start: Math.max(this.fullRange.start, newBounds.start),
            end: Math.min(this.fullRange.end, newBounds.end)
        });

        // Update
        this.bounds = constrainedBounds;
        this.saveState();
        this.recomputeDOM_chart();
    }

    private handleMouseDown(event: MouseEvent): void {
        event.preventDefault(); // prevent text selection
        if (!this.tally) return; // No data, no interaction
        const rect = this.chartArea.getBoundingClientRect();
        const x = event.clientX - rect.left;
        if (x < 0 || x >= rect.width) return; // Click outside chart area

        if (this.container.style.cursor === 'grab') {
            // A pan operation (the cursor state is updated by keyboard handlers)
            this.currentDrag = {
                type: 'pan',
                startX: event.clientX,
                initialBounds: { ...this.bounds }
            };
            this.container.style.cursor = 'grabbing';
            event.preventDefault();
            return;
        } else if (this.selection && (event.target === this.selectionEdgeLeft || event.target === this.selectionEdgeRight)) {
            // An edge-drag operation
            const fixedEdge = event.target === this.selectionEdgeLeft ? this.selection.end : this.selection.start;
            this.currentDrag = {
                type: 'edge-selection',
                fixedEdge,
            };
            event.preventDefault();
            return;
        } else {
            // A new-selection operation
            const bar = Math.floor(x / rect.width * this.bi.count);
            const date = this.bi.find(bar)
            this.currentDrag = {
                type: 'new-selection',
                startX: event.clientX,
                startY: event.clientY,
                startDate: date,
                currentDate: date,
                hasBlown5Pixels: false,
            };
        }
    }

    private handleMouseMove(event: MouseEvent): void {
        // Handles hover and edge-hover
        // (Drag mouse move events are in handleGlobalMouseMove, to capture drags that go beyond bounds)
        const chartRect = this.chartArea.getBoundingClientRect();
        const x = event.clientX - chartRect.left;
        if (!this.tally || this.currentDrag || x < 0 || x >= chartRect.width) {
            this.hideHoverIndicators('all');
            return;
        }

        // Check if we're hovering over a selection edge using DOM hit-testing
        const edgeTarget = event.target === this.selectionEdgeLeft ? 'left' : event.target === this.selectionEdgeRight ? 'right' : undefined;

        if (this.selection && edgeTarget) {
            // We're hovering over a selection edge, show tooltips and hide bar hover
            this.hideHoverIndicators('hover');
            this.selectionTooltipLeft.style.display = edgeTarget === 'left' ? 'block' : 'none';
            this.selectionTooltipRight.style.display = edgeTarget === 'right' ? 'block' : 'none';
        } else {
            // We're hovering over the chart, show bar hover and hide edge tooltips
            this.hideHoverIndicators('selection');
            const bar = Math.floor(x / chartRect.width * this.bi.count);
            const date = this.bi.find(bar);
            const center = Math.round(this.bi.left(date) + this.bi.width / 2);
            this.hoverIndicator.style.left = `${center}px`;
            this.hoverIndicator.style.display = 'block';
            const month = MONTHS[Math.floor(date / 100) % 100];
            const text = this.bi.granularity === 'months' ? `${month} ${Math.floor(date / 10000)}` : `${date % 100} ${month}`;
            this.hoverTooltip.textContent = `${text}`;
            this.hoverTooltip.style.left = `${center}px`;
            this.hoverTooltip.style.display = 'block';
        }
    }

    private handleGlobalMouseMove(event: MouseEvent): void {
        const rect = this.chartArea.getBoundingClientRect();
        const x = event.clientX - rect.left;

        const findLast = (bar: number): Numdate => {
            const d = numToDate(this.bi.find(bar + 1)); // first day of the next bar
            d.setDate(d.getDate() - 1); // last day of current bar
            return dateToNum(d);
        };

        if (this.currentDrag?.type === 'pan') {
            // Pan drag
            const dayCount = dayInterval(this.currentDrag.initialBounds);

            // What's the furthest we can pan without exceeding fullRange?
            const minDeltaDays = dayInterval({ start: this.currentDrag.initialBounds.start, end: this.fullRange.start }) - 1;
            const maxDeltaDays = dayInterval({ start: this.currentDrag.initialBounds.end, end: this.fullRange.end }) - 1;
            const deltaX = this.currentDrag.startX - event.clientX; // represents the change we wish to make
            const rawDeltaDays = Math.round(deltaX / rect.width * dayCount);
            const deltaDays = Math.min(maxDeltaDays, Math.max(minDeltaDays, rawDeltaDays));

            // Calculate new bounds based on deltaDays
            const startDate = numToDate(this.currentDrag.initialBounds.start);
            const endDate = numToDate(this.currentDrag.initialBounds.end);
            startDate.setDate(startDate.getDate() + deltaDays);
            endDate.setDate(endDate.getDate() + deltaDays);
            const newBounds = { start: dateToNum(startDate), end: dateToNum(endDate) };
            if (newBounds.start !== this.bounds.start || newBounds.end !== this.bounds.end) {
                this.bounds = newBounds;
                this.recomputeDOM_chart();
            }
        } else if (this.currentDrag?.type === 'new-selection') {
            // New-selection drag
            const moveDistance = Math.max(Math.abs(event.clientX - this.currentDrag.startX), Math.abs(event.clientY - this.currentDrag.startY));
            this.currentDrag.hasBlown5Pixels ||= moveDistance >= 5;
            if (!this.currentDrag.hasBlown5Pixels) return; // Not enough movement yet

            const bar = Math.floor(x / rect.width * this.bi.count);
            const date = this.bi.find(bar);
            this.currentDrag.currentDate = date;
            this.selection = {
                start: Math.min(this.currentDrag.startDate, date),
                end: Math.max(this.currentDrag.startDate, date)
            };
            // in case of months/weeks view, our end date will be the last day of the bar.
            if (event.clientX > this.currentDrag.startX) {
                this.selection.end = findLast(this.bi.bar(this.selection.end));
            }
            this.reportSelectionChanged();
            this.recomputeDOM_selectionOverlay(); // recompute selection, but not bars/labels
            this.selectionTooltipLeft.style.display = event.clientX < this.currentDrag.startX ? 'block' : 'none';
            this.selectionTooltipRight.style.display = event.clientX > this.currentDrag.startX ? 'block' : 'none';
        } else if (this.currentDrag?.type === 'edge-selection') {
            // Edge-drag. The sense of the drag (hence whether we snap up or down) depends on where the drag is now.
            const bar = Math.floor(x / rect.width * this.bi.count);
            const fixedBar = this.bi.bar(this.currentDrag.fixedEdge);

            if (bar < fixedBar) {
                this.selection = { start: this.bi.find(bar), end: this.currentDrag.fixedEdge };
            } else if (bar > fixedBar) {
                this.selection = { start: this.currentDrag.fixedEdge, end: findLast(bar) };
            } else {
                this.selection = { start: this.bi.find(bar), end: findLast(bar) };
            }

            // Fire immediate event for edge dragging (per spec)
            this.reportSelectionChanged();
            this.recomputeDOM_selectionOverlay();
            this.selectionTooltipLeft.style.display = bar < fixedBar ? 'block' : 'none';
            this.selectionTooltipRight.style.display = bar >= fixedBar ? 'block' : 'none';
        }
    }

    private handleGlobalMouseUp(event: MouseEvent): void {
        if (this.currentDrag?.type === 'pan') {
            this.currentDrag = undefined;
            if (this.container.style.cursor === 'grabbing') {
                this.container.style.cursor = 'grab';
            }
            this.hideHoverIndicators('all');
            this.saveState();
        } else if (this.currentDrag?.type === 'new-selection') {
            const moveDistance = Math.max(Math.abs(event.clientX - this.currentDrag.startX), Math.abs(event.clientY - this.currentDrag.startY));
            this.currentDrag.hasBlown5Pixels ||= moveDistance >= 5;

            if (!this.currentDrag.hasBlown5Pixels && this.selection) { // Click to deselect
                this.selection = undefined;
            }
            this.reportSelectionChanged();

            this.currentDrag = undefined;
            this.saveState();
            this.recomputeDOM_selectionOverlay(); // recompute selection, but not bars/labels
        } else if (this.currentDrag?.type === 'edge-selection') {
            this.reportSelectionChanged();
            this.currentDrag = undefined;
            this.saveState();
            this.hideHoverIndicators('selection'); // Hide tooltips
        }
    }

    private handleMouseLeave(_event: MouseEvent): void {
        this.hideHoverIndicators('all');
    }

    /**
     * Hides hover indicators. Edge visibility is now controlled by CSS.
     */
    private hideHoverIndicators(indicators: 'hover' | 'selection' | 'all'): void {
        if (indicators === 'hover' || indicators === 'all') {
            this.hoverIndicator.style.display = 'none';
            this.hoverTooltip.style.display = 'none';
        }
        if (indicators === 'selection' || indicators === 'all') {
            this.selectionTooltipLeft.style.display = 'none';
            this.selectionTooltipRight.style.display = 'none';
        }
    }

    /**
     * Reports that the selection has changed via onSelectionChange event.
     * If alsoToScreenReader is true, it also tells the screen reader.
     */
    private reportSelectionChanged(): void {
        this.onSelectionChange(this.selection);

        if (!this.selection) {
            this.srAnnouncements.textContent = 'All dates';
        } else {
            const fmt = (date: Numdate): string => {
                const day = date % 100;
                const month = MONTHS[Math.floor(date / 100) % 100];
                const year = Math.floor(date / 10000);
                return `${day} ${month} ${year}`;
            };
            this.srAnnouncements.textContent = `${fmt(this.selection.start)} to ${fmt(this.selection.end)}`;
        }
    }

    private handleKeyDown(event: KeyboardEvent): void {
        if (!this.tally) return; // No data, no keyboard interaction
        const ZOOM_IN_CODES = ['ArrowUp', 'Equal'];
        const ZOOM_OUT_CODES = ['ArrowDown', 'Minus'];

        if (!event.shiftKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
            // PAN LEFT/RIGHT
            event.preventDefault(); // Prevent page scrolling
            const dayCount = dayInterval(this.bounds);
            const panStepDays = Math.max(1, Math.round(dayCount * 0.1)); // 10% of current view, minimum 1 day
            const intendedDeltaDays = event.code === 'ArrowLeft' ? -panStepDays : panStepDays;
            const minDeltaDays = dayInterval({ start: this.bounds.start, end: this.fullRange.start }) - 1;
            const maxDeltaDays = dayInterval({ start: this.bounds.end, end: this.fullRange.end }) - 1;
            const deltaDays = Math.min(maxDeltaDays, Math.max(minDeltaDays, intendedDeltaDays));
            if (deltaDays === 0) return;
            const startDate = numToDate(this.bounds.start);
            const endDate = numToDate(this.bounds.end);
            startDate.setDate(startDate.getDate() + deltaDays);
            endDate.setDate(endDate.getDate() + deltaDays);
            this.bounds = { start: dateToNum(startDate), end: dateToNum(endDate) };
            this.saveState();
            this.recomputeDOM_chart();
        } else if (!event.shiftKey && (ZOOM_IN_CODES.includes(event.code) || ZOOM_OUT_CODES.includes(event.code))) {
            // ZOOM IN/OUT
            event.preventDefault(); // Prevent page scrolling and default behavior
            const [startMs, endMs] = [numToDate(this.bounds.start).getTime(), numToDate(this.bounds.end).getTime()];
            const centerMs = startMs + (endMs - startMs) / 2; // Center of current view
            const zoomFactor = ZOOM_IN_CODES.includes(event.code) ? 1.2 : 1 / 1.2; // 20% zoom step
            const newSpanMs = (endMs - startMs) / zoomFactor;
            const [newStartMs, newEndMs] = [centerMs - newSpanMs / 2, centerMs + newSpanMs / 2];
            const attemptedBounds = { start: dateToNum(new Date(newStartMs)), end: dateToNum(new Date(newEndMs)) };
            const newBounds = expandToMinimum({
                start: Math.max(this.fullRange.start, attemptedBounds.start),
                end: Math.min(this.fullRange.end, attemptedBounds.end)
            });
            this.bounds = newBounds;
            this.saveState();
            this.recomputeDOM_chart();
        } else if (event.shiftKey && !this.selection && (event.code === 'ArrowLeft' || event.code === 'ArrowRight' || ZOOM_IN_CODES.includes(event.code) || ZOOM_OUT_CODES.includes(event.code))) {
            // CREATE SELECTION
            event.preventDefault();
            const dayCount = dayInterval(this.bounds);
            const daysWidth = Math.max(7, Math.round(dayCount * 0.2)); // 20% of current view, minimum 7 days            
            const start = numToDate(this.bounds.start);
            start.setDate(start.getDate() + Math.round((dayCount - daysWidth) / 2));
            const end = new Date(start);
            end.setDate(end.getDate() + daysWidth - 1); // -1 because range is inclusive            
            this.selection = { start: dateToNum(start), end: dateToNum(end) };
            this.reportSelectionChanged();
            this.saveState();
            this.recomputeDOM_chart();
        } else if (event.shiftKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
            // MOVE SELECTION LEFT/RIGHT
            event.preventDefault();
            if (!this.selection) return; // already implied by the previous condition, but this refines the type            
            const selectionDays = dayInterval(this.selection);
            const moveStepDays = Math.max(1, Math.round(selectionDays * 0.1)); // 10% of selection width, minimum 1 day
            const minDeltaDays = dayInterval({ start: this.selection.start, end: this.fullRange.start }) - 1;
            const maxDeltaDays = dayInterval({ start: this.selection.end, end: this.fullRange.end }) - 1;
            const attemptedDelta = event.code === 'ArrowLeft' ? -moveStepDays : moveStepDays;
            const deltaDays = Math.min(maxDeltaDays, Math.max(minDeltaDays, attemptedDelta));
            const newStartDate = numToDate(this.selection.start);
            const newEndDate = numToDate(this.selection.end);
            newStartDate.setDate(newStartDate.getDate() + deltaDays);
            newEndDate.setDate(newEndDate.getDate() + deltaDays);
            this.selection = { start: dateToNum(newStartDate), end: dateToNum(newEndDate) };
            this.reportSelectionChanged();
            this.saveState();
            this.recomputeDOM_chart();
        } else if (event.shiftKey && (ZOOM_IN_CODES.includes(event.code) || ZOOM_OUT_CODES.includes(event.code))) {
            // ENLARGE/SHRINK SELECTION
            event.preventDefault();
            if (!this.selection) return; // already implied by the previous condition, but this refines the type
            const selectionDays = dayInterval(this.selection);
            const centerMs = (numToDate(this.selection.start).getTime() + numToDate(this.selection.end).getTime()) / 2;
            const sizeFactor = ZOOM_IN_CODES.includes(event.code) ? 1.2 : 1 / 1.2;
            const newSelectionDays = Math.max(7, Math.round(selectionDays * sizeFactor)); // minimum 7 days
            const halfSpanMs = (newSelectionDays - 1) * 24 * 60 * 60 * 1000 / 2; // -1 because range is inclusive
            const newStartMs = centerMs - halfSpanMs;
            const newEndMs = centerMs + halfSpanMs;
            const attemptedBounds = { start: dateToNum(new Date(newStartMs)), end: dateToNum(new Date(newEndMs)) };
            this.selection = expandToMinimum({
                start: Math.max(this.fullRange.start, attemptedBounds.start),
                end: Math.min(this.fullRange.end, attemptedBounds.end)
            });
            this.reportSelectionChanged();
            this.saveState();
            this.recomputeDOM_chart();
        } else if (event.code === 'Escape') {
            event.preventDefault();
            if (!this.selection) return;
            this.selection = undefined;
            this.reportSelectionChanged();
            this.saveState();
            this.recomputeDOM_chart();
        }
    }

    private handleGlobalKeyDown(event: KeyboardEvent): void {
        if (event.code === 'Space') this.container.style.cursor = 'grab';
    }

    private handleGlobalKeyUp(event: KeyboardEvent): void {
        if (event.code === 'Space') this.container.style.cursor = 'default';
    }

    private handleVisibilityChange(): void {
        if (document.hidden) {
            this.container.style.cursor = 'default';
            // End any current drag operation when page loses focus
            if (this.currentDrag?.type === 'pan') {
                this.currentDrag = undefined;
                this.saveState();
            }
        }
    }

    /**
     * Returns a bar from the pool, or creates a new one if none are available.
     * The caller is responsible for setting style, display:block, content etc.
     */
    private getBarFromPool(): HTMLElement {
        const existing = this.chartArea.querySelector('.histogram-bar[style*="display: none"]');
        if (existing) {
            return existing as HTMLElement;
        } else {
            const bar = this.barTemplate.cloneNode(true) as HTMLElement;
            this.chartArea.appendChild(bar);
            return bar;
        }
    }

    /**
     * Updates chart DOM elements to match the current state (bars, labels),
     * and also the selection overlay if present.
     * Stores derived information in this.bi
     */
    private recomputeDOM_chart(): void {
        this.chartArea.querySelectorAll('.histogram-bar').forEach(bar => (bar as HTMLElement).style.display = 'none');

        if (!this.tally) {
            this.selectionOverlay.style.display = 'none';
            this.labelLeft.textContent = '';
            this.labelCenter.textContent = '';
            this.labelRight.textContent = '';
            return
        }

        this.bi = this.recomputeDOM_chart_bars(this.tally.dateCounts);
        this.recomputeDOM_chart_timeLabels();
        this.recomputeDOM_selectionOverlay();
    }

    /**
     * This function recomputes DOM elements.
     * It also returns a very useful 'bi: HistogramBarInfo' object that describes the bars.
     * To note: this.bounds represents a notional exact range of the histogram, but
     * bi.bounds represents the ranges of the bars which in weeks/months view may be slightly larger
     * than this.bounds (because they're enlarged to the nearest bar boundaries).
     */
    private recomputeDOM_chart_bars(dateCounts: Map<Numdate, OneDayTally>): HistogramBarInfo {
        const [chartWidth, chartHeight] = [this.chartArea.offsetWidth, this.chartArea.offsetHeight];
        const dayCount = dayInterval(this.bounds);
        const granularity = dayCount <= 140 ? 'days' : dayCount < 980 ? 'weeks' : 'months'; // at most 140 bars in days/weeks view

        let bi: HistogramBarInfo;
        let barCounts: Map<Numdate, OneDayTally>; // it's called "OneDayTally" but it's really the OneBarTally...
        const bar = (date: Numdate) => dayInterval({ start: this.bounds.start, end: date }) - 1;
        if (granularity === 'days') {
            bi = {
                granularity,
                bounds: { ...this.bounds },
                bar,
                left: (date) => bar(date) / dayCount * chartWidth,
                width: chartWidth / dayCount,
                find: (bar) => dateToNum(new Date(numToDate(this.bounds.start).setDate(numToDate(this.bounds.start).getDate() + bar))),
                count: dayCount,
                snap: (date) => date,
            }
            barCounts = dateCounts;
        } else {
            // In aggregate views, the keys of 'barCounts' are still Numdates, but they represent the date of the start of the bar.
            // The "viewport for aggregation" in generally will be larger than this.bounds,
            // so that the first and last bars don't get short-changed.
            let bounds: InclusiveDateRange;
            let barCount: number;
            if (granularity === 'weeks') {
                // We'll snap to a grid of weeks aligning on zero timestamp (Jan 1st 1970) as the origin of the grid.
                // This way we'll plot consistent weeks no matter how the user zooms/pans.
                const SEVEN_DAYS_IN_MS = 1000 * 60 * 60 * 24 * 7;
                const [startMs, endMs] = [numToDate(this.bounds.start).getTime(), numToDate(this.bounds.end).getTime()];
                const startSnap = new Date(Math.floor(startMs / SEVEN_DAYS_IN_MS) * SEVEN_DAYS_IN_MS); // first day of first week
                const endSnap = new Date(Math.ceil(endMs / SEVEN_DAYS_IN_MS) * SEVEN_DAYS_IN_MS);
                endSnap.setDate(endSnap.getDate() + 6); // final day of final week
                bounds = { start: dateToNum(startSnap), end: dateToNum(endSnap) };
                barCount = dayInterval(bounds) / 7;
                const bar = (date: Numdate) => (dayInterval({ start: bounds.start, end: date }) - 1) / 7;
                bi = {
                    granularity,
                    bounds: { ...this.bounds },
                    bar,
                    left: (date) => bar(date) / barCount * chartWidth,
                    width: chartWidth / barCount,
                    find: (bar) => dateToNum(new Date(numToDate(bounds.start).setDate(numToDate(bounds.start).getDate() + bar * 7))),
                    count: barCount,
                    snap: (date) => {
                        const d = numToDate(bounds.start);
                        d.setDate(d.getDate() + Math.floor((dayInterval({ start: bounds.start, end: date }) - 1) / 7) * 7);
                        return dateToNum(d);
                    },
                }
            } else {
                bounds = {
                    start: Math.floor(this.bounds.start / 100) * 100 + 1,
                    end: Math.floor(this.bounds.end / 100) * 100 + 31, // this over-approximation is safe because we only use it for bounds checking
                };
                barCount = monthInterval(bounds);
                const bar = (date: Numdate) => (monthInterval({ start: bounds.start, end: date }) - 1);
                bi = {
                    granularity,
                    bounds,
                    bar,
                    left: (date) => bar(date) / barCount * chartWidth,
                    width: chartWidth / barCount,
                    find: (bar) => {
                        const month = Math.floor((bounds.start / 100) % 100) - 1 + bar; // 0-based, might be >12 (but we'll modulo it next)
                        return (Math.floor(bounds.start / 10000) + Math.floor(month / 12)) * 10000 + (month % 12 + 1) * 100 + 1; // 1st of the month
                    },
                    count: barCount,
                    snap: (date: Numdate) => Math.floor(date / 100) * 100 + 1,
                }
            }
            // Now compute barCounts as aggregates from dateCounts:
            barCounts = new Map();
            for (const [date, counts] of dateCounts) {
                if (date < bounds.start || date > bounds.end) continue;
                const barDate = bi.snap(date);
                let barTally = barCounts.get(barDate);
                if (!barTally) {
                    barTally = { inBounds: { inFilter: 0, outFilter: 0 }, outBounds: { inFilter: 0, outFilter: 0 } };
                    barCounts.set(barDate, barTally);
                }
                barTally.inBounds.inFilter += counts.inBounds.inFilter;
                barTally.inBounds.outFilter += counts.inBounds.outFilter;
                barTally.outBounds.inFilter += counts.outBounds.inFilter;
                barTally.outBounds.outFilter += counts.outBounds.outFilter;
            }
        }

        // Calculation of maximums is the same for months as for days
        let maxInBoundsCount = 1; // cheap trick to avoid division-by-zero in pathological case where counts[date] === 0
        for (const [date, counts] of barCounts) {
            if (date < bi.bounds.start || date > bi.bounds.end) continue;
            maxInBoundsCount = Math.max(counts.inBounds.inFilter + counts.inBounds.outFilter, maxInBoundsCount);
        }

        // Render the bar. Blue/yellow/grey are disjoint.
        for (const [date, counts] of barCounts) {
            if (date < bi.bounds.start || date > bi.bounds.end) continue;
            const colorCounts = { blue: counts.inBounds.outFilter, yellow: counts.inBounds.inFilter + counts.outBounds.inFilter, grey: counts.outBounds.outFilter };
            let bottom = 0;
            for (const color of (['blue', 'yellow', 'grey'] as const)) {
                if (colorCounts[color] === 0) continue;
                const bar = this.getBarFromPool();
                const height = (colorCounts[color] / maxInBoundsCount) * chartHeight;
                bar.className = `histogram-bar histogram-bar-${color}`;
                bar.style.left = `${bi.left(date)}px`;
                bar.style.bottom = `${bottom}px`;
                bar.style.width = `${bi.width}px`;
                bar.style.height = `${height}px`;
                bar.style.display = 'block';
                bottom += height;
            }
        }

        return bi;
    }



    private recomputeDOM_chart_timeLabels(): void {
        if (!this.tally) return;
        const bi = this.bi;

        // Our goal is to show a few labels at "natural" marker points, years or months or days,
        // depending on the range of the data. We'll first try year-markers to see if there
        // are enough to populate the labels, or if the range is so small that it only shows
        // a single year hence year-markers are no good. In that case we'll try the same with
        // month-markers, then day-markers. Day-markers will necessarily work because of our
        // invariant that the bounds are at least 7 days.

        // For our three potential strategies (years, months, days), the following generators
        // produce an infinite sequence of markers starting at or slightly before bi.bounds.start.
        // The "slightly before" is to make this code simpler; it's later cleaned up by filterBounds.
        function* years(): Iterable<Numdate> {
            const startYear = Math.floor(bi.bounds.start / 10000);
            for (let year = startYear; ; year++) yield year * 10000 + 101; // January 1st of each year
        }
        function* months(): Iterable<Numdate> {
            const startYear = Math.floor(bi.bounds.start / 10000);
            for (let year = startYear, month = 1; ;) {
                yield year * 10000 + month * 100 + 1; // 1st of each month
                month += 1; if (month > 12) { year += 1; month = 1; }
            }
        }
        function* days(): Iterable<Numdate> {
            for (let date = numToDate(bi.bounds.start); ; date.setUTCDate(date.getUTCDate() + 1)) {
                yield dateToNum(date);
            }
        }

        // We'll use this "filterBounds" generator to (1) filter out early dates which were there
        // because the above functions are fuzzy, (2) stop the iterable after the end because
        // the above functions are infinite. We operate on pixels, not dates, so it's easy to
        // calculate "only include dates within 90% of the pixel width of the chart" (so that
        // labels don't get clipped at start or end).)
        function* filterBounds(dates: Iterable<Numdate>): Iterable<Numdate> {
            for (const date of dates) {
                const [center, chartWidth] = [bi.left(date) + bi.width / 2, bi.count * bi.width];
                if (center < chartWidth * 0.05) continue;
                else if (center > chartWidth * 0.95) break;
                else yield date;
            }
        }

        // Each of the three strategies (years, months, days) has its own way of formatting too:
        // years just as "2011, 2012, 2013", months as "Jan, Feb 2011, Mar", days as
        // "1 Jan, 2 Jan 2011, 3 Jan". Note that one label is more detailed than the others
        function yearFmt(date: Numdate, _detailed: boolean): string {
            return `${Math.floor(date / 10000)}`;
        }
        function monthFmt(date: Numdate, detailed: boolean): string {
            const month = MONTHS[Math.floor((date / 100) % 100)];
            return detailed ? `${month} ${yearFmt(date, true)}` : `${month}`;
        }
        function dayFmt(date: Numdate, detailed: boolean): string {
            const day = date % 100;
            return detailed ? `${day} ${monthFmt(date, true)}` : `${day} ${monthFmt(date, false)}`;
        }

        // Now we can declaratively write the three strategies:
        const strategies = [
            { dates: years(), fmt: yearFmt },
            { dates: months(), fmt: monthFmt },
            { dates: days(), fmt: dayFmt }
        ];

        // And there's a simple uniform way to pick the beset strategy!
        // We'll produce an array 'dates' which has three elements,
        // either three dates (if we want all three labels) or two dates
        // and the middle undefined (if we only want two labels).
        let dates: [Numdate, Numdate | undefined, Numdate] = [0, undefined, 0];
        let fmt = yearFmt;
        for (const strategy of strategies) {
            const dd = Array.from(filterBounds(strategy.dates));
            fmt = strategy.fmt;
            if (dd.length <= 1) continue;
            else if (dd.length === 2) dates = [dd[0], undefined, dd[1]];
            else if (dd.length === 3) dates = [dd[0], dd[1], dd[2]];
            else if (dd.length === 4) dates = [dd[0], dd[1], dd[2]];
            else dates = [dd[0], dd[Math.floor((dd.length - 1) / 2)], dd[dd.length - 1]];
            break;
        }

        // That's enough to position and format the labels.
        const labels = [this.labelLeft, this.labelCenter, this.labelRight];
        for (let i = 0; i < 3; i++) {
            const [date, label] = [dates[i], labels[i]];
            label.style.display = date ? 'block' : 'none';
            if (!date) continue;
            label.textContent = fmt(date, i === (dates[1] ? 1 : 0));
            label.style.left = `${bi.left(date)}px`;
        }
    }

    private recomputeDOM_selectionOverlay(): void {
        if (!this.selection) {
            this.selectionOverlay.style.display = 'none';
            return;
        }

        this.selectionOverlay.style.display = 'block';

        const visualStart = this.bi.snap(this.selection.start);
        const visualEnd = this.bi.snap(this.selection.end);
        const left = this.bi.left(visualStart);
        const width = this.bi.left(visualEnd) + this.bi.width - left;

        // Selection fill
        this.selectionFill.style.left = `${left}px`;
        this.selectionFill.style.width = `${width}px`;

        // Draggable edges. They're always present; CSS opacity controls whether they'll be visible.
        this.selectionEdgeLeft.style.left = `${left - 3}px`; // assume 6px width; centered on boundary
        this.selectionEdgeRight.style.left = `${left + width - 3}px`;

        // Tooltips at the edge centers (CSS translateX(-50%) will center them)
        // We'll always print full date regardless of graph granularity, since selection is an important user concept
        const fmt = (date: Numdate): string => `${date % 100} ${MONTHS[Math.floor(date / 100) % 100]} ${Math.floor(date / 10000)}`;
        this.selectionTooltipLeft.style.left = `${left}px`; // Center of left edge
        this.selectionTooltipRight.style.left = `${left + width}px`; // Center of right edge
        this.selectionTooltipLeft.style.display = 'none';
        this.selectionTooltipRight.style.display = 'none';
        this.selectionTooltipLeft.textContent = fmt(this.selection.start);
        this.selectionTooltipRight.textContent = fmt(this.selection.end);
    }
}
