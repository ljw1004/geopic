/**
 * Copyright (c) Lucian Wischik
 */

import { authFetch, escapeHtml, noRetryOn429 } from './utils.js';

/**
 * Manages a full-page photo/video/error overlay
 * 
 * This class encapsulates all overlay functionality including:
 * - Displaying images and videos from OneDrive
 * - Navigation between items using left/right arrows
 * - Metadata display with auto-hide behavior
 * - Fullscreen mode support
 * - Error handling for failed loads
 * 
 * INVARIANTS:
 * - Only one overlay can be active at a time
 * - currentItem is null when overlay is hidden, non-null when showing
 * - DOM elements are initialized once and reused for all items
 * - Navigation buttons are disabled appropriately based on getSibling callback results
 */
export class Overlay {
    public siblingGetter: undefined | ((id: string, direction: 'prev' | 'next') => string | undefined) = undefined;
    private currentId: string | undefined;
    private media: Map<string, MediaElement> = new Map();

    private overlay!: HTMLElement;
    private spinner!: HTMLElement;
    private errorDiv!: HTMLElement;
    private errorText!: HTMLElement;
    private imageControls!: HTMLElement;
    private imageFullscreen!: HTMLElement;
    private imageDescription!: HTMLElement;
    private navLeftIcon!: HTMLElement;
    private navRightIcon!: HTMLElement;

    constructor() {
        this.overlay = document.getElementById('overlay')!;
        this.spinner = this.overlay.querySelector('.overlay-spinner')!;
        this.errorDiv = this.overlay.querySelector('.overlay-error')!;
        this.errorText = this.overlay.querySelector('.overlay-error-text')!;
        this.imageControls = this.overlay.querySelector('.overlay-image-controls')!;
        this.imageFullscreen = this.overlay.querySelector('.overlay-image-fullscreen-icon')!;
        this.imageDescription = this.overlay.querySelector('.overlay-image-description')!;
        this.navLeftIcon = this.overlay.querySelector('.overlay-nav-icon.left')!;
        this.navRightIcon = this.overlay.querySelector('.overlay-nav-icon.right')!;

        // Prevent clicks on error text and controls from closing overlay
        this.errorText.onclick = (e) => e.stopPropagation();
        this.imageControls.onclick = (e) => e.stopPropagation();
        this.imageDescription.onclick = (e) => {
            // Allow clicks on links to work, but still prevent overlay dismissal
            e.stopPropagation();
            // If clicking on a link within description, dismiss overlay
            if ((e.target as HTMLElement).tagName === 'A') {
                this.dismiss();
            }
        };

        // Navigation
        const navigate = (direction: 'next' | 'prev'): void => {
            if (!this.currentId) return;
            const newId = this.siblingGetter ? this.siblingGetter(this.currentId, direction) : undefined;
            if (newId) this.showId(newId);
        };
        this.navLeftIcon.onclick = (e) => {
            e.stopPropagation();
            navigate('prev');
        };
        this.navRightIcon.onclick = (e) => {
            e.stopPropagation();
            navigate('next');
        };

        // Clicks on error area should close overlay
        this.overlay.onclick = () => this.dismiss();

        // Fullscreen
        this.imageFullscreen.onclick = (e) => {
            e.stopPropagation();
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                this.overlay.requestFullscreen();
            }
        };
        document.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) {
                this.imageControls.style.display = 'none';
            } else {
                if (this.currentId) this.dismiss();
            }
        });

        // ESC key to dismiss overlay
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.currentId) {
                this.dismiss();
            }
        });
    }

    private setVisibility(mode: 'media' | 'error' | 'dismissed'): void {
        for (const [_, media] of this.media) {
            if (mode === 'error' || mode === 'dismissed') {
                this.mediaRemove(media);
            } else if (this.currentId === media.id && media.state === 'loaded') {
                if (media.element!.parentNode === null) {
                    this.overlay.appendChild(media.element!);
                    if (media.element instanceof HTMLVideoElement) {
                        media.element.controls = true;
                        media.element.currentTime = 0;
                        media.element.play().catch(() => { });
                    } else if (media.element instanceof HTMLImageElement) {
                        // Restart the show-initially animation
                        this.imageControls.classList.remove('show-initially');
                        void this.imageControls.offsetWidth; // Force reflow
                        this.imageControls.classList.add('show-initially');
                    }
                }
            } else {
                media.element?.remove();
                if (media.element instanceof HTMLVideoElement) {
                    media.element.pause();
                }
            }
        }
        const showImageControls = mode === 'media' && this.currentId !== undefined && this.media.get(this.currentId)?.element instanceof HTMLImageElement;
        const showSpinner = mode === 'media' && this.currentId && this.media.get(this.currentId)?.state === 'loading';

        this.overlay.style.display = mode === 'dismissed' ? 'none' : 'flex';
        this.spinner.style.display = showSpinner ? 'block' : 'none';
        this.errorDiv.style.display = mode === 'error' ? 'flex' : 'none';
        this.imageControls.style.display = showImageControls ? 'flex' : 'none';
        this.imageControls.classList.toggle('show-initially', showImageControls);
        this.imageDescription.innerHTML = this.currentId ? this.media.get(this.currentId)?.descriptionHtml ?? '' : '';
    }

    private setIdAndUpdateNav(id: string | undefined, allowNav: boolean = true): void {
        this.currentId = id;
        const prevId = this.siblingGetter && id ? this.siblingGetter(id, 'prev') : undefined;
        const nextId = this.siblingGetter && id ? this.siblingGetter(id, 'next') : undefined;
        this.navLeftIcon.classList.toggle('enabled', Boolean(prevId) && allowNav);
        this.navRightIcon.classList.toggle('enabled', Boolean(nextId) && allowNav);
    }

    /**
     * Shows an error icon with message.
     */
    public showError(messageHtml: string, detailsText: string | undefined): void {
        this.setVisibility('error');
        const detailsHtml = detailsText ? `<br/><br/>${detailsText.split(' - ').map(escapeHtml).join('<br/>')}` : '';
        this.errorText.innerHTML = messageHtml + detailsHtml;
    }

    /**
     * Shows the overlay with the specified driveItem id.
     * Spinner is shown at start, until video/image is loaded or error is displayed
     */
    public showId(id: string): void {
        this.setIdAndUpdateNav(id);
        const nextId = this.siblingGetter && id ? this.siblingGetter(id, 'next') : undefined;

        for (const [_, media] of this.media) {
            if (media.id === id && media.state !== 'error') continue;
            else if (media.id === nextId) continue;
            this.mediaRemove(media);
        }
        if (!this.media.has(id)) {
            this.media.set(id, { id, element: undefined, state: 'loading', descriptionHtml: undefined });
            this.mediaStart(id).catch(err => console.error(err));
        }
        if (nextId && !this.media.has(nextId)) {
            this.media.set(nextId, { id: nextId, element: undefined, state: 'loading', descriptionHtml: undefined });
            this.mediaStart(nextId).catch(err => console.error(err));
        }
        this.setVisibility('media');
    }

    /**
     * This is an alternative to showId, for when we have a dataUrl that can be shown immediately
     */
    public showDataUrl(id: string, url: string, descriptionHtml: string): void {
        this.setIdAndUpdateNav(id, false);
        this.media.forEach(media => this.mediaRemove(media));
        this.media.clear();
        this.media.set(id, this.mediaCreateFromDataUrl(id, url, descriptionHtml));
        this.setVisibility('media');
    }

    private dismiss(): void {
        if (document.fullscreenElement) document.exitFullscreen();
        this.setVisibility('dismissed');
        this.setIdAndUpdateNav(undefined);
    }


    /**
     * MEDIA MANAGEMENT
     */

    async mediaStart(id: string): Promise<void> {
        const error = (html: string, text: string): void => {
            // Time might have passed, and media might no longer exist, so we have to recheck.
            const media = this.media.get(id);
            if (!media) return;
            media.state = 'error';
            if (this.currentId === id) this.showError(html, text);
            return;
        };

        // Fetch the onedrive item
        const onedriveErrorHtml = 'Unable to retrieve from OneDrive';
        const r = await authFetch(`https://graph.microsoft.com/v1.0/me/drive/items/${id}?expand=tags,thumbnails`, noRetryOn429);
        if (!r.ok) return error(onedriveErrorHtml, await r.text());
        const driveItem = await r.json();
        if (!driveItem.thumbnails || driveItem.thumbnails.length === 0 || !driveItem.thumbnails[0].large) return error(onedriveErrorHtml, 'missing thumbnails');

        // Fetch the image/video
        // Time might have passed during "authFetch", so we have to recheck whether media still exists.
        const media = this.media.get(id);
        if (!media) return;

        const onError = (e: string | Event): void => {
            const mediaErrorHtml = `Unable to show image.<br/><a href="${driveItem.webUrl}" target="geo-pic-image">Open in OneDrive</a>`;
            return error(mediaErrorHtml, e instanceof ErrorEvent ? e.message : typeof e === 'string' ? e : String(e));
        };
        const onLoad = (descriptionHtml: string | undefined) => {
            // Time might have passed during media-load, so we have to recheck.
            const media = this.media.get(id);
            if (!media) return;
            media.descriptionHtml = descriptionHtml;
            media.state = 'loaded';
            if (this.currentId === id) this.setVisibility('media');
        };

        if (driveItem.video) {
            media.element = document.createElement('video');
            media.element.className = 'overlay-media';
            media.element.controls = true;
            media.element.onloadeddata = () => onLoad(undefined);
            media.element.onerror = onError;
            media.element.src = driveItem['@microsoft.graph.downloadUrl'];
        } else {
            const tagList = (driveItem.tags ?? []).map((t: any) => t.name).map(escapeHtml);
            const tags = tagList.length > 0 ? `<br/>[${tagList.join(', ')}]` : '';
            const date = new Date(driveItem.photo.takenDateTime).toLocaleDateString();
            const descriptionHtml = `${date} &bull; ${driveItem.name}${tags}<br/><a href="${driveItem.webUrl}" target="geopic-image">Click to open full image in OneDrive</a>`;
            media.element = document.createElement('img');
            media.element.className = 'overlay-media';
            media.element.onload = () => onLoad(descriptionHtml);
            media.element.onerror = onError;
            media.element.src = driveItem.thumbnails[0].large.url;
        }
    }

    private mediaCreateFromDataUrl(id: string, url: string, descriptionHtml: string): MediaElement {
        const element = document.createElement('img');
        element.className = 'overlay-media';
        element.src = url;
        return {
            id,
            element,
            descriptionHtml,
            state: 'loaded',
        };
    }

    private mediaRemove(media: MediaElement): void {
        if (media.element instanceof HTMLVideoElement) {
            media.element.pause();
            media.element.removeAttribute('src');
            media.element.load();
        } else if (media.element instanceof HTMLImageElement) {
            media.element.removeAttribute('src');
        }
        media.element?.remove();
        this.media.delete(media.id);
    }

}

/**
 * MediaElement is part of the prefetch strategy. It's based on dynamically creating <img/> or <video/>
 * elements: one for the current item, and one for the next item, stored in the map 'Overlay.media'
 * The goal is that if the user has been viewing an item for a few seconds, and they click 'next', then
 * the next item is likely to already be loaded and we can stick it into the DOM immediately.
 * There's a bit of complexity around
 * - If the user wanted to see an item but it's not yet loaded, then we show a spinner:
 *   setVisibility('media') will do the right thing, showing spinner or showing media element,
 *   according to whether it's loaded. This depends on the 'onLoad' callback for the element
 *   calling setVisibility('media') once the element is loaded, to do the new right thing.
 *   To help this, setVisibility('media') is idempotent: always does the right thing.
 * - If we're loading media asynchronously, but the user clicks through 'next', then the asynchronous
 *   continuation of loading-media might now be out of date. The mediaStart() function handles
 *   this by rechecking the current state after each await.
 * 
 * INVARIANTS:
 * - Overlay.media may contain zero elements (if error/dismissed) or one element (if there's no next)
 *   or two (if there is). Any of these elements may be 'loading', 'loaded' or 'error'.
 * - setVisibility('media') is only called when there is a media element for this.currentId
 *   and when it's in 'loading' or 'loaded' state; never 'error'.
 * - Only the media element for this.currentId is parented into the DOM, and then only if it is loaded.
 *   (not error or loading).
 * - There's at most one parented media element.
 */
interface MediaElement {
    id: string;
    element: HTMLImageElement | HTMLVideoElement | undefined;
    state: 'loading' | 'loaded' | 'error';
    descriptionHtml: string | undefined;
}
