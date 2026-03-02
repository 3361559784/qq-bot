function createPokeModule({ config, sleep, fetchBypass }) {
    const {
        POKE_GROUP_COUNTING,
        USER_POKE_COOLDOWN_MS,
        POKE_WINDOW_MS,
        JUST_REPLIED_MS,
        POKE_COUNTER_THRESHOLD,
        POKE_ANGRY_THRESHOLD,
        POKE_STYLE_CONFIG,
        GROUP_MOOD_DECAY_CONFIG,
        NAPCAT_API_URL,
        NAPCAT_TOKEN,
        BOT_QQ_ID
    } = config;

    function getGroupMoodByCount(groupPokeCount) {
        const thresholds = GROUP_MOOD_DECAY_CONFIG.THRESHOLDS;
        if (groupPokeCount >= 8) return thresholds[8];
        if (groupPokeCount >= 5) return thresholds[5];
        if (groupPokeCount >= 3) return thresholds[3];
        return 'neutral';
    }

    function decayGroupMood(groupMood, now) {
        if (!groupMood || groupMood.value === 'neutral') {
            return { value: 'neutral', lastSet: now, setBy: 'system' };
        }

        const timeSinceLastSet = now - groupMood.lastSet;
        const decayLevels = Math.floor(timeSinceLastSet / GROUP_MOOD_DECAY_CONFIG.DECAY_INTERVAL_MS);

        if (decayLevels === 0) {
            return groupMood;
        }

        const levels = GROUP_MOOD_DECAY_CONFIG.LEVELS;
        const currentIndex = levels.indexOf(groupMood.value);
        const newIndex = Math.max(0, currentIndex - decayLevels);

        return {
            value: levels[newIndex],
            lastSet: now,
            setBy: 'decay'
        };
    }

    function migratePokeStatsIfNeeded(resDoc) {
        if (!resDoc || !resDoc.pokeStats) return resDoc;
        if (resDoc.pokeStats.group && resDoc.pokeStats.users) return resDoc;

        const oldKeys = Object.keys(resDoc.pokeStats).filter(k => k.includes(':'));
        if (oldKeys.length === 0) return resDoc;

        const newPokeStats = {
            group: { count: 0, lastTime: 0, intervals: [] },
            users: {}
        };

        for (const oldKey of oldKeys) {
            const oldData = resDoc.pokeStats[oldKey];
            const userId = oldKey.split(':')[1];

            newPokeStats.users[userId] = {
                lastTime: oldData.lastTime || 0,
                lastReplyTime: oldData.lastReplyTime || 0,
                intervals: oldData.intervals || []
            };

            if (oldData.count > newPokeStats.group.count) {
                newPokeStats.group.count = oldData.count;
                newPokeStats.group.lastTime = oldData.lastTime;
                newPokeStats.group.intervals = oldData.intervals || [];
            }
        }

        resDoc.pokeStats = newPokeStats;
        resDoc.migratedAt = new Date().toISOString();
        return resDoc;
    }

    function analyzePokeStyle(pokeStat, currentCount) {
        const intervals = pokeStat.intervals || [];

        if (intervals.length < 2) {
            return 'normal';
        }

        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

        if (avgInterval > POKE_STYLE_CONFIG.GENTLE_INTERVAL) {
            return 'gentle';
        }

        if (avgInterval < POKE_STYLE_CONFIG.FAST_INTERVAL) {
            return 'fast';
        }

        if (currentCount >= POKE_STYLE_CONFIG.FLIRTY_THRESHOLD &&
            avgInterval >= POKE_STYLE_CONFIG.FAST_INTERVAL &&
            avgInterval <= POKE_STYLE_CONFIG.GENTLE_INTERVAL) {
            return 'flirty';
        }

        return 'normal';
    }

    function countRapidPokes(intervals) {
        if (!intervals || intervals.length === 0) return 0;
        return intervals.filter(interval => interval < POKE_STYLE_CONFIG.RAPID_INTERVAL).length + 1;
    }

    async function updateLastBotReply(cosmosContainer, dbKey, sessionKey, context, maxRetries = 2) {
        if (!cosmosContainer) return;

        const now = Date.now();

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                let resDoc = null;
                let etag = null;
                try {
                    const response = await cosmosContainer.item(dbKey, dbKey).read();
                    resDoc = response.resource;
                    etag = response.resource._etag;
                } catch (e) {
                    resDoc = { id: dbKey, history: [], activity: {} };
                }

                resDoc.lastBotReply = resDoc.lastBotReply || {};
                resDoc.lastBotReply[sessionKey] = now;
                resDoc.last_updated = new Date().toISOString();

                const options = etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : {};
                await cosmosContainer.items.upsert(resDoc, options);

                context.log(`[DB] lastBotReply 更新成功 (key=${sessionKey}, attempt=${attempt + 1})`);
                return;
            } catch (err) {
                if (err.code === 412 && attempt < maxRetries) {
                    context.log(`[DB] lastBotReply ETag 冲突，重试 ${attempt + 1}/${maxRetries}`);
                    await sleep(50 + Math.random() * 100);
                    continue;
                }
                context.error(`[DB] lastBotReply 更新失败: ${err.message}`);
                return;
            }
        }
    }

    async function updatePokeStats(cosmosContainer, dbKey, pokeKey, newStats = {}, context, maxRetries = 2) {
        if (!cosmosContainer) return;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                let resDoc = null;
                let etag = null;
                try {
                    const response = await cosmosContainer.item(dbKey, dbKey).read();
                    resDoc = response.resource;
                    etag = response.resource._etag;
                } catch (e) {
                    resDoc = { id: dbKey, history: [], activity: {} };
                }

                resDoc.pokeStats = resDoc.pokeStats || {};
                resDoc.pokeStats[pokeKey] = {
                    ...resDoc.pokeStats[pokeKey],
                    ...newStats
                };
                resDoc.last_updated = new Date().toISOString();

                const options = etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : {};
                await cosmosContainer.items.upsert(resDoc, options);

                context.log(`[DB] pokeStats 更新成功 (key=${pokeKey}, count=${newStats.count}, attempt=${attempt + 1})`);
                return;
            } catch (err) {
                if (err.code === 412 && attempt < maxRetries) {
                    context.log(`[DB] pokeStats ETag 冲突，重试 ${attempt + 1}/${maxRetries}`);
                    await sleep(50 + Math.random() * 100);
                    continue;
                }
                context.error(`[DB] pokeStats 更新失败: ${err.message}`);
                return;
            }
        }
    }

    async function handlePokeLogic(userId, groupId, context, cosmosContainer) {
        context.log(`[Poke] ===== 进入 handlePokeLogic =====`);
        context.log(`[Poke] userId=${userId}, groupId=${groupId || '私聊'}, POKE_GROUP_COUNTING=${POKE_GROUP_COUNTING}`);

        let replyMessage = null;
        let shouldCounterPoke = false;
        let counterPokeCount = 0;
        let pokeStyle = 'normal';

        const pokeDbKey = groupId ? `group_${groupId}` : String(userId);
        context.log(`[Poke] pokeDbKey=${pokeDbKey}`);

        if (BOT_QQ_ID && String(userId) === String(BOT_QQ_ID)) {
            context.log(`[Poke] 忽略来自机器人自身的戳 (userId=${userId})`);
            return {
                status: 200,
                jsonBody: { status: 'ok', message: 'self_poke_ignored' }
            };
        }

        let resDoc = null;
        let pokeStats = {};
        let groupMood = null;
        try {
            if (cosmosContainer) {
                try {
                    const { resource } = await cosmosContainer.item(pokeDbKey, pokeDbKey).read();
                    resDoc = migratePokeStatsIfNeeded(resource);
                } catch (e) {
                    resDoc = null;
                }
                if (resDoc) {
                    pokeStats = resDoc.pokeStats || {};
                    groupMood = resDoc.groupMood || null;
                }
            }
        } catch (err) {
            context.log(`[Poke] DB读取失败: ${err}`);
        }

        const now = Date.now();

        if (POKE_GROUP_COUNTING && groupId) {
            pokeStats.group = pokeStats.group || { count: 0, lastTime: 0, intervals: [] };
            pokeStats.users = pokeStats.users || {};
            pokeStats.users[userId] = pokeStats.users[userId] || {
                lastTime: 0,
                lastReplyTime: 0,
                intervals: []
            };

            const timeSinceLastPoke = now - (pokeStats.users[userId].lastTime || 0);
            if (timeSinceLastPoke < USER_POKE_COOLDOWN_MS && timeSinceLastPoke > 0) {
                context.log(`[Poke] 用户 ${userId} 在冷却中 (${timeSinceLastPoke}ms < ${USER_POKE_COOLDOWN_MS}ms)，忽略`);
                return {
                    status: 200,
                    jsonBody: { status: 'ok', message: 'user_cooldown' }
                };
            }

            pokeStats.users[userId].lastTime = now;
            const groupTimeSinceLast = now - (pokeStats.group.lastTime || 0);
            if (groupTimeSinceLast < POKE_WINDOW_MS) {
                pokeStats.group.count += 1;
                pokeStats.group.intervals.push(groupTimeSinceLast);
                if (pokeStats.group.intervals.length > 5) pokeStats.group.intervals.shift();
            } else {
                pokeStats.group.count = 1;
                pokeStats.group.intervals = [];
            }
            pokeStats.group.lastTime = now;

            groupMood = groupMood ? decayGroupMood(groupMood, now) : { value: 'neutral', lastSet: now, setBy: 'system' };

            const newMoodByCount = getGroupMoodByCount(pokeStats.group.count);
            const moodLevels = GROUP_MOOD_DECAY_CONFIG.LEVELS;
            const currentMoodIndex = moodLevels.indexOf(groupMood.value);
            const newMoodIndex = moodLevels.indexOf(newMoodByCount);

            if (newMoodIndex > currentMoodIndex) {
                groupMood = {
                    value: newMoodByCount,
                    lastSet: now,
                    setBy: 'system'
                };
                context.log(`[Poke-GroupMood] 群组情绪升级: ${newMoodByCount} (戳击${pokeStats.group.count}次)`);
            }

            const groupPokeCount = pokeStats.group.count;
            const userLastReplyTime = pokeStats.users[userId].lastReplyTime || 0;

            if (groupMood.value === 'furious') {
                const furiousReplies = [
                    '互动频率过高，请稍后再试。',
                    '系统负载较高，请等待冷却。',
                    '请求过于频繁，已触发保护机制。'
                ];
                replyMessage = furiousReplies[Math.floor(Math.random() * furiousReplies.length)];
                shouldCounterPoke = true;
                counterPokeCount = 1;
            } else if (groupMood.value === 'angry') {
                const angryReplies = [
                    '互动频率较高，请稍作等待。',
                    '正在处理请求，请稍候。',
                    '系统繁忙，建议稍后再试。'
                ];
                replyMessage = angryReplies[Math.floor(Math.random() * angryReplies.length)];
                if (Math.random() < 0.5) {
                    shouldCounterPoke = true;
                    counterPokeCount = 1;
                }
            } else if (groupMood.value === 'annoyed') {
                const annoyedReplies = [
                    '请求频繁，请稍等片刻。',
                    '系统正在处理，请耐心等待。',
                    '收到请求，处理中...'
                ];
                replyMessage = annoyedReplies[Math.floor(Math.random() * annoyedReplies.length)];
            } else {
                const normalReplies = [
                    '收到，有什么可以帮您的？',
                    '在线中，请问有什么需要？',
                    '收到消息，随时可以提问。',
                    '系统就绪，请问需要什么帮助？'
                ];
                replyMessage = normalReplies[Math.floor(Math.random() * normalReplies.length)];
            }

            if (now - userLastReplyTime < JUST_REPLIED_MS) {
                const recentReplies = [
                    '刚刚已回复，请稍等。',
                    '请求冷却中，请稍后再试。',
                    '系统正在处理上一个请求。'
                ];
                replyMessage = recentReplies[Math.floor(Math.random() * recentReplies.length)];
            }
            pokeStats.users[userId].lastReplyTime = now;
            pokeStyle = (groupMood.value === 'neutral') ? 'normal' : 'fast';
        } else {
            const pokeKey = `${pokeDbKey}:${String(userId)}`;
            pokeStats[pokeKey] = pokeStats[pokeKey] || {
                count: 0,
                lastTime: 0,
                intervals: [],
                pokeStyle: 'normal',
                lastCounterTime: 0,
                lastReplyTime: 0
            };

            const timeSinceLastPoke = now - (pokeStats[pokeKey].lastTime || 0);
            if (timeSinceLastPoke < USER_POKE_COOLDOWN_MS && timeSinceLastPoke > 0) {
                context.log(`[Poke] 用户 ${userId} 在冷却中`);
                return { status: 200, jsonBody: { status: 'ok', message: 'user_cooldown' } };
            }

            if (timeSinceLastPoke < POKE_WINDOW_MS) {
                pokeStats[pokeKey].count += 1;
                pokeStats[pokeKey].intervals = pokeStats[pokeKey].intervals || [];
                pokeStats[pokeKey].intervals.push(timeSinceLastPoke);
                if (pokeStats[pokeKey].intervals.length > 5) pokeStats[pokeKey].intervals.shift();
            } else {
                pokeStats[pokeKey].count = 1;
                pokeStats[pokeKey].intervals = [];
            }
            pokeStats[pokeKey].lastTime = now;

            const detectedPokeStyle = analyzePokeStyle(pokeStats[pokeKey], pokeStats[pokeKey].count);
            pokeStats[pokeKey].pokeStyle = detectedPokeStyle;
            pokeStyle = detectedPokeStyle;

            const pokeCount = pokeStats[pokeKey].count;
            const rapidPokeCount = countRapidPokes(pokeStats[pokeKey].intervals);
            const timeSinceLastCounter = now - (pokeStats[pokeKey].lastCounterTime || 0);

            if (rapidPokeCount >= POKE_STYLE_CONFIG.RAPID_COUNTER_THRESHOLD &&
                timeSinceLastCounter > POKE_STYLE_CONFIG.COUNTER_COOLDOWN) {
                const rapidCounterReplies = [
                    '请求频率过高，已触发保护机制。',
                    '检测到高频请求，系统将进行限流。'
                ];
                replyMessage = rapidCounterReplies[Math.floor(Math.random() * rapidCounterReplies.length)];
                shouldCounterPoke = true;
                counterPokeCount = Math.floor(Math.random() * (POKE_STYLE_CONFIG.COUNTER_MAX - POKE_STYLE_CONFIG.COUNTER_MIN + 1)) + POKE_STYLE_CONFIG.COUNTER_MIN;
                pokeStats[pokeKey].lastCounterTime = now;
                pokeStats[pokeKey].count = 0;
            } else if (pokeCount >= POKE_COUNTER_THRESHOLD) {
                const counterReplies = [
                    '连续请求已达上限，触发反馈机制。',
                    '系统已记录高频请求。'
                ];
                replyMessage = counterReplies[Math.floor(Math.random() * counterReplies.length)];
                shouldCounterPoke = true;
                counterPokeCount = 1;
                pokeStats[pokeKey].count = 0;
            } else if (pokeCount >= POKE_ANGRY_THRESHOLD) {
                const angryReplies = [
                    '请求频率较高，请稍后再试。',
                    '系统提示：连续请求检测中。',
                    '收到多次请求，建议间隔一段时间。'
                ];
                replyMessage = angryReplies[Math.floor(Math.random() * angryReplies.length)];
            } else {
                const normalReplies = [
                    '收到，有什么可以帮您的？',
                    '在线中，请问有什么需要？',
                    '系统就绪，请提问。'
                ];
                replyMessage = normalReplies[Math.floor(Math.random() * normalReplies.length)];
            }

            const lastUserReplyTime = pokeStats[pokeKey].lastReplyTime || 0;
            if (now - lastUserReplyTime < JUST_REPLIED_MS) {
                const recentReplies = [
                    '刚刚已回复，请稍等。',
                    '请求冷却中，请稍后再试。',
                    '系统正在处理上一个请求。'
                ];
                replyMessage = recentReplies[Math.floor(Math.random() * recentReplies.length)];
            }
            pokeStats[pokeKey].lastReplyTime = now;
        }

        if (POKE_GROUP_COUNTING && groupId) {
            if (cosmosContainer) {
                try {
                    const saveDoc = resDoc || { id: pokeDbKey };
                    saveDoc.pokeStats = pokeStats;
                    saveDoc.groupMood = groupMood;
                    saveDoc.last_updated = new Date().toISOString();
                    await cosmosContainer.items.upsert(saveDoc);
                } catch (err) {
                    context.error(`[DB] 保存失败: ${err.message}`);
                }
            }
        } else {
            const pokeKey = `${pokeDbKey}:${String(userId)}`;
            await updatePokeStats(cosmosContainer, pokeDbKey, pokeKey, {
                count: pokeStats[pokeKey].count,
                lastTime: pokeStats[pokeKey].lastTime,
                lastReplyTime: pokeStats[pokeKey].lastReplyTime,
                intervals: pokeStats[pokeKey].intervals,
                pokeStyle: pokeStats[pokeKey].pokeStyle,
                lastCounterTime: pokeStats[pokeKey].lastCounterTime
            }, context);
        }

        const sessionKey = `${pokeDbKey}:bot`;
        await updateLastBotReply(cosmosContainer, pokeDbKey, sessionKey, context);

        if (groupId && replyMessage) {
            const sendMsgUrl = `${NAPCAT_API_URL}/send_group_msg`;
            const msgPayload = {
                group_id: Number(groupId),
                message: replyMessage
            };

            let sendSuccess = false;
            for (let attempt = 0; attempt < 3 && !sendSuccess; attempt++) {
                try {
                    const headers = { 'Content-Type': 'application/json' };
                    if (NAPCAT_TOKEN && NAPCAT_TOKEN.trim()) {
                        headers.Authorization = `Bearer ${NAPCAT_TOKEN}`;
                    }

                    const sendResponse = await fetchBypass(
                        sendMsgUrl,
                        {
                            method: 'POST',
                            headers,
                            body: JSON.stringify(msgPayload)
                        },
                        2
                    );

                    if (sendResponse && sendResponse.ok) {
                        sendSuccess = true;
                    }
                } catch (err) {
                    context.error(`[戳一戳] ❌ 发送消息异常 (尝试${attempt + 1}次): ${err.message}`);
                }

                if (!sendSuccess && attempt < 2) {
                    const delay = 1000 + attempt * 500;
                    await sleep(delay);
                }
            }
        }

        if (shouldCounterPoke && groupId && counterPokeCount > 0) {
            const napcatUrl = `${NAPCAT_API_URL}/group_poke`;
            const pokePayload = {
                group_id: Number(groupId),
                user_id: Number(userId)
            };

            for (let pokeIndex = 0; pokeIndex < counterPokeCount; pokeIndex++) {
                let counterSuccess = false;
                for (let attempt = 0; attempt < 3 && !counterSuccess; attempt++) {
                    try {
                        const headers = { 'Content-Type': 'application/json' };
                        if (NAPCAT_TOKEN && NAPCAT_TOKEN.trim()) {
                            headers.Authorization = `Bearer ${NAPCAT_TOKEN}`;
                        }

                        const pokeResponse = await fetchBypass(
                            napcatUrl,
                            {
                                method: 'POST',
                                headers,
                                body: JSON.stringify(pokePayload)
                            },
                            2
                        );

                        if (pokeResponse && pokeResponse.ok) {
                            counterSuccess = true;
                        }
                    } catch (err) {
                        context.error(`[戳一戳反击] ❌ 异常 (尝试${attempt + 1}次): ${err.message}`);
                    }

                    if (!counterSuccess && attempt < 2) {
                        const delay = 1000 + attempt * 500;
                        await sleep(delay);
                    }
                }

                if (pokeIndex < counterPokeCount - 1) {
                    await sleep(800 + Math.random() * 400);
                }
            }
        }

        const logKey = POKE_GROUP_COUNTING && groupId ? `group_${groupId}` : `${pokeDbKey}:${userId}`;
        const logCount = POKE_GROUP_COUNTING && groupId ? pokeStats.group?.count : pokeStats[`${pokeDbKey}:${userId}`]?.count;
        context.log(`[戳一戳] 处理完成 (key=${logKey}, count=${logCount}, mood=${groupMood?.value || 'N/A'}, style=${pokeStyle})`);

        return {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
                reply: replyMessage || '',
                auto_escape: false
            })
        };
    }

    return {
        handlePokeLogic,
        updateLastBotReply
    };
}

module.exports = {
    createPokeModule
};
