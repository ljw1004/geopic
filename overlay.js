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
    siblingGetter = undefined;
    currentId;
    media = new Map();
    overlay;
    spinner;
    errorDiv;
    errorText;
    imageControls;
    imageFullscreen;
    imageDescription;
    navLeftIcon;
    navRightIcon;
    constructor() {
        this.overlay = document.getElementById('overlay');
        this.spinner = this.overlay.querySelector('.overlay-spinner');
        this.errorDiv = this.overlay.querySelector('.overlay-error');
        this.errorText = this.overlay.querySelector('.overlay-error-text');
        this.imageControls = this.overlay.querySelector('.overlay-image-controls');
        this.imageFullscreen = this.overlay.querySelector('.overlay-image-fullscreen-icon');
        this.imageDescription = this.overlay.querySelector('.overlay-image-description');
        this.navLeftIcon = this.overlay.querySelector('.overlay-nav-icon.left');
        this.navRightIcon = this.overlay.querySelector('.overlay-nav-icon.right');
        // Prevent clicks on error text and controls from closing overlay
        this.errorText.onclick = (e) => e.stopPropagation();
        this.imageControls.onclick = (e) => e.stopPropagation();
        this.imageDescription.onclick = (e) => {
            // Allow clicks on links to work, but still prevent overlay dismissal
            e.stopPropagation();
            // If clicking on a link within description, dismiss overlay
            if (e.target.tagName === 'A') {
                this.dismiss();
            }
        };
        // Navigation
        const navigate = (direction) => {
            if (!this.currentId)
                return;
            const newId = this.siblingGetter ? this.siblingGetter(this.currentId, direction) : undefined;
            if (newId)
                this.showId(newId);
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
            }
            else {
                this.overlay.requestFullscreen();
            }
        };
        document.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) {
                this.imageControls.style.display = 'none';
            }
            else {
                if (this.currentId)
                    this.dismiss();
            }
        });
        // ESC key to dismiss overlay
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.currentId) {
                this.dismiss();
            }
        });
    }
    setVisibility(mode) {
        for (const [_, media] of this.media) {
            if (mode === 'error' || mode === 'dismissed') {
                this.mediaRemove(media);
            }
            else if (this.currentId === media.id && media.state === 'loaded') {
                if (media.element.parentNode === null) {
                    this.overlay.appendChild(media.element);
                    if (media.element instanceof HTMLVideoElement) {
                        media.element.controls = true;
                        media.element.currentTime = 0;
                        media.element.play().catch(() => { });
                    }
                    else if (media.element instanceof HTMLImageElement) {
                        // Restart the show-initially animation
                        this.imageControls.classList.remove('show-initially');
                        void this.imageControls.offsetWidth; // Force reflow
                        this.imageControls.classList.add('show-initially');
                    }
                }
            }
            else {
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
    setIdAndUpdateNav(id, allowNav = true) {
        this.currentId = id;
        const prevId = this.siblingGetter && id ? this.siblingGetter(id, 'prev') : undefined;
        const nextId = this.siblingGetter && id ? this.siblingGetter(id, 'next') : undefined;
        this.navLeftIcon.classList.toggle('enabled', Boolean(prevId) && allowNav);
        this.navRightIcon.classList.toggle('enabled', Boolean(nextId) && allowNav);
    }
    /**
     * Shows an error icon with message.
     */
    showError(messageHtml, detailsText) {
        this.setVisibility('error');
        const detailsHtml = detailsText ? `<br/><br/>${detailsText.split(' - ').map(escapeHtml).join('<br/>')}` : '';
        this.errorText.innerHTML = messageHtml + detailsHtml;
    }
    /**
     * Shows the overlay with the specified driveItem id.
     * Spinner is shown at start, until video/image is loaded or error is displayed
     */
    showId(id) {
        this.setIdAndUpdateNav(id);
        const nextId = this.siblingGetter && id ? this.siblingGetter(id, 'next') : undefined;
        for (const [_, media] of this.media) {
            if (media.id === id && media.state !== 'error')
                continue;
            else if (media.id === nextId)
                continue;
            this.mediaRemove(media);
        }
        this.mediaStart(id, nextId).catch(err => console.error(err));
        this.setVisibility('media');
    }
    /**
     * This is an alternative to showId, for when we have a dataUrl that can be shown immediately
     */
    showDataUrl(id, url, descriptionHtml) {
        this.setIdAndUpdateNav(id, false);
        this.media.forEach(media => this.mediaRemove(media));
        this.media.clear();
        const element = document.createElement('img');
        element.className = 'overlay-media';
        element.src = url;
        this.media.set(id, { id, element, descriptionHtml, state: 'loaded' });
        this.setVisibility('media');
    }
    /**
     * To hide the overlay, i.e. go back to map+histogram+thumbnails view.
     */
    dismiss() {
        if (document.fullscreenElement)
            document.exitFullscreen();
        this.setVisibility('dismissed');
        this.setIdAndUpdateNav(undefined);
    }
    /**
     * This function will create a 'loading' media element for id if one's not already there,
     * and once it has loaded (i.e. image has loaded or the video has started) then it'll also
     * create a 'loading' media element for nextId too. (The reason for this delay is
     * so that the current video's loading doesn't get slowed down by the next one's).
     */
    async mediaStart(id, nextId) {
        if (this.media.has(id)) {
            // If 'id' is already present then we don't need to do anything.
            // But we no longer have opportunity in its onLoad to also start nextId, so we'll do so now.
            // Note: mediaStart() is protected against multiple people calling it for the same id,
            // so it doesn't matter if we try to start it now and someone else was going to start it too.
            if (nextId)
                this.mediaStart(nextId, undefined).catch(err => console.error(err));
            return;
        }
        this.media.set(id, { id, element: undefined, state: 'loading', descriptionHtml: undefined });
        const error = (html, text) => {
            // Time might have passed, and media might no longer exist, so we have to recheck.
            const media = this.media.get(id);
            if (!media)
                return;
            media.state = 'error';
            if (this.currentId === id)
                this.showError(html, text);
            return;
        };
        // Fetch the onedrive item
        const onedriveErrorHtml = 'Unable to retrieve from OneDrive';
        const r = await authFetch(`https://graph.microsoft.com/v1.0/me/drive/items/${id}?expand=tags,thumbnails`, noRetryOn429);
        if (!r.ok)
            return error(onedriveErrorHtml, await r.text());
        const driveItem = await r.json();
        if (!driveItem.thumbnails || driveItem.thumbnails.length === 0 || !driveItem.thumbnails[0].large)
            return error(onedriveErrorHtml, 'missing thumbnails');
        // Fetch the image/video
        // Time might have passed during "authFetch", so we have to recheck whether media still exists.
        const media = this.media.get(id);
        if (!media)
            return;
        const onError = (e) => {
            const mediaErrorHtml = `Unable to show image.<br/><a href="${driveItem.webUrl}" target="geo-pic-image">Open in OneDrive</a>`;
            return error(mediaErrorHtml, e instanceof ErrorEvent ? e.message : typeof e === 'string' ? e : String(e));
        };
        const onLoad = (descriptionHtml) => {
            // Time might have passed during media loading, so we have to recheck.
            const media = this.media.get(id);
            if (!media)
                return;
            media.descriptionHtml = descriptionHtml;
            media.state = 'loaded';
            if (this.currentId === id)
                this.setVisibility('media');
            if (nextId)
                this.mediaStart(nextId, undefined).catch(err => console.error(err));
        };
        if (driveItem.video) {
            media.element = document.createElement('video');
            media.element.className = 'overlay-media';
            media.element.controls = true;
            media.element.onloadeddata = () => onLoad(undefined);
            media.element.onerror = onError;
            media.element.src = driveItem['@microsoft.graph.downloadUrl'];
        }
        else {
            const tagList = (driveItem.tags ?? []).map((t) => t.name).map(escapeHtml);
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
    /**
     * This method thoroughly removes and cleans up a media element:
     * stops it downloading anything, stops it playing if it's a video,
     * removes it from the DOM, removes it from this.media
     */
    mediaRemove(media) {
        if (media.element instanceof HTMLVideoElement) {
            media.element.pause();
            media.element.removeAttribute('src');
            media.element.load();
        }
        else if (media.element instanceof HTMLImageElement) {
            media.element.removeAttribute('src');
        }
        media.element?.remove();
        this.media.delete(media.id);
    }
}
//# sourceMappingURL=overlay.js.map