// ==UserScript==
// @name         跳过B站广告
// @namespace    http://tampermonkey.net/
// @version      0.8.3
// @description  P:跳转到当前时间后(且忽略前个P点后3s)的最高峰。O:跳转到"O周期内首次P按下时"的位置,并重置P链。视频变更检测基于标题。
// @author       Samuel233
// @match        https://www.bilibili.com/video/*
// @grant        unsafeWindow
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    let bpxPlayer = null;
    let pKeyCooldownUntil = 0;

    // --- State Variables ---
    let targetTimeForOJump = null;
    let isNextPFirstInOCycle = true;
    let lastSuccessfulPJumpTime = -1;
    let sortedHeatmapPeaks = [];
    let heatmapDataReady = false;
    let lastKnownTitle = null; // 改用标题跟踪当前视频

    const P_KEY_COOLDOWN_MS = 1000;
    const P_IGNORE_DURATION_S = 3.0;

    console.log("Bilibili 热度跳转脚本已加载 v0.8.3 by Samuel233。视频变更检测基于标题。");

    function getBilibiliPlayer() {
        if (bpxPlayer && typeof bpxPlayer.seek === 'function' && typeof bpxPlayer.getCurrentTime === 'function') {
            return bpxPlayer;
        }
        bpxPlayer = unsafeWindow.player ||
                      (unsafeWindow.wrappedJSObject && unsafeWindow.wrappedJSObject.player) ||
                      document.querySelector('video[id^="bilibiliPlayer"]');
        if (bpxPlayer) {
            if (typeof bpxPlayer.seek !== 'function' && typeof bpxPlayer.currentTime === 'number') {
                bpxPlayer.seek = function(time) { this.currentTime = time; };
            }
            if (typeof bpxPlayer.getCurrentTime !== 'function' && typeof bpxPlayer.currentTime === 'number') {
                bpxPlayer.getCurrentTime = function() { return this.currentTime; };
            }
            if (typeof bpxPlayer.getDuration !== 'function' && typeof bpxPlayer.duration === 'number') {
                 bpxPlayer.getDuration = function() { return this.duration; };
            }
            if (!(typeof bpxPlayer.seek === 'function' && typeof bpxPlayer.getCurrentTime === 'function')) {
                console.warn("播放器对象不完整或不符合预期。");
                bpxPlayer = null;
            }
        }
        return bpxPlayer;
    }

    function parseSvgPathD(dAttribute) {
        if (!dAttribute) return [];
        const points = [];
        const normalizedD = dAttribute.replace(/[\n\r\t]/g, " ").replace(/\s*([MLCSTQAHVZmlcstqahvz])\s*/g, " $1 ")
                                   .replace(/(\d)-/g, "$1 -")
                                   .trim();
        const commands = normalizedD.split(/(?=[MLCSTQAHVZmlcstqahvz])/);
        let currentX = 0, currentY = 0, subpathStartX = 0, subpathStartY = 0;
        for (const cmdStr of commands) {
            if (!cmdStr.trim()) continue;
            const command = cmdStr.charAt(0);
            const argsStr = cmdStr.substring(1).trim();
            const args = argsStr.split(/[\s,]+/).map(s => parseFloat(s)).filter(n => !isNaN(n));
            let rel = command === command.toLowerCase();
            switch (command.toUpperCase()) {
                case 'M': for (let i = 0; i < args.length; i += 2) { currentX = rel && i > 0 ? currentX + args[i] : args[i]; currentY = rel && i > 0 ? currentY + args[i+1] : args[i+1]; if (i === 0) { subpathStartX = currentX; subpathStartY = currentY; } points.push({ x: currentX, y: currentY }); } break;
                case 'L': for (let i = 0; i < args.length; i += 2) { currentX = rel ? currentX + args[i] : args[i]; currentY = rel ? currentY + args[i+1] : args[i+1]; points.push({ x: currentX, y: currentY }); } break;
                case 'H': for (let i = 0; i < args.length; i++) { currentX = rel ? currentX + args[i] : args[i]; points.push({ x: currentX, y: currentY }); } break;
                case 'V': for (let i = 0; i < args.length; i++) { currentY = rel ? currentY + args[i] : args[i]; points.push({ x: currentX, y: currentY }); } break;
                case 'C': for (let i = 0; i < args.length; i += 6) { currentX = rel ? currentX + args[i+4] : args[i+4]; currentY = rel ? currentY + args[i+5] : args[i+5]; points.push({ x: currentX, y: currentY }); } break;
                case 'Z': currentX = subpathStartX; currentY = subpathStartY; points.push({x: currentX, y: currentY}); break;
                default: if (args.length >= 2) { let lXIdx = args.length - 2, lYIdx = args.length - 1; if ( (command.toUpperCase() === 'Q' && args.length % 4 === 0) || (command.toUpperCase() === 'S' && args.length % 4 === 0) || (command.toUpperCase() === 'T' && args.length % 2 === 0) || (command.toUpperCase() === 'A' && args.length % 7 === 0) ) { currentX = rel ? currentX + args[lXIdx] : args[lXIdx]; currentY = rel ? currentY + args[lYIdx] : args[lYIdx]; points.push({ x: currentX, y: currentY }); } }
            }
        }
        return points;
    }

    function getCurrentVideoTitle() {
        const titleElement = document.querySelector('h1.video-title'); // 基于用户截图
        if (titleElement) {
            // 优先使用 data-title 或 title 属性，它们可能更干净
            return titleElement.getAttribute('data-title') || titleElement.title || titleElement.textContent.trim();
        }
        // 备用选择器 (如果上面那个失效)
        const altTitleElement = document.querySelector('.video-info .tit') || document.querySelector('.video-data .video-title');
        if (altTitleElement) {
            return altTitleElement.textContent.trim();
        }
        console.warn("未能获取到视频标题元素。");
        return null;
    }

    function resetScriptStateForNewVideo(newTitle) {
        console.log(`检测到视频变更 (或强制重置)。旧标题: "${lastKnownTitle}", 新标题: "${newTitle}". 重置所有交互状态。`);
        heatmapDataReady = false;
        sortedHeatmapPeaks = [];
        targetTimeForOJump = null;
        isNextPFirstInOCycle = true;
        lastSuccessfulPJumpTime = -1;
        lastKnownTitle = newTitle; // 更新最后已知的标题
    }

    async function fetchAndProcessAllHeatmapData() {
        const player = getBilibiliPlayer();
        if (!player) { console.warn("播放器未准备好，无法获取热度数据。"); return false; }

        const currentVideoTitle = getCurrentVideoTitle();

        if (currentVideoTitle && currentVideoTitle.length > 0) {
            if (lastKnownTitle !== currentVideoTitle) {
                resetScriptStateForNewVideo(currentVideoTitle);
            }
        } else {
            console.warn("无法获取当前视频标题，热度数据可能不准确或状态未重置。");
        }

        if (heatmapDataReady) {
            return true;
        }

        let allHeatmapPoints = [];
        const currentVideoCid = unsafeWindow.cid || (player.getVideoBasicInfo && player.getVideoBasicInfo().cid); // 仍然尝试获取CID供特定数据源使用

        // --- 数据源获取逻辑 ---
        if (player.heatmapData && Array.isArray(player.heatmapData) && player.heatmapData.length > 0) { /* ... */ }
        else if (player.points && Array.isArray(player.points) && player.points.length > 0 && player.points[0].hasOwnProperty('time')) { /* ... */ }
        if (allHeatmapPoints.length === 0 && typeof unsafeWindow.GrayManager?.getGray === 'function' && currentVideoCid) {
            try { /* ... GrayManager ... */ } catch (error) { console.error("GrayManager 获取数据出错:", error); }
        }
        if (allHeatmapPoints.length === 0) { /* ... SVG ... */ }
        // (为了简洁，数据源获取的具体实现代码与 v0.8.2 保持一致，这里省略重复部分)
        // Start Data Acquisition (condensed from v0.8.2)
        if (player.heatmapData && Array.isArray(player.heatmapData) && player.heatmapData.length > 0) {
            allHeatmapPoints = player.heatmapData.map(p => ({ timestamp: p.timestamp, intensity: p.intensity, source: 'player.heatmapData' }));
        } else if (player.points && Array.isArray(player.points) && player.points.length > 0 && player.points[0].hasOwnProperty('time')) {
            allHeatmapPoints = player.points.map(p => ({ timestamp: p.time, intensity: p.value || p.count || 1, source: 'player.points' }));
        }
        if (allHeatmapPoints.length === 0 && typeof unsafeWindow.GrayManager?.getGray === 'function' && currentVideoCid) { // GrayManager 需要CID
            try {
                const data = await new Promise(resolve => unsafeWindow.GrayManager.getGray(currentVideoCid, d => resolve(d)));
                if (data && data.highlight && data.highlight.length > 0) {
                    allHeatmapPoints = data.highlight.map(p => ({ timestamp: p.locate, intensity: p.view, source: 'GrayManager' }));
                }
            } catch (error) { console.error("GrayManager 获取数据出错:", error); }
        }
        if (allHeatmapPoints.length === 0) {
            let pathElement = document.querySelector('#bpx-player-pbp-curve-path path');
            if (!pathElement) { pathElement = document.querySelector('.bpx-player-pbp-progress svg path') || document.querySelector('svg path[id*="pbp-curve-path"]'); }
            if (pathElement) {
                const dAttribute = pathElement.getAttribute('d');
                if (dAttribute) {
                    const svgPoints = parseSvgPathD(dAttribute);
                    const duration = player.getDuration();
                    if (duration > 0 && svgPoints.length > 0) {
                        const svgViewBoxWidth = 1000;
                        svgPoints.forEach(p => {
                            const timestamp = (p.x / svgViewBoxWidth) * duration; const intensity = 100 - p.y;
                            if (timestamp >= 0 && timestamp <= duration && p.x >=0 && p.x <= svgViewBoxWidth && p.y >=0 && p.y <= 100) {
                                allHeatmapPoints.push({ timestamp, intensity, source: 'SVG' });
                            }
                        });
                    }
                }
            }
        }
        // End Data Acquisition

        if (allHeatmapPoints.length === 0) { console.warn("未能获取到任何热度数据源。"); heatmapDataReady = false; return false; }
        const uniquePointsMap = new Map();
        allHeatmapPoints.forEach(p => { if (!uniquePointsMap.has(p.timestamp) || p.intensity > uniquePointsMap.get(p.timestamp).intensity) { uniquePointsMap.set(p.timestamp, p); } });
        sortedHeatmapPeaks = Array.from(uniquePointsMap.values()).sort((a, b) => b.intensity - a.intensity);

        if (sortedHeatmapPeaks.length > 0) {
            console.log(`已为视频 "${currentVideoTitle || '未知'}" 获取并排序了 ${sortedHeatmapPeaks.length} 个热度点。`);
            heatmapDataReady = true;
            if (currentVideoTitle && currentVideoTitle.length > 0) lastKnownTitle = currentVideoTitle;
            return true;
        } else {
            console.warn("处理后没有有效的热度点。"); heatmapDataReady = false; return false;
        }
    }

    function handleOKey() {
        const player = getBilibiliPlayer();
        if (!player) { alert("播放器未找到。"); return; }

        const currentVideoTitle = getCurrentVideoTitle();
        if (currentVideoTitle && currentVideoTitle.length > 0 && lastKnownTitle !== currentVideoTitle) {
            resetScriptStateForNewVideo(currentVideoTitle);
        }

        if (targetTimeForOJump !== null) {
            player.seek(targetTimeForOJump);
            console.log(`O键: 跳转到已记录的O周期目标时间点: ${targetTimeForOJump.toFixed(2)}s (针对视频 "${lastKnownTitle || '未知'}")`);
        } else {
            alert("O键提示: 当前没有已记录的“O周期内首次P点”可供跳转。\n(请在按下此O键后，按一次P键来设定下次O的目标)");
            console.log("O键: targetTimeForOJump 未设置，不执行跳转。");
        }
        isNextPFirstInOCycle = true;
        lastSuccessfulPJumpTime = -1;
        console.log(`O键: 下一个P将设置新的O跳转目标。P链已重置。`);
    }

    async function handlePKey() {
        const now = Date.now();
        if (now < pKeyCooldownUntil) { console.log("P键操作过于频繁。"); return; }
        pKeyCooldownUntil = now + P_KEY_COOLDOWN_MS;

        const player = getBilibiliPlayer();
        if (!player) { alert("播放器未找到。"); return; }

        const currentVideoTitle = getCurrentVideoTitle();
        if (currentVideoTitle && currentVideoTitle.length > 0 && lastKnownTitle !== currentVideoTitle) {
            resetScriptStateForNewVideo(currentVideoTitle);
        }

        const timeWhenPKeyWasPressed = player.getCurrentTime();

        if (isNextPFirstInOCycle) {
            targetTimeForOJump = timeWhenPKeyWasPressed;
            isNextPFirstInOCycle = false;
            console.log(`P键(O周期内首次): O键的下次跳转目标已设置为 ${targetTimeForOJump.toFixed(2)}s (视频 "${lastKnownTitle || '未知'}")`);
        }

        if (!heatmapDataReady) {
            const success = await fetchAndProcessAllHeatmapData();
            if (!success) { alert("初始化热度数据失败，无法执行 P 键操作。"); return; }
        }
        if (sortedHeatmapPeaks.length === 0) { alert("没有可用的热度峰值数据 (针对当前视频)。"); return; }

        const searchReferenceTime = player.getCurrentTime();
        console.log(`P键: 搜索参考时间点 (搜索前精确播放时间): ${searchReferenceTime.toFixed(2)}s`);

        const ignorePeaksUpTo = (lastSuccessfulPJumpTime !== -1) ? (lastSuccessfulPJumpTime + P_IGNORE_DURATION_S) : -1;
        if (ignorePeaksUpTo !== -1) {
            console.log(`P键: 将忽略 ${lastSuccessfulPJumpTime.toFixed(2)}s 之后 ${P_IGNORE_DURATION_S.toFixed(1)}s 内的热度点 (即忽略到 ${ignorePeaksUpTo.toFixed(2)}s 之前的点)`);
        }

        let foundPeakToJump = null;
        for (const peak of sortedHeatmapPeaks) {
            if (peak.timestamp > searchReferenceTime) {
                if (peak.timestamp > ignorePeaksUpTo) {
                    foundPeakToJump = peak;
                    break;
                }
            }
        }

        if (foundPeakToJump) {
            console.log(`P键: 找到有效峰值 T=${foundPeakToJump.timestamp.toFixed(2)}s (强度 ${foundPeakToJump.intensity.toFixed(2)})。跳转前精确参考位置: ${searchReferenceTime.toFixed(2)}s`);
            player.seek(foundPeakToJump.timestamp);
            lastSuccessfulPJumpTime = foundPeakToJump.timestamp;
        } else {
            alert(`在 T=${searchReferenceTime.toFixed(2)}s 之后 (并考虑 ${P_IGNORE_DURATION_S.toFixed(1)}s 忽略规则) 未找到符合条件的热度峰值。`);
            console.log(`P键: 未找到符合条件的峰值。`);
        }
    }

    document.addEventListener('keydown', function(event) {
        const targetTagName = event.target.tagName.toLowerCase();
        if (event.target.isContentEditable || targetTagName === 'input' || targetTagName === 'textarea' || targetTagName === 'select') { return; }
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) { return; }
        if (event.key === 'p' || event.key === 'P') { handlePKey(); }
        else if (event.key === 'o' || event.key === 'O') { handleOKey(); }
    });

    setTimeout(() => {
        // console.log("脚本初始化 setTimeout 执行");
        const player = getBilibiliPlayer(); // 尝试获取播放器，但主要目的是获取标题
        let initialVideoTitle = getCurrentVideoTitle();

        if (initialVideoTitle && initialVideoTitle.length > 0) {
            if (lastKnownTitle === null) {
                lastKnownTitle = initialVideoTitle;
                console.log(`脚本初始化：记录初始标题 = "${lastKnownTitle}"`);
            } else if (lastKnownTitle !== initialVideoTitle) {
                // 如果在脚本注入到此setTimeout之间标题就变了
                resetScriptStateForNewVideo(initialVideoTitle);
            }
        } else {
            console.log("脚本初始化：未能获取到初始视频标题。");
        }

        if (lastKnownTitle && !heatmapDataReady) { // 如果标题已知，且数据未准备好
             console.log("脚本加载3秒后，为当前标题尝试预获取热度数据...");
             fetchAndProcessAllHeatmapData();
        }
    }, 3000);

})();
