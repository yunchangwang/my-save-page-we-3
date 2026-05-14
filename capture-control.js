"use strict";

document.addEventListener("DOMContentLoaded",onLoadPage,false);

var targetTabId = 0;
var targetWindowId = 0;
var initialTabId = 0;
var statusPollTimer = 0;
var trackingListeners = [];
var previousTabState = {};  // 用于记录之前Tab的监听状态
var isGloballyListening = false;  // 全局监听状态：用户是否开启了监听
var isMigrating = false;  // 是否正在迁移中（防止重复迁移）
var isNetworkRecording = false;  // 网络录制状态

function onLoadPage()
{
    targetWindowId = getTargetWindowId();
    initialTabId = getInitialTabId();
    targetTabId = initialTabId;  // 初始化时使用初始Tab ID

    document.getElementById("save-settings-button").addEventListener("click",saveSettings,false);
    document.getElementById("start-button").addEventListener("click",startListening,false);
    document.getElementById("stop-button").addEventListener("click",stopListeningAndSave,false);
    document.getElementById("clear-button").addEventListener("click",clearBufferedSnapshots,false);
    document.getElementById("capture-network-checkbox").addEventListener("change",handleNetworkCheckboxChange,false);
    window.addEventListener("beforeunload",cleanup,false);

    loadSettings();
    setupTabTracking();
    refreshStatus();
    startStatusPolling();
}

async function startListening()
{
    var tab,state,checkbox;

    setStatus("正在开启监听...");

    try
    {
        tab = await getTargetTab();
        await ensureCaptureScript(tab.id);
        state = await sendTabMessage(tab.id,{ type: "startAutoCapture" });

        if (!state) {
            setStatus("开启监听失败。");
        } else {
            isGloballyListening = true;
            console.log("[AutoCapture] 全局监听已开启");

            checkbox = document.getElementById("capture-network-checkbox");
            if (checkbox && checkbox.checked) {
                await startNetworkRecordingInternal(tab);
            }

            await refreshStatus();
        }
    }
    catch (e)
    {
        setStatus("无法开启监听。\n" + e.message);
    }
}

async function stopListeningAndSave()
{
    var tab,state,snapshots,i,snapshot,content,htmlSnapshots,harData,networkStatus,checkbox,completedRecordings,har;

    setStatus("正在停止监听...");
    console.log("[DEBUG] ========== stopListeningAndSave 开始执行 ==========");

    try
    {
        isGloballyListening = false;
        console.log("[AutoCapture] 全局监听已停止");

        tab = await getTargetTab();
        await ensureCaptureScript(tab.id);
        state = await sendTabMessage(tab.id,{ type: "stopAutoCapture" });

        if (!state) setStatus("Failed to stop listener.");
        else if (state.pending)
        {
            setStatus("正在等待当前抓取完成...");
            await waitForCaptureIdle(tab.id);
        }

        // 停止网络录制并收集HAR数据
        checkbox = document.getElementById("capture-network-checkbox");
        console.log("[DEBUG] checkbox 元素:", checkbox);
        console.log("[DEBUG] checkbox.checked:", checkbox ? checkbox.checked : "checkbox is null");
        console.log("[DEBUG] isNetworkRecording:", isNetworkRecording);

        harData = null;

        if (checkbox && checkbox.checked) {
            console.log("[DEBUG] 进入了接口抓取分支");

            if (isNetworkRecording) {
                console.log("[DEBUG] 正在停止网络录制...");
                await stopNetworkRecordingInternal();
                console.log("[DEBUG] 网络录制已停止");
            }

            // 获取网络录制状态并收集HAR数据
            try {
                networkStatus = await sendRuntimeMessage({ type: "getNetworkStatus" });

                if (networkStatus && networkStatus.totalEntryCount > 0) {
                    setStatus("正在获取HAR数据...");

                    // 将 HAR 数据存储到 IndexedDB
                    const storeResponse = await sendRuntimeMessage({ type: "storeHarInIndexedDB" });

                    if (storeResponse && !storeResponse.error) {
                        console.log("[Network Monitor] 正在从 IndexedDB 读取 HAR 数据...");

                        // 从 IndexedDB 读取数据
                        harData = await getHarFromIndexedDB();

                        console.log("[Network Monitor] HAR 数据读取成功，长度:", harData.length);
                    }
                }
            } catch (e) {
                console.error("[Network Monitor] 获取HAR数据失败:", e);
            }
        } else {
            console.log("[DEBUG] 未勾选接口抓取复选框，跳过HAR数据收集");
        }

        // 收集所有HTML快照
        snapshots = await getSnapshotList(tab.id);

        if (snapshots.length == 0)
        {
            setStatus("监听已停止，但没有可保存的数据。");
            await refreshStatus();
            return;
        }

        htmlSnapshots = [];

        for (i = 0; i < snapshots.length; i++)
        {
            snapshot = snapshots[i];
            content = await sendRuntimeMessage({ type: "getAutoCaptureSnapshotHtml", tabid: tab.id, id: snapshot.id });

            if (content && content.html)
            {
                setStatus("正在收集第 " + (i+1) + " / " + snapshots.length + " 份快照...");
                htmlSnapshots.push({
                    filename: content.filename,
                    html: content.html
                });
            }
        }

        // 打包下载（包含HAR数据）
        setStatus("正在打包下载...");
        const folder = sanitizeAutoCaptureFolder(document.getElementById("folder-input").value.trim());
        await downloadAsZip(htmlSnapshots, harData, folder);

        // 清理数据
        await sendRuntimeMessage({ type: "clearAutoCaptureSnapshots", tabid: tab.id });
        await sendTabMessage(tab.id,{ type: "resetAutoCaptureStorageState" });

        if (harData) {
            await sendRuntimeMessage({ type: "clearNetworkRecordings" });
            await clearHarFromIndexedDB();  // 清理 IndexedDB 中的 HAR 数据
        }

        var statusMessage = "已打包下载 " + htmlSnapshots.length + " 份快照";
        if (harData) {
            statusMessage += " 和 HAR 文件";
        }
        statusMessage += "。";
        setStatus(statusMessage);

        window.setTimeout(refreshStatus,500);
    }
    catch (e)
    {
        console.error("停止监听失败:", e);
        setStatus("无法停止监听。\n" + e.message);
    }
}

async function clearBufferedSnapshots()
{
    var tab,state,checkbox;

    setStatus("正在清空缓存快照...");

    try
    {
        isGloballyListening = false;  // 清除全局监听状态
        console.log("[AutoCapture] 全局监听已停止（清空缓存）");

        tab = await getTargetTab();
        await ensureCaptureScript(tab.id);
        state = await sendTabMessage(tab.id,{ type: "stopAutoCapture" });

        if (state && state.pending)
        {
            setStatus("正在等待当前抓取完成...");
            await waitForCaptureIdle(tab.id);
        }

        // 停止网络录制
        checkbox = document.getElementById("capture-network-checkbox");
        if (checkbox && checkbox.checked && isNetworkRecording) {
            await stopNetworkRecordingInternal();

            // 清空网络录制数据
            try {
                await sendRuntimeMessage({ type: "clearNetworkRecordings" });
            } catch (e) {
                console.error("[Network Monitor] 清空网络录制数据失败:", e);
            }
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
    var tab,state,storage,lines,folder,limitmb,networkStatus,checkbox;

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

        // 获取网络状态
        checkbox = document.getElementById("capture-network-checkbox");
        if (checkbox && checkbox.checked) {
            try {
                networkStatus = await sendRuntimeMessage({ type: "getNetworkStatus" });
            } catch (e) {
                console.error("[Network Monitor] 获取网络状态失败:", e);
            }
        }

        lines = [];
        lines.push("=== 窗口级监控模式 ===");
        lines.push("窗口ID：" + targetWindowId);
        lines.push("当前Tab：" + tab.title);
        lines.push("当前URL：" + (tab.url && tab.url.length > 60 ? tab.url.substring(0,60) + "..." : tab.url));
        lines.push("");
        lines.push("全局监听：" + (isGloballyListening ? "已开启" : "未开启"));
        lines.push("当前页面监听：" + (state.listening ? "是" : "否"));
        lines.push("抓取进行中：" + (state.capturing ? "是" : "否"));
        lines.push("缓存已满：" + (state.storagefull ? "是" : "否"));
        lines.push("缓存快照数：" + ((storage && storage.snapshotcount) || 0));

        // 显示网络状态
        if (networkStatus) {
            lines.push("网络录制：" + (networkStatus.isRecording ? "进行中" : "未开启"));
            if (networkStatus.totalEntryCount > 0) {
                lines.push("已捕获接口数：" + networkStatus.totalEntryCount);
            }
        }

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

async function downloadAsZip(htmlSnapshots, harData, folder)
{
    var zip, filename, i, htmlSnapshot, zipBlob, objectURL, downloadId, zipFilename;

    try {
        // 检查 JSZip 是否可用
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip 库未加载');
        }

        setStatus("正在打包...");

        // 创建 ZIP 对象
        zip = new JSZip();

        // 添加 HTML 文件
        for (i = 0; i < htmlSnapshots.length; i++) {
            htmlSnapshot = htmlSnapshots[i];
            if (htmlSnapshot && htmlSnapshot.html) {
                // 使用原始文件名
                zip.file(htmlSnapshot.filename, htmlSnapshot.html);
                setStatus("正在打包第 " + (i+1) + " / " + htmlSnapshots.length + " 份快照...");
            }
        }

        // 添加 HAR 文件（如果存在）
        if (harData) {
            const harFilename = "network-" + new Date().toISOString().replace(/[:.]/g, "-") + ".har";
            zip.file(harFilename, harData);
            setStatus("已添加HAR文件到ZIP");
        }

        // 生成 ZIP 文件
        setStatus("正在生成ZIP文件...");
        zipBlob = await zip.generateAsync({ type: "blob" });

        // 生成文件名
        zipFilename = folder ? (folder + "/capture-" + new Date().toISOString().replace(/[:.]/g, "-") + ".zip") : "capture-" + new Date().toISOString().replace(/[:.]/g, "-") + ".zip";

        // 创建下载
        objectURL = URL.createObjectURL(zipBlob);
        downloadId = await chrome.downloads.download({
            url: objectURL,
            filename: zipFilename,
            saveAs: false
        });

        await waitForDownload(downloadId);
        URL.revokeObjectURL(objectURL);

        return { success: true, downloadId: downloadId };
    } catch (e) {
        console.error("打包下载失败:", e);
        throw e;
    }
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

function getTargetWindowId()
{
    var params,windowId;

    params = new URLSearchParams(window.location.search);
    windowId = +(params.get("windowId") || 0);

    return windowId;
}

function getInitialTabId()
{
    var params,tabId;

    params = new URLSearchParams(window.location.search);
    tabId = +(params.get("initialTabId") || 0);

    return tabId;
}

function setupTabTracking()
{
    if (targetWindowId <= 0) return;

    // 监听Tab切换事件
    var tabActivatedListener = function(activeInfo) {
        if (activeInfo.windowId === targetWindowId) {
            handleTabSwitch(activeInfo.tabId);
        }
    };

    // 监听Tab更新事件（页面跳转等）
    var tabUpdatedListener = function(tabId, changeInfo, tab) {
        if (tab.windowId === targetWindowId && tab.active && changeInfo.status === "complete") {
            handleTabUpdate(tab);
        }
    };

    chrome.tabs.onActivated.addListener(tabActivatedListener);
    chrome.tabs.onUpdated.addListener(tabUpdatedListener);

    trackingListeners.push({ event: "onActivated", listener: tabActivatedListener });
    trackingListeners.push({ event: "onUpdated", listener: tabUpdatedListener });

    console.log("[AutoCapture] 窗口级跟踪已启动，窗口ID:", targetWindowId);
}

async function handleTabSwitch(newTabId)
{
    var oldTabId, newTab;

    // 防止重复迁移
    if (isMigrating) {
        console.log("[AutoCapture] 正在迁移中，跳过本次Tab切换");
        return;
    }

    // 获取新Tab信息，检查是否是扩展页面
    try {
        newTab = await chrome.tabs.get(newTabId);
        if (newTab.url && newTab.url.startsWith("chrome-extension://")) {
            console.log("[AutoCapture] 忽略扩展页面的Tab切换:", newTabId);
            return;  // 如果是扩展页面，直接返回，不处理
        }
    } catch (e) {
        console.error("[AutoCapture] 获取Tab信息失败:", e);
        return;
    }

    oldTabId = targetTabId;
    targetTabId = newTabId;

    console.log("[AutoCapture] Tab切换:", oldTabId, "->", newTabId, "全局监听状态:", isGloballyListening);

    // 如果全局监听已开启，自动在新Tab开启监听
    if (isGloballyListening) {
        isMigrating = true;  // 设置迁移标志

        try {
            // 停止旧Tab的监听（如果存在）
            if (oldTabId > 0 && oldTabId !== newTabId) {
                await trySendTabMessage(oldTabId, { type: "stopAutoCapture" });
                console.log("[AutoCapture] 已停止旧Tab的监听:", oldTabId);
            }

            setStatus("检测到Tab切换，正在将监听迁移到新页面...");

            // 确保脚本已注入
            await ensureCaptureScript(newTabId);

            // 在新Tab开启监听
            await sendTabMessage(newTabId, { type: "startAutoCapture" });
            console.log("[AutoCapture] 监听已迁移到新Tab:", newTabId);

            await refreshStatus();
        } catch (e) {
            console.error("[AutoCapture] 迁移监听失败:", e);
            setStatus("监听迁移失败: " + e.message);
        } finally {
            isMigrating = false;  // 清除迁移标志
        }
    } else {
        console.log("[AutoCapture] 全局监听未开启，不迁移监听状态");
    }
}

async function handleTabUpdate(tab)
{
    // 如果是扩展页面，不处理
    if (tab.url && tab.url.startsWith("chrome-extension://")) {
        return;
    }

    console.log("[AutoCapture] Tab更新:", tab.id, tab.url, "全局监听状态:", isGloballyListening);

    // 重新注入脚本（如果需要）
    await ensureCaptureScript(tab.id);

    // 如果全局监听已开启，在更新后的页面重新开启监听
    if (isGloballyListening && tab.active) {
        try {
            await sendTabMessage(tab.id, { type: "startAutoCapture" });
            console.log("[AutoCapture] 页面更新后已重新开启监听:", tab.id);
        } catch (e) {
            console.error("[AutoCapture] 页面更新后重启监听失败:", e);
        }
    }

    // 刷新状态显示
    await refreshStatus();
}

function cleanup()
{
    // 清理事件监听器
    trackingListeners.forEach(function(item) {
        if (item.event === "onActivated") {
            chrome.tabs.onActivated.removeListener(item.listener);
        } else if (item.event === "onUpdated") {
            chrome.tabs.onUpdated.removeListener(item.listener);
        }
    });

    trackingListeners = [];
    stopStatusPolling();
}

async function getTargetTab()
{
    var tabs, i;

    if (targetWindowId <= 0) throw new Error("缺少目标窗口。");

    // 获取窗口内所有Tab
    tabs = await chrome.tabs.query({ windowId: targetWindowId });

    if (!tabs || tabs.length === 0) {
        throw new Error("窗口内没有页签。");
    }

    // 过滤掉扩展页面（chrome-extension:// 开头的URL）
    var nonExtensionTabs = tabs.filter(function(tab) {
        return !tab.url || !tab.url.startsWith("chrome-extension://");
    });

    if (nonExtensionTabs.length === 0) {
        throw new Error("窗口内没有可监控的网页。");
    }

    // 优先返回当前targetTabId对应的Tab（如果存在且不是扩展页面）
    if (targetTabId > 0) {
        for (i = 0; i < nonExtensionTabs.length; i++) {
            if (nonExtensionTabs[i].id === targetTabId) {
                return nonExtensionTabs[i];
            }
        }
    }

    // 如果当前targetTabId无效，返回活动Tab（排除扩展页面）
    var activeTabs = nonExtensionTabs.filter(function(tab) {
        return tab.active;
    });

    if (activeTabs.length > 0) {
        targetTabId = activeTabs[0].id;
        return activeTabs[0];
    }

    // 如果没有活动Tab，返回第一个非扩展Tab
    targetTabId = nonExtensionTabs[0].id;
    return nonExtensionTabs[0];
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

/************************************************************************/

/* Network monitoring functions */

async function handleNetworkCheckboxChange()
{
    var checkbox,tab;

    checkbox = document.getElementById("capture-network-checkbox");

    if (isGloballyListening && checkbox.checked && !isNetworkRecording) {
        // 如果已经在监听HTML，且用户勾选了接口抓取，则开始网络录制
        try {
            tab = await getTargetTab();
            await startNetworkRecordingInternal(tab);
        } catch (e) {
            console.error("[Network Monitor] handleNetworkCheckboxChange 开启网络录制失败:", e);
        }
    } else if (!checkbox.checked && isNetworkRecording) {
        // 如果用户取消勾选，则停止网络录制
        stopNetworkRecordingInternal();
    }

    refreshStatus();
}

async function startNetworkRecordingInternal(tab)
{
    var response;

    try {
        if (!tab) {
            setStatus("开启网络录制失败: 缺少目标Tab");
            return;
        }

        // 确保不是扩展页面
        if (tab.url && tab.url.startsWith("chrome-extension://")) {
            setStatus("开启网络录制失败: 不能对扩展页面录制");
            return;
        }

        response = await sendRuntimeMessage({
            type: "startNetworkRecording",
            tabId: tab.id
        });

        if (response && response.error) {
            throw new Error(response.message);
        }

        isNetworkRecording = true;
        console.log("[Network Monitor] 网络录制已开启");
        setStatus("网络录制已开启");
    } catch (e) {
        console.error("[Network Monitor] 开启网络录制失败:", e);
        setStatus("开启网络录制失败: " + e.message);
        isNetworkRecording = false;
    }
}

async function stopNetworkRecordingInternal()
{
    var response;

    try {
        response = await sendRuntimeMessage({ type: "stopNetworkRecording" });

        if (response && response.error) {
            console.error("[Network Monitor] 停止网络录制失败:", response.message);
        } else {
            isNetworkRecording = false;
        }
    } catch (e) {
        console.error("[Network Monitor] 停止网络录制失败:", e);
    }
}

async function exportHarFile()
{
    var response;

    try {
        setStatus("正在导出HAR文件...");
        response = await sendRuntimeMessage({ type: "exportHar" });

        if (response && !response.error) {
            setStatus(response.message);
        } else {
            setStatus("导出HAR失败: " + (response?.message || "未知错误"));
        }
    } catch (e) {
        setStatus("导出HAR失败: " + e.message);
    }
}

/************************************************************************/

/* IndexedDB functions for HAR data transfer */

async function getHarFromIndexedDB()
{
    const dbName = "SavePageWE_HAR";
    const storeName = "harData";

    try {
        // 打开数据库
        const request = indexedDB.open(dbName, 1);
        const db = await new Promise((resolve, reject) => {
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName);
                }
            };
        });

        // 读取数据
        const transaction = db.transaction([storeName], "readonly");
        const store = transaction.objectStore(storeName);
        const getRequest = store.get("currentHar");

        const harString = await new Promise((resolve, reject) => {
            getRequest.onerror = () => reject(getRequest.error);
            getRequest.onsuccess = () => resolve(getRequest.result);
        });

        db.close();

        if (!harString) {
            throw new Error("IndexedDB 中没有 HAR 数据");
        }

        return harString;
    } catch (e) {
        console.error("[IndexedDB] 读取 HAR 数据失败:", e);
        throw e;
    }
}

async function clearHarFromIndexedDB()
{
    const dbName = "SavePageWE_HAR";
    const storeName = "harData";

    try {
        // 打开数据库
        const request = indexedDB.open(dbName, 1);
        const db = await new Promise((resolve, reject) => {
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName);
                }
            };
        });

        // 删除数据
        const transaction = db.transaction([storeName], "readwrite");
        const store = transaction.objectStore(storeName);
        const deleteRequest = store.delete("currentHar");

        await new Promise((resolve, reject) => {
            deleteRequest.onerror = () => reject(deleteRequest.error);
            deleteRequest.onsuccess = () => resolve();
        });

        db.close();

        console.log("[IndexedDB] HAR 数据已清理");
    } catch (e) {
        console.error("[IndexedDB] 清理 HAR 数据失败:", e);
    }
}
