"use strict";

document.addEventListener("DOMContentLoaded",onLoadPage,false);

var targetTabId = 0;
var statusPollTimer = 0;

function onLoadPage()
{
    targetTabId = getTargetTabId();
    
    document.getElementById("save-settings-button").addEventListener("click",saveSettings,false);
    document.getElementById("start-button").addEventListener("click",startListening,false);
    document.getElementById("stop-button").addEventListener("click",stopListeningAndSave,false);
    document.getElementById("clear-button").addEventListener("click",clearBufferedSnapshots,false);
    window.addEventListener("beforeunload",stopStatusPolling,false);
    
    loadSettings();
    refreshStatus();
    startStatusPolling();
}

async function startListening()
{
    var tab,state;
    
    setStatus("正在开启监听...");
    
    try
    {
        tab = await getTargetTab();
        await ensureCaptureScript(tab.id);
        state = await sendTabMessage(tab.id,{ type: "startAutoCapture" });
        
        if (!state) setStatus("开启监听失败。");
        else await refreshStatus();
    }
    catch (e)
    {
        setStatus("无法开启监听。\n" + e.message);
    }
}

async function stopListeningAndSave()
{
    var tab,state,snapshots,i,snapshot,content,downloaded;
    
    setStatus("正在停止监听...");
    
    try
    {
        tab = await getTargetTab();
        await ensureCaptureScript(tab.id);
        state = await sendTabMessage(tab.id,{ type: "stopAutoCapture" });
        
        if (!state) setStatus("Failed to stop listener.");
        else if (state.pending)
        {
            setStatus("正在等待当前抓取完成...");
            await waitForCaptureIdle(tab.id);
        }
        
        snapshots = await getSnapshotList(tab.id);
        
        if (snapshots.length == 0)
        {
            setStatus("监听已停止，但没有可保存的缓存快照。");
            await refreshStatus();
            return;
        }
        
        downloaded = 0;
        
        for (i = 0; i < snapshots.length; i++)
        {
            snapshot = snapshots[i];
            content = await sendRuntimeMessage({ type: "getAutoCaptureSnapshotHtml", tabid: tab.id, id: snapshot.id });
            
            if (content && content.html)
            {
                setStatus("正在保存第 " + (i+1) + " / " + snapshots.length + " 份快照...");
                await downloadSnapshot(content.html,applyAutoCaptureFolder(content.filename));
                downloaded++;
            }
        }
        
        await sendRuntimeMessage({ type: "clearAutoCaptureSnapshots", tabid: tab.id });
        await sendTabMessage(tab.id,{ type: "resetAutoCaptureStorageState" });
        
        setStatus("已保存 " + downloaded + " 份快照。");
        
        window.setTimeout(refreshStatus,500);
    }
    catch (e)
    {
        setStatus("无法停止监听。\n" + e.message);
    }
}

async function clearBufferedSnapshots()
{
    var tab,state;
    
    setStatus("正在清空缓存快照...");
    
    try
    {
        tab = await getTargetTab();
        await ensureCaptureScript(tab.id);
        state = await sendTabMessage(tab.id,{ type: "stopAutoCapture" });
        
        if (state && state.pending)
        {
            setStatus("正在等待当前抓取完成...");
            await waitForCaptureIdle(tab.id);
        }
        
        await sendRuntimeMessage({ type: "clearAutoCaptureSnapshots", tabid: tab.id });
        await sendTabMessage(tab.id,{ type: "resetAutoCaptureStorageState" });
        
        setStatus("缓存快照已清空。");
        window.setTimeout(refreshStatus,100);
    }
    catch (e)
    {
        setStatus("无法清空缓存快照。\n" + e.message);
    }
}

async function refreshStatus()
{
    var tab,state,storage,lines,folder,limitmb;
    
    try
    {
        tab = await getTargetTab();
        await ensureCaptureScript(tab.id);
        state = await sendTabMessage(tab.id,{ type: "getAutoCaptureState" });
        storage = await sendRuntimeMessage({ type: "getAutoCaptureStorageState", tabid: tab.id });
        
        if (!state)
        {
            setStatus("无法读取自动抓取状态。");
            return;
        }
        
        lines = [];
        lines.push("页签：" + tab.title);
        lines.push("监听中：" + (state.listening ? "是" : "否"));
        lines.push("抓取进行中：" + (state.capturing ? "是" : "否"));
        lines.push("缓存已满：" + (state.storagefull ? "是" : "否"));
        lines.push("缓存快照数：" + ((storage && storage.snapshotcount) || 0));
        folder = document.getElementById("folder-input").value.trim();
        lines.push("保存子目录：" + (folder || "（默认下载目录）"));
        limitmb = +(document.getElementById("limit-input").value || 0);
        lines.push("缓存上限：" + (limitmb > 0 ? limitmb + " MB" : "（未设置）"));
        if (storage) lines.push("已用缓存：" + formatBytes(storage.totalbytes || 0));
        
        if (storage && storage.filename) lines.push("最近文件：" + storage.filename);
        if (storage && storage.capturedat) lines.push("抓取时间：" + (new Date(storage.capturedat)).toLocaleString());
        
        setStatus(lines.join("\n"));
    }
    catch (e)
    {
        setStatus("无法读取状态。\n" + e.message);
    }
}

async function loadSettings()
{
    var local;
    
    local = await chrome.storage.local.get([ "options-autocapturefolder", "options-autocapturelimitmb" ]);
    
    document.getElementById("folder-input").value = local["options-autocapturefolder"] || "";
    document.getElementById("limit-input").value = local["options-autocapturelimitmb"] || 10;
}

async function saveSettings()
{
    var folder,limitmb;
    
    folder = document.getElementById("folder-input").value.trim();
    limitmb = +(document.getElementById("limit-input").value || 10);
    
    if (!(limitmb > 0)) limitmb = 10;
    if (limitmb < 10) limitmb = 10;
    if (limitmb > 2048) limitmb = 2048;
    
    document.getElementById("limit-input").value = limitmb;
    
    await chrome.storage.local.set({ "options-autocapturefolder": folder, "options-autocapturelimitmb": limitmb });
    
    setStatus("自动抓取设置已更新。");
    window.setTimeout(refreshStatus,100);
}

async function getSnapshotList(tabId)
{
    var response;
    
    response = await sendRuntimeMessage({ type: "getAutoCaptureSnapshotList", tabid: tabId });
    
    if (!response || !response.snapshots) return [];
    
    return response.snapshots;
}

async function waitForCaptureIdle(tabId)
{
    var state,i;
    
    for (i = 0; i < 60; i++)
    {
        await delay(250);
        state = await sendTabMessage(tabId,{ type: "getAutoCaptureState" });
        
        if (state && !state.capturing) return;
    }
    
    throw new Error("等待抓取完成超时。");
}

function applyAutoCaptureFolder(filename)
{
    var folder;
    
    folder = sanitizeAutoCaptureFolder(document.getElementById("folder-input").value.trim());
    
    if (folder == "") return filename;
    
    return folder + "/" + filename;
}

function sanitizeAutoCaptureFolder(folder)
{
    var i,segments,sanitized;
    
    if (!folder) return "";
    
    folder = folder.replace(/\\/g,"/");
    segments = folder.split("/");
    sanitized = [];
    
    for (i = 0; i < segments.length; i++)
    {
        segments[i] = segments[i].trim();
        
        if (segments[i] == "" || segments[i] == "." || segments[i] == "..") continue;
        
        segments[i] = segments[i].replace(/[<>:"|?*\u0000-\u001F]/g,"-");
        
        if (segments[i] != "") sanitized.push(segments[i]);
    }
    
    return sanitized.join("/");
}

async function downloadSnapshot(htmltext,filename)
{
    var blob,objectURL,downloadId;
    
    blob = new Blob([ htmltext ],{ type: "text/html" });
    objectURL = URL.createObjectURL(blob);
    
    try
    {
        downloadId = await chrome.downloads.download({ url: objectURL, filename: filename, saveAs: false });
    }
    catch (e)
    {
        URL.revokeObjectURL(objectURL);
        throw e;
    }
    
    await waitForDownload(downloadId);
    
    URL.revokeObjectURL(objectURL);
}

async function sendRuntimeMessage(message)
{
    var response;
    
    response = await chrome.runtime.sendMessage(message);
    
    if (!response) throw new Error("扩展运行时没有返回响应。");
    
    return response;
}

function formatBytes(bytes)
{
    if (bytes >= 1024*1024) return (bytes/(1024*1024)).toFixed(1) + " MB";
    if (bytes >= 1024) return (bytes/1024).toFixed(1) + " KB";
    return bytes + " B";
}

function waitForDownload(downloadId)
{
    return new Promise(function(resolve,reject)
    {
        chrome.downloads.onChanged.addListener(listener);
        
        function listener(downloadDelta)
        {
            if (downloadDelta.id != downloadId) return;
            
            if (downloadDelta.error && downloadDelta.error.current)
            {
                chrome.downloads.onChanged.removeListener(listener);
                reject(new Error(downloadDelta.error.current));
            }
            else if (downloadDelta.state && downloadDelta.state.current == "interrupted")
            {
                chrome.downloads.onChanged.removeListener(listener);
                reject(new Error("Download interrupted."));
            }
            else if (downloadDelta.state && downloadDelta.state.current == "complete")
            {
                chrome.downloads.onChanged.removeListener(listener);
                resolve();
            }
        }
    });
}

async function ensureCaptureScript(tabId)
{
    var response;
    var styles,i;
    
    response = await trySendTabMessage(tabId,{ type: "getAutoCaptureState" });
    
    if (response) return;
    
    styles = [ "message-panel.css", "lazyload-panel.css", "unsaved-panel.css", "comments-panel.css", "pageinfo-panel.css" ];
    
    for (i = 0; i < styles.length; i++)
    {
        try
        {
            await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: [ styles[i] ], origin: "AUTHOR" });
        }
        catch (e) {}
    }
    
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: [ "content.js" ], world: "ISOLATED" });
    await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, files: [ "content-frame.js" ], world: "ISOLATED" });
    
    await delay(250);
}

function getTargetTabId()
{
    var params,tabId;
    
    params = new URLSearchParams(window.location.search);
    tabId = +(params.get("tabId") || 0);
    
    return tabId;
}

async function getTargetTab()
{
    var tab;
    
    if (targetTabId <= 0) throw new Error("缺少目标页签。");
    
    tab = await chrome.tabs.get(targetTabId);
    
    if (!tab) throw new Error("目标页签已不存在。");
    
    return tab;
}

async function sendTabMessage(tabId,message)
{
    var response;
    
    response = await trySendTabMessage(tabId,message);
    
    if (!response) throw new Error("内容脚本没有返回响应。");
    
    return response;
}

async function trySendTabMessage(tabId,message)
{
    try
    {
        return await chrome.tabs.sendMessage(tabId,message);
    }
    catch (e)
    {
        return null;
    }
}

function delay(milliseconds)
{
    return new Promise(function(resolve)
    {
        window.setTimeout(resolve,milliseconds);
    });
}

function startStatusPolling()
{
    if (statusPollTimer) return;
    
    statusPollTimer = window.setInterval(refreshStatus,1000);
}

function stopStatusPolling()
{
    if (!statusPollTimer) return;
    
    window.clearInterval(statusPollTimer);
    statusPollTimer = 0;
}

function setStatus(text)
{
    document.getElementById("status").textContent = text;
}
