// ==========================================
// 天气服务模块 (Weather Service)
// ==========================================

const CITY_MAP = {
    "安徽": "Hefei", "福建": "Fuzhou", "甘肃": "Lanzhou", "广东": "Guangzhou", "广西": "Nanning", 
    "贵州": "Guiyang", "海南": "Haikou", "河北": "Shijiazhuang", "河南": "Zhengzhou", "黑龙江": "Harbin",
    "湖北": "Wuhan", "湖南": "Changsha", "吉林": "Changchun", "江苏": "Nanjing", "江西": "Nanchang",
    "辽宁": "Shenyang", "内蒙古": "Hohhot", "宁夏": "Yinchuan", "青海": "Xining", "山东": "Jinan",
    "山西": "Taiyuan", "陕西": "Xi'an", "四川": "Chengdu", "西藏": "Lhasa", "新疆": "Urumqi",
    "云南": "Kunming", "浙江": "Hangzhou", "香港": "Hong Kong", "澳门": "Macau", "台湾": "Taipei",
    "合肥": "Hefei", "福州": "Fuzhou", "兰州": "Lanzhou", "广州": "Guangzhou", "南宁": "Nanning",
    "贵阳": "Guiyang", "海口": "Haikou", "石家庄": "Shijiazhuang", "郑州": "Zhengzhou", "哈尔滨": "Harbin",
    "武汉": "Wuhan", "长沙": "Changsha", "长春": "Changchun", "南京": "Nanjing", "南昌": "Nanchang",
    "沈阳": "Shenyang", "呼和浩特": "Hohhot", "银川": "Yinchuan", "西宁": "Xining", "济南": "Jinan",
    "太原": "Taiyuan", "西安": "Xi'an", "成都": "Chengdu", "拉萨": "Lhasa", "乌鲁木齐": "Urumqi",
    "昆明": "Kunming", "杭州": "Hangzhou", "北京": "Beijing", "上海": "Shanghai", "天津": "Tianjin",
    "重庆": "Chongqing", "深圳": "Shenzhen", "苏州": "Suzhou", "青岛": "Qingdao", "大连": "Dalian",
    "厦门": "Xiamen", "宁波": "Ningbo", "烟台": "Yantai", "无锡": "Wuxi", "佛山": "Foshan", "东莞": "Dongguan"
};

const CITY_PINYIN_FALLBACK = {
    "潜江": "Qianjiang",
    "荆州": "Jingzhou",
    "襄阳": "Xiangyang",
    "宜昌": "Yichang",
    "黄冈": "Huanggang",
    "黄石": "Huangshi",
    "十堰": "Shiyan",
    "恩施": "Enshi",
    "随州": "Suizhou",
    "咸宁": "Xianning",
    "仙桃": "Xiantao",
    "天门": "Tianmen",
    "麻城": "Macheng",
    "广水": "Guangshui",
    "孝感": "Xiaogan",
    "鄂州": "Ezhou",
    "荆门": "Jingmen"
};

function toPinyinCityName(rawChinese) {
    if (!rawChinese) return "";
    let name = rawChinese.replace(/(市|省|区|县)$/g, "");
    name = name.replace(/^的/, "");

    if (CITY_MAP[name]) {
        return CITY_MAP[name];
    }
    if (CITY_PINYIN_FALLBACK[name]) {
        return CITY_PINYIN_FALLBACK[name];
    }
    return name;
}

function getWeatherDesc(code) {
    if (code === 0) return "☀️ 晴天";
    if (code >= 1 && code <= 3) return "☁️ 多云/阴天";
    if (code >= 45 && code <= 48) return "🌫️ 有雾";
    if (code >= 51 && code <= 55) return "🌧️ 毛毛雨";
    if (code >= 61 && code <= 65) return "🌧️ 下雨";
    if (code >= 66 && code <= 67) return "❄️ 雨夹雪";
    if (code >= 71 && code <= 77) return "🌨️ 下雪";
    if (code >= 80 && code <= 82) return "🌧️ 阵雨";
    if (code >= 95 && code <= 99) return "⛈️ 雷雨";
    return "未知天气";
}

module.exports = {
    CITY_MAP,
    CITY_PINYIN_FALLBACK,
    toPinyinCityName,
    getWeatherDesc
};
