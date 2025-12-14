"""项目自动评估脚本 - 使用 OpenAI API（或相兼容的 endpoint）对 Campus Copilot 项目进行评分

用法示例：
  export OPENAI_API_KEY="sk-..."
  python3 tools/evaluate_with_chatgpt.py

输出：终端 JSON + tools/eval_result.json
"""

import os
import json
import sys

try:
    from openai import OpenAI
except Exception:
    OpenAI = None
import httpx
import re
import time

PROJECT_SUMMARY = {
    "name": "Campus Copilot (爱丽丝)",
    "one_liner": "课表理解与对话型助教——多源导入、结构化存储、可解释的防幻觉策略",
    "tech_stack": ["Next.js", "Azure Functions", "Azure Vision OCR", "Puppeteer", "Cosmos DB", "Framer Motion", "Tailwind"],
    "key_features": [
        "多格式课表导入（学习通/Excel/ICS/OCR/手动）",
        "自然语言查询（今天/明天/下一节/地点/教师/按周）",
        "结构化存储 schedule_profile 到 Cosmos DB",
        "防幻觉策略：规则优先 + LLM 二次补全",
        "人格化交互：Alice 表情、戳一戳、评委面板演示"
    ],
    "demonstration": "一键导入 demo、查询下一节课、OCR 导入、清除课表验证红线意识",
    "maturity_notes": "前后端已实现本地可运行，Cosmos DB 已验证有 schedule_profile 存在（54 门课）",
}

EVAL_PROMPT = f"""
你是一个技术评审，目标是根据项目摘要对 Campus Copilot 项目进行量化评分并给出可执行建议。
项目摘要（JSON）：
{json.dumps(PROJECT_SUMMARY, ensure_ascii=False, indent=2)}

请按照如下维度给出 0-10 的整数评分，并在每个维度后给出 1-2 行评语与改进建议：
1) 功能完整性 (Feature completeness)
2) 创新性 (Novelty)
3) 可靠性与安全 (Robustness & Safety)
4) 可部署性/工程成熟度 (Deployability)
5) 演示与用户体验 (Demo quality / UX)

最后请给出一个总体评分（0-10），并列出 3 条按优先级排序的、可执行的改进建议（从容易到高影响）。

要求输出 JSON，仅包含 keys: scores (map), overall (int), recommendations (array of 3 strings), rationale (short text)。
不要加入额外的注释文字。
"""

OUTPUT_JSON_PATH = os.path.join(os.path.dirname(__file__), 'eval_result.json')


def run_evaluation():
    # 优先使用 GITHUB_TOKEN（仓库已有示例使用此方式访问 GitHub-hosted models）
    gh_token = os.environ.get('GITHUB_TOKEN')
    # 若不存在在环境中，尝试从 local.settings.json 中读取（仅本地使用）
    if not gh_token:
        local_settings = os.path.join(os.path.dirname(__file__), '..', 'local.settings.json')
        try:
            with open(local_settings, 'r', encoding='utf-8') as f:
                raw = f.read()
                m = re.search(r'"GITHUB_TOKEN"\s*:\s*"([^"]+)"', raw)
                if m:
                    gh_token = m.group(1)
        except Exception:
            gh_token = None

    if gh_token:
        # 使用 GitHub-hosted models 的 inference endpoint (仓库中使用的 base URL)
        url = os.environ.get('GITHUB_MODELS_BASE', 'https://models.inference.ai.azure.com')
        endpoint = url.rstrip('/') + '/v1/responses'
        headers = {
            'Authorization': f'Bearer {gh_token}',
            'Content-Type': 'application/json'
        }

        # 支持传入模型列表，按优先级依次尝试
        default_models = 'gpt-4o-mini,gpt-4o,gpt-4.1-mini,mistral-ai/mistral-small-2503'
        models = os.environ.get('GITHUB_MODEL_LIST', os.environ.get('GITHUB_MODEL', default_models)).split(',')
        models = [m.strip() for m in models if m.strip()]

        text_out = None
        resp = None
        for model in models:
            body = {
                'model': model,
                'input': EVAL_PROMPT,
                'max_tokens': 800
            }

            # 指数退避重试（遇到 429 重试），其它 4xx/5xx 则跳到下一个模型
            retries = 3
            backoff = 1
            for attempt in range(retries):
                try:
                    r = httpx.post(endpoint, json=body, headers=headers, timeout=60)
                    if r.status_code == 429:
                        # 速率限制，等待后重试
                        time.sleep(backoff)
                        backoff *= 2
                        continue
                    r.raise_for_status()
                    resp = r.json()
                    # 解析常见字段
                    if isinstance(resp, dict):
                        if 'output' in resp:
                            out = resp['output']
                            if isinstance(out, list):
                                text_out = ' '.join([str(x.get('content', '') if isinstance(x, dict) else x) for x in out])
                            else:
                                text_out = str(out)
                        elif 'results' in resp and isinstance(resp['results'], list):
                            parts = []
                            for it in resp['results']:
                                if isinstance(it, dict):
                                    parts.append(it.get('content') or it.get('text') or str(it))
                                else:
                                    parts.append(str(it))
                            text_out = '\n'.join(parts)
                        else:
                            text_out = json.dumps(resp, ensure_ascii=False)
                    break
                except httpx.HTTPStatusError as he:
                    # 非速率限制的 HTTP 错误，跳出重试并尝试下一个 model
                    print(f'模型 {model} 调用失败: {he}', file=sys.stderr)
                    break
                except Exception as e:
                    print(f'模型 {model} 请求异常: {e}', file=sys.stderr)
                    time.sleep(backoff)
                    backoff *= 2

            if text_out:
                # 成功获得输出，停止尝试其他模型
                break

        if not text_out:
            print('使用 GITHUB_TOKEN 调用所有候选模型均失败或被限流，回退到 OpenAI API 分支', file=sys.stderr)
            gh_token = None

    if not gh_token:
        # 检查 openai 库
        if OpenAI is None:
            print("错误：缺少 openai 客户端库。安装：pip install openai 或 pip install openai==3.x",
                  file=sys.stderr)
            sys.exit(2)

        api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('OPENAI_KEY')
        if not api_key:
            print("错误：未发现 OPENAI_API_KEY 环境变量。请先设置后重试。", file=sys.stderr)
            print("示例： export OPENAI_API_KEY=\"sk-...\"")
            sys.exit(3)

        client = OpenAI(api_key=api_key)

        try:
            resp = client.responses.create(
                model=os.environ.get('OPENAI_MODEL', 'gpt-4o-mini'),
                input=EVAL_PROMPT,
                max_tokens=800
            )
            # 提取 text
            if hasattr(resp, 'output'):
                parts = resp.output
                if isinstance(parts, list):
                    text_out = ' '.join([p.get('content', '') if isinstance(p, dict) else str(p) for p in parts])
                else:
                    text_out = str(parts)
            else:
                text_out = getattr(resp, 'choices', [{}])[0].get('text') if hasattr(resp, 'choices') else str(resp)
        except Exception as e:
            print("调用模型失败：", e, file=sys.stderr)
            sys.exit(4)

    # 尝试解析文本输出
    text_out = None
    # 兼容 responses vs completions
    if hasattr(resp, 'output'):
        # new responses API
        parts = resp.output
        if isinstance(parts, list):
            text_out = ' '.join([p.get('content', '') if isinstance(p, dict) else str(p) for p in parts])
        else:
            try:
                text_out = json.dumps(parts, ensure_ascii=False)
            except Exception:
                text_out = str(parts)
    else:
        text_out = getattr(resp, 'choices', [{}])[0].get('text') if hasattr(resp, 'choices') else str(resp)

    if not text_out:
        print('未能解析模型返回内容', file=sys.stderr)
        sys.exit(5)

    # 尝试将模型生成的 JSON 提取并解析
    candidate = None
    try:
        if not text_out:
            text_out = ''
        # 查找最先出现的 JSON 对象
        start = text_out.find('{')
        end = text_out.rfind('}')
        if start != -1 and end != -1 and end > start:
            candidate = text_out[start:end+1]
            data = json.loads(candidate)
        else:
            data = { 'raw': text_out }
    except Exception as e:
        data = { 'raw': text_out, 'parse_error': str(e) }

    # 保存
    with open(OUTPUT_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump({ 'request_prompt': EVAL_PROMPT, 'response_text': text_out, 'parsed': data }, f, ensure_ascii=False, indent=2)

    print(json.dumps({ 'parsed': data }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    run_evaluation()
