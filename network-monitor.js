"use strict";

/************************************************************************/
/*                                                                      */
/*      Save Page WE - Network Monitor for HAR Capture                 */
/*                                                                      */
/*      Last Edit - 13 May 2026                                         */
/*                                                                      */
/************************************************************************/

import { buildMergedHar } from "./har.js";

const DEBUGGER_VERSION = "1.3";
const recordings = new Map();
const attachedTabIds = new Set();
let recordingSession = null;

/************************************************************************/

function logInfo(message, details)
{
    if (details === undefined) {
        console.info(`[Network Monitor] ${message}`);
        return;
    }
    console.info(`[Network Monitor] ${message}`, details);
}

function logError(message, error)
{
    console.error(`[Network Monitor] ${message}`, error);
}

/************************************************************************/

function getDebuggerTarget(tabId)
{
    return { tabId };
}

function isHttpUrl(url)
{
    return /^https?:/i.test(url || "");
}

/************************************************************************/

function ensureRecording(tabId)
{
    const recording = recordings.get(tabId);
    if (!recording) {
        throw new Error("No recording state found for this tab.");
    }
    return recording;
}

function createRecording(tab)
{
    return {
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title || "",
        url: tab.url || "",
        startedAt: Date.now(),
        pageRef: `page_${tab.id}_${Date.now()}`,
        requests: new Map(),
        entries: []
    };
}

function createRequestEntry(params, recording)
{
    return {
        id: params.requestId,
        pageRef: recording.pageRef,
        tabId: recording.tabId,
        pageTitle: recording.title,
        pageUrl: recording.url,
        pageStartedAt: recording.startedAt,
        request: params.request,
        requestHeaders: params.request.headers || {},
        responseHeaders: {},
        startedMonotonicTime: params.timestamp,
        wallTime: params.wallTime,
        finishedMonotonicTime: params.timestamp,
        type: params.type || "other"
    };
}

function finalizeEntry(recording, entry)
{
    if (!entry) {
        return;
    }
    recording.entries.push(entry);
}

/************************************************************************/

async function fillResponseBody(tabId, entry)
{
    try {
        const result = await chrome.debugger.sendCommand(
            getDebuggerTarget(tabId),
            "Network.getResponseBody",
            { requestId: entry.id }
        );

        entry.responseBody = result?.body ?? "";
        entry.responseBodyIsBase64 = Boolean(result?.base64Encoded);
    } catch (error) {
        entry.responseBodyError = error?.message || String(error);
        logInfo("Response body unavailable", {
            tabId,
            requestId: entry.id,
            url: entry.request?.url,
            error: entry.responseBodyError
        });
    }
}

function finalizePendingRequests(recording)
{
    for (const entry of recording.requests.values()) {
        finalizeEntry(recording, entry);
    }
    recording.requests.clear();
}

function updateRecordingTabMeta(tabId, patch)
{
    const recording = recordings.get(tabId);
    if (!recording) {
        return;
    }
    Object.assign(recording, patch);
}

/************************************************************************/

function getSessionWindowId()
{
    return recordingSession?.windowId ?? null;
}

function isTabInSessionWindow(tab)
{
    return Boolean(recordingSession && tab?.windowId === recordingSession.windowId);
}

function shouldAutoAttachCreatedTab(tab)
{
    if (!recordingSession || tab.windowId !== recordingSession.windowId) {
        return false;
    }

    if (tab.openerTabId == null) {
        return false;
    }

    return attachedTabIds.has(tab.openerTabId) || recordings.has(tab.openerTabId);
}

function hasCompletedData(recording)
{
    return recording.entries.length + recording.requests.size > 0;
}

/************************************************************************/

function handleRequestWillBeSent(tabId, params)
{
    const recording = recordings.get(tabId);
    if (!recording) {
        return;
    }

    if (!isHttpUrl(params.request?.url)) {
        return;
    }

    if (params.redirectResponse) {
        const previousEntry = recording.requests.get(params.requestId);
        if (previousEntry) {
            previousEntry.response = params.redirectResponse;
            previousEntry.responseHeaders = params.redirectResponse.headers || previousEntry.responseHeaders;
            previousEntry.finishedMonotonicTime = params.timestamp;
            finalizeEntry(recording, previousEntry);
            recording.requests.delete(params.requestId);
        }
    }

    const entry = createRequestEntry(params, recording);
    recording.requests.set(params.requestId, entry);
}

function handleRequestExtraInfo(tabId, params)
{
    const recording = recordings.get(tabId);
    const entry = recording?.requests.get(params.requestId);
    if (!entry) {
        return;
    }
    entry.requestHeaders = params.headers || entry.requestHeaders;
}

function handleResponseReceived(tabId, params)
{
    const recording = recordings.get(tabId);
    const entry = recording?.requests.get(params.requestId);
    if (!entry) {
        return;
    }
    entry.response = params.response;
    entry.type = params.type || entry.type;
}

function handleResponseExtraInfo(tabId, params)
{
    const recording = recordings.get(tabId);
    const entry = recording?.requests.get(params.requestId);
    if (!entry) {
        return;
    }
    entry.responseHeaders = params.headers || entry.responseHeaders;
}

async function handleLoadingFinished(tabId, params)
{
    const recording = recordings.get(tabId);
    const entry = recording?.requests.get(params.requestId);
    if (!entry) {
        return;
    }

    entry.finishedMonotonicTime = params.timestamp;
    entry.encodedDataLength = params.encodedDataLength || 0;
    await fillResponseBody(tabId, entry);
    finalizeEntry(recording, entry);
    recording.requests.delete(params.requestId);
}

function handleLoadingFailed(tabId, params)
{
    const recording = recordings.get(tabId);
    const entry = recording?.requests.get(params.requestId);
    if (!entry) {
        return;
    }

    entry.finishedMonotonicTime = params.timestamp;
    entry.errorText = params.errorText;
    finalizeEntry(recording, entry);
    recording.requests.delete(params.requestId);
}

/************************************************************************/

chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId == null) {
        return;
    }

    switch (method) {
        case "Network.requestWillBeSent":
            handleRequestWillBeSent(source.tabId, params);
            break;
        case "Network.requestWillBeSentExtraInfo":
            handleRequestExtraInfo(source.tabId, params);
            break;
        case "Network.responseReceived":
            handleResponseReceived(source.tabId, params);
            break;
        case "Network.responseReceivedExtraInfo":
            handleResponseExtraInfo(source.tabId, params);
            break;
        case "Network.loadingFinished":
            void handleLoadingFinished(source.tabId, params);
            break;
        case "Network.loadingFailed":
            handleLoadingFailed(source.tabId, params);
            break;
        default:
            break;
    }
});

chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId == null) {
        return;
    }

    const recording = recordings.get(source.tabId);
    if (recording) {
        finalizePendingRequests(recording);
    }

    attachedTabIds.delete(source.tabId);
    logInfo("Debugger detached", { tabId: source.tabId });
});

chrome.tabs.onCreated.addListener((tab) => {
    if (!recordingSession || !shouldAutoAttachCreatedTab(tab)) {
        return;
    }

    recordings.set(tab.id, createRecording(tab));
    logInfo("Queued new tab for auto-attach", { tabId: tab.id, openerTabId: tab.openerTabId });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!recordingSession || !isTabInSessionWindow(tab)) {
        return;
    }

    // 过滤扩展页面
    if (tab.url && tab.url.startsWith("chrome-extension://")) {
        return;
    }

    if (tab.pendingUrl && tab.pendingUrl.startsWith("chrome-extension://")) {
        return;
    }

    if (typeof changeInfo.title === "string") {
        updateRecordingTabMeta(tabId, { title: changeInfo.title });
    }

    if (typeof changeInfo.url === "string") {
        updateRecordingTabMeta(tabId, { url: changeInfo.url });
    }

    if (attachedTabIds.has(tabId)) {
        return;
    }

    if (!recordings.has(tabId) && !shouldAutoAttachCreatedTab(tab)) {
        return;
    }

    if (!isHttpUrl(tab.url)) {
        return;
    }

    try {
        await attachTab(tab, { reloadAfterAttach: false });
    } catch (error) {
        logError(`Auto-attach failed for tab ${tabId}`, error);
    }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (!recordingSession || windowId !== recordingSession.windowId || attachedTabIds.has(tabId)) {
        return;
    }

    try {
        const tab = await chrome.tabs.get(tabId);

        // 过滤扩展页面
        if (tab.url && tab.url.startsWith("chrome-extension://")) {
            return;
        }

        if (!tab.url || tab.url === "about:blank") {
            return;
        }

        if (tab.pendingUrl && tab.pendingUrl.startsWith("chrome-extension://")) {
            return;
        }

        if (!isHttpUrl(tab.url)) {
            return;
        }

        if (!recordings.has(tabId)) {
            recordings.set(tabId, createRecording(tab));
        }

        await attachTab(tab, { reloadAfterAttach: false });
    } catch (error) {
        logError(`Activation auto-attach failed for tab ${tabId}`, error);
    }
});

/************************************************************************/

async function attachDebugger(tabId)
{
    await chrome.debugger.attach(getDebuggerTarget(tabId), DEBUGGER_VERSION);
    await chrome.debugger.sendCommand(getDebuggerTarget(tabId), "Network.enable");
}

async function detachDebugger(tabId)
{
    try {
        await chrome.debugger.detach(getDebuggerTarget(tabId));
    } catch {
        // Ignore detach failures when the target is already gone.
    }
}

async function attachTab(tab, options = {})
{
    const { reloadAfterAttach = false } = options;

    if (attachedTabIds.has(tab.id)) {
        return;
    }

    let recording = recordings.get(tab.id);

    if (!recording) {
        recording = createRecording(tab);
        recordings.set(tab.id, recording);
    } else {
        recording.title = tab.title || recording.title;
        recording.url = tab.url || recording.url;
        recording.windowId = tab.windowId;
    }

    logInfo("Attaching tab", { tabId: tab.id, url: tab.url, reloadAfterAttach });
    await attachDebugger(tab.id);
    attachedTabIds.add(tab.id);

    if (reloadAfterAttach) {
        await chrome.tabs.reload(tab.id);
    }
}

/************************************************************************/

export async function startNetworkRecording(tabId)
{
    if (recordingSession) {
        throw new Error("A network recording session is already active.");
    }

    const tab = await chrome.tabs.get(tabId);

    if (!isHttpUrl(tab.url)) {
        throw new Error("The current tab must be an HTTP or HTTPS page.");
    }

    recordings.clear();
    attachedTabIds.clear();
    recordingSession = {
        windowId: tab.windowId,
        startedAt: Date.now(),
        rootTabId: tab.id
    };

    recordings.set(tabId, createRecording(tab));
    await attachTab(tab, { reloadAfterAttach: false });
    logInfo("Started network recording session", { windowId: tab.windowId, rootTabId: tab.id });

    return {
        message: "Network recording session started. This window will auto-attach eligible tabs."
    };
}

export async function stopNetworkRecording()
{
    if (!recordingSession) {
        throw new Error("There is no active network recording session.");
    }

    const tabIds = Array.from(attachedTabIds);

    for (const tabId of tabIds) {
        const recording = recordings.get(tabId);
        if (recording) {
            finalizePendingRequests(recording);
        }
        await detachDebugger(tabId);
        attachedTabIds.delete(tabId);
    }

    const recordedTabCount = Array.from(recordings.values()).filter(hasCompletedData).length;
    recordingSession = null;
    logInfo("Stopped network recording session", { recordedTabCount });

    return { message: `Network recording session stopped. Captured data from ${recordedTabCount} tab(s).` };
}

export function getNetworkRecordings()
{
    return recordings;
}

export function getAttachedTabIds()
{
    return attachedTabIds;
}

export function isNetworkRecording()
{
    return Boolean(recordingSession);
}

export function getCompletedRecordings()
{
    return Array.from(recordings.values()).filter(hasCompletedData);
}

export async function exportHar(folder)
{
    if (recordingSession) {
        throw new Error("Stop the active recording session before exporting the HAR file.");
    }

    const completedRecordings = getCompletedRecordings();

    if (completedRecordings.length === 0) {
        throw new Error("No recorded requests are available to export.");
    }

    const har = buildMergedHar(completedRecordings);
    const baseFilename = `network-${new Date().toISOString().replace(/[:.]/g, "-")}.har`;

    // 应用子目录（如果提供）
    const filename = folder ? `${folder}/${baseFilename}` : baseFilename;

    const content = encodeURIComponent(JSON.stringify(har, null, 2));
    const url = `data:application/x-http-archive+json;charset=utf-8,${content}`;
    const entryCount = completedRecordings.reduce((sum, recording) => sum + recording.entries.length, 0);
    logInfo("Exporting HAR", { tabCount: completedRecordings.length, entryCount, filename });

    const downloadId = await chrome.downloads.download({
        url,
        filename,
        saveAs: false
    });

    if (downloadId == null) {
        throw new Error("The browser did not create a download task.");
    }

    logInfo("HAR download created", { downloadId, filename });
    return { message: `Exported ${entryCount} requests from ${completedRecordings.length} tab(s) to ${filename}.` };
}

export function getNetworkStatus()
{
    const snapshot = {};
    let totalEntryCount = 0;
    let recordedTabCount = 0;

    for (const [tabId, recording] of recordings.entries()) {
        const entryCount = recording.entries.length + recording.requests.size;
        snapshot[tabId] = {
            entryCount,
            title: recording.title
        };

        if (entryCount > 0) {
            recordedTabCount += 1;
            totalEntryCount += entryCount;
        }
    }

    return {
        sessionWindowId: getSessionWindowId(),
        activeTabIds: Array.from(attachedTabIds),
        isRecording: Boolean(recordingSession),
        recordedTabCount,
        totalEntryCount,
        recordings: snapshot
    };
}

export function clearNetworkRecordings()
{
    recordings.clear();
    logInfo("Cleared all network recordings");
}
