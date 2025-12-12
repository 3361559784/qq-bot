const { app } = require('@azure/functions');

// 导入所有函数(这会自动注册它们)
require('./functions/schoolBot');
require('./functions/dailyClassReminder');
require('./functions/ocrCourse');
