# Geopic for OneDrive

**Geopic** is a fast way to browse your OneDrive photo and video collection through space and time.
View your vacation photos on an interactive world map. Zoom in to photos from home when your kids
were young. It's free.
* Use it now: https://unto.me/geopic
* Video demo: https://youtu.be/s5_HOz0dX84

![Geopic Preview](preview.jpg)

## How it works

*Your photos remain private!* Everything remains on your own personal OneDrive. All Geopics does is
read your Photos folder from OneDrive, store its index from OneDrive for faster viewing.
The photos never go anywhere else other than your personal OneDrive and your web browser.

**Relive your travels**. Click anywhere on the world map to see photos you took there. Zoom into
your hometown, that beach in Hawaii, or the city you visited last summer. You can also right-click to zoom out.

**Slideshow mode**. Click on an image to enlarge it. While looking at photos/videos, there's
also a full-screen button at the bottom right, and left/right buttons to either side.
Click again (or press Escape) to dismiss and go back to the map.

**Search your collection**. Search for "Person" to find family photos, "Flower" for garden shots,
"2024" to see last year's adventures, ".mov" (iPhone) or ".mp4" (Android) to find your videos,
"London" to zoom the map there. Search works on photo tags, folder names, filenames, and places.

**Find specific memories**. Use the timeline at the top left to jump to "that amazing week in Italy"
or "when my kids were toddlers". Drag to select date-ranges. You can also zoom in to narrow it down.

*Geopic is still work in progress*. It sometimes feels a bit janky when you click or zoom and it doesn't do what you think it was going to do. I'm working on that...

## Troubleshooting

*How do I get started with OneDrive?* Back up all your phone's photos with the app: [Download on the App Store](https://apps.apple.com/us/app/microsoft-onedrive/id477537958) for iOS, or [Get it on Google Play](https://play.google.com/store/apps/details?id=com.microsoft.skydrive&hl=en_US) for Android. Under Settings, turn on "Camera Backup" to upload all existing photos and automatically upload new ones. Most users will need a paid plan to get more OneDrive storage, but their [subscription plans](https://www.microsoft.com/en-us/microsoft-365/onedrive/compare-onedrive-plans) are better value for money than iCloud or Google Photos.

*Missing old photos?* Geopic only shows photos that have time and location geotags. I used to
use a digital camera until 2016 so none of my old photos have geotags and they don't show up here;
only the new ones I took with my iPhone since then. I've been gradually adding tags
to old photos with the free [GeoTag](https://apps.apple.com/us/app/geotag/id1465180184) app for Mac.

*Missing recent photos?* Make sure the OneDrive app on your phone has "Camera Backup" turned on,
and is working. Sometimes it turns off by itself, for example when you upgrade your phone's version.

*Keyword searches not working?* Keyword filters are only based on a photo's folder name, filename,
and the AI-powered tags that OneDrive itself applied to them (and it only has a few fairly generic
tags like Person, Fashion, Flower, Restaurant). If you search for a family member name like "Fred"
that won't work because OneDrive doesn't use personal information in its tags.
You can see what tags OneDrive chose for a photo when you enlarge it.
When you type in a placename like "Paris" that doesn't work by keyword filters; instead it zooms
the map to that place.

*Why do photos look blurry?* To keep things fast, Geopics shows at most an 800x600 pixel version of your photos. To get full resolution, click the "Open in OneDrive" link.

*Stuck/error while indexing?* Building an index is demanding! It needs to read every single photo from
your OneDrive! Sometimes you'll see "throttling" when Microsoft's OneDrive servers have rate-limited
you. That's normal, and Geopic will keep trying until they're free.
Sometimes the servers will just randomly stalll or flake out and you might see no progress for ten
minutes, or an error message. Try refreshing and try again: it will pick up where it left off.
If that doesn't work then logout ⏏, reload the page, and try again.
If you keep getting an error message every single time, please create an issue here on github.
You should copy+paste the exact error text that it produced.

*Doesn't work on mobile?* Sorry, Geopic has only been designed for desktop, and has only been tested on
Chrome. Mobile support is work in progress.

*Google Photos, or iCloud?* Geopic is only for OneDrive.
If you're paying for iCloud then you can already use the Photos > Collections > Map on your iPhone/iPad
(and I hope you don't mind 50gb of your phone used for "optimized storage" for your 500gb iCloud
collection...) If you're paying for Google Photos then you can already use Photos > Your Map on your
Android device. As far as I'm aware, neither offer the same filtering ability as Geopic.

## Contributing and self-hosting

This is a hobby project. I made it just because I needed a better way to view my photo archive.
I hope you enjoy using it, or enhancing it, or taking the code and hosting it on your own website.
And if the OneDrive folks over at Microsoft decide to incorporate this kind of thing, please do!

1. `npm install` first time
2. `tsc` or `tsc --watch` to typecheck+build
3. View index.html in its intended final domain, in a web-browser...

This index.html is only functional in its intended final domain. This is because of two keys. If you are forking for your own domain, you'll need to get your own keys.
* **OneDrive Integration**: You need to register an application in the [Microsoft Azure Portal](https://portal.azure.com/) under your web domain, and get the CLIENT_ID key (stored in index.ts). The CLIENT_ID is tied specifically to that domain: when it does OAuth2 redirection, OneDrive checks CLIENT_ID, looks up its internal database of how the app is registered, and only allows authentication redirects to its registered redirect URI. The CLIENT_ID currently in index.ts only allows redirects to https://unto.me/geopics -- hosting it anywhere else won't work.
* **Google Maps integration**. You need to register yourself for Google Maps in the [Google Cloud Console](https://console.cloud.google.com/) and get a key. In the registration, you should remember to configure it to only allow Google Maps API requests from the domain you name. We pass the key in via the <script/> tag in index.html. The key currently in index.html only allows Google Maps API requests from https://unto.me/geopics -- hosting it anywhere else won't allow the Google Maps API calls to work.

I made a funny observation. The OneDrive thumbnail urls are 1.8k long. The small thumbnail content itself
when encoded as a data-url is just 2.0k long. So it'd be better for OneDrive to serve them as data!