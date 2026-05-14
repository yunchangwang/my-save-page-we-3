"use strict";

function toHeaderArray(headers = {})
{
    return Object.entries(headers).map(([name, value]) => ({
        name,
        value: Array.isArray(value) ? value.join(", ") : String(value)
    }));
}

function isHttpUrl(urlString)
{
    return /^https?:/i.test(urlString || "");
}

function parseUrlParts(urlString)
{
    try {
        const url = new URL(urlString);
        return {
            queryString: Array.from(url.searchParams.entries()).map(([name, value]) => ({ name, value })),
            path: `${url.pathname}${url.search}`
        };
    } catch {
        return {
            queryString: [],
            path: urlString
        };
    }
}

function toCookies(headers = {})
{
    const cookieHeader = headers.Cookie || headers.cookie;

    if (!cookieHeader || typeof cookieHeader !== "string") {
        return [];
    }

    return cookieHeader.split(/;\s*/).filter(Boolean).map((item) => {
        const [name, ...rest] = item.split("=");
        return {
            name,
            value: rest.join("=")
        };
    });
}

function normalizeHttpVersion(protocol)
{
    const value = String(protocol || "").toLowerCase();

    if (!value) {
        return "unknown";
    }

    if (value === "http/1.0") {
        return "HTTP/1.0";
    }

    if (value === "http/1.1") {
        return "HTTP/1.1";
    }

    if (value === "h2" || value === "http/2" || value === "http2") {
        return "HTTP/2";
    }

    if (value === "h3" || value === "http/3" || value === "http3") {
        return "HTTP/3";
    }

    return String(protocol);
}

function millisecondsBetween(start, end)
{
    if (typeof start !== "number" || typeof end !== "number" || end < start) {
        return 0;
    }

    return Math.round((end - start) * 1000);
}

function buildTimings(entry)
{
    const responseTiming = entry.response?.timing;

    if (!responseTiming) {
        const total = millisecondsBetween(entry.startedMonotonicTime, entry.finishedMonotonicTime);
        return {
            blocked: 0,
            dns: -1,
            connect: -1,
            ssl: -1,
            send: 0,
            wait: total,
            receive: 0
        };
    }

    const dns = responseTiming.dnsEnd >= 0 && responseTiming.dnsStart >= 0
        ? Math.max(0, responseTiming.dnsEnd - responseTiming.dnsStart)
        : -1;
    const connect = responseTiming.connectEnd >= 0 && responseTiming.connectStart >= 0
        ? Math.max(0, responseTiming.connectEnd - responseTiming.connectStart)
        : -1;
    const ssl = responseTiming.sslEnd >= 0 && responseTiming.sslStart >= 0
        ? Math.max(0, responseTiming.sslEnd - responseTiming.sslStart)
        : -1;
    const send = responseTiming.sendEnd >= 0 && responseTiming.sendStart >= 0
        ? Math.max(0, responseTiming.sendEnd - responseTiming.sendStart)
        : 0;
    const wait = responseTiming.receiveHeadersEnd >= 0 && responseTiming.sendEnd >= 0
        ? Math.max(0, responseTiming.receiveHeadersEnd - responseTiming.sendEnd)
        : 0;
    const total = millisecondsBetween(entry.startedMonotonicTime, entry.finishedMonotonicTime);
    const receive = Math.max(0, total - send - wait);

    return {
        blocked: 0,
        dns,
        connect,
        ssl,
        send,
        wait,
        receive
    };
}

function buildEntry(entry)
{
    const request = entry.request ?? {};
    const response = entry.response ?? {};
    const startedDateTime = entry.wallTime
        ? new Date(entry.wallTime * 1000).toISOString()
        : new Date().toISOString();
    const totalTime = millisecondsBetween(entry.startedMonotonicTime, entry.finishedMonotonicTime);
    const requestHeaders = entry.requestHeaders ?? request.headers ?? {};
    const responseHeaders = entry.responseHeaders ?? response.headers ?? {};
    const { queryString, path } = parseUrlParts(request.url ?? "");
    const responseContentSize = typeof response.encodedDataLength === "number"
        ? response.encodedDataLength
        : entry.encodedDataLength ?? 0;
    const httpVersion = normalizeHttpVersion(response.protocol);
    const requestBodySize = typeof request.postData === "string" ? request.postData.length : 0;
    const content = {
        size: responseContentSize,
        compression: 0,
        mimeType: response.mimeType ?? "application/octet-stream"
    };

    if (typeof entry.responseBody === "string") {
        content.text = entry.responseBody;

        if (entry.responseBodyIsBase64) {
            content.encoding = "base64";
        }
    }

    return {
        startedDateTime,
        time: totalTime,
        request: {
            method: request.method ?? "GET",
            url: request.url ?? "",
            httpVersion,
            cookies: toCookies(requestHeaders),
            headers: toHeaderArray(requestHeaders),
            queryString,
            headersSize: -1,
            bodySize: requestBodySize,
            postData: typeof request.postData === "string"
                ? {
                    mimeType: requestHeaders["Content-Type"] || requestHeaders["content-type"] || "",
                    text: request.postData
                }
                : undefined
        },
        response: {
            status: response.status ?? 0,
            statusText: response.statusText ?? "",
            httpVersion,
            cookies: [],
            headers: toHeaderArray(responseHeaders),
            content,
            redirectURL: responseHeaders.Location || responseHeaders.location || "",
            headersSize: -1,
            bodySize: responseContentSize
        },
        cache: {},
        timings: buildTimings(entry),
        pageref: entry.pageRef
    };
}

function buildPage(recording)
{
    return {
        startedDateTime: new Date(recording.startedAt).toISOString(),
        id: recording.pageRef,
        title: recording.title || recording.url || `Tab ${recording.tabId}`,
        pageTimings: {
            onContentLoad: -1,
            onLoad: -1
        }
    };
}

export function buildHar(recording)
{
    return buildMergedHar([recording]);
}

export function buildMergedHar(recordings)
{
    const pages = recordings.map(buildPage);
    const mergedEntries = recordings
        .flatMap((recording) => recording.entries)
        .filter((entry) => isHttpUrl(entry.request?.url))
        .sort((left, right) => {
            const leftTime = typeof left.wallTime === "number" ? left.wallTime : left.pageStartedAt / 1000;
            const rightTime = typeof right.wallTime === "number" ? right.wallTime : right.pageStartedAt / 1000;
            return leftTime - rightTime;
        })
        .map(buildEntry);

    return {
        log: {
            version: "1.2",
            creator: {
                name: "Save Page WE - HAR Capture",
                version: "33.9"
            },
            browser: {
                name: "Chromium",
                version: "MV3"
            },
            pages,
            entries: mergedEntries
        }
    };
}
