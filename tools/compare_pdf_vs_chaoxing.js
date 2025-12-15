#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function normText(s) {
  return String(s || '')
    .replace(/[\s\u00A0]+/g, '')
    .replace(/[（）()【】\[\]「」《》<>]/g, '')
    .replace(/[，,。.;；:：·•]/g, '')
    .trim();
}

function normTime(s) {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const hh = String(Number(m[1])).padStart(2, '0');
  return `${hh}:${m[2]}`;
}

function isPE(name) {
  return /体育/.test(String(name || ''));
}

function parseWeeksToSet(weeksStr) {
  const s = String(weeksStr || '').replace(/\s/g, '');
  if (!s) return null;

  // 支持: "1-16周", "1-16", "1,2,3", "1-8,10-16" 等
  const cleaned = s
    .replace(/周/g, '')
    .replace(/第/g, '')
    .replace(/\(|\)|（|）/g, '');

  const set = new Set();
  const parts = cleaned.split(/[,，、;]/).filter(Boolean);
  for (const p of parts) {
    const range = p.split('-').filter(Boolean);
    if (range.length === 1) {
      const n = Number(range[0]);
      if (Number.isFinite(n)) set.add(n);
    } else if (range.length === 2) {
      const a = Number(range[0]);
      const b = Number(range[1]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        for (let i = start; i <= end; i++) set.add(i);
      }
    }
  }
  return set.size ? set : null;
}

function setToRanges(set) {
  if (!set || set.size === 0) return '';
  const arr = Array.from(set).sort((a, b) => a - b);
  const ranges = [];
  let start = arr[0];
  let prev = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const cur = arr[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`);
    start = cur;
    prev = cur;
  }
  ranges.push(start === prev ? String(start) : `${start}-${prev}`);
  return ranges.join(',');
}

function keyForCourse(c, ignoreLocation = false) {
  const weekday = Number(c.weekday || c.day) || 0;
  const start = normTime(c.startTime || c.timeStart);
  const end = normTime(c.endTime || c.timeEnd);
  const name = normText(c.courseName || c.name);
  const loc = ignoreLocation ? '' : normText(c.location);
  return `${weekday}|${start}-${end}|${name}|${loc}`;
}

async function ocrPdfToCourses(pdfPath) {
  const pdfBuf = fs.readFileSync(pdfPath);

  const PDFParse = require('pdf-parse');
  const { readTextFromComputerVision } = require('../services/visionService');
  const { parseScheduleFromOcrText } = require('../services/ocrSchedule');

  if (!process.env.COMPUTER_VISION_ENDPOINT || !process.env.COMPUTER_VISION_KEY) {
    throw new Error('缺少 COMPUTER_VISION_ENDPOINT / COMPUTER_VISION_KEY (用于 Azure Computer Vision Read OCR)');
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_MODELS_TOKEN;
  if (!token) throw new Error('缺少 GITHUB_TOKEN (用于模型结构化解析)');

  const parser = new PDFParse(pdfBuf);
  const shots = await parser.getScreenshot({ scale: 2 });
  const pages = Array.isArray(shots?.pages) ? shots.pages : [];
  if (!pages.length) throw new Error('PDF 渲染失败: pages 为空');

  const ctx = { log: (...args) => console.log('[OCR]', ...args) };

  let fullText = '';
  for (let i = 0; i < pages.length; i++) {
    const dataUrl = String(pages[i]?.dataUrl || '');
    const m = dataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
    if (!m) continue;
    const imgBuf = Buffer.from(m[1], 'base64');
    const pageText = await readTextFromComputerVision(imgBuf, ctx);
    if (pageText && String(pageText).trim()) {
      fullText += `\n\n[第${i + 1}页]\n${pageText}`;
    }
  }

  if (!fullText.trim()) throw new Error('PDF OCR 为空');

  const { schedule, confidence } = await parseScheduleFromOcrText(fullText, token);
  if (!Array.isArray(schedule) || schedule.length === 0) throw new Error('模型未解析出课程');

  return { courses: schedule, confidence };
}

async function fetchChaoxingCoursesWithWeeks(chaoxingUrl) {
  const {
    extractCurriculumUuid,
    fetchChaoxingSchedule,
    transformLessonsToStandardFormat,
    getScheduleInfo
  } = require('../services/chaoxingSchedule');

  const uuid = extractCurriculumUuid(chaoxingUrl);
  if (!uuid) throw new Error('无法从学习通链接提取 curriculumUuid');

  const info = await getScheduleInfo(uuid);
  if (!info.success) throw new Error(`获取课表信息失败: ${info.error}`);

  const maxWeek = Number(info.maxWeek) || 20;
  const curriculum = info.curriculum;

  // key -> { base, weeks:Set }
  const map = new Map();

  // 简单分批并发，避免同时打爆
  const batchSize = 5;
  for (let w = 1; w <= maxWeek; w += batchSize) {
    const batch = [];
    for (let week = w; week < w + batchSize && week <= maxWeek; week++) {
      batch.push(
        fetchChaoxingSchedule(uuid, week)
          .then(r => ({ week, r }))
          .catch(e => ({ week, r: { success: false, error: e.message } }))
      );
    }

    const results = await Promise.all(batch);
    for (const { week, r } of results) {
      if (!r.success) continue;
      const lessons = r.data?.lessons || [];
      const events = transformLessonsToStandardFormat(lessons, curriculum);
      for (const e of events) {
        const item = {
          courseName: e.name,
          location: e.location,
          weekday: e.day,
          startTime: e.startTime,
          endTime: e.endTime,
          weeks: null
        };

        const k = keyForCourse(item, false);
        if (!map.has(k)) {
          map.set(k, { base: item, weeks: new Set([week]) });
        } else {
          map.get(k).weeks.add(week);
        }
      }
    }
  }

  const courses = [];
  for (const { base, weeks } of map.values()) {
    courses.push({
      ...base,
      weeks: setToRanges(weeks)
    });
  }

  return { courses, maxWeek };
}

function diffWeeks(a, b) {
  const sa = parseWeeksToSet(a);
  const sb = parseWeeksToSet(b);
  if (!sa || !sb) return null;
  const onlyA = new Set([...sa].filter(x => !sb.has(x)));
  const onlyB = new Set([...sb].filter(x => !sa.has(x)));
  return { onlyA: setToRanges(onlyA), onlyB: setToRanges(onlyB) };
}

async function main() {
  const pdfPath = process.argv[2];
  const chaoxingUrl = process.argv[3];

  if (!pdfPath || !chaoxingUrl) {
    console.error('用法: node tools/compare_pdf_vs_chaoxing.js <pdf路径> <学习通链接>');
    process.exit(1);
  }

  const absPdf = path.isAbsolute(pdfPath) ? pdfPath : path.join(process.cwd(), pdfPath);
  if (!fs.existsSync(absPdf)) throw new Error(`找不到PDF: ${absPdf}`);

  console.log('[1/3] PDF -> OCR -> 结构化...');
  const { courses: pdfCourses, confidence } = await ocrPdfToCourses(absPdf);
  console.log(`PDF解析: ${pdfCourses.length} 门, 置信度(字段完整度): ${(confidence * 100).toFixed(1)}%`);

  console.log('[2/3] 学习通 -> 全周抓取 -> 聚合周次...');
  const { courses: cxCourses, maxWeek } = await fetchChaoxingCoursesWithWeeks(chaoxingUrl);
  console.log(`学习通聚合: ${cxCourses.length} 门(去重后), maxWeek=${maxWeek}`);

  console.log('[3/3] 对比(忽略体育)...');
  const cxMap = new Map();
  const cxMapNoLoc = new Map();
  for (const c of cxCourses) {
    if (isPE(c.courseName || c.name)) continue;
    cxMap.set(keyForCourse(c, false), c);
    cxMapNoLoc.set(keyForCourse(c, true), c);
  }

  const pdfMap = new Map();
  const pdfMapNoLoc = new Map();
  for (const c of pdfCourses) {
    if (isPE(c.courseName || c.name)) continue;
    pdfMap.set(keyForCourse(c, false), c);
    pdfMapNoLoc.set(keyForCourse(c, true), c);
  }

  const missingInCx = [];
  const missingInPdf = [];
  const mismatches = [];

  for (const [k, pc] of pdfMap.entries()) {
    const match = cxMap.get(k) || cxMapNoLoc.get(keyForCourse(pc, true));
    if (!match) {
      missingInCx.push(pc);
      continue;
    }
    const wdiff = diffWeeks(pc.weeks, match.weeks);
    if (wdiff && (wdiff.onlyA || wdiff.onlyB)) {
      mismatches.push({
        type: 'weeks',
        pdf: pc,
        cx: match,
        detail: wdiff
      });
    }
  }

  for (const [k, cc] of cxMap.entries()) {
    const match = pdfMap.get(k) || pdfMapNoLoc.get(keyForCourse(cc, true));
    if (!match) missingInPdf.push(cc);
  }

  console.log('--- 汇总 ---');
  console.log(`PDF(非体育)条目: ${pdfMap.size}`);
  console.log(`学习通(非体育)条目: ${cxMap.size}`);
  console.log(`PDF有但学习通没有: ${missingInCx.length}`);
  console.log(`学习通有但PDF没有: ${missingInPdf.length}`);
  console.log(`周次不一致: ${mismatches.length}`);

  const show = (label, arr, n = 10) => {
    if (!arr.length) return;
    console.log(`\n${label} (展示前${Math.min(n, arr.length)}条):`);
    for (const c of arr.slice(0, n)) {
      console.log(`- 周${c.weekday} ${normTime(c.startTime)}-${normTime(c.endTime)} ${c.courseName} @ ${c.location || '-'} weeks=${c.weeks || '-'}`);
    }
  };

  show('PDF有但学习通没有', missingInCx);
  show('学习通有但PDF没有', missingInPdf);

  if (mismatches.length) {
    console.log('\n周次不一致(展示前10条):');
    for (const m of mismatches.slice(0, 10)) {
      const pc = m.pdf;
      const cc = m.cx;
      console.log(`- ${pc.courseName} 周${pc.weekday} ${normTime(pc.startTime)}-${normTime(pc.endTime)} @${pc.location || '-'} | PDF weeks=${pc.weeks} vs 学习通 weeks=${cc.weeks} | diff: PDF-only=${m.detail.onlyA || '-'} cx-only=${m.detail.onlyB || '-'}`);
    }
  }
}

main().catch((e) => {
  console.error('❌ 失败:', e.message);
  process.exit(1);
});
