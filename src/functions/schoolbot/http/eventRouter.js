async function routeNonChatEvents({
  body,
  selfId,
  context,
  arisDisablePoke,
  botQqId,
  cosmosContainer,
  handlePokeLogic,
  updateLastBotReply
}) {
  const msgType = body?.msg_type ?? body?.msgType;
  const subMsgType = body?.sub_msg_type ?? body?.subMsgType;

  if (msgType === 5 && subMsgType === 12) {
    if (arisDisablePoke) {
      return {
        status: 200,
        jsonBody: { status: 'ok', message: 'poke_disabled' }
      };
    }

    try {
      const elements = body.elements || [];
      const grayTipElement = elements.find(el => el.elementType === 8)?.grayTipElement;
      const jsonStr = grayTipElement?.jsonGrayTipElement?.jsonStr || '';

      if (jsonStr.includes('戳了戳')) {
        const pokerId = body.senderUin || body.user_id;
        const groupId = body.peerUin;

        if (botQqId && String(pokerId) === String(botQqId)) {
          return {
            status: 200,
            jsonBody: { status: 'ok', message: 'self_poke_ignored' }
          };
        }

        if (pokerId && groupId) {
          return await handlePokeLogic(pokerId, groupId, context, cosmosContainer);
        }
      }
    } catch (err) {
      context.log(`[灰条戳一戳] 解析失败: ${err.message}`);
    }

    return {
      status: 200,
      jsonBody: { status: 'ok', message: 'gray_tip_processed' }
    };
  }

  if (body?.post_type === 'notice') {
    if (botQqId && String(body.user_id) === String(botQqId)) {
      return {
        status: 200,
        jsonBody: { status: 'ok', message: 'self_notice_ignored' }
      };
    }

    if (body.notice_type === 'notify' && body.sub_type === 'poke' && String(body.target_id) === String(selfId)) {
      if (arisDisablePoke) {
        return {
          status: 200,
          jsonBody: { status: 'ok', message: 'poke_disabled' }
        };
      }
      return await handlePokeLogic(body.user_id, body.group_id, context, cosmosContainer);
    }

    if (body.sub_type === 'poke' && String(body.target_id) === String(selfId)) {
      if (arisDisablePoke) {
        return {
          status: 200,
          jsonBody: { status: 'ok', message: 'poke_disabled' }
        };
      }
      return await handlePokeLogic(body.user_id, body.group_id, context, cosmosContainer);
    }

    if (body.notice_type === 'group_increase' && String(body.user_id) !== String(selfId)) {
      const welcomeMsg = '欢迎新成员加入！有任何问题可以随时提问。';
      const groupDbKey = `group_${body.group_id}`;
      const sessionKey = `${groupDbKey}:${body.user_id}`;
      await updateLastBotReply(cosmosContainer, groupDbKey, sessionKey, context);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          reply: welcomeMsg,
          auto_escape: false
        })
      };
    }

    return {
      status: 200,
      jsonBody: { status: 'ok', message: 'notice_logged' }
    };
  }

  return null;
}

module.exports = {
  routeNonChatEvents
};
