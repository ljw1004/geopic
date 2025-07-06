// Tests+prototypes go here!
// WE WILL LEAVE THIS FILE IN PLACE. IT SHOULD NOT BE REMOVED.

export {}

/**
 * Converts a number in YYYYMMDD format to a Date object.
 */
function numToDate(yyyymmdd: number): Date {
    const year = Math.floor(yyyymmdd / 10000);
    const month = Math.floor((yyyymmdd % 10000) / 100) - 1; // Month is 0-indexed in Date
    const day = yyyymmdd % 100;
    return new Date(Date.UTC(year, month, day));
}

/**
 * Calculates the number of days between two dates in YYYYMMDD format (exclusive).
 */
function dayInterval(date0: number, date: number): number {
    return (numToDate(date).getTime() - numToDate(date0).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * HISTOGRAM TODO: DESIGN IDEAS
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
 */
function renderHistogram(counts: Map<number, number>): void {
    const WIDTH = 300;
    const barContainer = document.getElementById('histogram-bars')!;
    console.log(Object.keys(counts).length);
    let [minDate, maxDate, maxCount] = [0, 0, 0];
    for (const [date, count] of counts) {
        minDate = (minDate && minDate < date) ? minDate : date;
        maxDate = (maxDate && maxDate > date) ? maxDate : date;
        maxCount = Math.max(maxCount, count);
    }
    const totalDays = dayInterval(minDate, maxDate);
    for (const [day, count] of counts) {
        const days = dayInterval(minDate, day);
        const x = days / totalDays * WIDTH;
        const width = 1 / totalDays * WIDTH;

        const greyBar = document.createElement('div');
        greyBar.className = 'bar bar-grey';
        greyBar.style.left = `${x}px`;
        greyBar.style.width = `${width}px`;
        greyBar.style.height = `${count / maxCount * 100}%`;
        barContainer.appendChild(greyBar);

        const blueBar = document.createElement('div');
        blueBar.className = 'bar bar-blue';
        blueBar.style.left = `${x}px`;
        blueBar.style.width = `${width}px`;
        blueBar.style.height = `${count / maxCount * 50}%`;
        barContainer.appendChild(blueBar);
    }

    // TODO: bar-chart pooling. We can't keep recreating this many DOM elements.
    // We should re-use existing ones.

    // TODO: add time labels.
    // Underneath the chart there'll be time labels. They will adjust to be appropriate to the current zoom level:
    // if we're zoomed out so far that only years make sense, they'll show years; if zoomed in more so that months
    // make sense then they'll show months; if zoomed in more then they'll show days. We should only show at
    // most three labels under the chart: one towards the left, one towards the right, one roughly centered.
    // They might not be exactly at the left/center/right, e.g. if the leftmost sensible label to show is "2024"
    // then we'd show it centered where 2024-01-01 is exactly.
   
}

export function testHistogram(counts: Map<number, number>) {
    renderHistogram(counts);
}

