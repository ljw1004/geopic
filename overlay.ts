import { authFetch, escapeHtml } from './utils.js';

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

    private overlay!: HTMLElement;
    private img!: HTMLImageElement;
    private video!: HTMLVideoElement;
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
        this.img = this.overlay.querySelector('img.overlay-media')! as HTMLImageElement;
        this.video = this.overlay.querySelector('video.overlay-media')! as HTMLVideoElement;
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

        // Prevent clicks on the error text from closing the overlay
        this.errorText.onclick = (e) => e.stopPropagation();

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

    private setVisibility(mode: 'spinner' | 'image' | 'video' | 'error' | 'dismissed'): void {
        this.overlay.style.display = mode === 'dismissed' ? 'none' : 'flex';
        this.spinner.style.display = mode === 'spinner' ? 'block' : 'none';
        this.img.style.display = mode === 'image' ? 'block' : 'none';
        this.video.style.display = mode === 'video' ? 'block' : 'none';
        this.errorDiv.style.display = mode === 'error' ? 'flex' : 'none';
        this.imageControls.style.display = mode === 'image' ? 'flex' : 'none';
        this.imageControls.classList.toggle('show-initially', mode === 'image');
        if (mode !== 'image') this.img.removeAttribute('src');
        if (mode !== 'video') { this.video.removeAttribute('src'); this.video.pause(); this.video.load(); }
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
        this.errorText.innerHTML = messageHtml + (detailsText ? `<br/><br/>${escapeHtml(detailsText)}` : '');
    }

    /**
     * Shows the overlay with the specified driveItem id.
     * Spinner is shown at start, until video/image is loaded or error is displayed
     */
    public async showId(id: string): Promise<void> {
        this.setIdAndUpdateNav(id);
        this.setVisibility('spinner');

        const r = await authFetch(`https://graph.microsoft.com/v1.0/me/drive/items/${id}?expand=tags,thumbnails`);
        if (!r.ok) {
            this.showError('Unable to retrieve from OneDrive', await r.text());
            return;
        }
        const driveItem = await r.json();
        if (!driveItem.thumbnails || driveItem.thumbnails.length === 0 || !driveItem.thumbnails[0].large) {
            this.showError('Unable to retrieve from OneDrive', 'missing thumbnails');
            return;
        }

        const onError = (e: string | Event): void => {
            this.showError(`Unable to show image.<br/><a href="${driveItem.webUrl}" target="geo-pic-image">Open in OneDrive</a>`, e instanceof ErrorEvent ? e.message : typeof e === 'string' ? e : undefined);
        }
        if (driveItem.video) {
            this.video.onloadeddata = () => this.setVisibility('video');
            this.video.onerror = onError;
            this.video.src = driveItem['@microsoft.graph.downloadUrl'];
        } else {
            const tagList = (driveItem.tags || []).map((t: any) => t.name).map(escapeHtml);
            const tags = tagList.length > 0 ? `<br/>[${tagList.join(', ')}]` : '';
            const date = new Date(driveItem.lastModifiedDateTime).toLocaleDateString();
            this.imageDescription.innerHTML = `${date} &bull; ${driveItem.name}${tags}<br/><a href="${driveItem.webUrl}" target="geopic-image">Click to open full image in OneDrive</a>`;
            this.img.onload = () => this.setVisibility('image');
            this.img.onerror = onError;
            this.img.src = driveItem.thumbnails[0].large.url;
        }
    }

    /**
     * This is an alternative to showId, for when we have a dataUrl that can be shown immediately
     */
    public showDataUrl(id: string, url: string, descriptionHtml: string): void {
        this.setIdAndUpdateNav(id, false);
        this.setVisibility('image');
        this.imageDescription.innerHTML = descriptionHtml;
        this.img.src = url;
    }

    private dismiss(): void {
        if (document.fullscreenElement) document.exitFullscreen();
        this.setVisibility('dismissed');
        this.setIdAndUpdateNav(undefined);
    }
}