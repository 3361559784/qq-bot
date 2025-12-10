/**
 * 学习通 (Chaoxing) 课表爬虫模块
 * 使用 Puppeteer 绕过移动端限制，提取课程表数据
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// ==========================================
// 配置区 (Configuration)
// ==========================================

// 移动端 User-Agent (模拟 iPhone)
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// Chrome/Edge 可执行文件路径 (macOS 常见位置)
const CHROME_PATHS = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge'
];

// 超时配置
const TIMEOUT_CONFIG = {
    navigation: 45000,  // 页面导航超时 45秒
    selector: 15000,    // 等待元素出现超时 15秒
    idle: 3000          // 页面稳定等待时间 3秒
};

// 可能的课表容器选择器 (按优先级尝试)
const SCHEDULE_SELECTORS = [
    '.class-table-container',
    '.schedule-container',
    '.curriculum-table',
    '.course-list',
    '.week-schedule',
    '.timetable',
    'table',
    '.schedule',
    'body'  // 兜底：整个页面
];

// ==========================================
// 工具函数
// ==========================================

/**
 * 查找可用的 Chrome/Edge 浏览器路径
 */
function findChromePath() {
    for (const chromePath of CHROME_PATHS) {
        if (fs.existsSync(chromePath)) {
            return chromePath;
        }
    }
    throw new Error('未找到 Chrome/Edge/Chromium 浏览器。请安装 Chrome/Edge 或设置 CHROME_PATH 环境变量');
}

/**
 * 延时函数
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 核心爬取函数
 * @param {string} url - 学习通课表页面 URL
 * @param {object} context - Azure Functions context (用于日志)
 * @returns {Promise<{success: boolean, text: string, screenshotPath: string, html: string, error?: string}>}
 */
async function scrapeChaoxingSchedule(url, context) {
    const chromePath = process.env.CHROME_PATH || findChromePath();
    context.log(`[ChaoxingScraper] 使用 Chrome: ${chromePath}`);
    
    let browser = null;
    let screenshotPath = null;

    try {
        // 1. 启动浏览器 (无头模式 + 移动端配置)
        context.log('[ChaoxingScraper] 启动浏览器...');
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: true,  // 生产环境使用无头模式
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',  // 隐藏 webdriver 标识
                '--disable-features=IsolateOrigins,site-per-process',
                '--window-size=375,812',
                '--user-agent=' + MOBILE_UA
            ]
        });

        const page = await browser.newPage();

        // 2. 隐藏自动化特征
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
            
            // 覆盖 Chrome 对象
            window.navigator.chrome = {
                runtime: {},
            };
            
            // 覆盖 permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
        });

        // 3. 设置移动端 UA + 视口
        await page.setUserAgent(MOBILE_UA);
        await page.setViewport({ 
            width: 375, 
            height: 812, 
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 2
        });

        // 4. 设置额外的 HTTP 头
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Referer': 'https://www.chaoxing.com/'
        });

        context.log(`[ChaoxingScraper] 导航到: ${url}`);
        
        // 5. 访问页面 (等待网络空闲)
        await page.goto(url, { 
            waitUntil: 'networkidle2', 
            timeout: TIMEOUT_CONFIG.navigation 
        });

        // 6. 额外等待页面稳定 + 滚动触发懒加载
        await sleep(TIMEOUT_CONFIG.idle);
        
        // 滚动页面以触发动态内容加载
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if(totalHeight >= scrollHeight){
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });
        
        // 等待滚动后的内容渲染
        await sleep(2000);

        // 7. 尝试等待课表容器出现
        let foundSelector = null;
        for (const selector of SCHEDULE_SELECTORS) {
            try {
                await page.waitForSelector(selector, { timeout: TIMEOUT_CONFIG.selector });
                foundSelector = selector;
                context.log(`[ChaoxingScraper] 找到元素: ${selector}`);
                break;
            } catch (err) {
                // 继续尝试下一个选择器
            }
        }

        if (!foundSelector) {
            context.log('[ChaoxingScraper] 未找到特定课表容器，使用整页提取');
        }

        // 8. 提取课程数据 (结构化 + 纯文本) - 包含完整时间信息
        const extractedData = await page.evaluate(() => {
            const scheduleData = [];
            
            // 1. 提取表头:星期和日期
            const weekDays = [];
            const headerCells = document.querySelectorAll('#scheduleHead th, thead th');
            
            headerCells.forEach((th, index) => {
                if (index === 0) return; // 跳过第一列(时间列)
                const text = th.textContent.trim();
                const match = text.match(/(周[一二三四五六日])\s*(\d{2}-\d{2})/);
                if (match) {
                    weekDays.push({
                        day: match[1],
                        date: match[2]
                    });
                }
            });

            // 2. 创建时间-节次映射 (通过遍历所有tr收集时间信息)
            const timePeriodMap = {}; // key=行索引, value={period, timeStart, timeEnd}
            const allRows = document.querySelectorAll('#scheduleTable tr, table.schedule tr');
            
            allRows.forEach((row, rowIdx) => {
                const firstTd = row.querySelector('td:first-child');
                if (!firstTd) return;
                
                // 尝试从class选择器获取
                let periodNum = firstTd.querySelector('.periodNum')?.textContent.trim();
                let timeStart = firstTd.querySelector('.timeStart')?.textContent.trim();
                let timeEnd = firstTd.querySelector('.timeEnd')?.textContent.trim();
                const periodType = firstTd.querySelector('.title')?.textContent.trim() || '';
                
                // 如果没有class,尝试从文本解析 (格式: "1 08:00 08:45" 或 "108:0008:45")
                if (!periodNum || !timeStart) {
                    const text = firstTd.textContent.trim();
                    // 匹配格式: 数字 + 时间 (可能有空格)
                    const match = text.match(/^(\d+)\s*(\d{2}:\d{2})\s*(\d{2}:\d{2})/);
                    if (match) {
                        periodNum = match[1];
                        timeStart = match[2];
                        timeEnd = match[3];
                    }
                }
                
                if (periodNum || timeStart) {
                    timePeriodMap[rowIdx] = {
                        period: periodNum || '',
                        timeStart: timeStart || '',
                        timeEnd: timeEnd || '',
                        periodType: periodType
                    };
                }
            });

            // 3. 遍历所有.tddiv课程卡片,定位其所在行和列
            const courseCards = document.querySelectorAll('.tddiv');
            
            courseCards.forEach((card) => {
                const nameEl = card.querySelector('.courseName');
                const locEl = card.querySelector('.courseLoc');
                
                if (!nameEl) return;
                
                const courseName = nameEl.textContent.trim();
                const location = locEl ? locEl.textContent.replace('@', '').trim() : '';
                
                // 定位该课程所在的td和tr
                const parentTd = card.closest('td');
                const parentTr = card.closest('tr');
                
                if (!parentTd || !parentTr) return;
                
                // 计算列索引 (第几天)
                const allTdsInRow = parentTr.querySelectorAll('td');
                let columnIndex = -1;
                allTdsInRow.forEach((td, idx) => {
                    if (td === parentTd) columnIndex = idx;
                });
                
                // 计算行索引
                let rowIndex = -1;
                allRows.forEach((row, idx) => {
                    if (row === parentTr) rowIndex = idx;
                });
                
                const timeInfo = timePeriodMap[rowIndex] || {};
                const rowspan = parentTd.getAttribute('rowspan') || '1';
                
                scheduleData.push({
                    weekDay: weekDays[columnIndex - 1]?.day || `星期${columnIndex}`,  // -1 因为第0列是时间
                    date: weekDays[columnIndex - 1]?.date || '',
                    period: timeInfo.period || '',
                    timeStart: timeInfo.timeStart || '',
                    timeEnd: timeInfo.timeEnd || '',
                    periodType: timeInfo.periodType || '',
                    courseName: courseName,
                    location: location,
                    duration: parseInt(rowspan)
                });
            });

            // 提取当前周次
            const weekText = document.querySelector('.week')?.textContent.trim() || '';

            // 获取完整课表文本
            const mainContent = document.querySelector('.schedule, #scheduleTable');
            const fullTextBefore = mainContent ? mainContent.innerText : document.body.innerText;

            // 移除导航和脚本
            const scripts = document.querySelectorAll('script, style, .subNav, .selectBox, .headRight');
            scripts.forEach(el => el.remove());
            
            const fullText = mainContent ? mainContent.innerText : fullTextBefore;

            return {
                schedule: scheduleData,
                week: weekText,
                weekDays: weekDays,
                fullText: fullText
            };
        });
        
        context.log(`[ChaoxingScraper] 提取到 ${extractedData.schedule.length} 门课程`);
        context.log(`[ChaoxingScraper] 当前周次: ${extractedData.week}`);
        
        // 格式化课程数据为结构化文本
        let formattedText = `${extractedData.week}\n\n`;
        formattedText += `📅 课程表 (${extractedData.weekDays.map(d => `${d.day}${d.date}`).join(', ')})\n\n`;
        
        // 按星期分组显示课程
        const groupedByDay = {};
        extractedData.schedule.forEach(course => {
            if (!groupedByDay[course.weekDay]) {
                groupedByDay[course.weekDay] = [];
            }
            groupedByDay[course.weekDay].push(course);
        });
        
        // 遍历每一天输出课程
        extractedData.weekDays.forEach(dayInfo => {
            const courses = groupedByDay[dayInfo.day] || [];
            if (courses.length > 0) {
                formattedText += `\n${dayInfo.day} (${dayInfo.date}):\n`;
                courses.forEach(course => {
                    formattedText += `  第${course.period}节 ${course.timeStart}-${course.timeEnd} | ${course.courseName}`;
                    if (course.location) {
                        formattedText += ` @${course.location}`;
                    }
                    if (course.duration > 1) {
                        formattedText += ` [${course.duration}节连上]`;
                    }
                    formattedText += `\n`;
                });
            }
        });
        
        formattedText += `\n\n完整课表文本:\n${extractedData.fullText}`;

        // 9. 提取 HTML (用于调试)
        const htmlContent = await page.content();

        // 10. 截图保存 (用于调试和视觉验证)
        const timestamp = Date.now();
        const screenshotDir = process.env.TEMP || '/tmp';
        screenshotPath = path.join(screenshotDir, `chaoxing_schedule_${timestamp}.png`);
        
        await page.screenshot({ 
            path: screenshotPath, 
            fullPage: true 
        });
        
        context.log(`[ChaoxingScraper] 截图已保存: ${screenshotPath}`);
        context.log(`[ChaoxingScraper] 提取文本长度: ${formattedText.length} 字符`);

        return {
            success: true,
            text: formattedText,
            schedule: extractedData.schedule,  // 完整课程数据(包含时间)
            week: extractedData.week,
            weekDays: extractedData.weekDays,
            html: htmlContent,
            screenshotPath: screenshotPath,
            url: url
        };

    } catch (error) {
        context.error(`[ChaoxingScraper] 爬取失败: ${error.message}`);
        return {
            success: false,
            text: '',
            schedule: [],
            week: '',
            weekDays: [],
            html: '',
            screenshotPath: screenshotPath || '',
            error: error.message
        };
    } finally {
        if (browser) {
            await browser.close();
            context.log('[ChaoxingScraper] 浏览器已关闭');
        }
    }
}

/**
 * 简单的数据清洗 (移除多余空行和特殊字符)
 */
function cleanScrapedText(rawText) {
    return rawText
        .replace(/\n{3,}/g, '\n\n')  // 多个换行压缩为两个
        .replace(/[\r\t]/g, ' ')     // 移除回车和制表符
        .trim();
}

/**
 * 验证 URL 是否是学习通域名
 */
function isChaoxingUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.includes('chaoxing.com');
    } catch {
        return false;
    }
}

// ==========================================
// 导出模块
// ==========================================

module.exports = {
    scrapeChaoxingSchedule,
    cleanScrapedText,
    isChaoxingUrl
};
