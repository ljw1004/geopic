/**
 * Copyright (c) Lucian Wischik
 */

/**
 * INVARIANTS:
 * - 'img' only contains markers that have content=<img/>
 * - 'span' only contains markers that have content=<div><img/><span/></div>
 * - if and only if we added a click handler, we stored it in the listener field
 */
type Markers = {
    img: Map<string, { marker: google.maps.marker.AdvancedMarkerElement, listener: google.maps.MapsEventListener | undefined }>,
    span: Map<string, { marker: google.maps.marker.AdvancedMarkerElement, listener: google.maps.MapsEventListener | undefined }>,
}

/**
 * This class is a factory for image markers that belong to a google map,
 * specifically for the case where the caller needs to refresh the entire
 * list of markers on the map in one go. Each marker contains either
 * content=<img/>, or content=<div><img/><span/></div>.
 * Under the hood it's optimized to avoid dynamic allocation of markers or DOM elements.
 * 
 * How to use: any time the caller wants to refresh all markers on the map,
 * it calls add() for each one, then finishAdding() when done.
 * (Implicitly, the first add() after finishAdding() implies
 * a fresh batch of markers).
 * 
 * Pooling strategy... It's easier to think of this procedurally. Think of a
 * steady state 'finished' where we store a list of markers, some of which are used on
 * the map and some of which are unused. Then our refresh procedure starts, so all
 * the ones which used to be on the map are set aside in a "wasUsed / potential for
 * immediate reuse" area. One by one our refresh procedure adds (uses) markers to the map, either
 * taking them from this immediate-reuse pool if they're an exact match, or taking
 * them from the unused pool, or creating entirely new ones if none are available.
 * At the end of the refresh procedure, everything left in this immediate-reuse pool
 * gets moved into the unused pool, and our steady state has been restored.
 *
 * The refresh procedure start is implicit in the first call to add() after
 * the previous finishAdding(). The refresh procedure end happens when
 * we call finishAdding(). If finishAdding() was called without
 * any preceding add(), then that means the refresh procedure started and
 * finished with no markers. (This is to support the case where no markers are wanted!)
 */
export class MarkerPool {
    public state: {
        kind: 'finished',
        used: Markers, // all have .map=container
        unused: Markers, // all have .map=null, and listeners undefined
    } | {
        kind: 'adding',
        wasUsed: Markers, // all have .map=container
        used: Markers, // all have .map=container
        unused: Markers, // all have .map=null, and listeners undefined
    }

    constructor(private MAP: google.maps.Map, private MARKER_LIBRARY: google.maps.MarkerLibrary) {
        this.state = {
            kind: 'finished',
            used: { img: new Map(), span: new Map() },
            unused: { img: new Map(), span: new Map() },
        }
    }

    private static startAddingIfNeeded(state: MarkerPool['state']): Extract<MarkerPool['state'], { kind: 'adding' }> {
        if (state.kind === 'adding') return state;
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
     * Invariant: you don't try to add with the same id twice in the same refresh procedure.
     */
    public add(id: string, src: string, imgClassName: string, spanText: undefined | string, onClick: undefined | (() => void)): google.maps.marker.AdvancedMarkerElement {
        this.state = MarkerPool.startAddingIfNeeded(this.state);

        // The following code has several branches. They all establish some invariants:
        // - marker is defined
        // - marker.map === this.MAP
        // - marker.content is either <img/> or <div><img/><span/></div> according to spanText

        // Step 1. Attempt to reuse from immediate-reuse pool with exact matching src
        const kind = spanText === undefined ? 'img' : 'span';
        let markerAndListener = this.state.wasUsed[kind].get(id);
        if (markerAndListener) {
            this.state.wasUsed[kind].delete(id);
            // assuming invariant that forImmediateReuse has map=container
            // assuming invariant that forImmediateReuse[key] has correct content type
        } else {
            // Step 2. Failing that, pick the oldest marker from the unused pool (even with different src)
            const firstEntry = this.state.unused[kind].entries().next();
            if (!firstEntry.done) {
                const oldId = firstEntry.value[0];
                markerAndListener = firstEntry.value[1];
                this.state.unused[kind].delete(oldId);
                markerAndListener.marker.map = this.MAP; // because unused has map=null
                // assuming invariant that unused[key] has correct content type
            } else {
                const img = document.createElement('img');
                img.loading = 'lazy';
                let content: HTMLElement;
                if (kind === 'img') {
                    content = img;
                } else {
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
        let img: HTMLImageElement;
        if (spanText === undefined) {
            img = marker.content as HTMLImageElement;
        } else {
            const div = marker.content as HTMLDivElement;
            img = div.children[0] as HTMLImageElement;
            const span = div.children[1] as HTMLSpanElement;
            span.textContent = spanText;
        }
        if (img.src !== src) img.src = src;
        if (img.className !== imgClassName) img.className = imgClassName;
        const listener = onClick ? marker.addListener('click', onClick) : undefined;

        // Final book-keeping. We've established all the invariants described in Markers type.
        this.state.used[kind].set(id, { marker, listener });
        return marker;
    }

    /**
     * Removes all markers from the map, except for those that were added by
     * addMarker() since the last call to finishAddingMarkers().
     */
    public finishAdding(): void {
        // In case the user called finishAddingMarkers() twice without any intervening addMarkers()
        // to denote a map devoid of markers, we have to enter 'adding' state ourselves.
        const { used: onMap, wasUsed: forImmediateReuse, unused } = MarkerPool.startAddingIfNeeded(this.state);

        // Any remaining markers in immediate-reuse pool are moved to unused-pool
        // We're modifying by reference the same 'unused' that we got by destructuring earlier.
        for (const kind of ['img', 'span'] as const) {
            for (const [id, { marker, listener }] of forImmediateReuse[kind]) {
                marker.map = null; // establish the invariant for unused, that map=null
                listener?.remove(); // establish the invariant for unused, that listener is undefined
                // other invariants (about content-type and key) carry over
                unused[kind].set(id, { marker, listener: undefined });
            }
        }

        this.state = { kind: 'finished', used: onMap, unused };
    }
}


type Imgs = Map<string, HTMLImageElement>;

/**
 * This class is a factory for img elements that belong to a div.
 * It's basically the same as MarkerPool: see comments there.
 * The difference between used and unused elements is whether they're children of 'parent'
 */
export class ImgPool {
    public state: {
        kind: 'finished',
        used: Imgs, // all are children
        unused: Imgs, // all are not children, have onclick=null
    } | {
        kind: 'adding',
        wasUsed: Imgs, // all are children
        used: Imgs, // all are children
        unused: Imgs, // all are not children, have onclick=null
    }

    constructor(private parent: HTMLElement) {
        this.state = {
            kind: 'finished',
            used: new Map(),
            unused: new Map(),
        }
    }

    private static startAddingIfNeeded(state: ImgPool['state']): Extract<ImgPool['state'], { kind: 'adding' }> {
        if (state.kind === 'adding') return state;
        return {
            kind: 'adding',
            wasUsed: state.used,
            used: new Map(),
            unused: state.unused,
        };
    }

    public add(id: string, src: string): HTMLImageElement {
        this.state = ImgPool.startAddingIfNeeded(this.state);

        let img = this.state.wasUsed.get(id);
        if (img) {
            this.state.wasUsed.delete(id);
        } else {
            const firstEntry = this.state.unused.entries().next();
            if (!firstEntry.done) {
                const oldId = firstEntry.value[0];
                img = firstEntry.value[1];
                this.state.unused.delete(oldId);
                this.parent.appendChild(img);
            } else {
                img = document.createElement('img');
                img.loading = 'lazy';
                this.parent.appendChild(img);
            }
        }

        if (img.src !== src) img.src = src;
        this.state.used.set(id, img);
        return img;
    }

    public finishAdding(): void {
        const { used, wasUsed, unused } = ImgPool.startAddingIfNeeded(this.state);
        for (const [id, img] of wasUsed) {
            img.remove();
            img.onclick = null;
            unused.set(id, img);
        }
        this.state = { kind: 'finished', used, unused };
    }
}

