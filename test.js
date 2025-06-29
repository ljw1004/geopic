import { fetchAsync } from './index.js';
export async function testFetch() {
    const r = await fetchAsync('GET', `https://graph.microsoft.com/v1.0/me/drive/items/92917DCE344E62BC!342443/children?$expand=thumbnails&$select=id,name,size,folder,lastModifiedDateTime,cTag,eTag`);
    console.log(JSON.stringify(r, null, 2));
}
export async function testCache() {
    const appFolderResponse = await fetchAsync('GET', 'https://graph.microsoft.com/v1.0/me/drive/special/approot');
    console.log('App folder ID:', appFolderResponse.id);
    const data = { foo: 1, bar: { a: 2, b: 3 } };
    const writeResponse = await fetchAsync('PUT', `https://graph.microsoft.com/v1.0/me/drive/special/approot:/file1.json:/content`, JSON.stringify(data), 'application/json');
    console.log(JSON.stringify(writeResponse, null, 2));
    const readResponse = await fetchAsync('GET', `https://graph.microsoft.com/v1.0/me/drive/special/approot:/file1.json:/content`);
    console.log(JSON.stringify(readResponse, null, 2));
}
export async function testBatch() {
    const folderIds = [
        "92917DCE344E62BC!342443",
        "92917DCE344E62BC!324268",
        "92917DCE344E62BC!324269",
        "92917DCE344E62BC!76025",
        "92917DCE344E62BC!325738",
    ];
    const readFiles = ["file1.json", "file2.json"];
    const writeFiles = ["file3.json", "file4.json"];
    const folderRequests = folderIds.map((id) => ({
        id: `folder-${id}`,
        method: 'GET',
        url: `/me/drive/items/${id}`
    }));
    const readRequests = readFiles.map((name) => ({
        id: `read-${name}`,
        method: 'GET',
        url: `/me/drive/special/approot:/${name}:/content`
    }));
    const writeRequests = writeFiles.map((name) => ({
        id: `write-${name}`,
        method: 'PUT',
        url: `/me/drive/special/approot:/${name}:/content`,
        body: { foo: 1, bar: 2 },
        headers: { 'Content-Type': 'application/json' }
    }));
    // This helper cleans up some idiosyncrasies of the batch response:
    // 1. GET :/content usually returns 302 redirect, which "fetch" follows automatically, but "batch" doesn't.
    //    This functino therefore follows redirects. Similar to fetchAsync, the body is either JSON object or string,
    //    depending on whether content-type includes 'application/json'.
    // 2. GET :/content with error response, and PUT :/content with its driveItem response, claim to return application/json body.
    //    They do that when fetched individually. But in the batch response, they return a base64-encoded string of that json.
    //    This is mentioned here https://learn.microsoft.com/en-us/answers/questions/1352007/using-batching-with-the-graph-api-returns-the-body
    //    Problem is, there's no generic way for us to tell! What if the response itself truly was base64?
    //    what if the response was a real string which also happened to be base-64 decodable?
    //    We'll recover one common case (where the response claims to be content-type application/json but it's a string),
    //    but it's all heuristic and you're basically on your own.
    async function postprocessBatchResponse(response) {
        const promises = [];
        for (const r of response.responses) {
            if (r.status === 302) { // redirect
                promises.push(fetch(r["headers"]["Location"]).then(async (rr) => {
                    r.headers = {};
                    rr.headers.forEach((value, key) => r.headers[key] = value);
                    r.status = rr.status;
                    r.body = (rr.headers.get('Content-Type')?.includes('application/json')) ? await rr.json() : await rr.text();
                }));
            }
            else if (r["headers"]?.["Content-Type"]?.includes('application/json') && typeof r.body === 'string') {
                r.body = JSON.parse(atob(r.body));
            }
        }
        await Promise.all(promises);
        return response;
    }
    const batch1Response = await fetchAsync('POST', 'https://graph.microsoft.com/v1.0/$batch', JSON.stringify({ requests: [...readRequests, ...writeRequests, ...folderRequests] }), 'application/json');
    console.log(JSON.stringify(await postprocessBatchResponse(batch1Response), null, 2));
}
//# sourceMappingURL=test.js.map