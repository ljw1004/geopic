/**
 * This class is a factory for image markers that belong to a google map,
 * specifically for the case where the caller needs to refresh the entire
 * list of markers on the map in one go. Each marker contains either
 * content=<img/>, or content=<div><img/><span/></div>.
 * Under the hood it's optimized to avoid dynamic allocation of markers or DOM elements.
 *
 * How to use: any time the caller wants to refresh all markers on the map,
 * it calls addMarker() for each one, then finishAddingMarkers() when done.
 * (Implicitly, the first addMarker() after finishAddingMarkers() implies
 * a fresh batch of markers).
 *
 * Pooling strategy... It's easier to think of this procedurally. Think of a
 * steady 'finished' state where we store a list of markers, some of which are on
 * the map and some of which are unused. Then our refresh procedure starts, so all
 * the ones which used to be on the map are set aside in a "potential for immediate
 * reuse" area. One by one our refresh procedure adds markers to the map, either
 * taking them from this immediate-reuse pool if they're an exact match, or taking
 * them from the unused pool, or creating entirely new ones if none are available.
 * At the end of the refresh procedure, everything left in this immediate-reuse pool
 * gets moved into the unused pool, and our steady state has been restored.
 *
 * The refresh procedure start is implicit in the first call to addMarker() after
 * the previous finishAddingMarkers(). The refresh proceceure end happens when
 * we call finishAddingMarkers(). If finishAddingMarkers() was called without
 * any preceding addMarkers(), then that means the refresh procedure started and
 * finished with no markers. (This is to support the case where no markers are wanted!)
 */
export class MarkerPool {
    MARKER_LIBRARY;
    MAP;
    state;
    static async create(map) {
        const markerLibrary = await google.maps.importLibrary("marker");
        return new MarkerPool(markerLibrary, map);
    }
    constructor(MARKER_LIBRARY, MAP) {
        this.MARKER_LIBRARY = MARKER_LIBRARY;
        this.MAP = MAP;
        this.state = {
            kind: 'finished',
            used: { img: new Map(), span: new Map() },
            unused: { img: new Map(), span: new Map() },
        };
    }
    static startAddingIfNeeded(state) {
        if (state.kind === 'adding')
            return state;
        return {
            kind: 'adding',
            wasUsed: state.used,
            used: { img: new Map(), span: new Map() },
            unused: state.unused,
        };
    }
    /**
     * Obtains a new marker, belonging to the map passed in the constructor.
     * The marker will have content either <img/> or <div><img/><span/></div>
     * depending on whether spanText was passed. The img will have the specified
     * src and imgClassName (use empty string for none). The marker will have a click listener
     * if specified. The caller is expected to .setPosition() and .setZIndex() as needed.
     */
    add(src, imgClassName, spanText, onClick) {
        this.state = MarkerPool.startAddingIfNeeded(this.state);
        // The following code has several branches. They all establish some invariants:
        // - marker is defined
        // - marker.map === this.MAP
        // - marker.content is either <img/> or <div><img/><span/></div> according to spanText
        // Step 1. Attempt to reuse from immediate-reuse pool with exact matching src
        const key = spanText === undefined ? 'img' : 'span';
        let markerAndListener = this.state.used[key].get(src);
        if (markerAndListener) {
            // A marker was previously added with the exact same src.
            // We don't support this, so we'll give them back the existing marker
            return markerAndListener.marker;
        }
        markerAndListener = this.state.wasUsed[key].get(src);
        if (markerAndListener) {
            this.state.wasUsed[key].delete(src);
            // assuming invariant that forImmediateReuse has map=container
            // assuming invariant that forImmediateReuse[key] has correct content type
        }
        else {
            // Step 2. Failing that, pick the oldest marker from the unused pool (even with different src)
            const firstEntry = this.state.unused[key].entries().next();
            if (!firstEntry.done) {
                const oldSrc = firstEntry.value[0];
                markerAndListener = firstEntry.value[1];
                this.state.unused[key].delete(oldSrc);
                markerAndListener.marker.map = this.MAP; // because unused has map=null
                // assuming invariant that unused[key] has correct content type
            }
            else {
                const img = document.createElement('img');
                img.loading = 'lazy';
                let content;
                if (key === 'img') {
                    content = img;
                }
                else {
                    content = document.createElement('div');
                    content.appendChild(img);
                    const badge = document.createElement('span');
                    content.appendChild(badge);
                }
                const marker = new this.MARKER_LIBRARY.AdvancedMarkerElement({ map: this.MAP, content });
                markerAndListener = { marker, listener: undefined };
                // here we're establishing the invariants
            }
        }
        // Now establish the invariant that marker has no listener that we installed
        // Assuming invariant that Markers.listener is any listener that we installed.
        const { marker, listener: oldListener } = markerAndListener;
        oldListener?.remove();
        // Now we'll set up its content, per our parameters
        let img;
        if (spanText === undefined) {
            img = marker.content;
        }
        else {
            const div = marker.content;
            img = div.children[0];
            const span = div.children[1];
            span.textContent = spanText;
        }
        if (img.src !== src)
            img.src = src;
        if (img.className !== imgClassName)
            img.className = imgClassName;
        const listener = onClick ? marker.addListener('click', onClick) : undefined;
        // Final book-keeping. We've established all the invariants described in Markers type.
        this.state.used[key].set(src, { marker, listener });
        return marker;
    }
    /**
     * Removes all markers from the map, except for those that were added by
     * addMarker() since the last call to finishAddingMarkers().
     */
    finishAdding() {
        // In case the user called finishAddingMarkers() twice without any intervening addMarkers()
        // to denote a map devoid of markers, we have to enter 'adding' state ourselves.
        const { used: onMap, wasUsed: forImmediateReuse, unused } = MarkerPool.startAddingIfNeeded(this.state);
        // Any remaining markers in immediate-reuse pool are moved to unused-pool
        // We're modifying by reference the same 'unused' that we got by destructuring earlier.
        for (const key of ['img', 'span']) {
            for (const [src, { marker, listener }] of forImmediateReuse[key]) {
                marker.map = null; // establish the invariant for unused, that map=null
                listener?.remove(); // establish the invariant for unused, that listener is undefined
                // other invariants (about content-type and key) carry over
                unused[key].set(src, { marker, listener: undefined });
            }
        }
        this.state = { kind: 'finished', used: onMap, unused };
    }
}
/**
 * This class is a factory for img elements that belong to a div.
 * It's basically the same as MarkerPool: see comments there.
 * The difference between used and unused elements is their
 * display style, either 'none' or '' (default)
 */
export class ImgPool {
    parent;
    state;
    constructor(parent) {
        this.parent = parent;
        this.state = {
            kind: 'finished',
            used: new Map(),
            unused: new Map(),
        };
    }
    static startAddingIfNeeded(state) {
        if (state.kind === 'adding')
            return state;
        return {
            kind: 'adding',
            wasUsed: state.used,
            used: new Map(),
            unused: state.unused,
        };
    }
    addImg(src) {
        this.state = ImgPool.startAddingIfNeeded(this.state);
        let img = this.state.used.get(src);
        if (img)
            return img; // already there
        img = this.state.wasUsed.get(src);
        if (img) {
            this.state.wasUsed.delete(src);
        }
        else {
            const firstEntry = this.state.unused.entries().next();
            if (!firstEntry.done) {
                const oldSrc = firstEntry.value[0];
                img = firstEntry.value[1];
                if (img.src !== src)
                    img.src = src;
                this.state.unused.delete(oldSrc);
                this.parent.appendChild(img);
            }
            else {
                img = document.createElement('img');
                img.loading = 'lazy';
                img.src = src;
                this.parent.appendChild(img);
            }
        }
        this.state.used.set(src, img);
        return img;
    }
    finishAdding() {
        const { used, wasUsed, unused } = ImgPool.startAddingIfNeeded(this.state);
        for (const [src, img] of wasUsed) {
            img.remove();
            img.onclick = null;
            unused.set(src, img);
        }
        this.state = { kind: 'finished', used, unused };
    }
}
//# sourceMappingURL=pools.js.map