# GeoPic

This code powers a webpage that shows your OneDrive photos in a map.


## Contributing

1. `npm install` first time
2. `tsc` or `tsc --watch` to typecheck+build
3. View index.html in its intended final domain, in a web-browser...

This index.html is only functional in its intended final domain. This is because of two keys. If you are forking for your own domain, you'll need to get your own keys.
* **OneDrive Integration**: You need to register an application in the [Microsoft Azure Portal](https://portal.azure.com/) under your web domain, and get the CLIENT_ID key (stored in index.ts). The CLIENT_ID is tied specifically to that domain: when it does OAuth2 redirection, OneDrive checks CLIENT_ID, looks up its internal database of how the app is registered, and only allows authentication redirects to its registered redirect URI. The CLIENT_ID currently in index.ts only allows redirects to https://unto.me/geopics -- hosting it anywhere else won't work.
* **Google Maps integration**. You need to register yourself for Google Maps in the [Google Cloud Console](https://console.cloud.google.com/) and get a key. In the registration, you should remember to configure it to only allow Google Maps API requests from the domain you name. We pass the key in via the <script/> tag in index.html. The key currently in index.html only allows Google Maps API requests from https://unto.me/geopics -- hosting it anywhere else won't allow the Google Maps API calls to work.
