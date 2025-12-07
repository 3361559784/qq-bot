const MILLENNIUM_ACADEMIC_RECORDS = {
  semester: "2025_Term_1",
  department: "General_Education",
  
  students: [
    {
      id: "ST_001",
      name: "早濑优香 (Yuuka)",
      subject: "高等数学",
      score: 100,
      attendance: "100%",
      remarks: "完美，无需辅导。"
    },
    {
      id: "ST_002",
      name: "才羽桃井 (Momoi)",
      subject: "高等数学",
      score: 12,  // 【分析点1】极低分，挂科预警
      attendance: "98%",
      remarks: "上课一直在画游戏草图。"
    },
    {
      id: "ST_003",
      name: "才羽绿 (Midori)",
      subject: "高等数学",
      score: 88,
      attendance: "98%",
      remarks: "成绩良好。"
    },
    {
      id: "ST_004",
      name: "花冈柚子 (Yuzu)",
      subject: "程序设计",
      score: 98,
      attendance: "5%",  // 【分析点2】出勤率极低，留级预警
      remarks: "一直躲在储物柜里自习。"
    },
    {
      id: "ST_005",
      name: "生盐乃爱 (Noa)",
      subject: "历史文献学",
      score: 100,
      attendance: "100%",
      remarks: "过目不忘。"
    },
    {
      id: "ST_006", // 【分析点3】数据异常：分数超过上限
      name: "角楯卡琳 (Karin)",
      subject: "数值计算",
      score: 150, 
      attendance: "85%",
      remarks: "数据录入错误？满分应为100。"
    }
  ]
};